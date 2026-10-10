/**
 * DailyMaintenanceScheduler — 每日维护调度器
 * ============================================
 * 统一触发知识库的日常维护任务：
 *   ① KnowledgeDecayEngine  — 知识衰减/休眠/垃圾清理
 *   ② EntityStrengthTracker — 实体关联强度衰减
 *   ③ PersonaFeedService    — 知识→M6 人格反哺
 *   ④ KnowledgeGrowthLogger — 生长日志记录
 *
 * 通过 M7 定时器每日触发一次（非严格日历日，首次启动后每24h触发）。
 *
 * 使用:
 *   const scheduler = new DailyMaintenanceScheduler(storage, m6);
 *   scheduler.start();  // 启动每日定时器
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import { KnowledgeDecayEngine } from './KnowledgeDecayEngine.js';
import { EntityStrengthTracker } from './EntityStrengthTracker.js';
import { PersonaFeedService } from './PersonaFeedService.js';
import { KnowledgeGrowthLogger } from './KnowledgeGrowthLogger.js';

const DAILY_INTERVAL_MS = 24 * 3600_000; // 24小时

export class DailyMaintenanceScheduler {
  private storage: FusionStorageAdapter;
  private m6: any;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastRunDate = '';

  constructor(storage: FusionStorageAdapter, m6?: any) {
    this.storage = storage;
    this.m6 = m6;
  }

  /** 启动每日定时器（设置后每24h检查一次） */
  start(): void {
    if (this._timer) return;
    // 启动后立即执行一次，然后每24h检查
    this._runOnce().catch(() => {});
    this._timer = setInterval(() => this._runOnce().catch(() => {}), DAILY_INTERVAL_MS);
    console.log('[DailyMaintenance] 定时器启动 (每24h)');
  }

  /** 注入 M6（延迟注入） */
  setM6(m6: any): void {
    this.m6 = m6;
    console.log('[DailyMaintenance] M6 已注入');
  }

  /** 停止定时器 */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 手动触发一次维护 */
  async runOnce(): Promise<{ decay: any; strength: number; persona: any }> {
    return this._runOnce();
  }

  private async _runOnce(): Promise<{ decay: any; strength: number; persona: any }> {
    const today = new Date().toISOString().substring(0, 10);
    // 避免同一天重复运行
    if (this._lastRunDate === today) return { decay: null, strength: 0, persona: null };
    this._lastRunDate = today;

    console.log('[DailyMaintenance] 🔄 开始每日维护...');
    const result = { decay: null as any, strength: 0, persona: null as any };

    // ⓪ 知识库行数骤降告警（P0-7b，2026-10-07）
    //   背景：2026-08-26→08-28 知识库从 68 条塌到 3 条，**两个月无人察觉**，直到业主问
    //     「怎么熊梓铭看不到知识库关于她的资料了」才被发现（见 docs/P0-6-...调查报告.md）。
    //   机制：与上次基线（engine_store 持久化）对比，降幅 >30% 即告警。
    //   🔴 只报告，不阻断、不自动修复 —— 与「知识库里的东西不能随便被清理，除非业主确认或手动」一致。
    //   确定性实现、零 LLM 调用。放在衰减之前，以便把本轮的降幅归因清楚。
    try {
      const kbSqlite = this.storage.getSQLite();
      if (kbSqlite) {
        const cur = Number((kbSqlite.queryAll('SELECT COUNT(*) c FROM knowledge_base')?.[0] as any)?.c ?? 0);
        const _kbKey = 'kb_count_baseline';
        const prevRow = kbSqlite.queryAll('SELECT value FROM engine_store WHERE key = ? LIMIT 1', [_kbKey]);
        const prev = prevRow?.[0] ? parseInt(String((prevRow[0] as any).value ?? ''), 10) : NaN;
        if (Number.isFinite(prev) && prev > 0 && cur < prev * 0.7) {
          const drop = prev - cur;
          const pct = ((drop / prev) * 100).toFixed(1);
          console.warn(`[DailyMaintenance] 🔴 知识库行数骤降: ${prev} → ${cur}（-${drop} 条 / -${pct}%）`);
          console.warn('[DailyMaintenance]    🔴 知识库禁止无确认清理 —— 请立即人工核查。' +
            '同类事故记录：68→3 条，两个月无人察觉（docs/P0-6-知识库人物档案丢失调查报告.md）');
        } else {
          console.log(`[DailyMaintenance] 知识库行数: ${cur}（基线 ${Number.isFinite(prev) ? prev : '首次记录'}）`);
        }
        kbSqlite.writeRaw('INSERT OR REPLACE INTO engine_store (key, value) VALUES (?, ?)', [_kbKey, String(cur)]);
      }
    } catch (err) {
      console.warn('[DailyMaintenance] 知识库行数校验失败(不阻塞):', err);
    }

    // ⓪-b 清「微信临时信息」（P0-8a，2026-10-07 立规；2026-10-08 加时间边界）
    //   业主原话（2026-10-07）：「微信信息每天晚上还要彻底清除避免污染」。
    //   🔴 这是**业主明文定义的例行清理规则**，也是「知识库只增不删」原则的**明文例外** ——
    //      不是脚本自行判断"看起来像垃圾"。判据是结构性的：source_name 以 'wechat_relay/' 开头。
    //
    // 🔴 2026-10-08 修正（业主：「要改」）：原为**无时间条件的全量 DELETE**。
    //   缺陷链：`_lastRunDate` 是**内存态**（见 `_runOnce` 开头），服务一重启即清零，
    //   而 `start()` 的语义是「启动后立即执行一次」⇒ **每次重启都全量清一遍**。
    //   实测：微信条目 909 → 0 全部发生在白天（pm2 当日 ↺20 次重启），此时中继侧
    //   `RETENTION_HOURS=24` 的 22:00 清扫**还没到** ⇒ 业主要求的「保留当天」被打破，
    //   玉瑶/诗雨白天查不到当天的外部消息。
    //   改法：只删**超过 24h** 的，与中继保留期同语义 —— 当天消息保得住，过期的照清。
    //   ⚠️ 本块新增 2 个条件分支（before>0 / deleted>0），已在此标记说明：
    //      一个是「没数据就不打日志」，一个是区分「本次删除 N 条」与「都在 24h 内不删」，
    //      两者都是**可观测性**必需（业主原则：清了没清必须看得见），非业务判断分支。
    try {
      const wkSqlite = this.storage.getSQLite();
      if (wkSqlite) {
        const before = Number((wkSqlite.queryAll("SELECT COUNT(*) c FROM knowledge_base WHERE source_name LIKE 'wechat_relay/%'")?.[0] as any)?.c ?? 0);
        if (before > 0) {
          // 与中继保留期同为 24h；created_at 为 ISO-8601 UTC，字符串比较即时间比较
          const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
          const res = wkSqlite.writeRaw(
            "DELETE FROM knowledge_base WHERE source_name LIKE 'wechat_relay/%' AND created_at < ?",
            [cutoff],
          );
          const deleted = Number((res as any)?.changes ?? 0);
          if (deleted > 0) {
            console.log(`[DailyMaintenance] 🧹 微信过期清理(>24h): 删除 ${deleted} 条（阈值 ${cutoff}）`);
          } else {
            console.log(`[DailyMaintenance] 微信条目 ${before} 条均未超 24h，本次不清理`);
          }
        }
      }
    } catch (err) {
      console.warn('[DailyMaintenance] 微信临时信息清理失败(不阻塞):', err);
    }

    try {
      // ① 知识衰减
      const decayEngine = new KnowledgeDecayEngine(this.storage);
      result.decay = await decayEngine.runDaily();
    } catch (err) {
      console.warn('[DailyMaintenance] 知识衰减失败:', err);
    }

    try {
      // ④ 世界关系图谱维护
      const sqlite = this.storage.getSQLite();
      const fg = (globalThis as any).__familyGraph;
      if (fg && sqlite) {
        const { FGMaintenance } = await import('../../app/fg/FGMaintenance.js');
        const fgMaint = new FGMaintenance(sqlite);
        const fgReport = await fgMaint.runDaily();
        result.strength = fgReport.inferences;

        // V4.0: 实体生命周期闭环 (每日批量状态流转)
        try {
          const { LifecycleManager } = await import('../../m4/household/LifecycleManager.js');
          const lm = new LifecycleManager(fg);
          const lifecycleReport = await lm.runDaily();
          if (lifecycleReport.activeToDormant > 0 || lifecycleReport.dormantToArchived > 0 || lifecycleReport.dormantToActive > 0) {
            console.log('[DailyMaintenance] 生命周期闭环: ' +
              (lifecycleReport.activeToDormant > 0 ? `active→dormant ${lifecycleReport.activeToDormant}人 ` : '') +
              (lifecycleReport.dormantToActive > 0 ? `dormant→active ${lifecycleReport.dormantToActive}人 ` : '') +
              (lifecycleReport.dormantToArchived > 0 ? `dormant→archived ${lifecycleReport.dormantToArchived}人` : '')
            );
          }
        } catch (e2) { console.warn('[DailyMaintenance] 生命周期闭环失败:', (e2 as Error)?.message || e2); }

        // V4.0: 占位实体自动升级 (placeholder → real)
        if (fg && typeof fg.runDailyHouseholdMaintenance === 'function') {
          try {
            var hmResult = fg.runDailyHouseholdMaintenance();
            if (hmResult.dirtyNames > 0 || hmResult.placeholders > 0 || hmResult.lifecycle > 0) {
              var parts = []; if (hmResult.dirtyNames > 0) parts.push('dirty:' + hmResult.dirtyNames); if (hmResult.placeholders > 0) parts.push('placeholder:' + hmResult.placeholders); if (hmResult.lifecycle > 0) parts.push('lifecycle:' + hmResult.lifecycle); console.log('[DailyMaintenance] household: ' + parts.join(' | '));
            }
          } catch (e3) { console.warn('[DailyMaintenance] household fail: ' + (e3 as Error).message); }
        }
      }
    } catch (err) {
      console.warn('[DailyMaintenance] FG 维护失败:', err);
    }

    // 🆕 V4.0·Phase 4: 知识优化 — 优先级升级 + 关联标签
    try {
      const evoDb = this.storage.getSQLite();
      if (evoDb) {
        // 4.2 优先级升级: recall_count >= 3 的条目提高 impression_score
        const promoted = evoDb.queryAll(
          "SELECT id, title, recall_count, impression_score FROM knowledge_base WHERE recall_count >= 3 AND impression_score < 0.7 AND classification_pending = 0 LIMIT 20"
        );
        if (promoted && promoted.length > 0) {
          for (const p of promoted) {
            const row = p as any;
            evoDb.writeRaw(
              "UPDATE knowledge_base SET impression_score = MIN(1.0, COALESCE(impression_score, 0.5) + 0.1), updated_at = datetime('now') WHERE id = ?",
              [row.id]
            );
          }
          console.log('[DailyMaintenance] 知识升级: ' + promoted.length + '条高频知识升级');
        }

        // 4.3 关联: 标 same-entity 的知识条目互相打 tag
        const grouped = evoDb.queryAll(
          "SELECT belong_entity_uuid, COUNT(*) as cnt FROM knowledge_base WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' GROUP BY belong_entity_uuid HAVING cnt >= 2 LIMIT 20"
        );
        if (grouped && grouped.length > 0) {
          let linked = 0;
          for (const g of grouped) {
            const grp = g as any;
            evoDb.writeRaw(
              "UPDATE knowledge_base SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', 'linked_entity') WHERE belong_entity_uuid = ? AND tags NOT LIKE '%linked_entity%'",
              [grp.belong_entity_uuid]
            );
            linked += (grp.cnt as number);
          }
          if (linked > 0) console.log('[DailyMaintenance] 知识关联: ' + linked + '条已打关联标签');
        }
      }
    } catch (e5) { console.warn('[DailyMaintenance] 知识演化失败:', (e5 as Error).message); }

    try {
      // 🔥 睡眠期巩固 (SleepTime Consolidator)
      const _stSqlite = this.storage.getSQLite();
      if (_stSqlite) {
        const { SleepTimeConsolidator } = await import('../../app/brain/SleepTimeConsolidator.js');
        const stc = new SleepTimeConsolidator(this.storage);
        const sleepReport = await stc.runDaily(24);
        console.log('[DailyMaintenance] 睡眠期巩固:', JSON.stringify(sleepReport));
      }
    } catch (err) {
      console.warn('[DailyMaintenance] 睡眠期巩固失败:', err);
    }

    try {
      // ② 实体关联强度衰减
      const strengthTracker = new EntityStrengthTracker(this.storage);
      result.strength = await strengthTracker.decayAll();
      await strengthTracker.cleanStale();
    } catch (err) {
      console.warn('[DailyMaintenance] 实体衰减失败:', err);
    }

    try {
      // ③ 人格反哺（需要 M6 实例）
      if (this.m6) {
        const personaFeed = new PersonaFeedService(this.storage, this.m6);
        result.persona = await personaFeed.dailyFeed();
      }
    } catch (err) {
      console.warn('[DailyMaintenance] 人格反哺失败:', err);
    }

    try {
      // ④ 生长日志
      const logger = new KnowledgeGrowthLogger(this.storage);
      await logger.log({
        eventType: 'prune',
        knId: 'daily_maintenance',
        detail: `衰减:${result.decay?.impressionDecayed ?? 0}条 休眠:${result.decay?.dormantMarked ?? 0}条 冲突:${result.decay?.conflictSuppressed ?? 0}条 清理:${result.decay?.staleCleaned ?? 0}条 实体衰减:${result.strength}条`,
        deltaCalcium: 0,
      });
    } catch { /* 日志失败不阻塞 */ }

    // V4.0 Phase 4: 月度对话主题提取（每30天一次，fire-and-forget）
    const _lastTopicRunKey = 'last_monthly_topic_run';
    const _days = Math.floor(Date.now() / 86400000);
    const _prevRun = (() => {
      try {
        const r = this.storage.getSQLite()?.queryAll(
          "SELECT value FROM engine_store WHERE key = ? LIMIT 1", [_lastTopicRunKey]
        );
        return r?.[0] ? parseInt((r[0] as any).value || '0', 10) : 0;
      } catch { return 0; }
    })();
    if (_days - _prevRun >= 30) {
      setImmediate(() => {
        try {
          const sqlite = this.storage.getSQLite();
          if (!sqlite) return;
          const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
          const rows = sqlite.queryAll(
            "SELECT content FROM conversations WHERE role='user' AND timestamp > ? AND roleplay_char IS NULL AND content IS NOT NULL LIMIT 500",
            [cutoff]
          );
          if (!rows?.length) return;
          const words = new Map<string, number>();
          const stopWords = new Set('的了在是我有不和就人也把被让从对跟说会着没看好看一看是一样能到下而去及但'.split(''));
          for (const r of rows) {
            const text = (r as any).content || '';
            const matches = text.match(/[一-龥]{2,4}/g) || [];
            for (const w of matches) {
              if (w.split('').some((c: string) => stopWords.has(c))) continue;
              words.set(w, (words.get(w) || 0) + 1);
            }
          }
          const top10 = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
          if (top10.length > 0) {
            // 🔴🔴 P0-8a(2026-10-07) 已**移除此处对 knowledge_base 的写入**（原为 `monthly_topic`
            //   「对话主题月报」类，正文约 130 字）。
            //   业主定义的边界：知识库**只存文档 + 微信临时信息**。月度主题是系统分析产物、不是文档；
            //   留在库里只会稀释检索 —— 短条目在 KnowledgeEngine.weightedSearch 里凭 titleBoost
            //   （标题命中最高 3 倍）反而更容易压过长文档。
            //   主题词本身仍照常计算并打进日志，调度基线照常推进；只是不再落进知识库。
            const monthStr = new Date().toISOString().substring(0, 7);
            sqlite.writeRaw(
              "INSERT OR REPLACE INTO engine_store (key, value) VALUES (?, ?)",
              [_lastTopicRunKey, String(_days)]
            );
            console.log('[DailyMaintenance] 📊 月度主题(' + monthStr + '，不入知识库): ' + top10.map(([w]) => w).join(', '));
          }
        } catch { /* 月度主题提取失败不阻塞 */ }
      });
    }

    // V4.0 Phase 5: 周度记忆自省（每7天一次，扫描矛盾/编造模式/过期关系）
    const _lastReviewKey = 'last_weekly_selfreview';
    const _prevReview = (() => {
      try {
        const r = this.storage.getSQLite()?.queryAll(
          "SELECT value FROM engine_store WHERE key = ? LIMIT 1", [_lastReviewKey]
        );
        return r?.[0] ? parseInt((r[0] as any).value || '0', 10) : 0;
      } catch { return 0; }
    })();
    if (_days - _prevReview >= 7) {
      setImmediate(async () => {
        try {
          const { MemorySelfReview } = await import('../../app/selfreview/MemorySelfReview.js');
          const sr = new MemorySelfReview(this.storage);
          const srReport = await sr.review();
          const sqlite = this.storage.getSQLite();
          sqlite?.writeRaw(
            "INSERT OR REPLACE INTO engine_store (key, value) VALUES (?, ?)",
            [_lastReviewKey, String(_days)]
          );
          console.log('[DailyMaintenance] 🔍 周度自省:', srReport.actions.join('; '));
        } catch (e) { console.warn('[DailyMaintenance] 周度自省失败', (e as Error)?.message || e); }
      });
    }

    console.log('[DailyMaintenance] ✅ 完成');
    return result;
  }

  /** 手动触发（对外暴露） */
  get lastRunDate(): string { return this._lastRunDate; }
}

