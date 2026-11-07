/**
 * MaintenanceService — 玉瑶 · 太虚境 后台维护引擎
 *
 * 定时任务：
 * - 进程健康检查（内存、事件循环）
 * - 对话记忆压缩（旧轮次→摘要）
 * - M2 存储 GC（清理过期记录）
 * - 缓存清理（tsx 等）
 *
 * 所有指标通过 getHealth() 暴露给前端。
 */

// MaintenanceService 接受的存储类型：FusionStorageAdapter 或兼容接口
type AnyStorage = { getStatus(): Promise<{ totalRecords: number }> | { totalRecords: number } };

import { FGHealthCheck } from '../app/fg/FGHealthCheck.js';
// 🔴 V23.1(2026-09-13): 压缩/窗口参数唯一事实源 —— 原为本地硬编码，与 MemoryConfig、config.ts
//   三处漂移（40/20 vs 200/100）。现统一从 MEMORY_CONFIG.compaction 取。
import { MEMORY_CONFIG } from '../config/MemoryConfig.js';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;               // 秒
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    // 🔴 2026-10-28 补齐堆外视野：`--max-old-space-size` 只约束 heapUsed，而实测堆只用
    //   117MB、rss 却达 867MB（差额 ~700MB 全在堆外）。external / arrayBuffers 正是
    //   sql.js 的 WASM 内存与 db.export() 缓冲的归属地 —— 不报就看不见「零日志死亡」的真凶。
    externalMB: number;
    arrayBuffersMB: number;
  };
  conversations: {
    total: number;
    oldestAgeHours: number;     // 最早对话距今小时
  };
  storage: {
    totalRecords: number;
    totalSizeKB: number;
  };
  lastMaintenance: {
    compaction: string | null;  // ISO 时间
    gc: string | null;
  };
  eventLoopLag: number;         // ms
}

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────

export interface MaintenanceConfig {
  /** 批13: 实体离线终审间隔（默认 24h；建档不频繁，低频即可） */
  entityTriageInterval?: number;
  /**
   * V50 终审吞吐(2026-10-12): 每个 24h 周期内连跑几轮终审。默认 14 轮 × 单批 15 = 210。
   *
   * 🔴 每日吞吐由**轮数**承担，单批 15 **不可加大** —— 这是实证结论，不是保守取值：
   *    pm2 日志 75 次实测，单批 22/23/24/26/30 **全部**落在 `观察N`（整轮未判定），
   *    成功轮次一律 `观察0`；`EntityTriageService.ts:90` 亦注明 DEFAULT_TRIAGE_BATCH
   *    与 JUDGE_MAX_TOKENS 是一组、**勿单独调其一**（30→15 正是为修此故障调下来的）。
   *    2026-10-12 实测单批 22/23/24/26/30 **整轮白跑**（现象，**机制未归因**——勿套用
   *    V45 已证伪的「输出被截断」说，那条已由剥离器修复 fb7e924 解决）。
   * 业主 2026-10-12 目标「每天 200 个」，故 14 轮（210 ≥ 200）。
   * **后续调整吞吐只改这一个数。**
   */
  entityTriageRounds?: number;
  /** 对话压缩间隔 (ms) — 默认 5 分钟 */
  compactionInterval: number;
  /** 存储 GC 间隔 (ms) — 默认 30 分钟 */
  gcInterval: number;
  /** 记忆衰减维护间隔 (ms) — 默认 15 分钟 */
  decayInterval: number;
  /** 对话历史超过此数量触发压缩 */
  compactionThreshold: number;
  /** 压缩后保留的完整对话轮数 */
  keepFullTurns: number;
  /** M2 存储保留的最大记录数（超出则 GC） */
  maxStorageRecords: number;
  /** 健康检查间隔 (ms) — 默认 15 秒 */
  healthCheckInterval: number;
  /** 事件循环延迟告警阈值 (ms) */
  eventLoopWarnThreshold: number;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  compactionInterval: 5 * 60 * 1000,      // 5 分钟
  gcInterval: 30 * 60 * 1000,             // 30 分钟
  decayInterval: 15 * 60 * 1000,          // 15 分钟
  // V23.1: 取自 MEMORY_CONFIG.compaction（唯一事实源），不再本地硬编码。
  //   历史：此处曾是 200/100 硬编码，而 config.ts/maintenance 是 40/20、MemoryConfig 是 200/100，
  //   三处漂移且只有本处生效 —— 现归一。
  compactionThreshold: MEMORY_CONFIG.compaction.threshold,
  keepFullTurns: MEMORY_CONFIG.compaction.keepFullTurns,
  maxStorageRecords: 500,                  // M2 最多 500 条
  healthCheckInterval: 15 * 1000,         // 15 秒
  eventLoopWarnThreshold: 200,            // 200ms 告警
};

// ──────────────────────────────────────────────
// 维护服务
// ──────────────────────────────────────────────

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  /** ISO 时间戳（chat.ts 存储时写入，用于健康报告计算最早记录时间） */
  timestamp?: string;
}

