/**
 * casual-floor — 闲聊「轻档」检索（2026-11-08，ADR-019）
 *
 * 为什么需要它：
 *   2026-11-07 的闲聊快路径把 casual 做成了**二值开关**——跳过 v11/v2/Foundation 的同时，
 *   也把本地毫秒级的 `findByEmotionalSimilarity` 一起砍掉了。实测玉瑶私聊 927 条消息中
 *   97.7% 被判 casual ⇒ 闲聊几乎全部失去「主动回忆」，与 MemSym 宪法信条 7（主动模式
 *   义务非可选）直接冲突。正确形态是**档位**而不是开关：轻档只做本地单次召回，
 *   全档仍走原链路。
 *
 * 本模块的契约（唯一职责）：
 *   · **只做一次**本地 `findByEmotionalSimilarity`（similarity_mode='balanced'）；
 *   · 阈值过滤与「排除当前分支」在此收口，调用方不再各写一份；
 *   · **永不抛出**：任何异常都降级为「零记忆」，因为闲聊回复不能因检索失败而中断。
 *
 * 明确不做（这些属于全档）：
 *   实体扩展 / 查询分解 / rerank / v11 / v2 / Foundation / LLM 重排 / 时间检索。
 */
import type { ScoredMemory } from '../../m2/types/index.js';
import type { PerceptionState24 } from '../../m3/types/perception.js';

/** 轻档默认召回条数 —— 只给模型一点「过去说过」的由头，不抢占对话主体 */
export const CASUAL_FLOOR_DEFAULT_LIMIT = 3;

/** 情感分阈值（沿用全档 fallback 的既有口径） */
export const CASUAL_FLOOR_EMOTIONAL = 0.3;
/** 钙化分阈值（同上） */
export const CASUAL_FLOOR_CALCIUM = 0.3;

/** 轻档只需要存储层这一个方法（结构化依赖，便于测试注入假实现） */
export interface CasualFloorStorage {
  findByEmotionalSimilarity(query: {
    current_perception: PerceptionState24;
    similarity_mode: 'balanced';
    limit: number;
    entityUuids?: string[];
  }): ScoredMemory[];
}

export interface CasualFloorOptions {
  storage: CasualFloorStorage;
  /** 当前感知（M3 24D）—— 与全档同一份输入，保证语义一致 */
  perception: PerceptionState24;
  /** 归属过滤（玉瑶私聊为空；会晤/实体空间传对应 UUID） */
  entityUuids?: string[];
  /** 当前轮分支 id —— 必须排除，否则会把「刚说的这句」当成过去的记忆 */
  branchId?: string;
  /** 召回条数上限（默认 3，硬上限 5） */
  limit?: number;
}

export interface CasualFloorResult {
  memories: ScoredMemory[];
  /** 本地检索耗时（ms），供 [Latency] 埋点使用 */
  ms: number;
}

/**
 * 收集闲聊轻档记忆。**永不抛出**。
 */
export function collectCasualFloorMemories(opts: CasualFloorOptions): CasualFloorResult {
  const t0 = Date.now();
  try {
    const limit = Math.max(1, Math.min(opts.limit ?? CASUAL_FLOOR_DEFAULT_LIMIT, 5));
    const raw = opts.storage.findByEmotionalSimilarity({
      current_perception: opts.perception,
      similarity_mode: 'balanced',
      // 多取一倍供阈值过滤，避免过滤后为空
      limit: limit * 2,
      entityUuids: opts.entityUuids && opts.entityUuids.length > 0 ? opts.entityUuids : undefined,
    }) || [];

    const memories = raw
      .filter((m): m is ScoredMemory => !!m && !!m.record && !!m.record.id)
      .filter(m => m.record.id !== opts.branchId)
      .filter(m => (Number(m.scores?.emotional) || 0) > CASUAL_FLOOR_EMOTIONAL
                || (Number(m.scores?.calcium) || 0) > CASUAL_FLOOR_CALCIUM)
      .slice(0, limit);

    return { memories, ms: Date.now() - t0 };
  } catch (e) {
    // 闲聊不能因为检索失败而中断：降级为空 + 留痕
    console.warn('[CasualFloor] 轻档检索失败，按零记忆降级:', (e as Error)?.message || e);
    return { memories: [], ms: Date.now() - t0 };
  }
}
