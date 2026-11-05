/**
 * FGHealthCheck — FG 关系图健康检查（方案C）
 *
 * 监控 FG 健康指标，定期运行清理任务。
 * 通过 FamilyGraph 私有 query/run 访问底层 SQL（sql.js 实例无 query 方法）。
 * 清理后必须显式 markDirty(true) 触发落盘，否则重启后还原。
 */
import type { FamilyGraph } from '../../m4/household/FamilyGraph.js';
import { NON_NAME_TAIL_CHARS } from '../entity/EntityCandidateGrader.js';

export interface FGHealthReport {
  totalNodes: number;
  totalEdges: number;
  garbageNodes: number;
  autoFixEdges: number;
  inferredEdges: number;
  noneEdges: number;
  /** 幽灵边：source/target 指向不存在的节点（清理遗留/半写入残留） */
  ghostEdges: number;
  duplicateEdges: number;
  isHealthy: boolean;
}

export class FGHealthCheck {
  private fg: FamilyGraph;

  constructor(fg: FamilyGraph) {
    this.fg = fg;
  }

  /** 私有 query 透传（FamilyGraph.query 是 private，返回 getAsObject 数组） */
  private q(sql: string, params?: unknown[]): any[] {
    return (this.fg as any).query(sql, params);
  }

  /** 私有 run 透传 */
  private r(sql: string, params?: unknown[]): void {
    (this.fg as any).run(sql, params);
  }

  /** 清理后强制立即落盘（FamilyGraph 私有 run 不经过 markDirty） */
  private flushDirty(): void {
    (this.fg as any).markDirty(true);
  }

  check(): FGHealthReport {
    const totalNodes = this.countNodes();
    const totalEdges = this.countEdges();
    const garbageNodes = this.countGarbageNodes();
    const autoFixEdges = this.countAutoFixEdges();
    const inferredEdges = this.countInferredEdges();
    const noneEdges = this.countNoneEdges();
    const ghostEdges = this.countGhostEdges();
    const duplicateEdges = this.countDuplicateEdges();

    const isHealthy =
      garbageNodes === 0 &&
      autoFixEdges === 0 &&
      inferredEdges === 0 &&
      noneEdges === 0 &&
      ghostEdges === 0 &&
      duplicateEdges === 0;

    return {
      totalNodes,
      totalEdges,
      garbageNodes,
      autoFixEdges,
      inferredEdges,
      noneEdges,
      ghostEdges,
      duplicateEdges,
      isHealthy,
    };
  }

  /** 执行清理并落盘，返回各项清理数 */
  runCleanup(): { cleaned: number; details: Record<string, number> } {
    const details: Record<string, number> = {
      autoFixAcquaintance: this.deleteAutoFixAcquaintanceEdges(),
      inferred: this.deleteInferredEdges(),
      noneEdges: this.deleteNoneEdges(),
      ghost: this.deleteGhostEdges(),
      duplicates: this.cleanupDuplicates(),
    };
    const cleaned = Object.values(details).reduce((a, b) => a + b, 0);
    if (cleaned > 0) this.flushDirty();
    return { cleaned, details };
  }

  private countNodes(): number {
    const result = this.q('SELECT COUNT(*) as cnt FROM nodes');
    return result[0]?.cnt || 0;
  }

  private countEdges(): number {
    const result = this.q('SELECT COUNT(*) as cnt FROM edges');
    return result[0]?.cnt || 0;
  }

  private countGarbageNodes(): number {
    // SQLite GLOB 不支持 Unicode 字符集范围（[一-鿿] 无效会误匹配全部中文名），故用 JS 正则判断
    const nodes = this.q("SELECT name FROM nodes WHERE type = 'person'");
    return nodes.filter((n: any) => {
      const name = String(n.name);
      if (name === '我') return false; // 用户本人节点，合法
      if (name.length < 2 || name.length > 6) return true;
      return !/^[\u4e00-\u9fff]+$/.test(name); // 含非中文字符 = 语音识别乱码/垃圾
    }).length;
  }

