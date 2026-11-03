/**
 * MemArch-v2.0.0 / M2-OnlineWrite / MemoryWriter
 *
 * 在线写入主编排器（对外唯一入口）
 *
 * 写入时序（8 步，严格遵循 §4.1）：
 *   ① 消息到达
 *   ② L1 原文同步落盘（conversations）—— 永远第一步
 *   ③ L0 编码：在线显著性计算（规则版）
 *   ④ 写入 wm_buffer（持久化，崩溃可恢复）
 *   ⑤ 事件分割器：判断是否切分 episode
 *   ⑥ 三岔门控判定
 *   ⑦ 前瞻记忆抽取
 *   ⑧ 写入 L3 痕迹（WRITE 门控时）
 *
 * 性能目标：在线写入 p95 ≤ 30ms（不含异步向量化）
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { WriteQueue } from '../storage/write_queue/WriteQueue.js';
import { M2_CONFIG } from './config.js';
import type {
  WorkingEntry,
  WriteMessageInput,
  WriteResult,
  Gate,
  TurnFeat,
  ProspectiveItem,
  WriteHooks,
} from './types.js';
import { SalienceCalculator } from './SalienceCalculator.js';
import { EventSegmenter } from './EventSegmenter.js';
import { GateDecider } from './Gate.js';
import { WorkingMemory } from './WorkingMemory.js';
import { ProspectiveExtractor } from './ProspectiveExtractor.js';

export class MemoryWriter {
  private readonly writer: WriteQueue;
  private readonly salienceCalc: SalienceCalculator;
  private readonly segmenter: EventSegmenter;
  private readonly gateDecider: GateDecider;
  private readonly workingMem: WorkingMemory;
  private readonly prospectiveExtractor: ProspectiveExtractor;

  // 当前 episode 上下文（内存态，崩溃后从 DB 恢复）
  private currentEpisodeId: string | null = null;
  private episodeHistory: TurnFeat[] = [];

  // 幂等性追踪：message_id → 已处理结果
  private processedMessages = new Map<string, WriteResult>();

  // 门控分布统计（Harness 监控用）
  private gateStats = { write: 0, rawOnly: 0, discard: 0 };

  private hooks: WriteHooks = {};

  constructor(private readonly db: Database.Database) {
    this.writer = new WriteQueue(db);
    this.salienceCalc = new SalienceCalculator();
    this.segmenter = new EventSegmenter();
    this.gateDecider = new GateDecider();
    this.workingMem = new WorkingMemory(db, this.writer);
    this.prospectiveExtractor = new ProspectiveExtractor(this.writer);

    // 注入崩溃恢复处理器：恢复时重新执行门控 + 写入逻辑
    this.workingMem.setRecoverHandler(async (entry, bufferId) => {
      // 重新计算门控
      const gate = this.gateDecider.decide(entry);
      if (gate === 'WRITE') {
        await this.writeTrace(entry);
      } else if (gate === 'RAW_ONLY') {
        await this.writer.enqueue((db) => {
          db.prepare(
            `UPDATE conversations SET lifecycle_state = 'raw_only' WHERE message_id = ?`
          ).run(entry.message_id);
        }, 'high');
      }
      this.workingMem.markDone(bufferId, gate);
    });
  }

  /**
   * 注入钩子（加固后预留外接点）
   */
  setHooks(hooks: WriteHooks): void {
    this.hooks = hooks;
  }

  /**
   * 进程启动时恢复未处理条目
   */
  async recover(): Promise<{ recovered: number; failed: number }> {
    // 恢复当前 episode 状态（从 DB 查最近 open 的 episode）
    this.restoreCurrentEpisode();
    return this.workingMem.recover();
  }

  /**
   * 对外唯一写入入口
   * 严格遵循 §4.1 写入时序，保证 p95 ≤ 30ms
   */
  async write(input: WriteMessageInput): Promise<WriteResult> {
    const start = performance.now();

    // ===== 参数校验（加固红线） =====
    if (!input.message_id || !input.role || !input.content) {
      throw new Error('MemoryWriter.write: message_id / role / content are required');
    }

    // ===== 幂等性检查 =====
    if (this.processedMessages.has(input.message_id)) {
      return this.processedMessages.get(input.message_id)!;
    }

    const tsUtc = input.ts_utc ?? Date.now();
    const namespace = input.namespace ?? 'default';

    // ===== 步骤 ②：L1 原文同步落盘（永远第一步，先于一切计算） =====
    const conversationId = await this.writer.writeConversation({
      message_id: input.message_id,
      namespace,
      roleplay_char: input.roleplay_char,
      role: input.role,
      content: input.content,
      ts_utc: tsUtc,
      episode_id: this.currentEpisodeId ?? undefined,
      sensitivity: input.sensitivity ?? 0,
    });

    // ===== 步骤 ③：L0 编码 —— 在线显著性计算（规则版） =====
    const partialEntry: WorkingEntry = {
      message_id: input.message_id,
      namespace,
      role: input.role,
      content: input.content,
      ts_utc: tsUtc,
      arousal: input.arousal,
      semantic_embedding: input.semantic_embedding,
    };

    const { salience, components } = this.salienceCalc.calculate(partialEntry);
    partialEntry.salience = salience;
    partialEntry.salience_components = components;
    partialEntry.has_meaningful_entity = this.detectMeaningfulEntity(input.content);

    // ===== 步骤 ⑤：事件分割（在门控之前，因为需要决定 episode_id） =====
    const turnFeat: TurnFeat = {
      ts: tsUtc,
      text: input.content,
      emb: input.semantic_embedding,
      arousal: input.arousal ?? 0.3,
    };

    const segResult = this.segmenter.isBoundary(this.episodeHistory, turnFeat);

    if (segResult.is_boundary) {
      // 切分：创建新 episode
      this.currentEpisodeId = this.createNewEpisode(namespace, tsUtc);
      this.episodeHistory = [];
    }

    partialEntry.episode_id = this.currentEpisodeId ?? undefined;
    this.episodeHistory.push(turnFeat);

    // ===== 步骤 ⑥：三岔门控判定 =====
    const gate = this.gateDecider.decide(partialEntry);
    this.gateStats[{ WRITE: 'write', RAW_ONLY: 'rawOnly', DISCARD: 'discard' }[gate] as keyof typeof this.gateStats]++;

    // ===== 步骤 ④：写入 wm_buffer（持久化，崩溃可恢复） =====
    const bufferId = await this.workingMem.push(partialEntry);

    // ===== 步骤 ⑧：WRITE 门控 → 写 L3 痕迹 =====
    let traceId: string | undefined;
    if (gate === 'WRITE') {
      traceId = await this.writeTrace(partialEntry);
    } else if (gate === 'RAW_ONLY') {
      // 标记 conversation 为 raw_only
      await this.writer.enqueue((db) => {
        db.prepare(
          `UPDATE conversations SET lifecycle_state = 'raw_only' WHERE message_id = ?`
        ).run(input.message_id);
      }, 'high');
    }

    // 更新 wm_buffer 状态
    this.workingMem.markDone(bufferId, gate);

    // ===== 步骤 ⑦：前瞻记忆抽取 =====
    const prospectiveItems = this.prospectiveExtractor.extract(
      input.content,
      input.message_id,
      input.role === 'user' ? 'user' : 'assistant',
    );
    if (prospectiveItems.length > 0) {
      await this.prospectiveExtractor.persist(prospectiveItems, namespace);
    }

    // ===== 组装结果 =====
    const latencyMs = performance.now() - start;
    const result: WriteResult = {
      conversation_id: conversationId,
      gate,
      salience,
      episode_id: this.currentEpisodeId ?? undefined,
      trace_id: traceId,
      prospective_items: prospectiveItems,
      segmentation: segResult,
      latency_ms: latencyMs,
    };

    // 幂等缓存（内存中保留，防止同消息重复推送）
    this.processedMessages.set(input.message_id, result);
    // 防止内存无限增长：超过 1000 条时清理最早的
    if (this.processedMessages.size > 1000) {
      const firstKey = this.processedMessages.keys().next().value;
      this.processedMessages.delete(firstKey);
    }

    // 触发钩子
    this.hooks.onMessageWritten?.(result);
    this.hooks.onGateDecision?.(partialEntry, gate, salience);

    return result;
  }

  /**
   * 写 L3 痕迹（WRITE 门控时调用）
   * c₀ = κ · S（初始巩固度）
   */
  private async writeTrace(entry: WorkingEntry): Promise<string> {
    const traceId = `tr_${randomUUID().replace(/-/g, '')}`;
    const c0 = M2_CONFIG.encoding.kappa * (entry.salience ?? 0.5);

    await this.writer.writeTrace({
      id: traceId,
      namespace: entry.namespace,
      raw_input: entry.content,
      summary: entry.content.slice(0, 100),  // 在线阶段先用截断原文，M3 睡眠期生成摘要
      episode_id: entry.episode_id,
      sensitivity: 0,
      created_at: entry.ts_utc,
    });

    // 补充写入 salience 等字段（writeTrace 基础字段后补充）
    await this.writer.enqueue((db) => {
      db.prepare(`
        UPDATE memories SET
          salience = ?,
          arousal = ?,
          self_relevance = ?,
          consolidation = ?,
          lifecycle_state = 'fresh',
          lifecycle_changed_at = ?,
          first_ref_at = ?,
          last_reinforced_at = ?
        WHERE id = ?
      `).run(
        entry.salience ?? 0.5,
        entry.arousal ?? 0.3,
        entry.salience_components?.self_rule ?? 0,
        c0,
        entry.ts_utc,
        entry.ts_utc,
        entry.ts_utc,
        traceId,
      );
    }, 'high');

    return traceId;
  }

  /**
   * 创建新 episode（写入 episodes 表）
   */
  private createNewEpisode(namespace: string, tsUtc: number): string {
    const episodeId = `ep_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.db.prepare(`
      INSERT INTO episodes (id, namespace, started_at, status, consolidation, lifecycle_state)
      VALUES (?, ?, ?, 'open', 0, 'fresh')
    `).run(episodeId, namespace, tsUtc);
    return episodeId;
  }

  /**
   * 从 DB 恢复当前 episode 状态（崩溃恢复后调用）
   */
  private restoreCurrentEpisode(): void {
    const row = this.db.prepare(`
      SELECT id FROM episodes WHERE status = 'open' ORDER BY started_at DESC LIMIT 1
    `).get() as { id: string } | undefined;

    if (row) {
      this.currentEpisodeId = row.id;
      // 加载最近历史（最多 10 轮，用于事件分割上下文）
      const convos = this.db.prepare(`
        SELECT ts_utc, content FROM conversations
        WHERE episode_id = ? ORDER BY ts_utc DESC LIMIT 10
      `).all(row.id) as Array<{ ts_utc: number; content: string }>;
      this.episodeHistory = convos.reverse().map(c => ({
        ts: c.ts_utc,
        text: c.content,
        arousal: 0.3,  // 恢复时默认值
      }));
    }
  }

  /**
   * 简单实体检测（完整版由 M3 实体抽取器提供）
   */
  private detectMeaningfulEntity(text: string): boolean {
    if (/[\u4e00-\u9fa5]{2,4}(先生|女士|老师|总|哥|姐)/.test(text)) return true;
    if (/(北京|上海|广州|深圳|杭州|东莞|公司|工厂|学校|大学)/.test(text)) return true;
    if (text.length >= 20) return true;  // 长文本默认有实体
    return false;
  }

  /**
   * 获取门控分布统计（Harness 监控用）
   */
  getGateStats(): { write: number; rawOnly: number; discard: number; total: number } {
    const total = this.gateStats.write + this.gateStats.rawOnly + this.gateStats.discard;
    return { ...this.gateStats, total };
  }

  /**
   * 获取 M2 → M3 接口：待复评的 RAW_ONLY 消息
   */
  async getRawOnlyPending(limit: number = 50): Promise<Array<{
    conversation_id: string;
    content: string;
    episode_id: string;
    context: string;
  }>> {
    const rows = this.db.prepare(`
      SELECT c.id, c.message_id, c.content, c.episode_id, e.gist
      FROM conversations c
      LEFT JOIN episodes e ON c.episode_id = e.id
      WHERE c.lifecycle_state = 'raw_only' AND c.namespace = 'default'
      ORDER BY c.ts_utc ASC LIMIT ?
    `).all(limit) as Array<{
      id: number; message_id: string; content: string; episode_id: string; gist: string | null;
    }>;

    return rows.map(r => ({
      conversation_id: r.message_id,
      content: r.content,
      episode_id: r.episode_id,
      context: r.gist ?? '',
    }));
  }

  /**
   * M2 → M3 接口：复评后补写痕迹
   */
  async reevaluateRawOnly(conversationId: string, decision: 'write' | 'discard'): Promise<void> {
    const convo = this.db.prepare(`
      SELECT * FROM conversations WHERE message_id = ?
    `).get(conversationId) as any;

    if (!convo) return;

    if (decision === 'write') {
      // 补写 L3 痕迹
      const entry: WorkingEntry = {
        message_id: convo.message_id,
        namespace: convo.namespace,
        role: convo.role,
        content: convo.content,
        ts_utc: convo.ts_utc,
        episode_id: convo.episode_id,
        salience: 0.5,  // 复评时由 LLM 重新计算，此处默认
      };
      await this.writeTrace(entry);
      await this.writer.enqueue((db) => {
        db.prepare(
          `UPDATE conversations SET lifecycle_state = 'fresh' WHERE message_id = ?`
        ).run(conversationId);
      }, 'high');
    } else {
      // 标记为 discarded（保留原文，但不再复评）
      await this.writer.enqueue((db) => {
        db.prepare(
          `UPDATE conversations SET lifecycle_state = 'expiring' WHERE message_id = ?`
        ).run(conversationId);
      }, 'high');
    }
  }

  /**
   * 定时清理（供外部定时器调用）
   */
  async sweep(): Promise<void> {
    await this.workingMem.sweep();
  }
}
