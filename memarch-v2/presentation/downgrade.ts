/**
 * MemArch-v2.0.0 / M5-Presentation / downgrade.ts
 *
 * B → A 升级机制（任务书命名为 downgrade.ts，实际功能是弱通路晋升）：
 *   原本走通路 B（弱/暗示）的记忆，若后续被用户 confirm/engaged 强化，
 *   累计达到阈值后，下次检索时提升到通路 A 可见度。
 *
 * 硬规则：
 *   - tombstone=true 不升级
 *   - suppressed=true 不升级（敏感记忆即便被强化也只走 B）
 *   - 已经在 A 的不重复升级
 */

import type {
  AttributionHit,
  NormalizedEvidence,
  PathwayStore,
} from './types.js';
import type { UpgradeConfig } from './config.js';

export interface UpgradeInput {
  /** 本轮归因结果 */
  hits: AttributionHit[];
  /** 本轮实际用到的证据（用于查 tombstone/suppressed/pathway） */
  used_evidences: NormalizedEvidence[];
  store: PathwayStore;
  config: UpgradeConfig;
}

export interface UpgradeResult {
  /** 本轮被晋升到 A 的 uuid */
  promoted: string[];
  /** 累计强化计数（诊断用） */
  counts: Record<string, number>;
  /** 被跳过的 uuid 及原因 */
  skipped: { uuid: string; reason: string }[];
}

export function applyUpgrades(input: UpgradeInput): UpgradeResult {
  const { hits, used_evidences, store, config } = input;
  const evMap = new Map(used_evidences.map((e) => [e.uuid, e]));
  const promoted: string[] = [];
  const skipped: { uuid: string; reason: string }[] = [];
  const counts: Record<string, number> = {};

  for (const hit of hits) {
    // 只对 confirm / engaged 计数
    if (hit.signal !== 'confirm' && hit.signal !== 'engaged') continue;

    const ev = evMap.get(hit.uuid);
    // 硬规则：墓碑不可升级
    if (ev?.tombstone) {
      skipped.push({ uuid: hit.uuid, reason: 'tombstone' });
      continue;
    }
    // 硬规则：suppressed 不升级
    if (ev?.suppressed) {
      skipped.push({ uuid: hit.uuid, reason: 'suppressed' });
      continue;
    }
    // 已经在 A 不重复升级
    if (ev?.pathway === 'A') {
      skipped.push({ uuid: hit.uuid, reason: 'already_A' });
      continue;
    }

    const newCount = store.bumpReinforcement(hit.uuid);
    counts[hit.uuid] = newCount;

    if (newCount >= config.promote_after_hits) {
      store.promoteToA(hit.uuid, config.boost_per_hit);
      promoted.push(hit.uuid);
    }
  }

  return { promoted, counts, skipped };
}
