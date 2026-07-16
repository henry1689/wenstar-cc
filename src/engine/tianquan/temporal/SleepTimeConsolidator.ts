/**
 * SleepTimeConsolidator.ts — 睡眠期巩固引擎 (V3.0)
 * ==================================================
 * 对话后 24 小时内异步流式执行记忆巩固流水线。
 * 对应人脑睡眠中的海马体回放→新皮层整合机制。
 *
 * 执行时间线（渐进式——根据距上次活跃的实际时间决定执行哪些阶段）:
 *   [对话结束] → [30min] 砂金→金库评估 → [1h] 惊讶度评估
 *   → [2h] 金库→黑钻评估 → [6h] 情景→语义归纳
 *   → [12h] 跨 session 关联 → [24h] 衰减归档
 *   → [48h] 系统巩固（海马体回放→皮层学习）
 *
 * 每次 runDaily() 根据实际距上次活跃时间，只执行到期阶段。
 * 避免一次性跑完全部 6 阶段——模拟人脑的渐进式巩固过程。
 *
 * 接入 DailyMaintenanceScheduler 运行。
 * 不阻塞对话流程，所有操作异步执行。
 */
import type { FusionStorageAdapter } from '../../../m2/FusionStorageAdapter.js';
import { MEMORY_CONFIG } from '../../../config/MemoryConfig.js';

/** 各阶段执行窗口（小时） */
const STAGE_WINDOWS = {
  SAND_TO_GOLD: 0.5,            // 30分钟
  SURPRISE: 1,                  // 1小时
  GOLD_TO_DIAMOND: 2,           // 2小时
  SECOND_BRAIN_SYNC: 4,         // 4小时（知识库→金库夜间同步）V4.0
  SEMANTIC_INDUCTION: 6,        // 6小时
  CROSS_SESSION: 12,            // 12小时
  FORGETTING: 24,               // 24小时
  SYSTEMS_CONSOLIDATION: 48,    // 48小时（海马体回放→皮层学习）
} as const;

export interface ConsolidationReport {
  sandToGold: number;
  goldToDiamond: number;
  secondBrainSynced: number;     // V4.0 新增
  cascadeCleared: number;        // V4.0 新增
  semanticInductions: number;
  crossSessionLinks: number;
  forgotten: number;
  hoursSinceLastActive: number;
  stagesRun: string[];
  timestamp: string;
}

export class SleepTimeConsolidator {
  private storage: FusionStorageAdapter;
  /** 各阶段上次运行时间戳（epoch ms），用于防重复执行 */
  private _stageLastRun: Map<string, number> = new Map();

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  /**
   * 记录用户活动时间（每次发消息时调用）
   * 持久化到 engine_store，跨重启保留
   */
  recordActivity(): void {
    const now = Date.now();
    try {
      const sqlite = this.storage.getSQLite();
      sqlite?.writeRaw(
        "INSERT OR REPLACE INTO engine_store (key, value) VALUES ('last_active_time', ?)",
        [String(now)]
      );
    } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
  }

  /**
   * 获取距上次活跃的小时数
   */
  getHoursSinceLastActive(): number {
    try {
      const sqlite = this.storage.getSQLite();
      const rows = sqlite?.queryAll("SELECT value FROM engine_store WHERE key = 'last_active_time' LIMIT 1");
      if (rows && rows.length > 0) {
        const lastActive = Number((rows[0] as any).value);
        if (lastActive > 0) {
          return (Date.now() - lastActive) / (1000 * 60 * 60);
        }
      }
    } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
    return 24; // 默认认为已过24h，运行全阶段
  }

