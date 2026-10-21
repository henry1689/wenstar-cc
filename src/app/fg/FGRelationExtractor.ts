/**
 * FGRelationExtractor — LLM 关系识别器（方案C）
 *
 * 使用 LLM 识别和验证人物关系，替代 RAG 低级识别。
 * 解决语音识别错误、关系推导过度泛化等问题。
 * 通过 FamilyGraph 私有 query/run 访问底层 SQL（sql.js 实例无 query 方法）。
 */
import type { FamilyGraph } from '../../m4/household/FamilyGraph.js';
import { RELATION_TYPE_DEFS } from './RelationshipTypes.js';

export interface RelationExtractionResult {
  valid: boolean;
  relations: Array<{
    from: string;
    to: string;
    relation: string;
    confidence: number;
    reason: string;
  }>;
  errors: string[];
}

export class FGRelationExtractor {
  private fg: FamilyGraph;
  private llm: any = null;

  constructor(fg: FamilyGraph) {
    this.fg = fg;
  }

  setLLM(llm: any): void {
    this.llm = llm;
  }

  /** 私有 query 透传 */
  private q(sql: string, params?: unknown[]): any[] {
    return (this.fg as any).query(sql, params);
  }

  /** 私有 run 透传 */
  private r(sql: string, params?: unknown[]): void {
    (this.fg as any).run(sql, params);
  }

  /** 清理后强制立即落盘 */
  private flushDirty(): void {
    (this.fg as any).markDirty(true);
  }

  /**
   * 使用 LLM 识别对话中的人物关系
   */
  async extractRelationsFromDialogue(
    dialogue: string,
    context?: { currentTime?: string; speaker?: string }
  ): Promise<RelationExtractionResult> {
    if (!this.llm) {
      return {
        valid: false,
        relations: [],
        errors: ['LLM provider not configured'],
      };
    }

    const prompt = this.buildExtractionPrompt(dialogue, context);
    
    try {
      const text = await this.llm.rawCall(
        [
          { role: 'system', content: '你是一个关系识别专家，只输出 JSON 格式的关系列表。' },
          { role: 'user', content: prompt },
        ],
        500,
        0.1
      );

      return this.parseExtractionResponse(text);
    } catch (err) {
      return {
        valid: false,
        relations: [],
        errors: [`LLM extraction failed: ${err}`],
      };
    }
  }

