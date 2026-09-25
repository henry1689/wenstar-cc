/**
 * EntityContextManager — 多角色超长上下文隔离管理器
 * ====================================================
 * 独立模块，作为 conversationHistory → enrichedHistory 之间的透明过滤层。
 *
 * 职责：
 *   1. getContextWindow() — 按当前实体 UUID 过滤历史对话
 *   2. groupByEntity()   — 将全局对话历史按 UUID 分桶
 *   3. mergeThreads()    — 多实体同时出现时按时间线混排
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
   * @param allHistory 全局 conversationHistory
   * @param entityName 当前会晤实体名（null=正常玉瑶模式）
   * @param maxTurns 最大轮次（经配置下限归一化，见下）
   * @returns 过滤后的对话历史
   */
  getContextWindow(
    allHistory: ConversationTurn[],
    entityName: string | null,
    maxTurns: number = 40,
    meetingStartIndex?: number,
  ): ConversationTurn[] {
    // 🔴 V34(2026-09-25): 配置下限兜底 —— 与 EntityContextStore.queryEntityContext 同口径。
    //   本方法的形参默认值 40，而调用点（chat.ts）也硬编码传 40 ⇒ `MemoryConfig.compaction.
    //   contextWindowTurns`（80）对**这条 RAM 路径完全失效** —— 配置写了等于没写。
    //   且会晤模式下 RAM 历史够长时根本不会走到 DB 兜底，于是"保留了 100 条却只注入 40 条"
    //   的老问题在这条路径上依旧存在。
    //   口径统一：调用方传得比配置小，也按配置取（窗口策略属本层职责，避免散落各调用点）。
    const _floor = (() => {
      try { return Number(MEMORY_CONFIG.compaction.contextWindowTurns) || 0; } catch { return 0; }
    })();
    const _maxTurns = _floor > 0 ? Math.max(maxTurns, _floor) : maxTurns;

    // 正常模式：返回最近 N 条（仅窗口大小归一化，行为不变）
    if (!entityName) {
      return allHistory.slice(-_maxTurns);
    }

    // 会晤模式：按 EntityMeeting 记录的时间索引截断
    //   会晤激活之后的所有对话都属于该会晤上下文，
    //   不依赖内容关键词匹配——避免 entity 角色的 "我" 自指回复被丢弃。
    if (meetingStartIndex !== undefined && meetingStartIndex > 0) {
      // 缓存键用**归一化后**的轮次：否则同一会话内配置生效前后会产生两份缓存条目
      const cacheKey = `${entityName}:${meetingStartIndex}:${_maxTurns}`;
      const cached = this._cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
        return cached.turns;
      }
      const safeStart = Math.max(0, meetingStartIndex);
      const result = allHistory.slice(safeStart).slice(-_maxTurns);
      this._cache.set(cacheKey, { ts: Date.now(), turns: result });
      this._cleanExpiredCache();
      return result;
    }

    // 降级：无 startIndex 时用内容关键词过滤（兼容旧调用）
    const cacheKey = `${entityName}:key:${_maxTurns}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.turns;
    }

    const entityTurns: ConversationTurn[] = [];
    for (const turn of allHistory) {
      if (((turn as any).content || '').includes(entityName)) {
        entityTurns.push(turn);
      }
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

  /**
   * 将全局对话历史按实体 UUID 分桶。
   * 用于分析/调试/多角色混排场景。
   */
  groupByEntity(
    allHistory: ConversationTurn[],
    knownNames: string[],
  ): Map<string, ConversationTurn[]> {
    const groups = new Map<string, ConversationTurn[]>();

    for (const turn of allHistory) {
      const content = (turn as any).content || '';
      let matched = false;
      for (const name of knownNames) {
        if (content.includes(name)) {
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name)!.push(turn);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 未匹配的归入"玉瑶"（用户与玉瑶的对话）
        if (!groups.has('_default')) groups.set('_default', []);
        groups.get('_default')!.push(turn);
      }
    }

    return groups;
  }

  /**
   * 多实体混排：当一段对话中涉及多个实体时，按时间线混排各实体的上下文。
   * 每个实体取最近 maxPerEntity 条，总共不超过 maxTotal 条。
   */
  mergeThreads(
    allHistory: ConversationTurn[],
    entityNames: string[],
    maxPerEntity: number = 20,
    maxTotal: number = 40,
  ): ConversationTurn[] {
    if (entityNames.length === 0) {
      return allHistory.slice(-maxTotal);
    }

    const perEntity = Math.min(maxPerEntity, Math.floor(maxTotal / entityNames.length));
    const merged: ConversationTurn[] = [];

    for (const name of entityNames) {
      const entityTurns = allHistory
        .filter(t => ((t as any).content || '').includes(name))
        .slice(-perEntity);
      merged.push(...entityTurns);
    }

    // 按时间戳排序
    merged.sort((a, b) => {
      const ta = (a as any).timestamp || '';
      const tb = (b as any).timestamp || '';
      return ta.localeCompare(tb);
    });

    return merged.slice(-maxTotal);
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: DB 级查询 + 策略驱动 + 隔离 + 压缩
  // ═══════════════════════════════════════════════════════════════

  /**
   * P5: 会晤内多实体隔离。
   * 按 belong_entity_uuid 逐条分配——目标实体的对话进 own，
   * 其他实体的对话作为 interspersed 时间线提示。
   */
  isolateEntityTurns(
    rawTurns: ConversationTurn[],
    targetEntityName: string,
  ): { own: ConversationTurn[]; interspersed: string[] } {
    const own: ConversationTurn[] = [];
    const interspersed: string[] = [];

    for (const turn of rawTurns) {
      const content = (turn as any).content || '';
      if (content.includes(targetEntityName) || (turn as any).role === 'user') {
        own.push(turn);
      } else {
        interspersed.push(
          `${(turn as any).timestamp?.substring(11, 16) || ''} ${
            (turn as any).role === 'assistant' ? targetEntityName : '鸿艺'
          }: ${content.substring(0, 60)}`,
        );
      }
    }

    return { own, interspersed };
  }

  /**
   * E1: 上下文安全上限。
   * 按 token 预算截断窗口——默认 8000 tokens，每条约 200 tokens。
   */
  applyTokenBudget(turns: ConversationTurn[], budgetTokens: number = 8000): ConversationTurn[] {
    const maxByBudget = Math.min(60, Math.floor(budgetTokens / 200));
    return turns.slice(-maxByBudget);
  }

  /** 清除缓存 */
  clearCache(): void {
    this._cache.clear();
  }
}
