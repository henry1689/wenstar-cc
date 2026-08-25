/**
 * MemoryAssessor — 三库自动流转调度器
 *
 * v2: 所有硬编码阈值/周期从 MemoryConfig 读取。
 *     新增幂等校验，防止重复晋升。
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import type { EntityGene } from '../../m1/types/dna.js';
import type { Perception24D } from '../../m3/types/perception.js';
import type { EmotionalMemoryRecord } from '../../m2/types/index.js';
import { initialStrength } from '../../m2/math.js';
import { autoPromoteCandidatesV2, logVaultOperation } from './VaultManager.js';
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

const NEUTRAL_PERCEPTION: Perception24D = {
  pleasure: 0,
  arousal: 0,
  dominance: 0,
  aggression: 0,
  sincerity: 0.5,
  humor: 0,
  factual: 0.5,
  logical: 0.5,
  certainty: 0.5,
  abstract: 0,
  temporal_focus: 0,
  self_ref: 0.5,
  intimacy: 0,
  power_diff: 0,
  dependency: 0,
  moral_judgment: 0,
  etiquette: 0.5,
  belonging: 0,
  sexual_attraction: 0,
  sensory_craving: 0,
  energy_merge: 0,
  possessiveness: 0,
  ecstasy: 0,
  safety: 0.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTopicTag(topic: unknown): string | undefined {
  if (typeof topic !== 'string') return undefined;
  const normalized = topic.trim().replace(/\s+/g, '_').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return normalized ? normalized.slice(0, 48) : undefined;
}

function parseConversationEntities(raw: unknown): EntityGene[] {
  const materialize = (name: string, type: EntityGene['type'] = 'person'): EntityGene => ({
    name,
    type,
    allele: name,
    phenotype: 'neutral',
    knowledge_type: 'private',
  });

  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') {
            const name = item.trim();
            return name ? materialize(name) : null;
          }
          if (item && typeof item === 'object' && typeof item.name === 'string') {
            const name = item.name.trim();
            if (!name) return null;
            return {
              name,
              type: item.type ?? 'person',
              allele: item.allele ?? name,
              phenotype: item.phenotype ?? 'neutral',
              knowledge_type: item.knowledge_type ?? 'private',
            } as EntityGene;
          }
          return null;
        })
        .filter((item): item is EntityGene => Boolean(item));
    }
  } catch { /* fallback to csv */ }

  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => materialize(name));
}

function parseSandPerception(raw: unknown): Perception24D {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ...NEUTRAL_PERCEPTION };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 24 && parsed.every((item) => typeof item === 'number')) {
      return {
        pleasure: parsed[0], arousal: parsed[1], dominance: parsed[2], aggression: parsed[3],
        sincerity: parsed[4], humor: parsed[5], factual: parsed[6], logical: parsed[7],
        certainty: parsed[8], abstract: parsed[9], temporal_focus: parsed[10], self_ref: parsed[11],
        intimacy: parsed[12], power_diff: parsed[13], dependency: parsed[14], moral_judgment: parsed[15],
        etiquette: parsed[16], belonging: parsed[17], sexual_attraction: parsed[18], sensory_craving: parsed[19],
        energy_merge: parsed[20], possessiveness: parsed[21], ecstasy: parsed[22], safety: parsed[23],
      };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        ...NEUTRAL_PERCEPTION,
        pleasure: clamp(Number(parsed.pleasure ?? 0), -1, 1),
        arousal: clamp(Number(parsed.arousal ?? 0), 0, 1),
        intimacy: clamp(Number(parsed.intimacy ?? 0), 0, 1),
      };
    }
  } catch { /* use neutral defaults */ }

  return { ...NEUTRAL_PERCEPTION };
}

function deriveNarrativeTag(text: string, topic: unknown): string | undefined {
  const topicTag = normalizeTopicTag(topic);
  if (topicTag) return topicTag;
  if (/工作|项目|客户|会议|公司|合同|研发|采购/.test(text)) return '工作';
  if (/妈妈|爸爸|家人|老婆|老公|女友|男友|朋友/.test(text)) return '关系';
  if (/记得|回忆|以前|过去|小时候/.test(text)) return '回忆';
  return undefined;
}