  /**
   * 清理垃圾实体（识别并标记语音识别错误产生的节点）
   */
  async cleanupGarbageNodes(): Promise<{ cleaned: number; garbageNodes: string[] }> {
    if (!this.llm) {
      return { cleaned: 0, garbageNodes: [] };
    }

    const result = this.q("SELECT id, name FROM nodes WHERE type = 'person' AND LENGTH(name) < 6");

    const garbageNodes: string[] = [];

    for (const node of result) {
      if (await this.isGarbageNode(node.name)) {
        garbageNodes.push(node.name);
      }
    }

    // 删除垃圾节点的边和节点
    let changed = 0;
    for (const name of garbageNodes) {
      const nodeId = result.find((n: any) => n.name === name)?.id;
      if (nodeId) {
        this.r('DELETE FROM edges WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
        this.r('DELETE FROM nodes WHERE id = ?', [nodeId]);
        changed++;
      }
    }

    if (changed > 0) this.flushDirty();

    return { cleaned: garbageNodes.length, garbageNodes };
  }

  private async isGarbageNode(name: string): Promise<boolean> {
    // 基本规则检查
    if (name.length < 2 || name.length > 6) return true;
    if (/^[一-鿿]+$/.test(name) === false) return true;
    if (/\s/.test(name)) return true;
    if (/^[0-9]/.test(name)) return true;
    
    // LLM 验证
    try {
      const text = await this.llm!.rawCall(
        [
          { role: 'system', content: '判断这个人名是否是语音识别错误产生的垃圾节点。只输出 true 或 false。' },
          { role: 'user', content: `这个名字是语音识别产生的，判断是否合理：${name}` },
        ],
        10,
        0
      );
      return text.toLowerCase().includes('true');
    } catch {
      return false;
    }
  }

  private buildExtractionPrompt(dialogue: string, context?: any): string {
    return `请从以下对话中提取人物关系：

对话内容：
${dialogue}

${context?.currentTime ? `当前时间：${context.currentTime}` : ''}
${context?.speaker ? `说话人：${context.speaker}` : ''}

输出格式（JSON）：
{
  "relations": [
    {
      "from": "人物A",
      "to": "人物B", 
      "relation": "关系类型",
      "confidence": 0.9,
      "reason": "理由"
    }
  ]
}

关系类型：child_of, parent_of, elder_sister_of, younger_sister_of, spouse_of, colleague_of, friend_of, acquaintance_of
注意：
1. 只提取明确提到的关系
2. 考虑年龄合理性（如 14 岁不可能是 parent_of）
3. 忽略语音识别错误产生的垃圾名称`;
  }

  private parseExtractionResponse(content: string): RelationExtractionResult {
    try {
      const json = content.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('No JSON found');

      const data = JSON.parse(json);
      return {
        valid: true,
        relations: data.relations || [],
        errors: [],
      };
    } catch {
      return {
        valid: false,
        relations: [],
        errors: ['Failed to parse LLM response'],
      };
    }
  }

  /**
   * 把 LLM 提取的关系写入 FG（2026-08-24 LLM识别方案）
   * 门槛: confidence≥0.7 | 8 种关系白名单 | 跳过"我" | 不建新节点（防 LLM 幻觉人名垃圾）
   * 标记: properties 写 _llm + confidence + reason（区别于 _v2 人工确认）
   */
  applyRelations(result: RelationExtractionResult): { applied: number; skipped: string[] } {
    if (!result.valid) return { applied: 0, skipped: [] };
    // 🔴 T011 Phase 1：白名单派生自 RELATION_TYPE_DEFS（单一真源），删除硬编码8类。
    //   修 T008 P0-1：原白名单含 elder_sister_of/younger_sister_of 而 DEFS 无此项 → 写出的边
    //   category undefined/reverse 自反。现直接用 DEFS 键集，新增关系类型自动生效。
    const WHITELIST = new Set(Object.keys(RELATION_TYPE_DEFS));
    const skipped: string[] = [];
    let applied = 0;
    const now = new Date().toISOString();

    for (const rel of result.relations || []) {
      if (!WHITELIST.has(rel.relation)) { skipped.push(`${rel.from}-${rel.to}:非法类型[${rel.relation}]`); continue; }
      // 🔴 血缘关系（child/parent）要求更高置信（0.9）——这类错误影响会晤身份，宁缺勿滥
      const minConf = ['parent_of','father_of','mother_of','child_of'].includes(rel.relation) ? 0.9 : 0.7;
      if ((rel.confidence ?? 0) < minConf) { skipped.push(`${rel.from}-${rel.to}:confidence不足(${rel.confidence})`); continue; }
      if (rel.from === '我' || rel.to === '我') { skipped.push(`${rel.from}-${rel.to}:涉及"我"（红线）`); continue; }
      const src = this.findPersonId(rel.from);
      const tgt = this.findPersonId(rel.to);
      if (!src || !tgt) { skipped.push(`${rel.from}-${rel.to}:节点不存在（不新建防幻觉）`); continue; }
      if (src === tgt) continue;
      // 🔴 血缘关系年龄合理性：复用 FamilyGraph V10.1 校验（_isParentAgePlausible），防 LLM"自信的错误"污染
      //    （如"熊梓铭 parent_of 徐诗雨"这类跨家族错配，confidence 再高也拦截）
      if (['parent_of','father_of','mother_of','child_of'].includes(rel.relation)) {
        const plausible = (this.fg as any)._isParentAgePlausible?.(rel.relation, src, tgt);
        if (plausible === false) { skipped.push(`${rel.from}-${rel.to}:年龄矛盾（V10.1校验）`); continue; }
      }
      const exist = this.q('SELECT id FROM edges WHERE source_id=? AND target_id=? AND relation=?', [src, tgt, rel.relation]);
      if (exist.length > 0) { skipped.push(`${rel.from}-${rel.to}:已存在`); continue; }
      this.r("INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        [this.fgId(), src, tgt, rel.relation,
          JSON.stringify({ _llm: true, confidence: rel.confidence, reason: rel.reason || '', _extractedAt: now }),
          now, now]);
      applied++;
    }
    if (applied > 0) this.flushDirty();
    return { applied, skipped };
  }

  /** 最近对话 → LLM 提取 → 写入 FG（一次调用） */
  async extractAndApplyRecent(
    dialogues: Array<{ role: string; content: string }>,
    context?: { currentTime?: string }
  ): Promise<{ extracted: number; applied: number; skipped: string[] }> {
    if (!this.llm) return { extracted: 0, applied: 0, skipped: ['LLM not configured'] };
    const text = (dialogues || []).slice(-30)
      .map(d => `${d.role === 'user' ? '用户' : '玉瑶'}: ${String(d.content || '').replace(/\s+/g, ' ').substring(0, 200)}`)
      .join('\n');
    if (!text.trim()) return { extracted: 0, applied: 0, skipped: [] };
    const result = await this.extractRelationsFromDialogue(text, context);
    const { applied, skipped } = this.applyRelations(result);
    return { extracted: result.relations?.length || 0, applied, skipped };
  }

  /** 人名 → 节点 id（先精确 name → aliases → 简称子串；不建新节点） */
  private findPersonId(name: string): string | null {
    const n = String(name || '').trim();
    if (!n || n.length < 2 || n.length > 6) return null;
    const rows = this.q("SELECT id FROM nodes WHERE name=? AND type='person'", [n]);
    if (rows.length > 0) return rows[0].id as string;
    const aliasRows = this.q("SELECT id FROM nodes WHERE type='person' AND aliases LIKE ?", [`%"${n}"%`]);
    if (aliasRows.length > 0) return aliasRows[0].id as string;
    // 🔴 2026-08-25: 简称子串匹配（对话常用"诗雨"→"徐诗雨"；仅唯一命中才用，防歧义误配）
    if (n.length >= 2) {
      const subRows = this.q("SELECT id FROM nodes WHERE type='person' AND name LIKE ?", [`%${n}%`]);
      if (subRows.length === 1) return subRows[0].id as string;
    }
    return null;
  }

  private fgId(): string {
    return 'llm_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  }
}