/**
 * 🔴 B（2026-09-22）：LLM 摘要超时（毫秒）—— 压缩流程不得被摘要久等阻塞
 *
 * 🔴 2026-10-30 对齐修正：20s → 50s。
 *   外层定时器必须**严格大于** LLM 调用自身的超时，否则它只是提前杀死本可成功的调用。
 *   内层（DeepSeekLLMProvider rawCall）＝45s，而本常量原为 20s ⇒ 外层恒先到。
 *   实测：本轮 47 次摘要失败中 **46 次是 `compaction summary timeout`**，摘要长期退化成
 *   「取前 160 字」的机械压缩。现取 50s，让调用自己的 45s 说了算，本常量只作最后兜底。
 *   ⚠️ 改这里时必须同步检查内层超时，二者是同一件事的两端。
 */
const COMPACTION_SUMMARY_TIMEOUT_MS = 50_000;

/**
 * V50 终审吞吐(2026-10-12): 默认轮数 = 14（14 × 单批 15 = 210 ≥ 业主目标 200/天）。
 * 单批 15 的上限依据见 `MaintenanceConfig.entityTriageRounds` 注释，勿改单批。
 */
const TRIAGE_ROUNDS_DEFAULT = 14;
/** V50: 终审轮间延迟（毫秒）—— 14 轮串行直打 LLM，留间隔避免连发 */
const TRIAGE_ROUND_GAP_MS = 2_000;

/**
 * 🔴 B：把 LLM 输出规范成“单段摘要”（纯函数，便于单测）
 * - 去换行/多余空白；去可能的 `【对话摘要】`/`【历史对话】` 前缀（防嵌套）；
 * - 限长 maxLen（超长截断加省略号）；空/仅空白 ⇒ 返回空串（调用方回退机械压缩）。
 */
export function normalizeCompactionSummary(raw: string, maxLen = 400): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^【对话摘要】/, '').replace(/^【历史对话】/, '').trim();
  if (!s) return '';
  if (s.length > maxLen) s = s.substring(0, maxLen) + '…';
  return s;
}

/**
 * 🔴 B：构造摘要提示词（纯函数）—— 保留人物/事件/情感基调/未竟约定，禁止编造。
 * 超长时**保留尾部**（最近的对话对连贯性更重要）。
 */
export function buildCompactionPrompt(turns: Array<{ role: string; content: string }>, maxChars = 3000): string {
  const lines = turns
    .map(function(t) { return (t.role === 'user' ? '鸿艺' : '她') + ': ' + String(t.content ?? '').replace(/\s+/g, ' '); })
    .filter(function(l) { return l.length > 3; })
    .join('\n');
  const body = lines.length > maxChars ? lines.slice(-maxChars) : lines;
  return (
    '把下面这段对话压缩成一段**第三人称**摘要（80–200 字）：\n' +
    '- 保留：人物、事件、情感基调、她说过的承诺与未完成的约定；\n' +
    '- 只写对话中真实出现的信息，禁止推测或编造；\n' +
    '- 只输出摘要正文，不要加前后缀、不要换行。\n\n' +
    body
  );
}

export class MaintenanceService {
  private config: MaintenanceConfig;
  private startTime = Date.now();
  private lastCompaction: string | null = null;
  private lastGc: string | null = null;
  private knowledgeGcTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopLag = 0;

  private compactionTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  private entityTriageTimer: ReturnType<typeof setInterval> | null = null;
  private slidingJunkCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** 批13: 实体离线终审执行器（注入式 —— Maintenance 不感知 LLM 与 FamilyGraph） */
  private entityTriageRunner: (() => Promise<{ scanned: number; promoted: number; annotated: number; kept: number; skipped: boolean; error?: string }>) | null = null;

  // 外部依赖（由 server.ts 注入）
  private conversationHistory: ConversationTurn[] = [];
  private getConversationHistory: () => ConversationTurn[] = () => [];
  private setConversationHistory: (h: ConversationTurn[]) => void = () => {};
  private saveConversationHistory: () => void = () => {};
  private storage: AnyStorage | null = null;
  /**
   * 批13: 注入实体离线终审执行器。
   * 注入式设计 —— MaintenanceService 只负责「何时跑」，不关心「怎么判」，
   * 因此不依赖 LLM provider 与 FamilyGraph（保持本类可独立测试）。
   */
  setEntityTriage(runner: typeof this.entityTriageRunner): void {
    this.entityTriageRunner = runner;
  }