  /**
   * 执行睡眠期巩固（每日维护调度器调用）
   * 根据实际距上次活跃时间，渐进式执行到期阶段。
   *
   * @param hoursSinceLastActive 可选覆盖值；不传则从 engine_store 自动计算
   */
  async runDaily(hoursSinceLastActive?: number): Promise<ConsolidationReport> {
    const hours = hoursSinceLastActive ?? this.getHoursSinceLastActive();
    const report: ConsolidationReport = {
      sandToGold: 0, goldToDiamond: 0,
      secondBrainSynced: 0, cascadeCleared: 0,  // V4.0
      semanticInductions: 0, crossSessionLinks: 0,
      forgotten: 0, hoursSinceLastActive: Math.round(hours * 10) / 10,
      stagesRun: [], timestamp: new Date().toISOString(),
    };

    try {
      const sqlite = this.storage.getSQLite();

      // ── [30min] 砂金→金库晋升 ──
      if (hours >= STAGE_WINDOWS.SAND_TO_GOLD && this._shouldRun('sand_to_gold')) {
        const sand = await this._promoteSandToGold(sqlite);
        report.sandToGold = sand;
        if (sand > 0) report.stagesRun.push('sand→gold');
      }

      // ── [1h] 惊讶度评估 ──
      if (hours >= STAGE_WINDOWS.SURPRISE && this._shouldRun('surprise')) {
        await this._evaluateSurprise(sqlite);
        report.stagesRun.push('surprise');
      }

      // ── [2h] 金库→黑钻晋升 ──
      if (hours >= STAGE_WINDOWS.GOLD_TO_DIAMOND && this._shouldRun('gold_to_diamond')) {
        const gold = await this._promoteGoldToDiamond(sqlite);
        report.goldToDiamond = gold;
        if (gold > 0) report.stagesRun.push('gold→diamond');
      }

      // ── [4h] V4.0 第二大脑→金库同步 + 级联删除 ──
      if (hours >= STAGE_WINDOWS.SECOND_BRAIN_SYNC && this._shouldRun('second_brain_sync')) {
        const synced = await this._syncSecondBrainToGold(sqlite);
        report.secondBrainSynced = synced;
        if (synced > 0) report.stagesRun.push('2nd_brain→gold');

        const cleared = await this._cascadeClearOnSourceChange(sqlite);
        report.cascadeCleared = cleared;
        if (cleared > 0) report.stagesRun.push('cascade_clear');
      }

      // ── [6h] 情景→语义归纳 ──
      if (hours >= STAGE_WINDOWS.SEMANTIC_INDUCTION && this._shouldRun('semantic')) {
        const semantic = await this._induceSemantic(sqlite);
        report.semanticInductions = semantic;
        if (semantic > 0) report.stagesRun.push('semantic_induction');
      }

      // ── [12h] 跨 session 实体关联 ──
      if (hours >= STAGE_WINDOWS.CROSS_SESSION && this._shouldRun('cross_session')) {
        const cross = await this._linkCrossSession(sqlite);
        report.crossSessionLinks = cross;
        if (cross > 0) report.stagesRun.push('cross_session');
      }

      // ── [24h] 衰减归档 + 选择性遗忘 ──
      if (hours >= STAGE_WINDOWS.FORGETTING && this._shouldRun('forgetting')) {
        const forgotten = await this._executeForgetting(sqlite);
        report.forgotten = forgotten;
        if (forgotten > 0) report.stagesRun.push('forgetting');
      }

      // ── [48h] 系统巩固（海马体回放→皮层学习）──
      if (hours >= STAGE_WINDOWS.SYSTEMS_CONSOLIDATION && this._shouldRun('systems_consolidation')) {
        await this._runSystemsConsolidation(sqlite);
        report.stagesRun.push('systems_consolidation');
      }

      if (report.stagesRun.length > 0) {
        console.log('[SleepTime] 巩固报告 (距活跃', report.hoursSinceLastActive, 'h):', JSON.stringify(report));
        // V4.0 Phase 2: 发布巩固完成事件到 TianquanEventBus
        (globalThis as any).__tianquanBus?.emit?.({
          type: 'consolidation:complete',
          traceId: `sc_${Date.now().toString(36)}`,
          timestamp: Date.now(),
          sessionId: '',
          payload: {
            sandToGold: report.sandToGold,
            goldToDiamond: report.goldToDiamond,
            semanticInductions: report.semanticInductions,
            crossSessionLinks: report.crossSessionLinks,
            forgotten: report.forgotten,
            stagesRun: report.stagesRun,
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[SleepTime] 巩固失败:', err);
    }
    return report;
  }

  /**
   * 阶段是否应该执行（每天每个阶段只执行一次，防止重复）
   */
  private _shouldRun(stageKey: string): boolean {
    const now = Date.now();
    const last = this._stageLastRun.get(stageKey) || 0;
    // 24小时内同一阶段只跑一次
    if (now - last < 23 * 3600_000) return false;
    this._stageLastRun.set(stageKey, now);
    return true;
  }

  /** ① 砂金→金库晋升 (V3.1 弹性窗口) */
  private async _promoteSandToGold(sqlite: any): Promise<number> {
    try {
      const now = Date.now();
      // 弹性晋升公式：弹性分 = calcium × 时间衰减 × 实体多样性
      // 阈值从 1.0 放宽至 0.7，捕获"当下普通、长期高价值"的滞后型记忆（由 MEMORY_CONFIG 统一管理）
      const _cfg = MEMORY_CONFIG.sleepConsolidation;
      const rows = sqlite.queryAll(
        `SELECT id, content, calcium_score, entity_names, dna_root_id, timestamp,
                perception_summary, seq_pos FROM conversations
         WHERE is_promoted = 0 AND calcium_score >= ${_cfg.sandToGoldMinCalcium} ORDER BY calcium_score DESC LIMIT ${_cfg.sandToGoldBatchSize}`
      );
      let count = 0;
      for (const row of rows) {
        const _content = (row as any).content || '';
        if (!_content) continue;

        // 时间衰减因子（30天线性衰减到0）
        const createdAt = new Date((row as any).timestamp || Date.now()).getTime();
        const idleHours = (now - createdAt) / 3600000;
        const decayFactor = Math.max(0, 1 - idleHours / 720);

        // 实体多样性加成
        let uniquePersons = 0;
        try {
          const entityNames = JSON.parse((row as any).entity_names || '[]');
          if (Array.isArray(entityNames)) {
            uniquePersons = new Set(
              entityNames.filter((n: string) => typeof n === 'string' && n.length > 1 && n !== '我')
            ).size;
          }
        } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }

        const diversityBoost = 1 + uniquePersons * 0.1;
        const calcium = (row as any).calcium_score || 0.5;
        const elasticScore = calcium * decayFactor * diversityBoost;
        // 多样性门槛：单人对话需更高弹性分，多人对话阈值放宽（由 MEMORY_CONFIG 统一管理）
        const threshold = uniquePersons >= 2 ? _cfg.multiPersonThreshold : _cfg.singlePersonThreshold;

        if (elasticScore < threshold) continue;

        sqlite.writeRaw(
          `INSERT OR IGNORE INTO memories (id, raw_input, calcium_score, seq_pos, created_at, memory_kind)
           VALUES (?, ?, ?, ?, ?, 'episodic')`,
          [String((row as any).id), _content, (row as any).calcium_score,
           (row as any).seq_pos || 0, (row as any).timestamp || new Date().toISOString()]
        );
        sqlite.writeRaw('UPDATE conversations SET is_promoted = 1 WHERE id = ?', [(row as any).id]);
        count++;
      }
      if (count > 0) console.log(`[SleepTime] 砂金→金库(弹性): ${count} 条 (阈值0.7, 多元化≥2人)`);
      return count;
    } catch { return 0; }
  }

  /** ② 惊讶度评估（记录日志） */
  private async _evaluateSurprise(sqlite: any): Promise<void> {
    try {
      // 读取情绪基线
      const rows = sqlite.queryAll("SELECT value FROM engine_store WHERE key = 'emotion_baseline' LIMIT 1");
      if (!rows?.length) return;
      const baseline = JSON.parse(rows[0].value as string);
      if (!baseline?.pleasure) return;

      // 扫描最近 50 条记忆，标记高惊讶度
      const recent = sqlite.queryAll(
        `SELECT id, perception_json FROM memories ORDER BY created_at DESC LIMIT 50`
      );
      let highSurprise = 0;
      for (const row of recent) {
        try {
          const perc = JSON.parse((row as any).perception_json || '{}');
          if (!perc.pleasure) continue;
          const surprise = (Math.abs(perc.pleasure - baseline.pleasure) +
            Math.abs(perc.arousal - baseline.arousal) +
            Math.abs(perc.intimacy - baseline.intimacy)) / 3;
          if (surprise > 0.3) {
            sqlite.writeRaw('UPDATE memories SET calcium_score = MIN(10, COALESCE(calcium_score, 0) + ?) WHERE id = ?',
              [surprise * 0.5, (row as any).id]);
            highSurprise++;
          }
        } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
      }
      if (highSurprise > 0) console.log(`[SleepTime] 惊讶度提升: ${highSurprise} 条`);
    } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
  }

  /** ③ 金库→黑钻晋升 */
  private async _promoteGoldToDiamond(sqlite: any): Promise<number> {
    try {
      const rows = sqlite.queryAll(
        `SELECT id, raw_input, calcium_score, recall_count FROM memories
         WHERE promoted_to_diamond = 0 AND (calcium_score >= ${MEMORY_CONFIG.goldToDiamond.minCalciumScore} OR recall_count >= ${MEMORY_CONFIG.goldToDiamond.minRecallCount})
         LIMIT ${MEMORY_CONFIG.goldToDiamond.batchSize}`
      );
      let count = 0;
      for (const row of rows) {
        // black_diamond 表结构: id, summary, emotion_tag, source_id, calcium_level, recall_count, tags, notes, created_at, ...
        sqlite.writeRaw(
          `INSERT OR IGNORE INTO black_diamond (id, summary, tags, created_at)
           VALUES (?, ?, ?, ?)`,
          [(row as any).id,
           ((row as any).raw_input || '').substring(0, 200),
           JSON.stringify(['auto_promoted', '珍藏']),
           new Date().toISOString()]
        );
        sqlite.writeRaw('UPDATE memories SET promoted_to_diamond = 1 WHERE id = ?', [(row as any).id]);
        count++;
      }
      if (count > 0) console.log(`[SleepTime] 金库→黑钻: ${count} 条`);
      return count;
    } catch { return 0; }
  }

  /** ④ 情景→语义归纳 (V3.0 增强：基于实体 + 跨会话模式提取) */
  private async _induceSemantic(sqlite: any): Promise<number> {
    try {
      // 扫描最近 200 条记忆，扩展时间窗口覆盖更多跨会话数据
      const rows = sqlite.queryAll(
        `SELECT id, raw_input, calcium_score, entity_names, created_at, perception_json
         FROM memories WHERE memory_kind = 'episodic'
         ORDER BY created_at DESC LIMIT 200`
      );
      if (!rows?.length) return 0;

      // ── 策略① 基于 M1 实体标注的主题聚类 ──
      const entityMentions = new Map<string, { count: number; snippets: string[]; days: Set<string>; calciumTotal: number }>();
      for (const row of rows) {
        try {
          const names = JSON.parse((row as any).entity_names || '[]');
          if (!Array.isArray(names)) continue;
          const text = (row as any).raw_input || '';
          const cal = (row as any).calcium_score || 0.5;
          const day = ((row as any).created_at || '').toString().substring(0, 10);
          for (const name of names) {
            if (typeof name !== 'string' || name.length < 2 || '我了是的不和人有着在'.includes(name)) continue;
            if (!entityMentions.has(name)) {
              entityMentions.set(name, { count: 0, snippets: [], days: new Set(), calciumTotal: 0 });
            }
            const entry = entityMentions.get(name)!;
            entry.count++;
            entry.days.add(day);
            entry.calciumTotal += cal;
            if (entry.snippets.length < 4) entry.snippets.push(text.substring(0, 80));
          }
        } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
      }

      // ── 策略② 按中文词组补充未被 M1 标注的主题 ──
      const wordMap = new Map<string, { count: number; snippets: string[] }>();
      for (const row of rows) {
        const text = (row as any).raw_input || '';
        const words = text.match(/[一-龥]{2,4}/g);
        if (!words) continue;
        const filtered = words.filter((w: string) => !'了的在是我有和就不人会也把被让从对跟说'.split('').some(c => w.includes(c)));
        for (const w of [...new Set(filtered)] as string[]) {
          // 跳过已被实体覆盖的
          if (entityMentions.has(w)) continue;
          if (!wordMap.has(w)) wordMap.set(w, { count: 0, snippets: [] });
          const entry = wordMap.get(w)!;
          entry.count++;
          if (entry.snippets.length < 3) entry.snippets.push(text.substring(0, 60));
        }
      }

      let inductions = 0;

      // ── 从实体聚类生成语义记忆 ──
      for (const [name, data] of entityMentions) {
        const avgCal = data.calciumTotal / data.count;
        const isCrossSession = data.days.size >= MEMORY_CONFIG.sleepConsolidation.semanticCrossSessionMinDays;
        // 实体被提及 3+ 次且有跨天出现，或提及 5+ 次
        const isSignificant = (data.count >= 3 && isCrossSession) || data.count >= 5;
        if (!isSignificant || avgCal < 0.25) continue;

        // 已有归纳？
        const existing = sqlite.queryAll(
          "SELECT id FROM knowledge_base WHERE title LIKE ? AND classification = '梦境洞察' LIMIT 1",
          [`%${name}%`]
        );
        if (existing?.length) continue;

        // 判断归纳类型
        const category = this._classifyPattern(name, data);
        const content = this._buildSemanticSummary(name, data, category, avgCal);

        // 🧠 多源融合: 查询 FG + 知识库 + 黑钻，生成四源融合经验摘要
        const fusedSummary = this._fuseMultiSource(name, category, data, sqlite);
        const finalContent = fusedSummary || content;

        const knId = `sem_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

        sqlite.writeRaw(
          `INSERT INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, locked, classification, classification_pending, interaction_type)
           VALUES (?, ?, ?, 'dream_behavior', ?, ?, ?, 1, '梦境洞察', 0, 'other')`,
          [knId, `${category}: ${name}`, finalContent,
           JSON.stringify(['auto_inducted', 'semantic', category, name, 'multi_source']),
           new Date().toISOString(), new Date().toISOString()]
        );

        // 🔥 经验回写: 将融合摘要写入 hippocampal_index，下次对话直接命中
        this._writebackExperience(name, data, finalContent, sqlite);
        inductions++;
      }

      // ── 从词组聚类生成补充归纳（仅当词组频次很高时） ──
      for (const [word, data] of wordMap) {
        if (data.count < 5 || inductions >= 10) continue;
        const existing = sqlite.queryAll(
          "SELECT id FROM knowledge_base WHERE title LIKE ? AND classification = '梦境洞察' LIMIT 1",
          [`%${word}%`]
        );
        if (existing?.length) continue;
        const knId = `sem_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        const content = `从 ${data.count} 次对话中归纳的话题：\n` + data.snippets.map(s => `- ${s}`).join('\n');

        // 🧠 多源融合: 词组归纳也走融合通道
        const wordData = { count: data.count, snippets: data.snippets, days: new Set<string>(), calciumTotal: 0.4 * data.count };
        const fusedSummary = this._fuseMultiSource(word, '话题归纳', wordData, sqlite);
        const finalContent = fusedSummary || content;

        sqlite.writeRaw(
          `INSERT INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, locked, classification, classification_pending, interaction_type)
           VALUES (?, ?, ?, 'dream_behavior', ?, ?, ?, 1, '梦境洞察', 0, 'other')`,
          [knId, `话题归纳: ${word}`, finalContent,
           JSON.stringify(['auto_inducted', 'semantic', 'topic', word, 'multi_source']),
           new Date().toISOString(), new Date().toISOString()]
        );
        this._writebackExperience(word, wordData, finalContent, sqlite);
        inductions++;
      }

      if (inductions > 0) {
        console.log(`[SleepTime] 情景→语义: ${inductions} 条归纳 (实体${entityMentions.size}个, 词组${wordMap.size}个)`);
        // V4.0 Phase 3: 异步同步到 MasterProfile（fire-and-forget）
        setImmediate(() => {
          try {
            const mp = (globalThis as any).__masterProfile;
            if (mp && typeof mp.upsert === 'function') {
              for (const [name, data] of entityMentions) {
                if (data.count >= 3) {
                  mp.upsert({ category: 'auto_inducted', subcategory: this._classifyPattern(name, data),
                    content: `在 ${data.days.size} 天内 ${data.count} 次提及 ${name}`, source: 'sleep_consolidation', confidence: 0.5 });
                }
              }
            }
          } catch { /* 画像不可用不阻塞 */ }
        });
      }
      return inductions;
    } catch { return 0; }
  }

  /** 判断归纳类型 */
  private _classifyPattern(name: string, data: { count: number; snippets: string[]; days: Set<string> }): string {
    const text = data.snippets.join('');
    if (/喜欢|爱喝|爱吃|偏好|习惯|每天|经常|总是/.test(text)) return '偏好归纳';
    if (/工作|加班|项目|开会|老板|同事/.test(text)) return '工作模式';
    if (/睡|失眠|熬夜|困|累|疲惫/.test(text)) return '健康关注';
    if (/开心|难过|焦虑|压力|烦|生气/.test(text)) return '情绪模式';
    if (/买|钱|价格|贵|便宜/.test(text)) return '消费习惯';
    if (data.days.size >= MEMORY_CONFIG.sleepConsolidation.semanticTopicFilterMinDays) return '跨会话模式';
    return '行为归纳';
  }

  /** 构建语义摘要 */
  private _buildSemanticSummary(
    name: string,
    data: { count: number; snippets: string[]; days: Set<string>; calciumTotal: number },
    category: string,
    avgCal: number
  ): string {
    const avgCalStr = avgCal >= MEMORY_CONFIG.sleepConsolidation.semanticCalciumHigh ? '高关注度'
      : avgCal >= MEMORY_CONFIG.sleepConsolidation.semanticCalciumMid ? '中度关注' : '一般关注';
    return [
      `在 ${data.days.size} 天内的 ${data.count} 次对话中反复提及「${name}」（${avgCalStr}，平均钙化 ${avgCal.toFixed(2)}）。`,
      '',
      '相关片段：',
      ...data.snippets.map(s => `  · ${s}`),
      '',
      `分类: ${category} | 跨天: ${data.days.size >= 2 ? '是' : '否'} | 钙化均值: ${avgCal.toFixed(2)}`,
    ].join('\n');
  }

  /** ⑤ 跨 session 实体关联 (V3.0 增强：更广搜索 + FG 关联) */
  private async _linkCrossSession(sqlite: any): Promise<number> {
    try {
      // 扩大搜索范围到最近 500 条记忆
      const rows = sqlite.queryAll(
        `SELECT entity_names, created_at FROM memories WHERE entity_names IS NOT NULL
         ORDER BY created_at DESC LIMIT 500`
      );
      const entitySessions = new Map<string, Set<string>>(); // name → set of dates
      for (const row of rows) {
        try {
          const names = JSON.parse((row as any).entity_names as string || '[]');
          if (!Array.isArray(names)) continue;
          const day = ((row as any).created_at || '').toString().substring(0, 10);
          for (const name of names) {
            if (typeof name !== 'string' || name.length < 2 || name === '我') continue;
            if (!entitySessions.has(name)) entitySessions.set(name, new Set());
            entitySessions.get(name)!.add(day);
          }
        } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
      }

      let links = 0;
      const fg = (globalThis as any).__familyGraph;

      for (const [name, days] of entitySessions) {
        if (days.size >= 2) {
          // 跨天出现，建议建立 FG 关联
          try {
            if (fg && typeof fg.searchPersonWithMemories === 'function') {
              await fg.searchPersonWithMemories(name);
              links++;
            }
          } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
        }
      }

      // 无 FG 时，将关联信息写入 dream_logs 作为备选
      if (!fg && links === 0) {
        const topEntities = [...entitySessions.entries()]
          .filter(([, days]) => days.size >= MEMORY_CONFIG.sleepConsolidation.semanticTopicFilterMinDays)
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 5);
        for (const [name, days] of topEntities) {
          sqlite.writeRaw(
            `INSERT OR IGNORE INTO dream_logs (id, summary, emotion_tag, source, tags, created_at)
             VALUES (?, ?, ?, 'cross_session', ?, ?)`,
            ['xl_' + name, `跨会话实体: ${name} 在 ${days.size} 天中被提及`, '中性',
             JSON.stringify(['cross_session', name]),
             new Date().toISOString()]
          );
          links++;
        }
      }

      return links;
    } catch { return 0; }
  }

  /** ⑥ 选择性遗忘执行 */
  private async _executeForgetting(sqlite: any): Promise<number> {
    try {
      // 查找标记为 suppressed 的记忆
      const marked = sqlite.queryAll(
        "SELECT id FROM memories WHERE lifecycle_state = 'suppressed'"
      );
      if (marked?.length) {
        sqlite.writeRaw(
          "UPDATE memories SET effective_strength = ?, calcium_score = ? WHERE lifecycle_state = 'suppressed'",
          [MEMORY_CONFIG.sleepConsolidation.forgettingStrengthFloor, MEMORY_CONFIG.sleepConsolidation.forgettingCalciumFloor]
        );
        console.log(`[SleepTime] 遗忘执行: ${marked.length} 条`);
      }
      return marked?.length || 0;
    } catch { return 0; }
  }

  // ═══════════════════════════════════════════════════════════════
  //  V4.0 Phase 3 新增阶段
  // ═══════════════════════════════════════════════════════════════

  /** ⑧ 第二大脑→第一大脑金库同步 (V4.0 Phase 3) */
  private async _syncSecondBrainToGold(sqlite: any): Promise<number> {
    try {
      // 读取 MDFileWatcher 的变更队列
      const mdWatcher = (globalThis as any).__mdFileWatcher;
      const changes = mdWatcher && typeof mdWatcher.getChanges === 'function'
        ? mdWatcher.getChanges()
        : [];

      if (changes.length === 0) return 0;

      const gateway = (globalThis as any).__secondBrainGateway;
      const sourceTracker = (globalThis as any).__sourceTracker;
      if (!gateway) return 0;

      let count = 0;
      for (const change of changes) {
        try {
          if (change.type === 'deleted') continue; // 删除由 cascade 处理

          const manifest = gateway.getManifest(change.path);
          if (!manifest) continue;

          // 提取摘要
          const summary = gateway.getMDSummary(change.path) || '';
          if (!summary) continue;

          // 写入 memories 表（标记 source_type='knowledge_vault'）
          const entryId = `kv_${manifest.uuid}_${Date.now().toString(36)}`.substring(0, 64);
          const now = new Date().toISOString();
          // 🔴 memories 表有很多 NOT NULL 列，必须全部提供
          const seqPos = -(Date.now() % 1000000);

          sqlite.writeRaw(
            `INSERT OR IGNORE INTO memories (id, seq_pos, raw_input, perception_json, calcium_score, calcium_level,
             locus_path, leaf_zone, effective_strength, created_at, lifecycle_state, memory_kind, recall_count,
             last_recalled_at, source_type, strength_updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'knowledge_vault', 0, NULL, 'knowledge_vault', ?)`,
            [entryId, seqPos, summary.substring(0, MEMORY_CONFIG.sleepConsolidation.secondBrainSummaryMaxLen), '{}',
             MEMORY_CONFIG.sleepConsolidation.secondBrainInitCalcium, 1,
             'knowledge_vault', 'language_semantic_zone',
             MEMORY_CONFIG.sleepConsolidation.secondBrainInitStrength, now, now]
          );

          // 溯源记录：MD源文件→memories 条目
          if (sourceTracker && typeof sourceTracker.track === 'function') {
            sourceTracker.track(
              change.path,
              manifest.uuid,
              change.currentSha256 || manifest.sha256,
              entryId,
            );
          }

          count++;
        } catch (err) {
          console.warn(`[SleepTime] 2ndBrain sync 失败 (${change.path}):`, (err as Error).message);
        }
      }

      if (count > 0) {
        console.log(`[SleepTime] 第二大脑→金库: ${count}/${changes.length} 条`);
      }
      return count;
    } catch (err) {
      console.warn('[SleepTime] 第二大脑同步失败:', err);
      return 0;
    }
  }

  /** ⑨ 级联删除：源文件变更 → 金库旧条目标记 expired (V4.0 Phase 3) */
  private async _cascadeClearOnSourceChange(sqlite: any): Promise<number> {
    try {
      const sourceTracker = (globalThis as any).__sourceTracker;
      if (!sourceTracker || typeof sourceTracker.findMemoriesBySource !== 'function') return 0;

      // 查找所有 stale 的 source_tracking 记录（SHA-256 不匹配的）
      const staleRows = sqlite.queryAll(
        `SELECT st.source_path, st.memory_id, st.source_hash,
                (SELECT sha256 FROM knowledge_base WHERE id IS NOT NULL LIMIT 0) AS dummy
         FROM source_tracking st
         WHERE st.status = 'active'`
      );

      if (!staleRows?.length) return 0;

      const gateway = (globalThis as any).__secondBrainGateway;
      if (!gateway) return 0;

      let cleared = 0;
      for (const row of staleRows) {
        const sourcePath = (row as any).source_path as string;
        const memoryId = (row as any).memory_id as string;

        // 检查源文件是否存在
        const manifest = gateway.getManifest(sourcePath);
        if (!manifest) {
          // 源文件被删除 → 标记为 orphaned
          sqlite.writeRaw(
            "UPDATE memories SET lifecycle_state = 'suppressed', suppression_reason = 'source_deleted' WHERE id = ? AND lifecycle_state = 'active'",
            [memoryId]
          );
          if (sourceTracker.markOrphanedBySource) {
            sourceTracker.markOrphanedBySource(sourcePath);
          }
          cleared++;
          continue;
        }

        // 检查 SHA-256 是否变更
        const currentHash = manifest.sha256;
        const syncedHash = (row as any).source_hash;
        if (currentHash && syncedHash && currentHash !== syncedHash) {
          // 文件内容变更 → 标记旧条目 suppressed，下次同步会创建新条目
          sqlite.writeRaw(
            "UPDATE memories SET lifecycle_state = 'suppressed', suppression_reason = 'source_updated' WHERE id = ? AND lifecycle_state = 'active'",
            [memoryId]
          );
          if (sourceTracker.markExpiredBySource) {
            sourceTracker.markExpiredBySource(sourcePath);
          }
          cleared++;
        }
      }

      if (cleared > 0) {
        console.log(`[SleepTime] 级联清除: ${cleared} 条`);
      }
      return cleared;
    } catch (err) {
      console.warn('[SleepTime] 级联删除失败:', err);
      return 0;
    }
  }

  /** ⑦ 系统巩固：海马体回放→皮层学习 (V3.0 新增) */
  private async _runSystemsConsolidation(sqlite: any): Promise<void> {
    try {
      // 1. 回放 top-20 高钙化记忆，强化 hippocampal_index 映射
      const topMemories = sqlite.queryAll(
        `SELECT id, raw_input, calcium_score, locus_path, entity_names, perception_json
         FROM memories WHERE calcium_score >= ${MEMORY_CONFIG.sleepConsolidation.systemsConsolidationCalcium} AND lifecycle_state != 'suppressed'
         ORDER BY calcium_score DESC LIMIT ${MEMORY_CONFIG.sleepConsolidation.systemsConsolidationBatchSize}`
      );
      if (!topMemories?.length) return;

      let reinforced = 0;
      for (const mem of topMemories) {
        try {
          const entities = JSON.parse((mem as any).entity_names || '[]');
          const personNames = Array.isArray(entities)
            ? entities.filter((e: any) => typeof e === 'string').map((n: string) => ({ name: n, type: 'person' as const }))
            : [];
          const perception = JSON.parse((mem as any).perception_json || '{}');

          // 更新稀疏索引的钙化 boost（反复走的路更粗）
          const sig = this._computeSigForMemory(
            (mem as any).locus_path || 'root.default',
            personNames,
            perception
          );
          sqlite.writeRaw(
            `UPDATE hippocampal_index SET calcium_boost = MIN(10.0, calcium_boost + ${MEMORY_CONFIG.sleepConsolidation.systemsConsolidationBoost}), last_activated_at = ? WHERE context_signature = ?`,
            [new Date().toISOString(), sig]
          );
          reinforced++;
        } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }
      }

      // 2. 将 top-5 高钙化记忆摘要写入 knowledge_base（皮层学习）
      const top5 = topMemories.slice(0, 5);
      for (const mem of top5) {
        const raw = ((mem as any).raw_input || '').substring(0, 120);
        const existing = sqlite.queryAll(
          "SELECT id FROM knowledge_base WHERE title = ? LIMIT 1",
          [`巩固记忆: ${raw}`]
        );
        if (existing?.length) continue;

        const knId = `sysc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        sqlite.writeRaw(
          `INSERT INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, locked, classification, classification_pending, interaction_type)
           VALUES (?, ?, ?, 'systems_consolidation', ?, ?, ?, 1, '系统巩固', 0, 'other')`,
          [knId, `巩固记忆: ${raw}`, `钙化 ${(mem as any).calcium_score?.toFixed(2)} 的持久记忆:\n${raw}`,
           JSON.stringify(['systems_consolidation', 'hippocampal_replay']),
           new Date().toISOString(), new Date().toISOString()]
        );
      }

      // 3. 清理 hippocampal_index 中的低质量条目
      try {
        const { HippocampalIndex } = require('./HippocampalIndex.js') as typeof import('./HippocampalIndex.js');
        const idx = new HippocampalIndex(sqlite);
        idx.runDailyMaintenance();
      } catch (e) { console.warn(`[SleepTimeConsolidator] 操作失败`, (e as Error)?.message || e); }

      if (reinforced > 0) console.log(`[SleepTime] 系统巩固: 强化 ${reinforced} 条稀疏索引 + ${top5.length} 条皮层学习`);
    } catch (err) {
      console.warn('[SleepTime] 系统巩固失败:', err);
    }
  }

  /** 计算记忆的上下文签名（供系统巩固使用） */
  private _computeSigForMemory(
    locusPath: string,
    entities: Array<{ name: string; type: string }>,
    perception?: { pleasure?: number; arousal?: number }
  ): string {
    const domain = locusPath?.split('.').slice(0, 2).join('.') || 'root';
    const persons = entities
      .filter(e => e.type === 'person' && e.name !== '我')
      .map(e => e.name).sort().join('|');
    const emo = perception
      ? `${(perception.pleasure ?? 0) > 0.2 ? 'pos' : (perception.pleasure ?? 0) < -0.2 ? 'neg' : 'neu'}`
      : 'neu';
    const raw = `${domain}|${emo}|${persons}`;
    // Use a simple hash (avoid importing crypto in consolidation context)
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(16, '0').substring(0, 16);
  }

  // ═══════════════════════════════════════════════════════════
  //  多源融合经验总结 + 索引回写 (V3.0)
  // ═══════════════════════════════════════════════════════════

  /**
   * 四象归元 — 多源融合经验摘要
   * 查询 FG（家族图谱）、知识库、黑钻，与对话上下文融合，
   * 生成带来源标注的复合经验摘要。
   */
  private _fuseMultiSource(
    topic: string,
    category: string,
    data: { count: number; snippets: string[]; days: Set<string>; calciumTotal: number },
    sqlite: any,
  ): string | null {
    try {
      const sources: string[] = [];

      // ① 对话上下文（已有）
      const avgCal = data.calciumTotal / data.count;
      const crossSession = data.days.size >= 2 ? `跨${data.days.size}天` : '单天';
      const ctxLine = `对话${data.count}次(${crossSession})，平均钙化${avgCal.toFixed(2)}`;
      sources.push(`对话上下文: ${ctxLine}`);

      // ② 家族图谱 — 查询相关人物档案
      const fgInfo = this._queryFamilyGraphForTopic(topic);
      if (fgInfo) sources.push(`FG: ${fgInfo}`);

      // ③ 知识库 — 同主题已有结论
      const kbInfo = this._queryKnowledgeForTopic(topic, sqlite);
      if (kbInfo) sources.push(`知识库: ${kbInfo}`);

      // ④ 黑钻 — 高钙化地标记忆
      const bdInfo = this._queryBlackDiamondForTopic(topic, sqlite);
      if (bdInfo) sources.push(`记忆锚点: ${bdInfo}`);

      if (sources.length <= 1) return null; // 只有对话源，不需融合

      const snippetsStr = data.snippets.slice(0, 3).map(s => `  · ${s}`).join('\n');
      return [
        `【${topic}·${category}】`,
        ...sources,
        '',
        '相关片段:',
        snippetsStr,
      ].join('\n');
    } catch { return null; }
  }

  /** 查询家族图谱中是否有相关人物/实体 */
  private _queryFamilyGraphForTopic(topic: string): string | null {
    try {
      const fg = (globalThis as any).__familyGraph;
      if (!fg || typeof fg.searchPersonWithMemories !== 'function') return null;

      // 检查 FG 中是否有同名人物
      const sqlite = this.storage.getSQLite();
      const persons = sqlite?.queryAll(
        "SELECT name, properties FROM nodes WHERE type = 'person' AND name LIKE ? LIMIT 3",
        [`%${topic}%`]
      );
      if (persons && persons.length > 0) {
        const names = persons.map((p: any) => p.name).join('、');
        return `关联人物: ${names}`;
      }
      return null;
    } catch { return null; }
  }

  /** 查询知识库中同主题的已有结论 */
  private _queryKnowledgeForTopic(topic: string, sqlite: any): string | null {
    try {
      const existing = sqlite.queryAll(
        "SELECT title, content FROM knowledge_base WHERE (title LIKE ? OR content LIKE ?) AND classification IN ('梦境洞察', '系统巩固', '梦境研究') LIMIT 3",
        [`%${topic}%`, `%${topic}%`]
      );
      if (existing && existing.length > 0) {
        const titles = existing.map((r: any) => (r.title || '').replace(topic, '').replace(/^[:：\s]+/, '').substring(0, 20)).filter(Boolean);
        return titles.length > 0 ? `已有归纳: ${titles.join('、')}` : '已有相关归纳';
      }
      return null;
    } catch { return null; }
  }

  /** 查询黑钻中是否有相关的高钙化地标记忆 */
  private _queryBlackDiamondForTopic(topic: string, sqlite: any): string | null {
    try {
      const diamonds = sqlite.queryAll(
        "SELECT summary, created_at FROM black_diamond WHERE summary LIKE ? ORDER BY created_at DESC LIMIT 2",
        [`%${topic}%`]
      );
      if (diamonds && diamonds.length > 0) {
        const dates = diamonds.map((d: any) => (d.created_at || '').substring(0, 10)).filter(Boolean);
        return dates.length > 0 ? `地标记忆(${dates.join(', ')})` : '有地标记忆';
      }
      return null;
    } catch { return null; }
  }

  /** 经验回写 — 将融合摘要写入 hippocampal_index（exp: 前缀，不干扰普通索引） */
  private _writebackExperience(
    topic: string,
    data: { count: number; snippets: string[]; days: Set<string> },
    summary: string,
    sqlite: any,
  ): void {
    try {
      const persons = this._extractPersonsFromSnippets(data.snippets);
      const personsStr = persons.sort().join('|');
      // exp: 前缀隔离经验条目，避免与 θ 节律的 context_signature 冲突
      const sig = `exp:${topic}:${personsStr}`.substring(0, 64);

      sqlite.writeRaw(
        `INSERT OR REPLACE INTO hippocampal_index (context_signature, memory_locations, calcium_boost, last_activated_at, experience_summary, created_at)
         VALUES (?, '["__exp__"]', 0.5, ?, ?, ?)`,
        [sig, new Date().toISOString(), summary.substring(0, 500), new Date().toISOString()]
      );
    } catch { /* 回写失败不阻塞 */ }
  }

  /** 从片段中提取人名 */
  private _extractPersonsFromSnippets(snippets: string[]): string[] {
    const names = new Set<string>();
    for (const s of snippets) {
      const matches = s.match(/[一-龥]{2,3}/g);
      if (!matches) continue;
      for (const m of matches) {
        if (!'了的在是我有和就不人会也把被让'.split('').some(c => m.includes(c))) {
          names.add(m);
        }
      }
    }
    return [...names].slice(0, 3);
  }
}
