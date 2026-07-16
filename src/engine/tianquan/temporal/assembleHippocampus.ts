/**
 * assembleHippocampus.ts — 海马体组件装配器 (V2.0 统一调度)
 * ==========================================================
 * 将所有海马体组件统一注册到 HippocampusRhythmCoordinator。
 * coordinator 的 10s 心跳完全替代原有的独立 setInterval。
 *
 * V2.0: 不再与旧定时器并行 —— 旧定时器在 server.ts 中已禁用。
 *       所有离线任务由 coordinator 根据节律统一调度。
 *
 * 在 server.ts initPipeline() 末尾调用 assembleAndStartHippocampus()。
 */
import {
  HippocampusRhythmCoordinator,
  initHippocampusCoordinator,
  HippocampusRhythm,
  type RhythmComponent,
} from './HippocampusRhythmCoordinator.js';
import type { FusionStorageAdapter } from '../../../m2/FusionStorageAdapter.js';
import type { M7Orchestrator } from '../../../m7/M7Orchestrator.js';
import type { ConsolidationQueue } from '../../../m7/ConsolidationQueue.js';
import type { InductionScheduler } from '../../../m7/InductionScheduler.js';
import { SleepTimeConsolidator } from './SleepTimeConsolidator.js';
import { HippocampalIndex } from './HippocampalIndex.js';

export interface HippocampusDeps {
  storage: FusionStorageAdapter;
  m7: M7Orchestrator;
  consolidationQueue: ConsolidationQueue;
  inductionScheduler: InductionScheduler;
}

// ═══════════════════════════════════════════════════════
//  组件任务包装
// ═══════════════════════════════════════════════════════

/** M7 梦境引擎 — 梦境队列内化 + 四维分析 */
function createM7Tasks(m7: M7Orchestrator): RhythmComponent {
  return {
    name: 'M7-DreamEngine',
    tasks: [
      {
        name: 'm7.processIdle',
        rhythm: HippocampusRhythm.SWR,
        intervalMs: 60_000,
        execute: async () => {
          if (!m7.shouldProcessQueue()) return 0;
          const result = await m7.processIdle();
          m7.cleanResolvedQueue();
          return result.internalized;
        },
      },
      {
        name: 'm7.processDreamAnalysis',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 5 * 60_000,
        execute: async () => {
          await m7.processDreamAnalysis();
          return 1;
        },
      },
    ],
  };
}

/** ConsolidationQueue — 记忆巩固晋升地标 (替代原有 30s 空闲检测) */
function createConsolidationTasks(cq: ConsolidationQueue): RhythmComponent {
  return {
    name: 'ConsolidationQueue',
    tasks: [
      {
        name: 'cq.runConsolidation',
        rhythm: HippocampusRhythm.SWR,
        intervalMs: 30_000,
        execute: async () => cq.runConsolidation(),
      },
    ],
  };
}

/** InductionScheduler — 情感归纳 (替代原有每小时 setInterval) */
function createInductionTasks(indSched: InductionScheduler): RhythmComponent {
  return {
    name: 'InductionScheduler',
    tasks: [
      {
        name: 'induction.runInduction',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 60 * 60_000,
        execute: async () => {
          await indSched.runInduction();
          return 1;
        },
      },
      {
        name: 'induction.buildEntityRelations',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 60 * 60_000,
        execute: async () => {
          indSched.triggerEntityRelations();
          return 1;
        },
      },
    ],
  };
}

/** SleepTimeConsolidator — 睡眠期巩固 6 阶段流水线 (替代 DailyMaintenanceScheduler 中的调用) */
function createSleepTimeTasks(storage: FusionStorageAdapter): RhythmComponent {
  const consolidator = new SleepTimeConsolidator(storage);
  (globalThis as any).__sleepTimeConsolidator = consolidator;

  return {
    name: 'SleepTimeConsolidator',
    tasks: [
      {
        name: 'sleepTime.runDaily',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 6 * 3600_000, // 每 6 小时（渐进式，根据实际空闲时间决定执行哪些阶段）
        execute: async () => {
          const hours = consolidator.getHoursSinceLastActive();
          const report = await consolidator.runDaily(hours);
          return report.sandToGold + report.goldToDiamond + report.semanticInductions + report.crossSessionLinks + report.forgotten;
        },
      },
    ],
  };
}

/** CoreMemoryManager — 定期刷新用户画像 */
function createCoreMemoryTasks(): RhythmComponent {
  return {
    name: 'CoreMemoryManager',
    tasks: [
      {
        name: 'coreMemory.refreshProfile',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 6 * 3600_000,
        execute: async () => {
          const cm = (globalThis as any).__coreMemory;
          if (cm && typeof cm.refreshFromProfile === 'function') {
            await cm.refreshFromProfile();
            return 1;
          }
          return 0;
        },
      },
    ],
  };
}

