/**
 * DualHelixWriter.ts — 双螺旋底座同步写入
 * ============================================
 * 任何记忆写入操作时, 同时向双螺旋底座写数据 (蓝皮书 §3.2-3.3)。
 *
 * 🔴 P071(2026-10-23): 底座1 state_spines（语义向量分片库）已彻底废除删除：
 *   40D 语义真源 = memories.perception_40d（本表从未建 HNSW、仅 24D+零占位、读写方全死）。
 *   本文件不再写 state_spines；迁移 v26 已 DROP 该表。
 *
 * 底座2 atom_address_timeline: 寻址元数据, B+Tree 线性时序索引
 * 底座3 atom_repair_index:     断链修复索引
 *
 * 铁律:
 *   - 底座仅通过 GlobalUID 关联
 *   - atom_address_timeline: 仅 B+Tree+倒排, 禁止存语义向量
 *   - 语义向量唯一真源 (memories.perception_40d)
 *
 * V2.0 可靠性增强：
 *   - 返回值改为 { success, error, details }，调用方可感知写入失败
 *   - 失败队列 + 3 次重试 + 超限告警（console.error 结构化格式）
 *   - retryHelixQueue() 供服务端定时重放
 *
 * 使用:
 *   import { writeToDualHelix, retryHelixQueue } from '../m2/DualHelixWriter.js';
 *   const result = writeToDualHelix(db, { globalUid, perceptionJson, seqPos, ... });
 *   if (!result.success) console.error('[DualHelix] 写入失败:', result.error);
 */

import type { DNA } from '../m1/types/dna.js';
import { createHash } from 'node:crypto';

export interface HelixWriteParams {
  /** 23字符 GlobalUID (DNAEncoder.generateGlobalUID) */
  globalUid: string;
  /** 24D 感知向量 JSON — 🔴 P071 起不再消费（底座1 已废除），保留字段兼容调用方 */
  perceptionJson: string;
  /** 全局序列号 */
  seqPos: number;
  /** ISO8601 创建时间 */
  createdAt: string;
  /** 区位指纹 (瑶光空白期为32位全0) */
  locationFingerprint?: string;
  /** locus_path */
  locusPath?: string;
  /** DNA root_id */
  dnaRootId?: string;
  /** 实体列表 */
  entityNames?: string[];
  /** 钙化分数 */
  calciumScore?: number;
  /** P071-Phase2: 藤蔓组ID（事件主干：dialog_group 优先/dna_root 兑底）→ ATL vine_group_id */
  vineGroupId?: string;
  /** P071-Phase2批B: 归属主体 UUID（户籍法：ATL 归属轴必须 TXS-ID，人名已废） */
  entityBelongUuid?: string;
}

export interface HelixWriteResult {
  success: boolean;
  error?: string;
  /** 失败底座列表，成功时为空数组 */
  failedSpines?: string[];
}

interface FailedEntry {
  params: HelixWriteParams;
  retries: number;
  firstError: string;
  firstFailedAt: string;
}

// ── 失败重试队列 ──
const MAX_RETRIES = 3;
const _failedQueue: FailedEntry[] = [];

/**
 * 向双螺旋底座写入一条海胆记录。
 *
 * 在 persistConversation() 的每个 writeMemory() 后调用。
 * 每个底座独立 try-catch，部分失败不影响其他底座写入。
 *
 * @returns { success, error, failedSpines } — success 为 false 时至少一个底座写入失败
 */
