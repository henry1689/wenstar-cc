/**
 * FusionStorageAdapter — 统一存储适配器
 *
 * 双写策略：SQLite（主存储，检索/排序/计算） + JSON Zone（人类可读备份）
 * 读取时优先走 SQLite。
 *
 * 取代旧的 JsonStorageAdapter。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
// C3(2026-09-11): 实体名序列化收口到 EntityNameCodec（唯一事实源）
import { formatNames } from './EntityNameCodec.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DNA, LeafZone } from '../m1/types/dna.js';
import type { Perception24D } from '../m3/types/perception.js';
import type { WriteResult, ReadResult, QueryOptions, StorageStatus } from './types/index.js';
import { SQLiteAdapter } from './SQLiteAdapter.js';
import { computeCalcium, initialStrength } from './math.js';
import type { EmotionalMemoryRecord, RetrievalQuery, ScoredMemory, EmotionalLandscape } from './types/index.js';
import { FAMILY_GRAPH_MIGRATION } from '../config/family-graph-migration.js';
import { ConversationDB } from './ConversationDB.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

export class FusionStorageAdapter {
  private sqlite: SQLiteAdapter;
  private dataDir: string;
  private seqCounter = 0;
  private initialized = false;
  /** 家族图谱主库引用（双库统一用） */
  private familyGraph: any | null = null;
  /** 共享 ConversationDB 实例（三段存储③砂金库） */
  private _conversationDB: any = null;
  /** P10: JSON Zone 备份开关（默认开启保持兼容，生产环境可关闭减少IO） */
  private enableJsonZone: boolean;
  /** 当前时空上下文（由 chat.ts 每轮注入） */
  private temporalContext: { period?: string; season?: string; lunarTerm?: string } = {};

  constructor(dataDir?: string, options?: { enableJsonZone?: boolean }) {
    this.dataDir = dataDir ?? join(PROJECT_ROOT, 'data', 'webui');
    this.enableJsonZone = options?.enableJsonZone ?? true;
    this.sqlite = new SQLiteAdapter(join(this.dataDir, 'fusion_memory.db'));
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    await this.sqlite.initialize();
    // 初始化共享 ConversationDB（使用同一个 sql.js 实例）
    // C4: 传递真实路径 + 落盘协调器 — 共享 db 的落盘委托给 SQLiteAdapter 统一 export（防抖合并，避免重复导出 96MB 库）
    this._conversationDB = new ConversationDB(
      join(this.dataDir, 'fusion_memory.db'),
      this.sqlite.getDb(),
      () => this.sqlite.scheduleFlush(),
    );
    await this._conversationDB.initialize();
    this.seqCounter = this.sqlite.getTotalCount();
    this.initialized = true;
  }

  // ─── 写入（接收 DNA + 24D 感知向量） ───

  /** 预分配下一个 seq_pos（不写入，由 WorkingMemory 负责实际写入） */
  reserveNextSeq(): number {
    this.ensureReady();
    // 🔴 P1.5 修复: 每轮对话预分配 2 个 seq（user + assistant）。
    // 原 seqCounter++ 每轮 +1 → 下一轮 user 的 seq = 上一轮 assistant 的 seqPos+1 →
    // 与 memories.seq_pos UNIQUE 冲突 → INSERT OR REPLACE 覆盖上一轮 assistant 记忆
    // （实测会晤/私聊 assistant 回复记忆全部丢失，同 seq 多行数 = 0 印证）。
    // 改为 +2: user=N+1, asst=N+2, 下轮 user=N+3 —— user/asst seq 全局唯一。
    const pos = this.seqCounter + 1;
    this.seqCounter += 2;
    return pos;
  }

  async write(dna: DNA, perception: Perception24D, primaryEmotion?: string, secondaryEmotions?: string[]): Promise<WriteResult> {
    this.ensureReady();
    // 优先用 dna.seq_pos（预分配），否则自增
    const pos = dna.seq_pos > 0 ? dna.seq_pos : (this.seqCounter + 1);
    if (dna.seq_pos <= 0) this.seqCounter++;
    else this.seqCounter = Math.max(this.seqCounter, dna.seq_pos);

    const calcium = computeCalcium(perception);
    const now = new Date().toISOString();
    const strength = initialStrength(calcium.score);
    // P0-4: 钙化分边界强制校验
    const clampedScore = Math.max(0, Math.min(10, calcium.score));

    // P0-1: 提取FG实体名列表 + V13: 解析归属UUID
    let fgNames: string | undefined;
    let belongEntityUuid: string | null = null;
    if (this.familyGraph) {
      try {
        const personNames = (dna.entity_genes || [])
          .filter((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1)
          .map((g: any) => g.name);
        if (personNames.length > 0) {
          // C3(2026-09-11): 序列化格式收口到 EntityNameCodec.formatNames
          fgNames = formatNames(personNames);
          // V13: 取第一个有UUID的实体作为归属
          for (const name of personNames) {
            try {
              const uuid = this.familyGraph.getUUIDByName(name);
              if (uuid) { belongEntityUuid = uuid; break; }
            } catch {}
          }
        }
      } catch { /* FG 不可用时不阻塞写入 */ }
    }

    const record: EmotionalMemoryRecord = {
      id: dna.branch_id,
      seq_pos: pos,
      created_at: now,
      dna_root_id: (dna as any).dna_root_id,
      // 🆕 编码健康修复: 透传 global_uid（否则 SQLiteAdapter.write() 里 || fallback 生成 MM+hash8 垃圾 UID）
      global_uid: (dna as any).global_uid,
      thread_id: (dna as any).dialog_group_id ?? (dna as any).dna_root_id ?? dna.branch_id,
      session_id: (dna as any).session_id ?? undefined,
      dialog_group_id: (dna as any).dialog_group_id,
      source_conversation_ids: [],
      perception,
      calcium_score: clampedScore,
      calcium_level: calcium.level,
      raw_input: dna.raw_input,
      locus_path: dna.locus_path,
      entity_genes: dna.entity_genes,
      leaf_zone: dna.leaf_zone,
      memory_kind: 'episodic',
      lifecycle_state: calcium.level >= 2 ? 'active' : 'candidate',
      confidence_score: 0.55,
      stability_score: calcium.level >= 2 ? 0.45 : 0.2,
      last_verified_at: null,
      promotion_reason: undefined,
      suppression_reason: undefined,
      archived_at: null,
      healed_at: null,
      primary_emotion: primaryEmotion,
      secondary_emotions: secondaryEmotions,
      recall_count: 0,
      last_recalled_at: null,
      reinforcement_accumulator: 0,
      effective_strength: strength,
      strength_updated_at: now,
      is_landmark: false,
      landmarked_at: null,
      // P0-1: 时空标签（由 chat.ts 每轮通过 setTemporalContext 注入）
      fg_entity_names: fgNames,
      // V13: 实体归属
      belongEntityUuid,
      time_period: this.temporalContext.period,
      season: this.temporalContext.season,
      lunar_term: this.temporalContext.lunarTerm,
    };

    // SQLite 写入（主存储）
    this.sqlite.write(record);

    // JSON Zone 写入（备份）— P10: 可关闭
    if (this.enableJsonZone) {
      this.appendToJsonZone(dna, perception);
    }

    return {
      success: true,
      real_ref: `seq_${String(pos).padStart(6, '0')}`,
      seq_pos: pos,
    };
  }

  // ─── 读取兼容接口 ───

  async read(branchId: string): Promise<ReadResult> {
    this.ensureReady();
    const record = this.sqlite.findById(branchId);
    if (!record) return { dna: null };
    return { dna: this.toDNA(record) };
  }

  async findByLocus(locusPath: string, options?: QueryOptions): Promise<DNA[]> {
    this.ensureReady();
    const records = this.sqlite.findByLocusWithStrength(locusPath, options?.limit ?? 20, 0.05, options?.entityUuids);
    return records.map(r => this.toDNA(r));
  }

  async findBySeqPosRange(start: number, end: number, options?: QueryOptions): Promise<DNA[]> {
    this.ensureReady();
    const records = this.sqlite.findBySeqPosRangeWithStrength(start, end, options?.limit ?? 50, 0.05, options?.entityUuids);
    return records.map(r => this.toDNA(r));
  }

  /** 带衰减门控的范围检索 */
  async findBySeqPosRangeFiltered(start: number, end: number, options?: QueryOptions & { minStrength?: number }): Promise<DNA[]> {
    this.ensureReady();
    const records = this.sqlite.findBySeqPosRangeWithStrength(start, end, options?.limit ?? 50, options?.minStrength ?? 0.05, options?.entityUuids);
    return records.map(r => this.toDNA(r));
  }

  /** 带衰减门控的话题检索 */
  async findByLocusFiltered(locusPath: string, options?: QueryOptions & { minStrength?: number }): Promise<DNA[]> {
    this.ensureReady();
    const records = this.sqlite.findByLocusWithStrength(locusPath, options?.limit ?? 20, options?.minStrength ?? 0.05, options?.entityUuids);
    return records.map(r => this.toDNA(r));
  }

  /** 获取衰减日志摘要 */
  getDecayStats(): { avgStrength: number; strongCount: number; weakCount: number } {
    const all = this.sqlite.findBySeqPosRange(0, 999_999_999, 200);
    if (all.length === 0) return { avgStrength: 0, strongCount: 0, weakCount: 0 };
    const avg = all.reduce((s, r) => s + r.effective_strength, 0) / all.length;
    return {
      avgStrength: Math.round(avg * 100) / 100,
      strongCount: all.filter(r => r.effective_strength > 0.5).length,
      weakCount: all.filter(r => r.effective_strength < 0.1).length,
    };
  }

  // ─── 新增：情感检索 ───

  findByEmotionalSimilarity(query: RetrievalQuery): ScoredMemory[] {
    this.ensureReady();
    return this.sqlite.findByEmotionalSimilarity(query);
  }

  updateRecall(memoryIds: string[]): void {
    this.ensureReady();
    this.sqlite.updateRecall(memoryIds);
  }

  applyReinforcement(perception: Perception24D, calcium: number, memoryIds: string[]): void {
    this.ensureReady();
    this.sqlite.applyReinforcement(perception, calcium, memoryIds);
  }

  getEmotionalLandscape(): EmotionalLandscape {
    this.ensureReady();
    return this.sqlite.getEmotionalLandscape();
  }

  promoteToLandmark(memoryId: string, narrativeTag?: string, sensoryAnchor?: string): boolean {
    this.ensureReady();
    const ok = this.sqlite.promoteToLandmark(memoryId, narrativeTag, sensoryAnchor);
    if (!ok) return false;
    const record = this.sqlite.findById(memoryId);
    if (!record) return true;
    record.lifecycle_state = 'promoted';
    record.promotion_reason = narrativeTag ?? 'landmark_promotion';
    record.last_verified_at = new Date().toISOString();
    this.sqlite.write(record);
    return true;
  }

  markScar(memoryId: string, scarType: string): boolean {
    this.ensureReady();
    const record = this.sqlite.findById(memoryId);
    if (!record || record.is_landmark) return false;
    record.scar = { type: scarType as any, healed: false, healed_at: null };
    record.lifecycle_state = 'suppressed';
    record.suppression_reason = scarType;
    this.sqlite.write(record);
    return true;
  }

  /** 愈合疤痕（用户原谅/时间衰减/正面回忆 → 标记愈合） */
  healScar(memoryId: string, healedBy: string): boolean {
    this.ensureReady();
    const record = this.sqlite.findById(memoryId);
    if (!record || !record.scar) return false;
    record.scar.healed = true;
    record.scar.healed_at = new Date().toISOString();
    record.lifecycle_state = 'healed';
    record.healed_at = record.scar.healed_at;
    record.last_verified_at = record.scar.healed_at;
    record.suppression_reason = undefined;
    this.sqlite.write(record);
    return true;
  }

  /** 更新已存在记忆的 VAD 谱曲 */
  updateVadSpectrum(memoryId: string, vad: any): boolean {
    this.ensureReady();
    return this.sqlite.updateVadSpectrum(memoryId, vad);
  }

  /** 实体重叠 → 关联知识检索 */
  findKnowledgeByEntityOverlap(entityNames: string[], limit = 5) {
    this.ensureReady();
    return this.sqlite.findKnowledgeByEntityOverlap(entityNames, limit);
  }

  runDecayMaintenance(): { total: number; archived: number } {
    this.ensureReady();
    return this.sqlite.runDecayMaintenance();
  }

  // ─── 实体关系检索（双库统一路由） ───

  /**
   * 查找关联实体（双库统一路由）
   * - shadow 模式：仅从 entity_relations（影子库）读取
   * - compat 模式：影子库 + FamilyGraph 合并
   * - main 模式：先查 FamilyGraph，不足时回退影子库
   */
  findRelatedEntities(entityNames: string[], minStrength = 0.3) {
    const oldResult = this.sqlite.findRelatedEntities(entityNames, minStrength);

    if (this.familyGraph && FAMILY_GRAPH_MIGRATION.readMode !== 'shadow') {
      try {
        const fgResult = this.familyGraph.getRelatedPersonsBatch(entityNames, minStrength);
        if (fgResult.length > 0) {
          // 合并：FamilyGraph 数据优先（覆盖同名条目），其余用影子库补足
          const fgNames = new Set(fgResult.map((r: any) => r.name));
          const merged = [...fgResult, ...oldResult.filter((r: any) => !fgNames.has(r.name))];
          return merged;
        }
      } catch (e) {
        console.warn('[FG-Mig] FamilyGraph 读取失败，回退影子库:', (e as Error).message);
      }
    }

    return oldResult;
  }

  /**
   * N跳关联实体检索（双库统一路由）
   */
  findRelatedEntitiesN(entityNames: string[], maxHops: 1|2|3 = 1, minStrength = 0.3, maxAgeDays?: number) {
    const oldResult = this.sqlite.findRelatedEntitiesN(entityNames, maxHops, minStrength, maxAgeDays);

    if (this.familyGraph && FAMILY_GRAPH_MIGRATION.readMode !== 'shadow') {
      try {
        const fgResult = this.familyGraph.getRelatedPersonsN(entityNames, maxHops, minStrength);
        if (fgResult.length > 0) {
          const fgNames = new Set(fgResult.map((r: any) => r.name));
          const merged = [...fgResult, ...oldResult.filter((r: any) => !fgNames.has(r.name))];
          return merged.sort((a: any, b: any) => (b.strength || 0) - (a.strength || 0)).slice(0, 15);
        }
      } catch (e) {
        console.warn('[FG-Mig] FamilyGraph N跳读取失败:', (e as Error).message);
      }
    }

    return oldResult;
  }

  findMemoriesByEntityNames(entityNames: string[], limit = 10) {
    return this.sqlite.findMemoriesByEntityNames(entityNames, limit);
  }

  /** V12.6: 按实体 UUID 查记忆（entity 路透传）— 透传 EmotionalMemoryRecord，与 findMemoriesByEntityNames 同构。
   *  🔴 不做 toDNA：MemoryRetriever entity 路消费 id/raw_input/seq_pos/memory_kind/calcium_score/created_at，
   *     这些字段 EmotionalMemoryRecord 全有（memory_kind 由 rowToRecord 回填），toDNA 反而改变形状。
   *  🔴 roleplay 过滤在调用方用 memory_kind === 'roleplay'（memory_type 从未被 rowToRecord 回填，勿用）。 */
  findByEntityUuid(uuid: string, limit = 15): EmotionalMemoryRecord[] {
    this.ensureReady();
    return this.sqlite.findByEntityUuid(uuid, limit);
  }

  /**
   * 实体关系摘要（双库合并）
   */
  getEntityRelationSummary() {
    const oldResult = this.sqlite.getEntityRelationSummary();

    if (this.familyGraph && FAMILY_GRAPH_MIGRATION.readMode !== 'shadow') {
      try {
        const fgSummary = this.familyGraph.getAllEdgesSummary();
        if (fgSummary.length > 0) {
          return [...fgSummary, ...oldResult];
        }
      } catch (e) {
        console.warn('[FG-Mig] FamilyGraph 摘要读取失败:', (e as Error).message);
      }
    }

    return oldResult;
  }

  // ─── 状态 ───

  async getStatus(): Promise<StorageStatus> {
    this.ensureReady();
    const status = this.sqlite.getStatus();
    return {
      totalRecords: status.totalRecords,
      zoneCounts: {},
      currentSeqPos: this.seqCounter,
      storagePath: this.dataDir,
    };
  }

  async nextSeqPos(): Promise<number> {
    this.seqCounter++;
    return this.seqCounter;
  }

  /**
   * 设置家族图谱实例（双库统一读取路由）
   */
  setFamilyGraph(fg: any): void {
    this.familyGraph = fg;
    // V12.1: FG 就位后，同步 entities 表 UUID
    try {
      const names = fg.getAllPersonNames?.() || [];
      for (const name of names) {
        if (name.length < 2 || name === '我') continue;
        const uuid = fg.getUUIDByName?.(name);
        if (uuid) {
          this.sqlite.writeRaw(
            "UPDATE entities SET uuid = ? WHERE name = ? AND type = 'person' AND (uuid IS NULL OR uuid = '')",
            uuid, name
          );
          this.sqlite.writeRaw(
            "INSERT OR IGNORE INTO entities (name, type, uuid) VALUES (?, 'person', ?)",
            name, uuid
          );
        }
      }
      console.log('[FusionStorage] entities 已与 FG 同步');
    } catch { /* 非关键 */ }
  }

  getFamilyGraph(): any | null {
    return this.familyGraph;
  }

  /**
   * P0-1: 由 chat.ts 每轮对话前注入当前时空上下文
   * 写入 memories 时自动附带 temporal 标签，无需额外计算
   */
  setTemporalContext(ctx: { period?: string; season?: string; lunarTerm?: string }): void {
    this.temporalContext = ctx;
  }

  /** 清除时空上下文（跨日或会话封存时调用） */
  clearTemporalContext(): void {
    this.temporalContext = {};
  }

  // ─── SQLite 直通 ───

  getSQLite(): SQLiteAdapter {
    return this.sqlite;
  }

  /** P0-3: 强制立即落盘（委托给 SQLiteAdapter） */
  flushNow(): void {
    this.sqlite.flushNow();
  }

  /** P0-3: 关闭前安全落盘 — 清定时器 → 强制落盘 → 关闭数据库 */
  shutdownFlush(): void {
    // 先让 ConversationDB 落盘（如果共享同一 db 实例则跳过）
    try {
      if (this._conversationDB?.shutdownFlush) {
        this._conversationDB.shutdownFlush();
      }
    } catch { /* best effort */ }
    this.sqlite.shutdownFlush();
  }

  /** 获取共享的 ConversationDB 实例（三段存储③砂金库） */
  getConversationDB(): any {
    return this._conversationDB;
  }

  // ─── 私有方法 ───

  private ensureReady(): void {
    if (!this.initialized) throw new Error('FusionStorageAdapter not initialized');
  }

  private toDNA(record: EmotionalMemoryRecord): DNA {
    return {
      branch_id: record.id,
      seq_pos: record.seq_pos,
      locus_path: record.locus_path,
      taxonomy_version: '1.0',
      leaf_zone: record.leaf_zone as LeafZone,
      ref: `seq_${String(record.seq_pos).padStart(6, '0')}`,
      entity_genes: record.entity_genes,
      raw_input: record.raw_input,
      created_at: record.created_at,
      calcium_score: record.calcium_score,
      calcium_level: record.calcium_level,
      // V12.7(批1): 补 memory_kind + belong_entity_uuid — 此前 toDNA 剥字段，
      // keyword/locus 路读侧过滤/entityUuid 恒 undefined（死过滤）。
      // EmotionalMemoryRecord 两字段均由 rowToRecord 回填（memory_kind L2166 / belongEntityUuid L2205）。
      memory_kind: record.memory_kind,
      belong_entity_uuid: record.belongEntityUuid ?? undefined,
    };
  }

  /**
   * Zone JSON 备份写入
   * 保持与旧 JsonStorageAdapter 兼容的格式
   */
  private appendToJsonZone(dna: DNA, perception: Perception24D): void {
    try {
      const zone = dna.leaf_zone || 'language_semantic_zone';
      const zoneDir = join(this.dataDir, 'zones');
      if (!existsSync(zoneDir)) mkdirSync(zoneDir, { recursive: true });

      const filePath = join(zoneDir, `${zone}.json`);
      let data: any[] = [];
      if (existsSync(filePath)) {
        try { data = JSON.parse(readFileSync(filePath, 'utf-8')); } catch (err) { console.warn("[Fusion] Zone解析失败:", err); data = []; }
      }

      data.push({
        position: data.length,
        seq_pos: this.seqCounter,
        dna: { ...dna, leaf_zone: undefined },
        written_at: new Date().toISOString(),
        perception_preview: {
          calcium_score: computeCalcium(perception).score,
          pleasure: perception.pleasure,
          arousal: perception.arousal,
          intimacy: perception.intimacy,
        },
      });

      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[FusionStorageAdapter] Zone backup write failed:', err);
    }
  }
}