  private countAutoFixEdges(): number {
    // 🔴 2026-08-24: 仅统计 acquaintance_of 的 _auto_fix（真垃圾）。
    //    ⑬⑯ 补全的合法反向边（colleague/spouse/boss 等）也带 _auto_fix 标记，属设计内完整性修复，不算垃圾。
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE properties LIKE '%_auto_fix%' AND relation = 'acquaintance_of'
    `);
    return result[0]?.cnt || 0;
  }

  private countInferredEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE properties LIKE '%_inferred%'
    `);
    return result[0]?.cnt || 0;
  }

  private countNoneEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE source_id LIKE 'None%' OR target_id LIKE 'None%'
    `);
    return result[0]?.cnt || 0;
  }

  private countDuplicateEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM (
        SELECT source_id, target_id, relation, COUNT(*) as cnt
        FROM edges
        GROUP BY source_id, target_id, relation
        HAVING cnt > 1
      )
    `);
    return result[0]?.cnt || 0;
  }

  private deleteAutoFixAcquaintanceEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE properties LIKE '%_auto_fix%' AND relation = 'acquaintance_of'`);
    return before - this.countEdges();
  }

  private deleteInferredEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE properties LIKE '%_inferred%'`);
    return before - this.countEdges();
  }

  private deleteNoneEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE source_id LIKE 'None%' OR target_id LIKE 'None%'`);
    return before - this.countEdges();
  }

  /** 幽灵边计数：任一端节点不存在（最大垃圾源，2026-08-24 清理实证 922 条） */
  private countGhostEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)
    `);
    return result[0]?.cnt || 0;
  }

  private deleteGhostEdges(): number {
    const before = this.countEdges();
    this.r('DELETE FROM edges WHERE source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)');
    return before - this.countEdges();
  }

  private cleanupDuplicates(): number {
    // 🔴 2026-08-24 V2修复: 用「有序三元组 (source_id,target_id,relation)」分组——只删完全重复（同方向同关系）。
    //    曾误用「无序对」分组，把有向互反关系（colleague_of/spouse_of 的 A→B 与 B→A 同 relation 同无序对）
    //    当重复删一半，致 78 条 colleague + 3 条 spouse 反向被误删（2026-08-24 review 实证）。
    //    保留 created_at 最早一条（MIN(id) 是随机 UUID 最小，非最早创建）。
    const before = this.countEdges();
    this.r(`
      DELETE FROM edges
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY source_id, target_id, relation
            ORDER BY created_at ASC, id ASC
          ) AS rn
          FROM edges
        ) WHERE rn = 1
      )
    `);
    return before - this.countEdges();
  }

  /**
   * 滑窗垃圾实体自检（2026-10-23，长期兜底预警）
   * ============================================================
   * 背景：尤其/水乳交/阿珍带/阿珍聊/阿珍妈 5 个滑窗片段曾误晋升 active。
   *   根因 = 滑窗跨词边界切割 + 强上下文判定在情色/角色扮演语境被「叫/是/找」虚触发。
   *   代码侧已双层堵漏（NON_NAME_TAIL_CHARS 加 5 尾字 + _hasNameStrongContext 起名句降级），
   *   但语义判定无法穷尽 —— 新语境仍可能产生新变体，故加本自检作**兜底预警**。
   *
   * 判据（复用 NON_NAME_TAIL_CHARS 单一真源，不复制判据；只预警不自动 void，
   *   避免误杀真人 —— 是否清除由人工/离线终审定夺）：
   *
   *   ── 通道A（2026-10-23 原判据，零改动）──
   *   ① type='person' 且 status='active' 且 name != '我'
   *   ② 无 description 且无 relation_to_user（从未获得真实档案）
   *   ③ 名尾命中 NON_NAME_TAIL_CHARS（跨词边界滑窗片段的强特征）
   *   ④ evidence.contexts 显示源自单句（短窗口，非多轮真实交往）
   *   四条全中 → 疑似滑窗垃圾。
   *
   *   ── 通道B（2026-11-05 C 阶段补强，业主批准 A→C→B 顺序）──
   *   背景：13 个已确认滑窗垃圾 active（阿珍一/毕竟所/相处/师大…）实测**全部漏过**
   *   通道A —— 尾字集刻意保守（一/叫/所/处/大 不在集，防误伤真人）+ ④ contexts≤1
   *   过严（后妈 ctx=3 漏）。漏检是系统性的，不是偶发。
   *   ①② 之后命中以下任一即列入预警：
   *   ⑤ 前缀扩展：存在另一 active/dormant 人名或别名 base，name 以 base 开头且多 1-2 字
   *      （阿珍→阿珍一/阿珍叫/阿珍继 —— 滑窗切片最典型结构特征）
   *   ⑥ 计数倒挂：mention_count≥8 且 evidence.count≥1 且 mention≥3×evidence.count
   *      （子串误计数正反馈的指纹：「阿珍一个人」每次都被算作阿珍一被提及 176/11）
   *   ⑦ 单句低证：evidence 字段存在且 count≤2 且 contexts≤2
   *      🔴 evidence 必须存在才评估 —— 存量真人（陈锋华等 15/16 active）无 evidence
   *      字段，若按 0 计会全体误报；「低证」语义本就要求有证可评。
   *   命中结果以 hitChannel 标注（A / B5 / B6 / B7 可叠加）。
   *
   *   ⚠️ 已知预期命中：雷灵叶（业主 2026-11-05 拍板保留，单句引入+提及倒挂的数据
   *   特征与切片垃圾不可区分）——会出现在预警清单属正常，人工复核时已知保留。
   *
   * @returns 疑似垃圾实体清单（空数组 = 健康）
   */
  detectSlidingWindowJunk(): Array<{ name: string; id: string; uuid: string | null; mentions: number; tail: string; hitChannel: string }> {
    const suspects: Array<{ name: string; id: string; uuid: string | null; mentions: number; tail: string; hitChannel: string }> = [];
    let rows: any[] = [];
    try {
      rows = this.q("SELECT id, name, uuid, properties FROM nodes WHERE type='person' AND status='active' AND name != '我'");
    } catch (e: any) {
      console.warn('[FG SelfCheck] 滑窗自检查询失败(非阻塞):', e?.message || e);
      return suspects;
    }
    // 通道B⑤：active/dormant 人名+别名前缀集（单次构建；查询失败则该子通道降级关闭）
    const prefixSet = this._buildActiveNamePrefixes();
    for (const row of rows) {
      const name = String(row.name || '');
      if (!name) continue;
      let props: any = {};
      try { props = JSON.parse(row.properties || '{}'); } catch { props = {}; }
      // ①② 无真实档案（两通道共用前提）
      const hasProfile = !!(props.description || props.relation_to_user);
      if (hasProfile) continue;
      const tail = name[name.length - 1];
      const ev = props.evidence;
      const evObj = ev && typeof ev === 'object' && !Array.isArray(ev);
      const ec = evObj && typeof ev.count === 'number' ? ev.count : 0;
      const ctxCount = evObj && Array.isArray(ev.contexts) ? ev.contexts.length : 0;
      const mentions = evObj && typeof ev.count === 'number' ? ev.count : (props.mention_count ?? 0);
      const mc = typeof props.mention_count === 'number' ? props.mention_count : 0;

      const channels: string[] = [];
      // ── 通道A：③尾字 + ④单句（原四条件语义零改动，含无 evidence 老垃圾 ctxCount=0≤1）──
      if (NON_NAME_TAIL_CHARS.has(tail) && ctxCount <= 1) channels.push('A');
      // ── 通道B⑤：前缀扩展 ──
      if (prefixSet.size > 0) {
        for (const b of prefixSet) {
          if (name !== b && name.startsWith(b) && name.length - b.length >= 1 && name.length - b.length <= 2) {
            channels.push('B5'); break;
          }
        }
      }
      // ── 通道B⑥：计数倒挂 ──
      if (mc >= 8 && ec >= 1 && mc >= ec * 3) channels.push('B6');
      // ── 通道B⑦：单句低证（evidence 必须存在，见方法头 🔴）──
      if (evObj && ec <= 2 && ctxCount <= 2) channels.push('B7');

      if (channels.length > 0) {
        suspects.push({ name, id: row.id, uuid: row.uuid || null, mentions, tail, hitChannel: channels.join('+') });
      }
    }
    return suspects;
  }

  /**
   * 通道B⑤ 辅助：构建 active/dormant 人名+别名前缀集。
   * 单次查询 + 别名 JSON 解析；任何失败返回空集（子通道降级关闭，不影响通道A）。
   */
  private _buildActiveNamePrefixes(): Set<string> {
    const set = new Set<string>();
    try {
      const rows = this.q("SELECT name, aliases FROM nodes WHERE type='person' AND status IN ('active','dormant')") as Array<{ name: string; aliases: string }>;
      for (const r of rows) {
        const n = String(r.name || '');
        if (n.length >= 2) set.add(n);
        try {
          const arr = JSON.parse(r.aliases || '[]');
          if (Array.isArray(arr)) {
            for (const a of arr) if (typeof a === 'string' && a.length >= 2) set.add(a);
          }
        } catch { /* 单个节点别名损坏不阻断整体 */ }
      }
    } catch (e: any) {
      console.warn('[FG SelfCheck] 前缀集构建失败(通道B⑤降级):', e?.message || e);
      return new Set();
    }
    return set;
  }
}
