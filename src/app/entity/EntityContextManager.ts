/**
 * EntityContextManager — 多角色超长上下文隔离管理器
 * ====================================================
 * 独立模块，作为 conversationHistory → enrichedHistory 之间的透明过滤层。
 *
 * 职责（单一）：
 *   getContextWindow() — 按当前实体 UUID 过滤历史对话
 *
 * 🔴 V35(2026-10-05): 原列于本职责表的 groupByEntity() / mergeThreads() 已删除 ——
 *   二者标题都写着「按 UUID」，实现却都是 `content.includes(实体名)`（用名字冒充归属），
 *   且全仓**零调用点**。保留它们等于把一个已被实测证伪的判据留在库里等人误用；
 *   归属过滤的单一真源是 getContextWindow + belongEntityUuid。
 *
 * 不改变任何已有 pipeline 的输入输出。
 * 会晤模式：仅返回该实体的对话轮次
 * 正常模式：返回最近 N 条（行为不变）
 */
import type { ConversationTurn } from '../../m5/types/index.js';
// 🔴 V34(2026-09-25): 上下文窗口轮次的**配置单一事实源**（与 EntityContextStore.queryEntityContext 同口径）
import { MEMORY_CONFIG } from '../../config/MemoryConfig.js';

export interface EntityContextWindow {
  turns: ConversationTurn[];
  entityName: string | null;
}

export class EntityContextManager {
  /** 会话级缓存：entityName → 过滤结果 (30s TTL) */
  private _cache: Map<string, { ts: number; turns: ConversationTurn[] }> = new Map();
  private readonly CACHE_TTL = 30_000; // 30秒

