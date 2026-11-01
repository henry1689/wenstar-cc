/**
 * b-archive-recall — B 链路「深度回忆」调用面（P145 批 B）
 * ======================================================
 * 职责：把「用户这一句话是不是在要求看细节」与「按 groupId 单点拉起整块原文」两件事
 * 拼成一个**失败即回退**的函数，供检索链路在注入前调用。
 *
 * ──────────────────────────────────────────────────────────────
 * 🔴 为什么判定用 `detectDetailLevel` 而不是新写一套正则
 *
 *   仓里已有一份**用户口语 → 还原度**的映射（long-text-retrieval.ts，V23 落地，
 *   覆盖 full/detail/summary/auto 四档，注释记录了 S2-R7 的设计依据）。
 *   这里若再写一份「详细说说 / 完整回忆」的词表，就会立刻产生第二套判据 ——
 *   本仓不变量 #7 明令禁止。故**直接复用**：detail / full 视为深度回忆意图。
 *
 * 🔴 为什么失败一律回退（返回 null）而不是抛
 *
 *   深度回忆是**增强**，不是主链路。任何异常（表缺列 / 卷宗不存在 / 渲染超限）
 *   都应让调用方继续用既有的截断正文，而不是让整轮检索失败。
 *   但回退**不静默**：每次都打一行 warn，避免「明明该展开却没展开」无人知晓。
 *
 * 🔴 会晤场景的 fail-closed 在调用方
 *
 *   本函数接受 `audienceUuid`，但**不判断**会晤态。调用方必须做到：
 *   会晤模式下若解析不出当前发言人 UUID ⇒ **根本不调用本函数**（宁可不展开，
 *   也不能不带听众过滤就展开 —— 那会把「耳语给别人」的轮次回放给当前角色）。
 *   该约束写在 retrieval-stage 的调用点。
 *
 * 🔴 消费计数与回放同源
 *
 *   只有**真正渲染出文本并返回**时才记 USER_CONSUME —— 渲染失败不计数，
 *   否则「点了但没看到」也会推高块级钙化，污染排序信号。
 */

import { BArchiveReader } from '../../app/memory/BArchiveReader.js';
import type { BArchiveSqlSource } from '../../app/memory/BArchiveReader.js';
import { detectDetailLevel } from './long-text-retrieval.js';

/** 深度回忆入参 */
export interface DeepRecallInput {
  /** 数据源（通常是 ctx.storage.getSQLite()）；为空直接跳过 */
  sql: BArchiveSqlSource | null | undefined;
  /** 用户原始消息（用于判定 detail / full 意图） */
  message: string;
  /** 命中块的 groupId（由 extractDialogGroupId 从 SearchHit 取） */
  groupId: string | null | undefined;
  /**
   * 会晤听众 UUID。给定 ⇒ 回放只含「无归属」与「归属=听众」的轮次。
   * 户主/非会晤场景传 null（不过滤）。
   */
  audienceUuid?: string | null;
  /** 单次回放长度上限（默认用 BArchiveReader.RENDER_MAX_CHARS） */
  maxChars?: number;
}

/**
 * 尝试深度回忆。命中意图且成功渲染 ⇒ 返回整块回放文本；否则 null（调用方回退）。
 * **不抛异常**：所有失败路径都收敛成 null + 一行 warn。
 */
export function tryDeepRecall(input: DeepRecallInput): string | null {
  const gid = String(input.groupId ?? '').trim();
  if (!gid) return null;
  const sql = input.sql;
  if (!sql || typeof sql.queryAll !== 'function') return null;

  const level = detectDetailLevel(input.message || '');
  if (level !== 'detail' && level !== 'full') return null;

  try {
    const reader = new BArchiveReader(sql);
    const record = reader.getByGroupId(gid, { audienceUuid: input.audienceUuid ?? null });
    if (!record) {
      console.warn(`[BArchive] 深度回忆未命中卷宗 ${gid}（回退截断正文）`);
      return null;
    }
    const text = reader.render(record, { maxChars: input.maxChars });
    if (!text) {
      console.warn(`[BArchive] 卷宗 ${gid} 无可见原文（回退截断正文）`);
      return null;
    }

    // 渲染成功才记消费 —— 失败不计数（见文件头）
    const consumed = reader.recordConsume(gid, 'USER_CONSUME');
    console.log(
      `[BArchive] 深度回忆回放 ${gid} · ${record.conversations.length}轮 · ${text.length}字` +
      ` · 消费${consumed.counted ? '计入' : `未计(${consumed.reason})`}` +
      ` · 快照=${record.snapshot?.agg ?? 'none'}` +
      ` · 完整性=${record.integrity.contentHashMatches === false ? '⚠️哈希不符' : 'ok'}`,
    );
    return text;
  } catch (e) {
    console.warn('[BArchive] 深度回忆失败，回退截断正文:', (e as Error)?.message);
    return null;
  }
}
