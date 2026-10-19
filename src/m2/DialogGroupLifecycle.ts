/**
 * DialogGroupLifecycle — 对话组（块）级生命周期规则单一真源
 * ============================================================
 * A2 / Phase 2.1（R016 任务A2，业主已确认 T004 方向）。
 *
 * 状态机：active → consolidating → archived
 *   - consolidating：block_calcium_score >= 5（高钙组，进入沉淀/巩固通道）
 *   - archived：创建 > 30 天 且 block_calcium_score < 2（低钙老组，降召回优先级）
 *   - 其余：active
 *
 * 三条铁律（业主裁决 / 只增不减原则）：
 *   1. **沉淀窗 30 分钟**：闭组不足 30 分钟的组不做任何流转（新组先让摘要/钙化稳定）。
 *   2. **归档不删除**：本模块只 UPDATE lifecycle_state，绝不 DELETE —— archived 仅是
 *      优先级信号（供 2.3 统一编排降权），关键词召回路径必须仍能命中 archived 组。
 *   3. **状态是派生数据**：lifecycle_state := f(block_calcium_score, age)，纯函数决定，
 *      不接受自由形态；每次流转扫描把全表收敛到函数输出（幂等 = 重启不变）。
 *
 * 调用方（两处，均幂等）：
 *   - MigrationManager v25：存量 805 组一次性初始化（审计留痕）
 *   - MigrationManager.repairDataIntegrity：每次启动的幂等流转扫描（组龄跨过 30 天
 *     边界时由下次启动收敛；钙分在闭组时定格不再变，故目标状态一经确定不再改变）
 *
 * 与 memories 层 lifecycle_state（MemoryLifecycleProtocol 的 candidate/gold/... ）
 * 是两套独立状态机：那套管单条记忆，这套管对话组块。勿混用。
 */

export const DG_LIFECYCLE_RULE = {
  /** 沉淀窗：闭组不足该分钟数不做任何流转（业主裁决） */
  settlingWindowMinutes: 30,
  /** 达到该钙分 → consolidating（R016：block_calcium_score >= 5） */
  consolidatingCalcium: 5,
  /** 超过该天数且钙分低于 archivedCalcium → archived */
  archiveAfterDays: 30,
  /** archived 的钙分上界（严格小于） */
  archivedCalcium: 2,
} as const;

export type DialogGroupLifecycleState = 'active' | 'consolidating' | 'archived';

/**
 * 纯函数：给定钙分与组龄（分钟），返回目标生命周期状态。
 * 返回 null = 沉淀窗内（< settlingWindowMinutes）不做流转，保持现值。
 *
 * 优先级：calcium >= 5 恒 consolidating（与组龄无关，也不会被 archived 规则抢走——
 * archived 要求 calcium < 2，两规则无交集）。
 */
export function computeDialogGroupLifecycle(
  blockCalciumScore: number,
  ageMinutes: number,
): DialogGroupLifecycleState | null {
  if (ageMinutes < DG_LIFECYCLE_RULE.settlingWindowMinutes) return null; // 沉淀窗
  const raw = Number.isFinite(blockCalciumScore) ? blockCalciumScore : 0;
  const score = raw < 0 ? 0 : raw; // 负值属数据异常，错底为 0（不误档、不抛错）
  if (score >= DG_LIFECYCLE_RULE.consolidatingCalcium) return 'consolidating';
  if (
    ageMinutes > DG_LIFECYCLE_RULE.archiveAfterDays * 24 * 60 &&
    score < DG_LIFECYCLE_RULE.archivedCalcium
  ) {
    return 'archived';
  }
  return 'active';
}

export interface DgLifecycleAdvanceResult {
  /** 本次流转的组数（state 实际变化） */
  transitions: number;
  /** 扫描的总组数 */
  scanned: number;
  /** 收敛后的分布（含未变行） */
  distribution: Record<DialogGroupLifecycleState, number>;
  /** 沉淀窗内被跳过的组数 */
  skippedSettling: number;
}

/**
 * 幂等流转扫描：把 dialog_groups.lifecycle_state 全表收敛到 computeDialogGroupLifecycle 输出。
 * - 只 UPDATE，不 DELETE（只增不减）；
 * - 沉淀窗内的组不动；
 * - 重复执行零变化（重启幂等，验收项）。
 *
 * @param db 具备 run/exec 的 SQLite 适配层 —— **必须是 sql.js 约定**：
 *   run(sql, params数组) / exec(sql) 返回 [{values: rows}]。传 better-sqlite3 裸对象不兼容（变参与数组绑参数不同）。
 * @param now 可注入时钟（测试用）
 */
export function advanceDialogGroupLifecycle(
  db: { run: (sql: string, params: any[]) => void; exec: (sql: string) => any },
  now: Date = new Date(),
): DgLifecycleAdvanceResult {
  const rows = db.exec(
    'SELECT dialog_group_id, block_calcium_score, created_at, lifecycle_state FROM dialog_groups',
  );
  const values: any[][] = (rows && rows[0] && rows[0].values) || [];
  const nowMs = now.getTime();
  let transitions = 0;
  let skippedSettling = 0;
  const distribution: Record<DialogGroupLifecycleState, number> = { active: 0, consolidating: 0, archived: 0 };

  for (const [dgId, calcium, createdAt, currentState] of values) {
    const createdMs = Date.parse(String(createdAt || ''));
    const ageMinutes = Number.isFinite(createdMs) ? (nowMs - createdMs) / 60000 : 0;
    const target = computeDialogGroupLifecycle(Number(calcium) || 0, ageMinutes);
    if (target === null) {
      // 沉淀窗内：保持现值（新组闭组时写入的 'active'），计入分布但不流转
      skippedSettling += 1;
      const cur = (currentState as DialogGroupLifecycleState) || 'active';
      if (distribution[cur] !== undefined) distribution[cur] += 1;
      continue;
    }
    if (target !== currentState) {
      // 🔴 参数必须是**数组**（sql.js Database.run(sql, BindParams) 约定，与 repairDataIntegrity
      //   批次1-5 同风格）。曾写成 variadic 被测试夹具（better-sqlite3 原生 variadic）掩盖，
      //   生产 sql.js 静默错绑（WHERE 匹配 0 行、不抛错）→ 状态永不落库、每次重启重流转。
      db.run(
        'UPDATE dialog_groups SET lifecycle_state = ?, updated_at = ? WHERE dialog_group_id = ?',
        [target, now.toISOString(), String(dgId)],
      );
      transitions += 1;
    }
    distribution[target] += 1;
  }

  return { transitions, scanned: values.length, distribution, skippedSettling };
}