  /**
   * 获取当前实体的上下文窗口。
   *
   * 🔴 V35(2026-10-05) 判据收敛：**归属由 belongEntityUuid 决定，绝不由文本内容决定。**
   *   原实现是三层降级，其中：
   *   ① `meetingStartIndex` 路径的 setter（EntityMeeting.setMeetingStartHistoryIndex）
   *      **全仓零调用点** ⇒ 恒为 0 ⇒ 该路径从未生效，其注释里「不依赖内容关键词匹配——
   *      避免 entity 角色的"我"自指回复被丢弃」的修复是**死代码**（已实测确认）；
   *   ② 于是每次都走 `content.includes(entityName)` 关键词路径 —— 把「文本里有没有出现名字」
   *      当成了「这轮是谁说的」。实测徐诗雨 300 条助手回复中 **24.3% 不含自己名字即被整条丢弃**，
   *      且带说话人前缀的为 0 条，判定纯由内容偶然性决定 ⇒ 模型看不见自己刚说过的话，
   *      表现为「聊天没有承上启下、话题惯性弱、聊几句就忘了前面说的」。
   *   现统一为 UUID 判据（户籍管理法第五条/第七条：归属 fail-closed、无归属即拒之门外）：
   *   写入方 persistence-stage 在**落库与落内存时都盖归属章**，本方法只做匹配，不再猜。
   *
   * @param allHistory 全局 conversationHistory
   * @param entityUuid 当前会晤实体 UUID；null = 玉瑶态（不按归属过滤，取最近 N 条）
   * @param maxTurns 最大轮次（经配置下限归一化，见下）
   * @returns 过滤后的对话历史
   */
  getContextWindow(
    allHistory: ConversationTurn[],
    entityUuid: string | null,
    maxTurns: number = 40,
  ): ConversationTurn[] {
    // 🔴 V34(2026-09-25): 配置下限兜底 —— 与 EntityContextStore.queryEntityContext 同口径。
    //   本方法的形参默认值 40，而调用点（chat.ts）也硬编码传 40 ⇒ `MemoryConfig.compaction.
    //   contextWindowTurns`（80）对**这条 RAM 路径完全失效** —— 配置写了等于没写。
    //   口径统一：调用方传得比配置小，也按配置取（窗口策略属本层职责，避免散落各调用点）。
    const _floor = (() => {
      try { return Number(MEMORY_CONFIG.compaction.contextWindowTurns) || 0; } catch { return 0; }
    })();
    const _maxTurns = _floor > 0 ? Math.max(maxTurns, _floor) : maxTurns;

    // 玉瑶态（无会晤实体）
    // 🔴 户籍隔离 fail-closed(2026-10-08): 原注释「历史本就按玉瑶 UUID 单独装载」是**错误前提** ——
    //   入参 allHistory 是**全局** conversationHistory，跟徐诗雨聊的轮次就在里面，
    //   直接 slice(-N) 等于把他人会话原样倒给玉瑶。
    //   生产路径**不经过这里**：chat.ts:731 仅在 `if (_meetingUuid)` 时才调用本方法，
    //   玉瑶态走 else 分支从 EntityContextStore 按玉瑶 UUID 查专属历史（其 catch 回落
    //   已改为不回落混合历史，见 chat.ts 玉瑶态分支）。故此处不可能因生产调用而泄漏。
    //   但留着一条静默放行通道本身就是隐患（谁新增一个调用点就中招），故显式告警留痕：
    //   丢弃必须可见，不得静默（P-13 精神）。修复方向不是在这里猜玉瑶 UUID（那会造成
    //   第二份归属真源，违反不变量#7），而是由调用方保证 entityUuid 非空。
    if (!entityUuid) {
      console.warn(
        `[EntityContextManager] getContextWindow 收到空 entityUuid — 按「无主体」直取最近 ${_maxTurns} 条` +
        `（不做归属过滤）。生产路径不经过此分支；若你正在新增调用点，请改为传入真实归属 UUID。`,
      );
      return allHistory.slice(-_maxTurns);
    }

    const cacheKey = `${entityUuid}:${_maxTurns}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.turns;
    }

    // 归属匹配 —— deny-by-default：无归属章的轮次一律排除（户籍管理法 fail-closed）
    const entityTurns: ConversationTurn[] = [];
    let _noOwnership = 0;
    for (const turn of allHistory) {
      const _belong = (turn as any).belongEntityUuid as string | undefined;
      if (!_belong) {
        _noOwnership++;
        continue;
      }
      if (_belong === entityUuid) entityTurns.push(turn);
    }
    // P-13 精神：丢弃必须可见，不得静默
    if (_noOwnership > 0) {
      console.warn(
        `[EntityContextManager] 归属缺失 ${_noOwnership} 轮已按 fail-closed 排除（entityUuid=${entityUuid}）`,
      );
    }

    const result = entityTurns.slice(-_maxTurns);
    this._cache.set(cacheKey, { ts: Date.now(), turns: result });
    this._cleanExpiredCache();
    return result;
  }

  private _cleanExpiredCache(): void {
    if (this._cache.size <= 50) return;
    const now = Date.now();
    for (const [k, v] of this._cache) {
      if (now - v.ts > this.CACHE_TTL) this._cache.delete(k);
    }
  }

  // 🔴 V35(2026-10-05): 原 groupByEntity() / mergeThreads() 已删除。
  //   二者标题（"按实体 UUID 分桶" / "多实体混排"）与实现完全脱节：
  //   groupByEntity 用 `content.includes(name)`、mergeThreads 用 `content.includes(name)` 过滤 ——
  //   即"这轮是谁说的"由"正文里有没有出现名字"决定。这正是本次修复的主症结
  //   （实测徐诗雨 24.3% 的助手回复因此被误判为他人对话）。
  //   且二者全仓零调用点（含测试），签名本身也把 string[] 名字当参数，
  //   要改对必须换签名为 UUID[]，而没有任何调用方需要它们 —— 故整体移除，
  //   归属过滤收敛到 getContextWindow（单一真源，不变量#7）。

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: DB 级查询 + 策略驱动 + 隔离 + 压缩
  // ═══════════════════════════════════════════════════════════════

  // 🔴 V35(2026-10-05): 原 `isolateEntityTurns` 已删除（职责由 getContextWindow 的归属过滤完全承担）。
  //   它是一处「注释与实现互相矛盾」的活标本：文档注释写的是
  //     「P5: 会晤内多实体隔离。按 belong_entity_uuid 逐条分配——目标实体的对话进 own…」，
  //   实现却是 `content.includes(targetEntityName) || role === 'user'` ——
  //   即用「文本里有没有出现实体名字」冒充「这轮是谁说的」。实测徐诗雨 300 条助手回复中
  //   24.3% 不含自己名字，因而被整条移出上下文；且带说话人前缀的为 0 条，
  //   说明判定完全由内容偶然性决定。这正是「会晤聊天没有承上启下、聊几句就忘了前面说的」的主因。
  //   删除理由：getContextWindow 已按 belongEntityUuid 完成同一件事，
  //   保留第二道过滤器既违反不变量#7（禁止同一业务规则在多处实现），又会把正确的过滤结果再毁一次。

  // 🔴 V35-B(2026-10-05): 原 applyTokenBudget() 已删除（零调用点）。
  //   它是「窗口上限」这个概念的第 4 份实现：用 `Math.min(60, budgetTokens / 200)` 又算了一遍
  //   与 MemoryConfig.compaction.contextWindowTurns 无关的上限（且 60 与配置的 80 冲突）。
  //   窗口上限的唯一真源是 contextWindowTurns，由调用方读取后传入，本类不再自行推算。

  /** 清除缓存 */
  clearCache(): void {
    this._cache.clear();
  }
}