function derivePrimaryEmotion(perception: Perception24D): string {
  if (perception.intimacy >= 0.45) return '亲密';
  if (perception.pleasure >= 0.35) return '快乐';
  if (perception.pleasure <= -0.35) return '失落';
  if (perception.arousal >= 0.65) return '激动';
  if (perception.factual >= 0.7) return '事实';
  return '中性';
}

export class MemoryAssessor {
  private storage: FusionStorageAdapter;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    console.log('[MemoryAssessor] 启动三库流转调度器');

    this.schedule('sandToGold', MEMORY_CONFIG.sandToGold.intervalMs, () => this.runSandToGold());
    this.schedule('goldToDiamond', MEMORY_CONFIG.goldToDiamond.intervalMs, () => this.runGoldToDiamond());
    this.schedule('decay', MEMORY_CONFIG.decay.intervalMs, () => this.runDecay());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.started = false;
  }

  private schedule(name: string, interval: number, fn: () => Promise<void>): void {
    const tick = () => {
      fn().catch(err => console.warn(`[MemoryAssessor] ${name} 失败:`, err));
      this.timers.push(setTimeout(tick, interval));
    };
    this.timers.push(setTimeout(tick, Math.random() * 60000 + 5000));
  }

  // ── ① 砂金库→金库 ──

  private async runSandToGold(): Promise<void> {
    const cfg = MEMORY_CONFIG.sandToGold;
    let txOpened = false;
    try {
      const sqlite = this.storage.getSQLite();
      const recentConvs = sqlite.queryAll(
        `SELECT id, role, content, calcium_score, entity_names, dna_root_id, timestamp,
                perception_summary, topic, seq_pos, dialog_group_id, namespace
         FROM conversations
         WHERE is_promoted = 0 AND calcium_score >= ?
         ORDER BY calcium_score DESC LIMIT ?`,
        [cfg.minCalciumScore, cfg.batchSize]
      ) as any[];

      if (recentConvs.length === 0) {
        console.log('[MemoryAssessor] 砂金→金库: 无待晋升数据');
        return;
      }

      let promoted = 0;
      const promotedUuids: (string | null)[] = [];  // V13: 收集晋升条目的 UUID 用于 vault_log 标注
      let nextSeq = Number((sqlite.queryAll('SELECT COALESCE(MAX(seq_pos), 0) as max_seq FROM memories') as any[])?.[0]?.max_seq ?? 0) + 1;
      sqlite.writeRaw('BEGIN');
      txOpened = true;

      for (const conv of recentConvs) {
        if (conv.role !== 'user') continue;
        const text = (conv.content || '') as string;
        if (text.length < cfg.minContentLength) continue;

        const conversationId = Number(conv.id ?? 0);
        const dnaRootId = String(conv.dna_root_id || `sand_fallback_${conversationId || Date.now()}`);
        const calciumScore = Number(conv.calcium_score || 1.0);
        const memoryId = `mem_${dnaRootId.replace(/[^\w-]/g, '_')}_${conversationId || nextSeq}`;
        const perception = parseSandPerception(conv.perception_summary);
        // 🆕 V10.11: calcium_level 改用阈值映射（与 M3_CONFIG 一致），Math.floor(score) 对 0-2 范围会丢失精度
        const calciumLevel = (calciumScore >= 0.65 ? 3 : calciumScore >= 0.45 ? 2 : calciumScore >= 0.25 ? 1 : 0) as 0 | 1 | 2 | 3;
        const normalizedCalcium = clamp(calciumScore / MEMORY_CONFIG.recall.calciumMax, 0, 1);
        const narrativeTag = deriveNarrativeTag(text, conv.topic);
        const entityGenes = parseConversationEntities(conv.entity_names);
        const now = new Date().toISOString();
        const record: EmotionalMemoryRecord = {
          id: memoryId,
          seq_pos: nextSeq,
          created_at: String(conv.timestamp || now),
          dna_root_id: dnaRootId,
          // 🆕 编码健康修复: 从 conversations 继承规范 global_uid（conversations 有 DNAEncoder 生成的 23 字符 UID）
          global_uid: String(conv.global_uid || conv.globalUid || ''),
          thread_id: String(conv.dialog_group_id || dnaRootId || memoryId),
          session_id: null as any,
          dialog_group_id: conv.dialog_group_id ? String(conv.dialog_group_id) : undefined,
          source_conversation_ids: conversationId > 0 ? [conversationId] : [],
          perception,
          calcium_score: clamp(calciumScore, MEMORY_CONFIG.recall.calciumMin, MEMORY_CONFIG.recall.calciumMax),
          calcium_level: calciumLevel,
          raw_input: text.substring(0, 500),
          locus_path: narrativeTag ? `chat.promoted.${narrativeTag}` : 'chat.promoted',
          entity_genes: entityGenes,
          leaf_zone: 'spatiotemporal_episode_zone',
          memory_kind: 'episodic',
          lifecycle_state: calciumLevel >= 2 ? 'active' : 'candidate',
          confidence_score: 0.62,
          stability_score: calciumLevel >= 2 ? 0.48 : 0.24,
          last_verified_at: now,
          promotion_reason: 'sand_to_gold',
          suppression_reason: undefined,
          archived_at: null,
          healed_at: null,
          fg_entity_names: entityGenes.length > 0 ? entityGenes.map((gene) => gene.name).join(',') : undefined,
          // V13: 从 source conversation 继承 entity 归属
          belongEntityUuid: String(conv.belong_entity_uuid || conv.entity_uuid || null),
          primary_emotion: derivePrimaryEmotion(perception),
          recall_count: 0,
          last_recalled_at: null,
          reinforcement_accumulator: 0,
          effective_strength: Number(initialStrength(normalizedCalcium).toFixed(4)),
          strength_updated_at: now,
          is_landmark: false,
          landmarked_at: null,
          narrative_tag: narrativeTag,
          sensory_anchor: undefined,
          promoted_to_diamond: false,
          namespace: typeof conv.namespace === 'string' && conv.namespace.trim() ? conv.namespace.trim() : 'default',
        };

        try {
          // 幂等：已存在则跳过
          const exist = sqlite.queryAll('SELECT id FROM memories WHERE id = ? LIMIT 1', [memoryId]);
          if (exist.length > 0) continue;

          sqlite.write(record);
          sqlite.writeRaw('UPDATE conversations SET is_promoted = 1 WHERE id = ?', conv.id);
          promoted++;
          promotedUuids.push(record.belongEntityUuid || null);
          nextSeq++;
        } catch { /* 去重跳过 */ }
      }

      sqlite.writeRaw('COMMIT');
      txOpened = false;
      if (promoted > 0) {
        // V13: 收集晋升中的多数 UUID 作为归属
        const euuidCount = new Map<string, number>();
        for (const entry of promotedUuids) {
          if (entry) euuidCount.set(entry, (euuidCount.get(entry) || 0) + 1);
        }
        let majorityUuid: string | null = null;
        let maxCount = 0;
        for (const [uid, cnt] of euuidCount) {
          if (cnt > maxCount) { maxCount = cnt; majorityUuid = uid; }
        }
        logVaultOperation(sqlite, 'promote_sand', 'sand', undefined, undefined, `砂金晋升金库 ${promoted} 条`, undefined, majorityUuid);
        console.log(`[MemoryAssessor] 砂金→金库: ${promoted} 条 (calcium>=${cfg.minCalciumScore}, UUID=${majorityUuid || 'none'})`);
      }
    } catch (err) {
      if (txOpened) {
        try { this.storage.getSQLite().writeRaw('ROLLBACK'); } catch { /* rollback best effort */ }
      }
      console.warn('[MemoryAssessor] 砂金→金库失败:', err);
    }
  }

  // ── ② 金库→黑钻 ──

  private async runGoldToDiamond(): Promise<void> {
    try {
      const sqlite = this.storage.getSQLite();
      const entries = autoPromoteCandidatesV2(sqlite, MEMORY_CONFIG.goldToDiamond.batchSize);
      if (entries.length > 0) {
        console.log(`[MemoryAssessor] 金库→黑钻: ${entries.length} 条`);
        // V11.0: 增量n-gram索引写入
        try {
          const { indexDocument } = await import('../../m4/SearchIndexBuilder.js');
          for (const entry of entries) {
            const summary = entry?.summary || entry?.notes || '';
            if (summary.length > 5) {
              indexDocument(sqlite.rawDb || sqlite, 'black_diamond', String(entry.id || ''), summary);
            }
          }
        } catch { /* 索引写入不阻塞 */ }
      }
    } catch (err) {
      console.warn('[MemoryAssessor] 金库→黑钻失败:', err);
    }
  }

  // ── ③ 钙化分衰减 ──
  // P2-1: 衰减速率按内容类别独立控制（不再按 calcium_score 分桶），
  //       calcium_score 专职晋升门槛和召回优先级。

  private async runDecay(): Promise<void> {
    const dc = MEMORY_CONFIG.decay;
    const rd = MEMORY_CONFIG.retentionDecay;
    try {
      const sqlite = this.storage.getSQLite();
      const now = new Date().toISOString();

      // 1. 被压制记忆 — 最高优先级，快速遗忘（不区分内容类别）
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(lifecycle_state, 'candidate') = 'suppressed'`,
        MEMORY_CONFIG.recall.calciumMin, rd.suppressed.decay,
        dc.strengthFloor, rd.suppressed.strengthFactor, now,
      );

      // 2. 情感/亲密类 — 极慢衰减
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(promoted_to_diamond, 0) = 0
         AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
         AND (COALESCE(narrative_tag, '') LIKE '%家庭%' OR COALESCE(narrative_tag, '') LIKE '%家人%'
              OR COALESCE(narrative_tag, '') LIKE '%情人%' OR COALESCE(narrative_tag, '') LIKE '%恋人%'
              OR COALESCE(narrative_tag, '') LIKE '%感情%' OR COALESCE(narrative_tag, '') LIKE '%恋爱%'
              OR COALESCE(narrative_tag, '') LIKE '%亲密%' OR COALESCE(narrative_tag, '') LIKE '%伴侣%'
              OR COALESCE(narrative_tag, '') LIKE '%怀旧%' OR COALESCE(narrative_tag, '') LIKE '%回忆%')`,
        MEMORY_CONFIG.recall.calciumMin, rd.emotional.decay,
        dc.strengthFloor, rd.emotional.strengthFactor, now,
      );

      // 3. 关系/社交类 (_narrative_tag 匹配朋友/同事/社交/邻居等）
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(promoted_to_diamond, 0) = 0
         AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
         AND (COALESCE(narrative_tag, '') LIKE '%朋友%' OR COALESCE(narrative_tag, '') LIKE '%同事%'
              OR COALESCE(narrative_tag, '') LIKE '%社交%' OR COALESCE(narrative_tag, '') LIKE '%邻居%'
              OR COALESCE(narrative_tag, '') LIKE '%关系%')`,
        MEMORY_CONFIG.recall.calciumMin, rd.relational.decay,
        dc.strengthFloor, rd.relational.strengthFactor, now,
      );

      // 4. 工作/项目类
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(promoted_to_diamond, 0) = 0
         AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
         AND (COALESCE(narrative_tag, '') LIKE '%工作%' OR COALESCE(narrative_tag, '') LIKE '%项目%'
              OR COALESCE(narrative_tag, '') LIKE '%公司%' OR COALESCE(narrative_tag, '') LIKE '%会议%')`,
        MEMORY_CONFIG.recall.calciumMin, rd.work.decay,
        dc.strengthFloor, rd.work.strengthFactor, now,
      );

      // 5. 活跃记忆 (无特殊标签的活跃态 — 避免覆盖内容分类)
      const noSpecialTag = `(COALESCE(narrative_tag, '') NOT LIKE '%家庭%' AND COALESCE(narrative_tag, '') NOT LIKE '%家人%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%情人%' AND COALESCE(narrative_tag, '') NOT LIKE '%恋人%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%感情%' AND COALESCE(narrative_tag, '') NOT LIKE '%恋爱%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%亲密%' AND COALESCE(narrative_tag, '') NOT LIKE '%伴侣%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%怀旧%' AND COALESCE(narrative_tag, '') NOT LIKE '%回忆%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%朋友%' AND COALESCE(narrative_tag, '') NOT LIKE '%同事%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%社交%' AND COALESCE(narrative_tag, '') NOT LIKE '%邻居%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%关系%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%工作%' AND COALESCE(narrative_tag, '') NOT LIKE '%项目%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%公司%' AND COALESCE(narrative_tag, '') NOT LIKE '%会议%')`;
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(promoted_to_diamond, 0) = 0
         AND COALESCE(lifecycle_state, 'candidate') = 'active'
         AND ${noSpecialTag}`,
        MEMORY_CONFIG.recall.calciumMin, rd.active.decay,
        dc.strengthFloor, rd.active.strengthFactor, now,
      );

      // 6. 中性/默认 — candidate/healed 且无特殊标签
      const neutralTag = `(COALESCE(narrative_tag, '') NOT LIKE '%家庭%' AND COALESCE(narrative_tag, '') NOT LIKE '%家人%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%情人%' AND COALESCE(narrative_tag, '') NOT LIKE '%恋人%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%感情%' AND COALESCE(narrative_tag, '') NOT LIKE '%恋爱%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%亲密%' AND COALESCE(narrative_tag, '') NOT LIKE '%伴侣%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%怀旧%' AND COALESCE(narrative_tag, '') NOT LIKE '%回忆%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%朋友%' AND COALESCE(narrative_tag, '') NOT LIKE '%同事%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%社交%' AND COALESCE(narrative_tag, '') NOT LIKE '%邻居%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%关系%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%工作%' AND COALESCE(narrative_tag, '') NOT LIKE '%项目%'
        AND COALESCE(narrative_tag, '') NOT LIKE '%公司%' AND COALESCE(narrative_tag, '') NOT LIKE '%会议%')`;
      sqlite.writeRaw(
        `UPDATE memories SET calcium_score = ROUND(MAX(?, calcium_score - ?), 1),
         effective_strength = ROUND(MAX(?, effective_strength * ?), 4),
         strength_updated_at = ?
         WHERE calcium_score > 0
         AND COALESCE(promoted_to_diamond, 0) = 0
         AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'healed')
         AND ${neutralTag}`,
        MEMORY_CONFIG.recall.calciumMin, rd.neutral.decay,
        dc.strengthFloor, rd.neutral.strengthFactor, now,
      );

      console.log('[MemoryAssessor] 钙化分衰减完成 (按内容类别)');
    } catch (err) {
      console.warn('[MemoryAssessor] 钙化分衰减失败:', err);
    }
  }

  async triggerSandToGold(): Promise<number> {
    await this.runSandToGold();
    const sqlite = this.storage.getSQLite();
    const count = sqlite.queryAll('SELECT COUNT(*) as c FROM memories') as any[];
    return count[0]?.c || 0;
  }

  async triggerGoldToDiamond(): Promise<number> {
    await this.runGoldToDiamond();
    const sqlite = this.storage.getSQLite();
    const count = sqlite.queryAll('SELECT COUNT(*) as c FROM black_diamond') as any[];
    return count[0]?.c || 0;
  }

  /** P0: 公开衰减触发器 — 供 HippocampusRhythmCoordinator 调度（原 runDecay private） */
  async triggerDecay(): Promise<number> {
    await this.runDecay();
    return 1;
  }
}
