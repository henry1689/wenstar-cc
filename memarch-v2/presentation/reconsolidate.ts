/**
 * MemArch-v2.0.0 / M5-Presentation / reconsolidate.ts
 *
 * 再巩固：当用户 correct 时，触发该记忆节点的新版本写入。
 *   1. 走 M2 online_write 写入路径（WriteSink.write）写新版本
 *   2. 旧版本发 'decay' 信号给 M3，进入睡眠巩固的衰减队列
 *   3. 不直接删旧版本——保留审计轨迹，由 M3 睡眠期决定何时墓碑化
 */

import type {
  NormalizedEvidence,
  ReinforceSink,
  WriteSink,
} from './types.js';
import type { ReconsolidateConfig } from './config.js';

export interface ReconsolidateInput {
  /** 被纠正的旧记忆证据 */
  old_evidence: NormalizedEvidence;
  /** 用户纠正后的新内容（即用户这一轮的回应原文） */
  user_correction: string;
  writeSink: WriteSink;
  reinforceSink: ReinforceSink;
  config: ReconsolidateConfig;
  /** 当前时间 epoch ms（可注入便于测试） */
  now?: number;
}

export interface ReconsolidateResult {
  old_uuid: string;
  new_trace_id?: string;
  old_decayed: boolean;
}

/**
 * 执行再巩固。
 *
 * 注意：新版本的 message_id 用 `${old_uuid}::v${Date.now()}`，保证幂等且可追溯。
 */
export function reconsolidate(input: ReconsolidateInput): ReconsolidateResult {
  const { old_evidence, user_correction, writeSink, reinforceSink, config } = input;
  const now = input.now ?? Date.now();

  // 1. 写新版本——内容是用户纠正后的说法
  const newMessageId = `${old_evidence.uuid}::v${now}`;
  const writeResult = writeSink.write({
    message_id: newMessageId,
    role: 'user',
    content: user_correction,
    ts_utc: now,
    namespace: config.namespace,
  });

  // 2. 旧版本发 decay——不删除，进 M3 衰减队列
  reinforceSink.reinforce(old_evidence.uuid, config.decay_signal);

  return {
    old_uuid: old_evidence.uuid,
    new_trace_id: writeResult.trace_id,
    old_decayed: true,
  };
}