export function writeToDualHelix(db: any, params: HelixWriteParams): HelixWriteResult {
  if (!params.globalUid) {
    return { success: false, error: '缺少 global_uid', failedSpines: [] };
  }

  const failedSpines: string[] = [];

  const ts = new Date(params.createdAt).getTime();
  const checksum = createHash('sha256')
    .update(`${params.globalUid}:${params.seqPos}:${ts}`)
    .digest('hex').substring(0, 16);

  // ═══════ 底座1 state_spines: 🔴 P071 已废除删除（40D 真源=memories.perception_40d，不再写入） ═══════

  // ═══════ 底座2: atom_address_timeline ═══════
  try {
    const timeSliceTag = new Date(ts).toISOString().substring(0, 7); // YYYY-MM
    // 🔴 P071-Phase2批B: 归属轴改写 TXS-ID（原 entityNames[0] 人名违户籍法，已废——v29 迁移历史数据）
    const entityBelong = params.entityBelongUuid || '';
    db.run(
      `INSERT OR REPLACE INTO atom_address_timeline
       (global_uid, global_time_seq, absolute_timestamp, time_slice_tag, vine_group_id, entity_belong_id,
        hot_cold_level, crc_checksum, state_flag, created_at, route_stamp_list)
       VALUES (?, ?, ?, ?, ?, ?, 'W', ?, 'N', ?, ?)`,
      [
        params.globalUid, params.seqPos, ts, timeSliceTag,
        params.vineGroupId || null, entityBelong || null, checksum, ts,
        JSON.stringify([{ workshop: 'M1', phase_id: 'encode', node_id: 'DNAEncoder', timestamp: ts / 1000, detail: 'initial_encode' }]),
      ],
    );
  } catch (e) {
    failedSpines.push('spine2:atom_address_timeline');
  }

  // ═══════ 底座3: atom_repair_index ═══════
  try {
    db.run(
      `INSERT OR REPLACE INTO atom_repair_index (global_uid, spine_storage_position, flesh_storage_position, last_verified_at)
       VALUES (?, ?, ?, unixepoch())`,
      [
        params.globalUid,
        `memories.perception_40d::${params.globalUid}`,
        `memories::${params.dnaRootId || params.globalUid}`,
      ],
    );
  } catch (e) {
    failedSpines.push('spine3:atom_repair_index');
  }

  if (failedSpines.length > 0) {
    // 入失败队列，供后续重试
    _failedQueue.push({
      params,
      retries: 0,
      firstError: `底座写入失败: ${failedSpines.join(', ')}`,
      firstFailedAt: new Date().toISOString(),
    });
    return { success: false, error: `底座写入失败: ${failedSpines.join(', ')}`, failedSpines };
  }

  return { success: true, failedSpines: [] };
}

/**
 * 重试失败队列中的所有条目。
 * 每个条目最多重试 MAX_RETRIES 次，超限后输出结构化告警日志。
 *
 * 供 server.ts 定时调用（建议 5 分钟间隔）。
 *
 * @returns 本次重试成功的条目数
 */
export function retryHelixQueue(db: any): number {
  if (_failedQueue.length === 0) return 0;

  let succeeded = 0;
  const stillFailed: FailedEntry[] = [];

  for (const entry of _failedQueue) {
    entry.retries++;
    const result = writeToDualHelix(db, entry.params);

    if (result.success) {
      succeeded++;
      // 不重新入队列
    } else if (entry.retries >= MAX_RETRIES) {
      // 超限告警 — 结构化格式，供 observability 采集
      console.error(JSON.stringify({
        alert: 'DualHelixWriteFailed',
        severity: 'ERROR',
        globalUid: entry.params.globalUid,
        seqPos: entry.params.seqPos,
        retries: entry.retries,
        firstError: entry.firstError,
        lastError: result.error,
        firstFailedAt: entry.firstFailedAt,
        lastFailedAt: new Date().toISOString(),
        message: `[DualHelix] ${entry.params.globalUid} 写入失败，已重试 ${entry.retries} 次仍失败，寻址链/修复索引可能残缺`,
      }));
      // 不再重试，保留日志即可
    } else {
      stillFailed.push(entry);
    }
  }

  // 清空旧队列，仅保留仍需重试的条目
  _failedQueue.length = 0;
  _failedQueue.push(...stillFailed);

  if (succeeded > 0) {
    console.log(`[DualHelix] 重试成功: ${succeeded} 条`);
  }
  if (stillFailed.length > 0) {
    console.warn(`[DualHelix] 仍有 ${stillFailed.length} 条待重试 (已重试 ${stillFailed[0]?.retries || 0}/${MAX_RETRIES})`);
  }

  return succeeded;
}

/**
 * 获取失败队列状态，供监控端点查询。
 */
export function getHelixQueueStatus(): { size: number; oldestFailedAt: string | null; maxRetries: number } {
  return {
    size: _failedQueue.length,
    oldestFailedAt: _failedQueue.length > 0 ? _failedQueue[0].firstFailedAt : null,
    maxRetries: MAX_RETRIES,
  };
}