  /**
   * 批13 → V50 终审吞吐(2026-10-12): 执行一个 24h 周期内的**多轮**实体离线终审。
   * 无候选时 runner 内部直接跳过（零 LLM 调用）。失败只记录，绝不影响其他维护任务。
   *
   * 为什么是多轮而不是把单批改大：见 `MaintenanceConfig.entityTriageRounds` 注释 ——
   * 单批 15 是实证安全上限，每日吞吐只能由轮数承担。
   *
   * fail-fast 判据 = **本轮零进展**（promoted + annotated === 0）：
   *   `applyJudgments` 的入参只有 promote/annotate 两组，`keepObserving` **不传进去**
   *   ⇒ 判成 unknown 的节点不写任何 `_judge` 标记 ⇒ 下一轮 `collectCandidateItems`
   *   会原样再取到同一批。零进展后继续跑等于空转重复计费（历史 `扫描30 观察30`×11 即此形态）。
   */
  private async runEntityTriage(): Promise<void> {
    if (!this.entityTriageRunner) return;
    const rounds = this.config.entityTriageRounds ?? TRIAGE_ROUNDS_DEFAULT;
    const sum = { scanned: 0, promoted: 0, annotated: 0, kept: 0 };
    let completed = 0;
    let stopped: string | null = null;

    for (let i = 0; i < rounds; i++) {
      let r: { scanned: number; promoted: number; annotated: number; kept: number; skipped: boolean; error?: string };
      try {
        r = await this.entityTriageRunner();
      } catch (e: any) {
        stopped = '第' + (i + 1) + '轮异常: ' + (e?.message || e);
        break;
      }
      // skipped 含「无候选」与「已有终审在进行中」两种，二者都不应继续消耗剩余轮次
      if (r.skipped) { stopped = r.error || '无候选可判'; break; }
      if (r.error) { console.warn('[Maintenance] 实体终审失败(非阻塞): ' + r.error); stopped = r.error; break; }

      sum.scanned += r.scanned; sum.promoted += r.promoted;
      sum.annotated += r.annotated; sum.kept += r.kept;
      completed++;

      if (r.promoted + r.annotated === 0) {
        stopped = '第' + (i + 1) + '轮零进展（观察' + r.kept + '）— 队列未前进，停止以免空转';
        break;
      }
      // 轮间小延迟，避免连续直打 LLM；最后一轮不等
      if (i < rounds - 1) await new Promise((res) => setTimeout(res, TRIAGE_ROUND_GAP_MS));
    }

    // 完全无候选 → 沿用原语义静默（不刷日志）；其余情况必须可见（含部分完成）
    if (completed === 0) {
      if (stopped && stopped !== '无候选可判') console.warn('[Maintenance] 实体终审未开跑: ' + stopped);
      return;
    }
    console.log(
      '[Maintenance] 实体终审: ' + completed + '/' + rounds + '轮' +
      ' 扫描' + sum.scanned + ' 提升' + sum.promoted +
      ' 标注' + sum.annotated + ' 观察' + sum.kept +
      (stopped ? ' | 停止: ' + stopped : ''),
    );
  }

  /**
   * 滑窗垃圾实体自检（2026-10-23，长期兑底预警）
   * 复用 FGHealthCheck.detectSlidingWindowJunk（判据单一真源）。
   * 只预警不自动 void —— 避免误杀真人，是否清除由人工/离线终审定夺。
   * 发现疑似即 console.warn 高亮，供每日体检/日志回溯。
   */
  private runSlidingWindowSelfCheck(): void {
    const fg = this.familyGraph ?? (this._fgGetter ? this._fgGetter() : null);
    if (!fg) return;
    try {
      const report = new FGHealthCheck(fg);
      const suspects = report.detectSlidingWindowJunk();
      if (suspects.length > 0) {
        const names = suspects.map(s => s.name + '(尾:' + s.tail + ',提及' + s.mentions + ')').join(', ');
        console.warn('[FG SelfCheck] ⚠️ 疑似滑窗垃圾实体 ' + suspects.length + ' 个，建议人工核实后 void: ' + names);
      } else {
        console.log('[FG SelfCheck] 滑窗垃圾自检通过：无疑似实体');
      }
    } catch (e: any) {
      // 自检失败绝不阻塞主链路
      console.warn('[FG SelfCheck] 自检失败(非阻塞):', e?.message || e);
    }
  }

  private runDecay: () => Promise<{ total: number; archived: number }> = async () => ({ total: 0, archived: 0 });
  /** B：注入的 LLM 摘要器（null = 未注入 ⇒ 全程机械压缩） */
  private _summarizeTurns: ((turns: Array<{ role: string; content: string }>) => Promise<string>) | null = null;
  private _sqliteGetter: (() => any | null) | null = null;
  private familyGraph: any | null = null;
  private _fgGetter: (() => any) | null = null;

  constructor(config?: Partial<MaintenanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 启动事件循环延迟监测
    this.startEventLoopMonitor();
  }

  // ─── 注入依赖（由 server.ts 调用） ───

  injectDeps(deps: {
    conversationHistory: ConversationTurn[];
    getConversationHistory: () => ConversationTurn[];
    setConversationHistory: (h: ConversationTurn[]) => void;
    saveConversationHistory: () => void;
    storage: AnyStorage | (() => AnyStorage);
    /** 记忆衰减维护函数 */
    runDecay?: () => Promise<{ total: number; archived: number }>;
    /** 知识库过期无分类条目清理（铁律：3个月无分类视为垃圾） */
    runKnowledgeGc?: () => number;
    /** 记事记忆过期清理 */
    runNoteGc?: () => number;
    /** 砂金库→金库关联：压缩时查 M2 是否已存（提供 SQLite queryAll） */
    _sqliteGetter?: () => any | null;
    /** 家族图谱主库（双写人名抢救用） */
    familyGraph?: any;
    /**
     * 🔴 B（2026-09-22）：把一段对话压缩成**真实摘要**（由 server.ts 注入 LLM 实现）。
     *   保持本类“不感知 LLM”的既有设计（与 runDecay / entityTriageRunner 同风格）；
     *   未注入或抛错/超时 ⇒ 回退机械压缩（原行为），**不阻塞压缩流程**。
     */
    summarizeTurns?: (turns: Array<{ role: string; content: string }>) => Promise<string>;
  }): void {
    this.conversationHistory = deps.conversationHistory;
    this.getConversationHistory = deps.getConversationHistory;
    this.setConversationHistory = deps.setConversationHistory;
    this.saveConversationHistory = deps.saveConversationHistory;
    this.storage = typeof deps.storage === 'function' ? null : deps.storage;
    if (typeof deps.storage === 'function') {
      this._storageGetter = deps.storage as () => AnyStorage;
    }
    if (deps.runDecay) this.runDecay = deps.runDecay;
    if (deps.summarizeTurns) this._summarizeTurns = deps.summarizeTurns;
    if (deps.runKnowledgeGc) this._runKnowledgeGc = deps.runKnowledgeGc;
    if (deps.runNoteGc) this._runNoteGc = deps.runNoteGc;
    if (deps._sqliteGetter) this._sqliteGetter = deps._sqliteGetter;
    if (deps.familyGraph) {
      this.familyGraph = typeof deps.familyGraph === 'function' ? null : deps.familyGraph;
      if (typeof deps.familyGraph === 'function') {
        this._fgGetter = deps.familyGraph as () => any;
      }
    }
  }

