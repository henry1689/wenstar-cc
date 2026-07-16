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
      }
    } catch (err) {
      console.warn('[DailyMaintenance] FG 维护失败:', err);
    }

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
            const summary = `本月对话主题 Top10:\n${top10.map(([w, c], i) => `${i + 1}. ${w} (${c}次)`).join('\n')}`;
            const monthStr = new Date().toISOString().substring(0, 7);
            const knId = `topic_${monthStr.replace('-', '')}`;
            sqlite.writeRaw(
              `INSERT OR REPLACE INTO knowledge_base (id, title, content, source_type, tags, created_at, updated_at, classification, classification_pending)
               VALUES (?, ?, ?, 'monthly_topic', ?, datetime('now'), datetime('now'), '对话主题月报', 0)`,
              [knId, `对话主题月报 ${monthStr}`, summary,
               JSON.stringify(['monthly_topic', monthStr, ...top10.slice(0, 5).map(([w]) => w)])]
            );
            sqlite.writeRaw(
              "INSERT OR REPLACE INTO engine_store (key, value) VALUES (?, ?)",
              [_lastTopicRunKey, String(_days)]
            );
            console.log('[DailyMaintenance] 📊 月度主题: ' + top10.map(([w]) => w).join(', '));
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
