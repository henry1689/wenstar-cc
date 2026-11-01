/**
 * bArchiveHash — B 链路「沉睡卷宗」哈希口径的**唯一实现**（P145 批 A 落地 / 批 B 抽离）
 * ====================================================================================
 * 口径出处：P145 微调 4（2026-11-01 业主批准）。**口径一经落地不可再改** ——
 * 改了要全量重算存量哈希，而存量一旦重算，「原文有没有变过」这个判断就永久失去基线。
 *
 * ## 内容哈希 `content_hash`
 * 只覆盖 `conversations` 原文：按 `seq_pos ASC`（同序再按 `timestamp ASC`），
 * 每行拼接 `seq_pos ⟨SEP_FIELD⟩ role ⟨SEP_FIELD⟩ content`，行间用 `SEP_ROW` 连接，
 * `sha256` 取前 32 位 hex。
 *
 * **不含 `block_summary`**：摘要会重生成，混在一算则每次重生成都要全量重算，
 * 且无法区分「原文变了」还是「摘要变了」。摘要由 `summary_hash` 独立承载。
 *
 * ## 摘要哈希 `summary_hash`
 * 对 `block_summary` 文本直接 `sha256` 取前 32 hex。空摘要写 NULL（不写空串的哈希）。
 *
 * ## 为什么抽成单源模块（批 B）
 * 批 A 时口径只存在于 `BlockArchiveService` 一处。批 B 的 `BArchiveReader` 需要
 * **校验**同一份哈希，若各写一遍，「写入侧算的」与「校验侧算的」一旦漂移，
 * 所有存量块都会被误判为「被篡改」。本仓不变量 #7：同一业务规则禁止多处实现。
 *
 * ## 分隔符为什么用具名常量
 * `SEP_FIELD` / `SEP_ROW` 是不可见控制字符（0x01 / 0x02）。批 A 的教训：直接写字面量
 * 在编辑器/终端里显示为空串，极易被误以为「没写进去」而重复改动。
 * 故这里用 **转义字面量** 表达，源码可读、运行时字节与批 A 完全一致（口径不变）。
 */

import { createHash } from 'node:crypto';

/** 字段分隔符 = 0x01（Start Of Heading） */
export const SEP_FIELD = '';
/** 行分隔符 = 0x02（Start Of Text） */
export const SEP_ROW = '';

/** 哈希取多少位 hex（32 位 = 128 bit，碰撞概率对本场景可忽略，且省一半存储） */
const HASH_HEX_LEN = 32;

/** 参与内容哈希的一行（`conversations` 的最小投影） */
export interface HashableConversation {
  seq_pos?: number | string | null;
  role?: string | null;
  content?: string | null;
}

/**
 * 计算卷宗内容哈希。
 *
 * 🔴 **调用方必须按 `seq_pos ASC, timestamp ASC` 排好序再传进来** ——
 *   本函数是纯函数，不重排；排序口径属于查询侧职责，写在调用点的 SQL 里。
 *   批 A 的 `BlockArchiveService` 与批 B 的 `BArchiveReader` 使用**逐字相同**的
 *   ORDER BY，保证同一组算出的哈希必然相等。
 */
export function computeContentHash(rows: readonly HashableConversation[]): string {
  const payload = rows
    .map((c) => `${c.seq_pos ?? ''}${SEP_FIELD}${c.role ?? ''}${SEP_FIELD}${c.content ?? ''}`)
    .join(SEP_ROW);
  return createHash('sha256').update(payload).digest('hex').slice(0, HASH_HEX_LEN);
}

/**
 * 计算摘要哈希。
 *
 * 空摘要（null / undefined / 空串）返回 `null` —— 表示「没有摘要」，
 * 与「摘要为空字符串的哈希」在语义上必须区分得开。
 */
export function computeSummaryHash(summary: string | null | undefined): string | null {
  if (typeof summary !== 'string' || summary.length === 0) return null;
  return createHash('sha256').update(summary).digest('hex').slice(0, HASH_HEX_LEN);
}