  private _runKnowledgeGc: () => number = () => 0;
  private _runNoteGc: (() => number) | null = null;

  private _storageGetter: (() => AnyStorage) | null = null;

  // ─── 启动/停止 ───

  start(): void {
    console.log('[Maintenance] 启动维护引擎');

    // 对话压缩定时器
    this.compactionTimer = setInterval(() => {
      this.runCompaction().catch(e =>
        console.error('[Maintenance] 对话压缩失败:', e)
      );
    }, this.config.compactionInterval);

    // 存储 GC 定时器
    this.gcTimer = setInterval(() => {
      this.runGC().catch(e =>
        console.error('[Maintenance] 存储GC失败:', e)
      );
    }, this.config.gcInterval);

    // 知识库未分类条目 GC（3个月无分类彻底删除 — 铁律）
    // 记事记忆过期清理（365天）
    this.knowledgeGcTimer = setInterval(() => {
      try {
        const r = this._runKnowledgeGc(); if (r > 0) console.log('[Maintenance] 知识库GC: 清理 ' + r + ' 条过期未分类条目');
        // 清理过期记事记忆（调用 YuyaoMemoryService，通过注入的函数）
        if (this._runNoteGc) { const n = this._runNoteGc(); if (n > 0) console.log('[Memory] 清理过期记事: ' + n + ' 条'); }
      } catch (e: any) { console.error('[Maintenance] 知识库GC失败:', e); }
      // (v1.1) 同步清理 FG 过期 pending 条目（30天TTL）
      try {
        const fg = this.familyGraph ?? (this._fgGetter ? this._fgGetter() : null);
        if (fg && typeof fg.cleanExpiredPendingItems === 'function') {
          const r = fg.cleanExpiredPendingItems();
          if (r > 0) console.log('[Maintenance] FG pending清理: ' + r + ' 条');
        }
      } catch (e) { console.warn('[Maintenance] FG pending清理失败:', e); }
      // 🔵 批15(B): void 边自愈 —— 兜底防线。
      // 即使任何遗漏路径（未来新增的状态变更、人工 SQL 改动）产生了 void 参与边，
      // 也会在 24h 内被自动修复，而不是像批14 那样残留 179 条直到人工发现。
      try {
        const fg2 = this.familyGraph ?? (this._fgGetter ? this._fgGetter() : null);
        if (fg2 && typeof fg2.pruneVoidEdges === 'function') {
          fg2.pruneVoidEdges();   // 内部仅在确有清理时打印 [FG SelfHeal]
        }
      } catch (e) { console.warn('[Maintenance] void 边自愈失败(非阻塞):', e); }
    }, 24 * 60 * 60 * 1000);

    // 记忆衰减定时器（15 分钟）
    this.decayTimer = setInterval(async () => {
      // 🔴 V27批6（评审 P2-1）: 显式 catch —— 否则衰减失败只落 unhandledRejection，静默不执行
      const result = await this.runDecay().catch((e: any) => {
        console.error("[Maintenance] 衰减维护失败:", e?.message || e);
        return { total: 0, archived: 0 };
      });
      if (result.total > 0) {
        console.log(`[Maintenance] 衰减维护: ${result.total}条, ${result.archived}条归档`);
      }
    }, this.config.decayInterval);

    // 🔵 批13: 实体离线终审 —— 消费 FG 观察区(candidate)队列，用 LLM 批量判定。
    // 低频（每日一次触发）即可：建档不频繁、不特急，但很重要（用户 2026-09-20）。
    // 保守策略：只提升真人 + 标注噪声；置信度阈值见 FamilyGraph.applyJudgments。
    //   ⚠️ 原注释写「噪声仅标注（永不自动回收）」—— 已过时。V50 E2（业主 2026-10-12 裁决）
    //      起，noise 且 confidence≥0.95 且 status=candidate 会**自动回收 void**（带审计与清边）；
    //      低置信仍只写标记（保留 2026-09-20 保护档）。单次触发内连跑多轮，见 runEntityTriage。
    this.entityTriageTimer = setInterval(async () => {
      // 🔴 2026-09-20：补齐 catch —— 否则实体离线终审失败只会落 unhandledRejection（静默不执行），
      //   与 M9 巩固链路同类问题（见 docs/data-storage-reference.md「④ 批处理失败可见性」）。
      try {
        await this.runEntityTriage();
      } catch (e: any) {
        console.error('[Maintenance] 实体离线终审失败(非阻塞，下轮重试):', e?.message || e);
      }
    }, this.config.entityTriageInterval ?? 24 * 60 * 60 * 1000);

    // 🔵 滑窗垃圾实体自检（2026-10-23）：每日一次，只预警不自动清除（判据见 FGHealthCheck.detectSlidingWindowJunk）
    this.slidingJunkCheckTimer = setInterval(() => {
      try {
        this.runSlidingWindowSelfCheck();
      } catch (e: any) {
        console.warn('[Maintenance] 滑窗自检失败(非阻塞，下轮重试):', e?.message || e);
      }
    }, this.config.entityTriageInterval ?? 24 * 60 * 60 * 1000);
    // 首轮延迟 15 分钟（等 FG 稳定后再跑，避免启动期误报）
    setTimeout(() => {
      try {
        this.runSlidingWindowSelfCheck();
      } catch (e: any) {
        console.warn('[Maintenance] 首轮滑窗自检失败(非阻塞):', e?.message || e);
      }
    }, 15 * 60_000);

    // 首轮尽快执行
    // 🔴 2026-09-20：原先两处 `.catch(() => {})` 静默吞错 ⇒ 改为告警（失败可见）
    setTimeout(() => this.runCompaction().catch((e: any) => console.warn('[Maintenance] 首轮压缩失败(非阻塞):', e?.message || e)), 30_000);
    setTimeout(() => this.runGC().catch((e: any) => console.warn('[Maintenance] 首轮 GC 失败(非阻塞):', e?.message || e)), 60_000);
    // 🔵 批13: 首轮实体终审延迟 5 分钟（等检索/FG 稳定后再跑，避免和启动期任务抢资源）
    // 🔴 2026-09-20：`void` 浮空 promise 必须挂 catch —— 否则失败落 unhandledRejection（静默不执行）
    setTimeout(() => {
      this.runEntityTriage().catch((e: any) => console.error('[Maintenance] 首轮实体终审失败(非阻塞):', e?.message || e));
    }, 5 * 60_000);
    // 🔵 批15(P1-2): void 边自愈【首轮】—— 原实现只在 24h interval 内，
    // 进程存活不足 24h（或被 /api/reset 重置计时）时永不执行。
    // 与其它首轮任务并列（30s/60s/5min），启动后 10 分钟跑一次。
    setTimeout(() => {
      try {
        const fg2 = this.familyGraph ?? (this._fgGetter ? this._fgGetter() : null);
        if (fg2 && typeof fg2.pruneVoidEdges === 'function') fg2.pruneVoidEdges();
      } catch (e) { console.warn('[Maintenance] void 边自愈首轮失败(非阻塞):', e); }
    }, 10 * 60_000);
    setTimeout(async () => {
      // 🔴 V27批6（评审 P2-1）: 显式 catch —— 否则衰减失败只落 unhandledRejection，静默不执行
      const result = await this.runDecay().catch((e: any) => {
        console.error("[Maintenance] 衰减维护失败:", e?.message || e);
        return { total: 0, archived: 0 };
      });
      console.log(`[Maintenance] 首轮衰减: ${result.total}条, ${result.archived}条归档`);
    }, 90_000);
  }