/** SelectiveForgetting — 过期遗忘清理 + 每日维护 (替代 DailyMaintenanceScheduler) */
function createDailyMaintenanceTasks(storage: FusionStorageAdapter): RhythmComponent {
  return {
    name: 'DailyMaintenance',
    tasks: [
      {
        name: 'dailyMaint.knowledgeDecay',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 24 * 3600_000,
        execute: async () => {
          // 检查是否已有 DailyMaintenanceScheduler 实例
          const dm = (globalThis as any).__dailyMaintenanceScheduler;
          if (dm && typeof dm.runOnce === 'function') {
            await dm.runOnce();
            return 1;
          }
          return 0;
        },
      },
      {
        name: 'forgetting.suppressedCleanup',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 24 * 3600_000,
        execute: async () => {
          const sqlite = storage.getSQLite();
          if (!sqlite) return 0;
          const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
          const result = sqlite.writeRaw(
            "DELETE FROM memories WHERE lifecycle_state = 'suppressed' AND created_at < ?",
            [cutoff]
          );
          const deleted = (result as any)?.changes || 0;
          if (deleted > 0) console.log(`[Hippocampus] 清理过期遗忘: ${deleted} 条`);
          return deleted;
        },
      },
    ],
  };
}

/** 海马体稀疏索引维护 — 定期清理过期索引 + 晋升永久索引 */
function createHippocampalIndexMaintenance(storage: FusionStorageAdapter): RhythmComponent {
  return {
    name: 'HippocampalIndex',
    tasks: [
      // V4.0 Phase 3: 记忆自省 — 每周扫描幻觉日志+矛盾检测+过期关系
      {
        name: 'selfReview.weekly',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 7 * 24 * 3600_000, // 每周
        execute: async () => {
          try {
            const { MemorySelfReview } = await import('../../../app/selfreview/MemorySelfReview.js');
            const reviewer = new MemorySelfReview(storage);
            const report = await reviewer.review();
            if (report.conflicts > 0 || report.hallucinationPatterns.length > 0) {
              console.log('[SelfReview] 周度自省: ' + report.conflicts + ' 冲突, ' + report.hallucinationPatterns.length + ' 幻觉模式');
            }
            return report.conflicts;
          } catch { return 0; }
        },
      },
      {
        name: 'hippocampalIndex.dailyMaintenance',
        rhythm: HippocampusRhythm.DELTA,
        intervalMs: 24 * 3600_000,
        execute: async () => {
          const sqlite = storage.getSQLite();
          if (!sqlite) return 0;
          const idx = new HippocampalIndex(sqlite);
          return idx.runDailyMaintenance();
        },
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════════════

/**
 * 装配所有海马体组件并启动统一节律调度器。
 *
 * V2.0: coordinator 统一心跳完全替代以下旧定时器：
 *   - startM7Interval(m7)       → m7.processIdle + m7.processDreamAnalysis
 *   - consolidationQueue.start() → cq.runConsolidation
 *   - inductionScheduler.start() → indSched.runInduction + triggerEntityRelations
 *   - DailyMaintenanceScheduler  → SleepTimeConsolidator + Forgetting cleanup
 *
 * 旧定时器在 server.ts 中不再启动。
 *
 * @returns coordinator 实例，供 chat.ts 和 API 路由使用
 */
export function assembleAndStartHippocampus(deps: HippocampusDeps): HippocampusRhythmCoordinator {
  const { storage, m7, consolidationQueue, inductionScheduler } = deps;

  const hrc = initHippocampusCoordinator(storage);

  // 按节律分组注册 — SWR（回放巩固）优先，DELTA（深度整理）随后
  hrc.register(createM7Tasks(m7));
  hrc.register(createConsolidationTasks(consolidationQueue));
  hrc.register(createInductionTasks(inductionScheduler));
  hrc.register(createSleepTimeTasks(storage));
  hrc.register(createCoreMemoryTasks());
  hrc.register(createDailyMaintenanceTasks(storage));
  hrc.register(createHippocampalIndexMaintenance(storage));

  hrc.start();
  (globalThis as any).__hippocampusCoordinator = hrc;

  const report = hrc.getReport();
  console.log(`[Hippocampus] 装配完成 · ${report.activeTaskCount} 个活跃任务 · 节律: ${report.currentRhythm}`);
  return hrc;
}
