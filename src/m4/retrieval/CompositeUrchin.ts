/**
 * CompositeUrchin — 组合海胆语义向量刺聚合（蓝皮书第六章）
 * ============================================================
 * 组合海胆 = 对话组 / 话题段 / 文章等聚合体；其语义向量刺是**聚合派生、不落盘**。
 *
 * 【公式】（蓝皮书 §6.1）
 *   spine(G) = Σ_{i∈G} w_i · spine(member_i) / Σ_{i∈G} w_i ,   w_i = calcium_score_i
 *
 * 【红线】
 *   1. 🔴 **禁止持久化**（附录 A 第 7 条 / 蓝皮书 §6.3）：组合刺不落任何持久化表、
 *      不进缓存表。成员变动与钙化衰减会让缓存永久过期，
 *      且违反 ADR-013 ②「状态只有一处写」。本模块**不 import 任何数据库类型**。
 *   2. 🔴 **禁止 40 维以下截断**（蓝皮书 §6.3）：恒为 `PERCEPTION_40D_DIM` 维。
 *   3. 🔴 **禁止为组合体新增 40D/向量列**（蓝皮书 §6.3）——对话组没有 40D 列是
 *      事实（生产库实测，白皮书 §7.1 论证），不是待补的缺陷。
 *   4. 无有效成员 ⇒ 返回 `null`，**不伪造零向量**（零向量会让余弦返回 0，
 *      把「没数据」伪装成「负相关」，是变相降级）。
 */
import { PERCEPTION_40D_DIM } from '../../m3/types/perception-40d.js';

/** 组合海胆的一个成员（原子海胆） */
export interface CompositeMember {
  /** 该成员的 40 根语义向量刺（原生 `perception_40d` 解码结果），缺项则被过滤 */
  spine: number[] | null | undefined;
  /** 权重 = 该成员的 `calcium_score`（蓝皮书 §6.1）；`<= 0` 的成员不参与 */
  weight: number;
}

/**
 * 逐维值域钳制（蓝皮书 §6.2）。
 *
 * | 维度 | 值域 |
 * |---|---|
 * | D01–D35 | `[0, 1]` |
 * | D36 / D37 | `[-1, 1]` |
 * | D38–D40 | `[0, 1]` |
 *
 * 🔴 只在**聚合输出处**调用一次。逐成员钳制会改变加权平均的数学性质
 * ——例如两个 +1.2 / −1.2 的成员本应平均成 0，逐成员钳制后变成 (+1 + −1)/2 = 0
 * 看似一致，但在非对称权重下会失真，故按蓝皮书条文只钳一次。
 */
export function clampSpine40D(v: readonly number[]): number[] {
  const out = new Array<number>(PERCEPTION_40D_DIM);
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    const raw = Number.isFinite(v[i]) ? v[i] : 0;
    const dim = i + 1; // 维度编号从 1 起
    if (dim === 36 || dim === 37) {
      out[i] = Math.max(-1, Math.min(1, raw));
    } else {
      out[i] = Math.max(0, Math.min(1, raw));
    }
  }
  return out;
}

/** 组内成员数超过此值则不聚合，只用壳肉（蓝皮书 §6.4 成本条款） */
export const COMPOSITE_MEMBER_CEILING = 100;

/**
 * 组合海胆聚合（蓝皮书 §6.1）。**纯计算，不落盘、不缓存**。
 *
 * @returns 聚合后的 40 根组合刺；无有效成员时返回 `null`。
 *
 * 退化处置（蓝皮书 §7.4）：
 *   - 组内所有成员 `perception_40d` 全缺 ⇒ `null`，语义项由精排层按 §4.4 重归一化；
 *   - 成员数 `> COMPOSITE_MEMBER_CEILING` ⇒ `null` 并由调用方记 `WARN`（不聚合，只用壳肉）。
 */
export function aggregateSpines(members: readonly CompositeMember[]): number[] | null {
  if (!Array.isArray(members) || members.length === 0) return null;
  if (members.length > COMPOSITE_MEMBER_CEILING) return null;

  // 只保留「刺长度恰为 40 且权重为正」的成员 —— 刺长度不对说明脏数据，不能参与加权
  const valid: Array<{ spine: number[]; weight: number }> = [];
  for (const m of members) {
    if (!Array.isArray(m.spine) || m.spine.length !== PERCEPTION_40D_DIM) continue;
    if (!(m.weight > 0)) continue;
    valid.push({ spine: m.spine, weight: m.weight });
  }

  const wSum = valid.reduce((s, m) => s + m.weight, 0);
  // 无有效成员 ⇒ 无组合刺（不伪造零向量）
  if (wSum <= 0) return null;

  const out = new Array<number>(PERCEPTION_40D_DIM).fill(0);
  for (const m of valid) {
    for (let d = 0; d < PERCEPTION_40D_DIM; d++) {
      out[d] += (m.weight * m.spine[d]) / wSum;
    }
  }
  return clampSpine40D(out);
}

/** 聚合退化原因（供影子日志与 `dialog_group_skipped_total` 归因） */
export type CompositeDegradation =
  | 'ok'
  | 'empty_members'
  | 'ceiling_exceeded'
  | 'no_valid_spine';

/**
 * 与 `aggregateSpines` 同一算法，但额外返回退化原因。
 * ⚠️ 与 `aggregateSpines` 是**同一实现**的两个出口，不是两套逻辑 ——
 * `aggregateSpines` 只是丢掉原因的薄包装，避免双实现漂移。
 */
export function aggregateSpinesWithReason(
  members: readonly CompositeMember[],
): { spine: number[] | null; reason: CompositeDegradation } {
  if (!Array.isArray(members) || members.length === 0) {
    return { spine: null, reason: 'empty_members' };
  }
  if (members.length > COMPOSITE_MEMBER_CEILING) {
    return { spine: null, reason: 'ceiling_exceeded' };
  }
  const hasValid = members.some(
    (m) => Array.isArray(m.spine) && m.spine.length === PERCEPTION_40D_DIM && m.weight > 0,
  );
  if (!hasValid) return { spine: null, reason: 'no_valid_spine' };
  return { spine: aggregateSpines(members), reason: 'ok' };
}