  stop(): void {
    if (this.compactionTimer) clearInterval(this.compactionTimer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    if (this.decayTimer) clearInterval(this.decayTimer);
    // 🔴 批13 评审 F3: 必须清理 —— 否则 /api/reset → initPipeline → start() 后
    // 旧 interval 残留 + 新建 = 每重置一次多跑一份每日终审（重复 LLM 计费）。
    if (this.entityTriageTimer) clearInterval(this.entityTriageTimer);
    if (this.slidingJunkCheckTimer) clearInterval(this.slidingJunkCheckTimer);
    if (this.knowledgeGcTimer) clearInterval(this.knowledgeGcTimer);
    console.log('[Maintenance] 维护引擎已停止');
  }

  // ─── 健康报告 ───

  getHealth(): HealthReport {
    const mem = process.memoryUsage();
    const history = this.getConversationHistory();
    // 从历史记录中取最早的非空 timestamp 计算距今小时数
    let oldest = 0;
    for (const t of history) {
      if (t.timestamp) {
        const age = (Date.now() - new Date(t.timestamp).getTime()) / 3600000;
        if (age > oldest) oldest = Math.round(age);
      }
    }

    return {
      status: this.eventLoopLag > this.config.eventLoopWarnThreshold ? 'degraded' : 'ok',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
        rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
        // 堆外：sql.js 的 WASM 内存与 db.export() 缓冲都在这里，--max-old-space-size 管不到。
        //   实测 heapUsed 117MB / rss 867MB ⇒ ~700MB 全在堆外，是「零日志死亡」的真凶所在。
        externalMB: Math.round((mem.external || 0) / 1024 / 1024 * 10) / 10,
        arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1024 / 1024 * 10) / 10,
      },
      conversations: {
        total: history.length,
        oldestAgeHours: oldest,
      },
      storage: {
        totalRecords: 0,   // 由外部填充
        totalSizeKB: 0,
      },
      lastMaintenance: {
        compaction: this.lastCompaction,
        gc: this.lastGc,
      },
      eventLoopLag: this.eventLoopLag,
    };
  }

  /** 由外部更新 storage 统计（当前暂未启用 — 由 getHealth 直接计算） */

  // ─── 对话压缩 ───

  /**
   * 当对话历史超过阈值时，将最早的 half 压缩为摘要。
   * 保留最近 keepFullTurns 条完整对话。
   *
   * 压缩策略：将连续多轮 user/assistant 对话合并为一条概括性文本。
   * 如果已经压缩过的摘要再次被压缩，会进一步合并。
   */
  async runCompaction(): Promise<void> {
    // DB直接压缩：检查砂金库中未压缩的记录，超过阈值则标记
    const sqlite = this._sqliteGetter ? this._sqliteGetter() : null;
    if (sqlite) {
      try {
        // V23.1: 统计口径与归档 SQL 保持一致 —— `is_test=0` 会漏掉 NULL（实测库中大量 is_test 为 NULL），
        //   同时排除摘要条目（摘要不参与压缩，见下方归档 SQL 注释）。
        const totalRaw = sqlite.queryAll(
          "SELECT COUNT(*) as cnt FROM conversations WHERE is_compacted=0 AND (is_test IS NULL OR is_test=0) AND (is_summary IS NULL OR is_summary=0)",
        );
        const rawCount = totalRaw[0]?.cnt || 0;
        if (rawCount > this.config.compactionThreshold) {
          // 标记最早的 half 为已压缩（只标记，不删除）
          const keep = typeof this.config.keepFullTurns === 'number' && isFinite(this.config.keepFullTurns) ? this.config.keepFullTurns : 200;
          // 🔴 V34(2026-09-25) per-entity 保底 + 全库封顶（架构级）。
          //   原策略：`LIMIT toMark` 从**全库**最旧开始归档，保留窗口(keep)是**全库共享**的。
          //   实测后果：单个高频实体（1 天 477 轮）把 100 条窗口 100% 占满，
          //   其余实体的对话被瞬间归档 ⇒ 聊得越多记得越少，不聊的反而被挤掉。
          //   现改为：归档**只作用于「超出本实体自身保底窗口」的旧轮次**（实体间互不挤占），
          //   全库未归档总量以 keepFullTurns × 实体数 封顶（再以 maxUnarchivedRows 硬封顶防无界增长）。
          const _capCfg = Number(MEMORY_CONFIG.compaction.maxUnarchivedRows);
          const _cap = Number.isFinite(_capCfg) && _capCfg > 0 ? Math.floor(_capCfg) : 2000;
          const _entRow = sqlite.queryAll(
            "SELECT COUNT(DISTINCT COALESCE(belong_entity_uuid,'')) AS c FROM conversations WHERE is_compacted=0 AND (is_test IS NULL OR is_test=0) AND (is_summary IS NULL OR is_summary=0)",
          );
          const _entities = Math.max(1, Number(_entRow?.[0]?.c ?? 1) || 1);
          // 单实体时 = keep（与旧行为一致）；多实体时按实体数放宽，但有硬顶
          const _globalBudget = Math.max(keep, Math.min(keep * _entities, _cap));
          const toMark = Math.max(0, rawCount - _globalBudget);
          if (toMark > 0 && !isNaN(toMark)) {
            // 🔴 V23.1(2026-09-13): 归档必须**豁免摘要条目**（`is_summary=0`）。
            //   原 SQL 不带该条件 → 摘要条目被自己所属的压缩流程压掉，
            //   随即失去"摘要"身份（实测 11 条【对话摘要】全部 is_compacted=1、is_summary=0）。
            //   摘要本就是压缩的**产物**，不是待压缩的原始对话。
            // 🔴 V34: 内层相关子查询 = 「本实体内比我新的未归档轮次 ≥ keep 条」⇒ 我已在保底窗口之外。
            // 注：writeRaw 返回 void，受影响行数不回传 —— 日志中的 toMark 是「计划归档数」而非实写数
            sqlite.writeRaw(
              `UPDATE conversations SET is_compacted=1 WHERE id IN (
                 SELECT c.id FROM conversations c
                 WHERE c.is_compacted=0 AND (c.is_test IS NULL OR c.is_test=0) AND (c.is_summary IS NULL OR c.is_summary=0)
                   AND (SELECT COUNT(*) FROM conversations p
                        WHERE p.is_compacted=0 AND (p.is_test IS NULL OR p.is_test=0) AND (p.is_summary IS NULL OR p.is_summary=0)
                          AND COALESCE(p.belong_entity_uuid,'') = COALESCE(c.belong_entity_uuid,'')
                          AND p.timestamp > c.timestamp) >= ?
                 ORDER BY c.rowid ASC LIMIT ?)`,
              [keep, toMark]
            );
            console.log(`[Maintenance] DB压缩: 计划标记 ${toMark} 条对话为已压缩 (砂金库共 ${rawCount} 条 / ${_entities} 个实体 / 全库预算 ${_globalBudget})`);
          }
        }
      } catch (e) {
        console.warn('[Maintenance] DB压缩失败:', e);
      }
    }

    // 同时做内存压缩（原有逻辑）
    const history = this.getConversationHistory();
    if (history.length <= this.config.compactionThreshold) {
      return; // 未达阈值，无需压缩
    }

    const keep = this.config.keepFullTurns;
    const toCompact = history.slice(0, history.length - keep);
    const remaining = history.slice(history.length - keep);


    // 将旧对话压缩为摘要轮次（带 M2 关联检测）
    const summaries = await this.compressTurnsSmart(toCompact, sqlite);

    // 如果之前已有摘要，追加到新摘要前面
    const compacted: ConversationTurn[] = [
      ...summaries,
      ...remaining,
    ];

    this.setConversationHistory(compacted);
    this.saveConversationHistory();

    // 砂金库同步：压缩后清理 SQLite 旧数据 + 写入摘要
    if (this._sqliteGetter) {
      try {
        const sqlite = this._sqliteGetter();
        if (sqlite) {
          const firstTs = toCompact.length > 0 ? (toCompact[0].timestamp || new Date().toISOString()) : new Date().toISOString();
          const lastTs = toCompact.length > 0 ? (toCompact[toCompact.length - 1].timestamp || new Date().toISOString()) : new Date().toISOString();
          if (summaries.length > 0) {
            // 🔴 V23.1(2026-09-13) 防嵌套：生成摘要时排除**已有的摘要条目**。
            //   原实现把 `summaries`（含历史摘要）直接拼进来 → 实测出现
            //   `【对话摘要】【历史对话】【历史对话】…` 反复摘要嵌套。
            const _plainSummaries = summaries.filter(function (s: any) {
              const c = String(s?.content || '');
              return c && !c.startsWith('【对话摘要】') && !c.startsWith('【历史对话】');
            });
            const summaryText = _plainSummaries.map(function (s: any) { return s.content; }).filter(Boolean).join(' | ');
            if (summaryText) {
              // 🔴 V23.1: 传 isSummary=1 —— 摘要必须可被识别（否则 is_summary 恒 0，摘要通道失效）。
              //   is_compacted 保持 0：摘要是压缩产物，不应被归档流程压掉。
              // 🔴 2026-10-30 摘要行必须携带归属（与其它会话行同源）：
              //   空间视图按「任期 ∧ 归属」过滤，**无归属的 assistant 行会被判为 unknown speaker 丢弃**
              //   ⇒ 长会晤里早期压缩记忆在视图模式下不可见（「聊久了忘了开头」的一部分）。
              //   实测：conversations 共 167 条摘要、139 条 belong 为空；而无归属的 assistant 行
              //   100% 都是摘要行 —— 真实对话轮零丢失，丢的只是摘要。
              //   归属口径：被压缩轮次若同属一个实体则继承其 UUID；跨实体则留空（不猜，户籍管理法第五条）。
              const _belongSet = new Set<string>();
              for (const _t of toCompact) {
                const _b = (_t as { belongEntityUuid?: string })?.belongEntityUuid;
                if (typeof _b === 'string' && _b) _belongSet.add(_b);
              }
              const _summaryBelong = _belongSet.size === 1 ? Array.from(_belongSet)[0] : undefined;
              sqlite.insertConversation('assistant', '【对话摘要】' + summaryText.substring(0, 600), { seqPos: 0, isSummary: 1, belongEntityUuid: _summaryBelong } as any);
            }
          }
          const cutoff = remaining.length > 0 ? remaining[0].timestamp : null;
          // 🔴 铁律：砂金库永久留存原始对话，仅做压缩标记，不物理删除
          if (cutoff) {
            // V23.1: 同样豁免摘要条目（与 runCompaction 的归档 SQL 保持同一口径）
            // 🔴 V34(2026-09-25): cutoff 来自**本会话**的 RAM 历史，而下面这条 UPDATE 是**全库**范围 ——
            //   不加约束时它会按一个实体的时间线归档掉**其他实体**更近的轮次，把上面刚建立的
            //   per-entity 保底整个抹掉。此处套用同一谓词：只归档"超出本实体自身保底窗口"的旧轮次。
            const _keepFloor = typeof this.config.keepFullTurns === 'number' && isFinite(this.config.keepFullTurns) ? this.config.keepFullTurns : 200;
            sqlite.writeRaw(
              `UPDATE conversations SET is_compacted = 1
               WHERE timestamp < ? AND is_compacted = 0 AND (is_summary IS NULL OR is_summary = 0)
                 AND (SELECT COUNT(*) FROM conversations p
                      WHERE p.is_compacted=0 AND (p.is_test IS NULL OR p.is_test=0) AND (p.is_summary IS NULL OR p.is_summary=0)
                        AND COALESCE(p.belong_entity_uuid,'') = COALESCE(conversations.belong_entity_uuid,'')
                        AND p.timestamp > conversations.timestamp) >= ?`,
              [cutoff, _keepFloor],
            );
            console.log('[Maintenance] 标记压缩完成: < ' + cutoff + ' (原始数据永久保留, per-entity 保底 ' + _keepFloor + ' 条)');
          }
        }
      } catch (e) {
        console.warn('[Maintenance] 砂金库同步失败:', e);
      }
    }

    this.lastCompaction = new Date().toISOString();
    console.log(
      `[Maintenance] 对话压缩: ${history.length} → ${compacted.length} 条 ` +
      `(压缩 ${history.length - compacted.length} 条)`
    );
  }

  /**
   * 智能压缩 — 关联 M2 金库检测。
   * 已存入 M2 的记忆标记为"(已存金库)"并保留摘要头，
   * 未存的日常对话直接丢弃（释放空间）。
   *
   * 🔴 批1（2026-11-07）：原「压缩前全文本扫姓氏批量救名」已物理删除
   *    （它是滑窗式无证据生成器，向 entities / entity_relations / FG 三条写入路径供垃圾）。
   */
  private async compressTurnsSmart(turns: ConversationTurn[], sqlite: any | null): Promise<ConversationTurn[]> {

    const result: ConversationTurn[] = [];
    const CHUNK_SIZE = 20; // LLM 批量摘要：20轮一组

    for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
      const chunk = turns.slice(i, i + CHUNK_SIZE);
      const userTexts = chunk.filter(function(t) { return t.role === 'user'; }).map(function(t) { return t.content; });
      const combinedUser = userTexts.join('').substring(0, 60);
      if (!combinedUser.trim()) continue;
      // 🔴 B（2026-09-22）：本块的摘要 —— LLM 优先（带超时）、失败/未注入则机械压缩兵底。
      const _chunkSummary = await this._summarizeChunk(chunk);

      // 查 M2：这条对话的关键词是否已被巩固为情感记忆
      let inGold = false;
      if (sqlite && combinedUser.length > 4) {
        try {
          const keyword = combinedUser.substring(0, 20).replace(/[^一-鿿\w]/g, '');
          if (keyword.length > 1) {
            const rows = sqlite.queryAll(
              `SELECT COUNT(*) as cnt FROM memories WHERE raw_input LIKE ?`,
              [`%${keyword}%`]
            );
            inGold = (rows?.[0]?.cnt ?? 0) > 0;
          }
        } catch { /* sqlite 不可用，降级为无检测压缩 */ }
      }

      if (inGold) {
        result.push({ role: 'user', content: `(已存金库) ${_chunkSummary}` });
      } else {
        // 未存金库但有人类对话 → 生成摘要（**B：LLM 优先，机械兵底**）
        if (chunk.map(function(t) { return t.content; }).filter(Boolean).join(' ').length > 10) {
          result.push({ role: 'user', content: '【历史对话】' + _chunkSummary });
        }
      }
    }

    console.log(`[Compaction] 智能压缩: ${turns.length} 轮 → ${result.length} 条摘要`);
    return result;
  }

  /**
   * 🔴 B（2026-09-22）：单块摘要 —— LLM 优先，失败/未注入回退机械压缩。
   *   机械兵底保留原语义（取正文前 160 字），**比原先的 40/80 字宽**。
   */
  private async _summarizeChunk(chunk: ConversationTurn[]): Promise<string> {
    const text = chunk.map(function(t) { return String(t.content || ''); }).filter(Boolean).join(' ');
    const mech = text.replace(/\s+/g, ' ').substring(0, 160);
    if (!text.trim() || text.trim().length < 10 || !this._summarizeTurns) return mech;
    try {
      const timeout = new Promise<string>(function(_, rej) {
        setTimeout(function() { rej(new Error('compaction summary timeout')); }, COMPACTION_SUMMARY_TIMEOUT_MS);
      });
      const out = await Promise.race([
        this._summarizeTurns(chunk.map(function(t) { return { role: String(t.role), content: String(t.content || '') }; })),
        timeout,
      ]);
      const normalized = normalizeCompactionSummary(out, 400);
      return normalized || mech;
    } catch (e) {
      console.warn('[Compaction] LLM 摘要失败，回退机械压缩:', (e as Error)?.message);
      return mech;
    }
  }

  /** 旧版压缩方法已替换为 compressTurnsSmart（保留 `已存金库` 检测） */

  // 🔴 批1（2026-11-07）：rescueNamesBeforeCompression 已物理删除。
  //   它是一个滑窗式无证据生成器（全量文本扫姓氏 → entities / entity_relations / FG 三条写入），
  //   与 M1 滑窗同源同类，已随实体提取架构收口一并退役。

  // ─── 存储 GC ───

  /**
   * 清理 M2 存储中过旧的记录。
   * 保留最近 maxStorageRecords 条（按 seq_pos 截断）。
   * FusionStorageAdapter 已基于 SQLite，支持删除操作。
   */
  async runGC(): Promise<void> {
    // 使用 getter 或直接引用的 storage
    const st = this.storage ?? (this._storageGetter?.() ?? null);
    if (!st) return;

    try {
      const status = await st.getStatus();
      const total = status.totalRecords;

      if (total <= this.config.maxStorageRecords) {
        return; // 未达阈值
      }

      // M2 已使用 SQLite（FusionStorageAdapter），支持删除操作。
      // 实际删除需注入 storage 的具体接口（findBySeqPosRange + writeRaw），
      // 当前 runGC 仅记录告警。如需激活，将 FusionStorageAdapter 传入
      // injectDeps 并在 runGC 中调用 sqlite.writeRaw('DELETE FROM memories ...')。
      console.log(
        `[Maintenance] M2 存储 ${total} 条，超过阈值 ${this.config.maxStorageRecords}。` +
        `（当前 GC 仅检测，未执行删除——如需激活请在 injectDeps 中传入 storage 完整接口）`
      );

      this.lastGc = new Date().toISOString();
    } catch (err) {
      console.error('[Maintenance] 存储状态检查失败:', err);
    }
  }

  // ─── 事件循环延迟监测 ───

  private startEventLoopMonitor(): void {
    let lastCheck = Date.now();
    setInterval(() => {
      const now = Date.now();
      this.eventLoopLag = now - lastCheck - 1000; // 1s 间隔
      lastCheck = now;
    }, 1000).unref();
  }

  // ─── 手动触发 ───

  async triggerCompaction(): Promise<{ before: number; after: number }> {
    const before = this.getConversationHistory().length;
    await this.runCompaction();
    const after = this.getConversationHistory().length;
    return { before, after };
  }
}
