/**
 * SceneSnapshotBuilder.ts — 场景快照封装中间层 (V3.2 / BIONIC-002 Phase B)
 * ========================================================================
 * 将 M4 检索碎片化输出 + 海马三突触回路 + 场景地图 + 情绪标签，
 * 封装为标准化 SceneSnapshot，作为海马体→前额叶的唯一数据契约。
 *
 * 这是海马时序域的输出层——所有流出海马的数据都经过此 Builder。
 *
 * 使用:
 *   const builder = new SceneSnapshotBuilder(sqlite);
 *   const snapshot = builder.build(materials);
 *   // snapshot 可直接交付 PrefrontalCortex.process()
 */

import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import type { DNA } from '../../../m1/types/dna.js';
import type { PerceptionState24 } from '../../../m3/types/perception.js';
import { HippocampalIndex } from './HippocampalIndex.js';
import { SceneMap } from './SceneMap.js';
import {
  type SceneSnapshot,
  type SceneSnapshotMaterials,
  type EmotionTrend,
  type NoveltyLevel,
  hourToTimeOfDay,
} from './types.js';
import { createHash } from 'node:crypto';

export class SceneSnapshotBuilder {
  private sqlite: SQLiteAdapter;
  private hIndex: HippocampalIndex;
  private sceneMap: SceneMap;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
    this.hIndex = new HippocampalIndex(sqlite);
    this.sceneMap = new SceneMap(sqlite);
  }

  /**
   * 从 M4 检索材料构建 SceneSnapshot。
   * 这是海马体唯一的输出入口。
   */
  build(materials: SceneSnapshotMaterials): SceneSnapshot {
    const {
      memories, m4Context, perception, sessionId, rawInput,
      entities, now: _now, locationFingerprint, hippocampalResult,
    } = materials;

    const now = _now ? new Date(_now) : new Date();
    const nowISO = now.toISOString();
    const dayOfWeek = now.getDay();
    const timeOfDay = hourToTimeOfDay(now.getHours());

    // ── 1. 上下文签名 ──
    const locusPath = m4Context.decision?.enhanced?.locus_path ?? 'root.unknown';
    const contextSignature = this._buildSignature(locusPath, entities, perception);

    // ── 2. 快照 ID ──
    const snapshotId = createHash('sha256')
      .update(`${contextSignature}|${sessionId}|${nowISO}`)
      .digest('hex')
      .substring(0, 12);

    // ── 3. 经验摘要 ──
    const experienceSummary = this._buildExperienceSummary(memories, m4Context);

    // ── 4. 情绪快照 ──
    const emotionTrend = this._deriveEmotionTrend(perception);
    const emotion = {
      pleasure: perception.pleasure ?? 0,
      arousal: perception.arousal ?? 0,
      intimacy: (perception as any).intimacy ?? 0.5,
      trend: emotionTrend,
    };

    // ── 5. 空间锚点（SceneMap） ──
    const spatial = this._buildSpatial(locationFingerprint, entities);

    // ── 6. 实体锚点 ──
    const entityAnchors = this._buildEntityAnchors(entities, rawInput, m4Context);

    // ── 7. 记忆指针 ──
    const memoryPointers = memories.map(m => m.branch_id || m.seq_pos?.toString() || '').filter(Boolean);

    // ── 8. 知识库 / FG 引用 ──
    const knowledgeRefs: string[] = [];
    const fgEventRefs: string[] = [];

    if (m4Context.family_context && m4Context.family_context.length > 0) {
      for (const fc of m4Context.family_context) {
        fgEventRefs.push(`${fc.entity}:${fc.relation}:${fc.related_entity}`);
      }
    }

    // ── 9. 钙化 ──
    const calciumScore = this._computeCalcium(memories, perception);

    // ── 10. 新颖性评估 ──
    const novelty = this._assessNovelty(memories, m4Context, hippocampalResult);

    // ── 11. 检索元数据 ──
    const retrievalMeta = m4Context.retrieval_quality
      ? {
          totalCandidates: m4Context.retrieval_quality.total_candidates,
          avgMatchScore: m4Context.retrieval_quality.avg_match_score,
          strategiesUsed: m4Context.retrieval_quality.strategies_used,
          dgDeduped: hippocampalResult?.dgDeduped ?? 0,
          ca3CompletedDimensions: hippocampalResult?.ca3CompletedDimensions ?? [],
          indexHit: hippocampalResult?.indexHit ?? false,
        }
      : undefined;

    // V4.0 Phase 5: 推送快照就绪事件到天权事件总线
    try { const _bus = (globalThis as any).__tianquanBus; if (_bus && typeof _bus.emit === "function") { _bus.emit({ type: "scene:snapshot_ready", traceId: snapshotId, timestamp: Date.now(), sessionId: sessionId || "", payload: { contextSignature, calciumScore, entityCount: entityAnchors.persons.length } }).catch(() => {}); } } catch { /* bus不可用 */ }
    return {
      snapshotId,
      contextSignature,
      temporal: { createdAt: nowISO, sessionId, timeOfDay, dayOfWeek },
      spatial,
      entities: entityAnchors,
      experienceSummary,
      emotion,
      memoryPointers,
      knowledgeRefs,
      fgEventRefs,
      calciumScore,
      novelty,
      retrievalMeta,
    };
  }

  // ─── 私有辅助 ───

  /** 构建上下文签名 */
  private _buildSignature(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    perception: PerceptionState24,
  ): string {
    return this.hIndex.computeSignature(locusPath, entities, perception);
  }

  /** 构建经验摘要（≤200 tokens，用于 θ 节律快速注入 LLM） */
  private _buildExperienceSummary(memories: DNA[], m4Context: any): string {
    const parts: string[] = [];

    // 从记忆提取摘要
    if (memories.length > 0) {
      const topMemories = memories.slice(0, 3);
      const summaries = topMemories
        .map(m => {
          const raw = m.raw_input || '';
          return raw.length > 60 ? raw.substring(0, 60) + '…' : raw;
        })
        .filter(Boolean);
      if (summaries.length > 0) {
        parts.push(summaries.join(' | '));
      }
    }

    // 从 FG 摘要提取
    const fs = m4Context?.memory_summary;
    if (fs && fs.timeline && fs.timeline.length > 0) {
      const recent = fs.timeline.slice(0, 2).map((t: any) => t.summary).filter(Boolean);
      if (recent.length > 0) {
        parts.push(recent.join(' | '));
      }
    }

    // 限 200 字符（约等于 200 tokens 的中文）
    let result = parts.join('。');
    if (result.length > 200) {
      result = result.substring(0, 197) + '…';
    }
    return result || '(无相关经验)';
  }

  /** 情绪趋势 */
  private _deriveEmotionTrend(perception: PerceptionState24): EmotionTrend {
    // 简化处理：如果有 arousal 漂移标记则使用，否则默认 stable
    const drift = (perception as any).emotion_drift;
    if (typeof drift === 'number') {
      if (drift > 0.1) return 'rising';
      if (drift < -0.1) return 'falling';
    }
    return 'stable';
  }

  /** 空间锚点 */
  private _buildSpatial(
    locationFingerprint?: string,
    entities?: Array<{ name: string; type: string }>,
  ): SceneSnapshot['spatial'] {
    if (locationFingerprint) {
      try {
        const sceneHash = createHash('sha256').update(locationFingerprint).digest('hex').substring(0, 10);
        const existing = this.sceneMap.queryByScene(sceneHash);
        return {
          sceneLabel: existing?.sceneLabel ?? `场景簇_${sceneHash}`,
          locationHash: sceneHash,
        };
      } catch {
        // SceneMap 查询失败，降级处理
      }
    }
    // 无位置指纹时用空标签
    return { sceneLabel: '未知场景' };
  }

  /** 实体锚点 */
  private _buildEntityAnchors(
    entities: Array<{ name: string; type: string }>,
    rawInput: string,
    m4Context: any,
  ): SceneSnapshot['entities'] {
    const persons = entities.filter(e => e.type === 'person' && e.name !== '我').map(e => e.name);
    // 从 raw_input 简单提取关键词作为 topics（后续可接 NLP 分词）
    const topicWords = rawInput
      ? rawInput.replace(/[，。！？、\s]+/g, ' ').split(' ').filter(w => w.length >= 2 && w.length <= 6).slice(0, 5)
      : [];
    // 从 FG 摘要提取频繁实体作为 objects 补充
    const objects: string[] = [];
    if (m4Context?.memory_summary?.frequentEntities) {
      for (const fe of m4Context.memory_summary.frequentEntities) {
        if (fe.type === 'object' || fe.type === 'location') {
          objects.push(fe.name);
        }
      }
    }

    return { persons, topics: topicWords, objects: objects.slice(0, 5) };
  }

  /** 钙化分数 */
  private _computeCalcium(memories: DNA[], perception: PerceptionState24): number {
    if (memories.length === 0) return 0;
    // 取 TOP-3 记忆的钙化均值
    const top = memories.slice(0, 3);
    const avg = top.reduce((sum, m) => sum + (m.calcium_score ?? 0), 0) / top.length;
    return Math.round(avg * 100) / 100;
  }

  /** 新颖性评估 */
  private _assessNovelty(
    memories: DNA[],
    m4Context: any,
    hippocampalResult?: SceneSnapshotMaterials['hippocampalResult'],
  ): SceneSnapshot['novelty'] {
    const totalCandidates = m4Context?.retrieval_quality?.total_candidates ?? 0;
    const avgScore = m4Context?.retrieval_quality?.avg_match_score ?? 0;
    const indexHit = hippocampalResult?.indexHit ?? false;

    let level: NoveltyLevel = 'routine';
    let similarity = 0.5;
    let multiplier = 1.0;

    if (totalCandidates === 0 || memories.length === 0) {
      // 完全无记忆 → 新颖
      level = 'novel';
      similarity = 0.0;
      multiplier = 1.5;
    } else if (indexHit && avgScore > 0.7) {
      // 索引命中且高分 → 熟悉
      level = 'familiar';
      similarity = avgScore;
      multiplier = 0.8;
    } else if (avgScore > 0.5) {
      level = 'familiar';
      similarity = avgScore;
      multiplier = 0.9;
    } else {
      level = 'routine';
      similarity = avgScore;
      multiplier = 1.0;
    }

    return { level, similarity, multiplier };
  }

  /**
   * 附加情绪调节建议（由 EmotionRegulator 生成后注入）
   * 在 build() 之后可选调用此方法补充快照
   */
  attachEmotionRegulation(
    snapshot: SceneSnapshot,
    regulation: {
      suggestedShift: { pleasure: number; arousal: number; intimacy: number };
      confidence: number;
      basis: string;
      shouldSoothe: boolean;
    },
  ): SceneSnapshot {
    snapshot.emotionRegulation = regulation;
    return snapshot;
  }
}
