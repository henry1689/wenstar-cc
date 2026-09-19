/**
 * live 冒烟的统一「服务可达性」判据 —— 把"静默通过"换成"显式跳过 / 明确失败"
 *
 * ## 为什么需要
 * 10 个 live 冒烟文件原先各自写：
 * ```ts
 * if (!serverAvailable) { console.warn('Server not running — all tests skip'); }
 * // 每个用例开头：if (!serverAvailable) return;   ← 静默"通过"
 * ```
 * 后果：**服务挂了 → 报告全绿**（零断言通过）。这与"假报绿灯"同型，是最危险的一类噪声。
 *
 * ## 契约（fail-closed，三态明确）
 * | 服务可达 | REQUIRE_LIVE_SERVER | 动作 |
 * |:--|:--|:--|
 * | 是 | 任意 | `proceed`（正常跑） |
 * | 否 | `1` | **`fail`**（抛错 ⇒ 套件红：既然声称在检查服务，服务就必须在） |
 * | 否 | 未设置 | `skip`（**显式跳过**：报告里计入 skipped，而非 passed） |
 *
 * 规则只写在这里一处；新增冒烟文件必须调用它（见 docs/testing-conventions.md）。
 */

/** 三态动作 */
export type LiveServerAction = 'proceed' | 'skip' | 'fail';

/** 环境变量形状（便于单测注入，无需改 process.env） */
export interface LiveServerEnv {
  [key: string]: string | undefined;
}

/**
 * 纯函数：决定 live 冒烟该怎么走（无副作用，可被单测穷举）。
 * @param reachable  `/api/health` 是否 200 且 body.status === 'ok'
 * @param env        环境变量（默认 `process.env`）
 */
export function decideLiveServerAction(reachable: boolean, env: LiveServerEnv = process.env): LiveServerAction {
  if (reachable) return 'proceed';
  return String(env.REQUIRE_LIVE_SERVER ?? '') === '1' ? 'fail' : 'skip';
}

/**
 * 在 `beforeAll` 中调用（返回"服务是否可用"，供各用例沿用 `serverAvailable` 变量）。
 *
 * - `proceed` → 返回 true
 * - `skip`    → 打印明确原因，返回 false（用例随后 `return`，但**整组已计入 skipped**）
 * - `fail`    → **抛错**（套件红且不静默）
 */
export function guardLiveServerOrSkip(
  label: string,
  reachable: boolean,
  detail = '',
  env: LiveServerEnv = process.env,
): boolean {
  const action = decideLiveServerAction(reachable, env);
  const tail = detail ? `（${detail}）` : '';
  if (action === 'proceed') return true;
  if (action === 'fail') {
    throw new Error(
      `[${label}] 服务不可达${tail}，但 REQUIRE_LIVE_SERVER=1 ⇒ 判定为**失败**（不允许静默通过）。` +
        `请先启动服务（node start.cjs / pm2 restart），或去掉 REQUIRE_LIVE_SERVER。`,
    );
  }
  console.warn(`[${label}] 服务不可达${tail} —— 本组**显式跳过**（如需强制校验：REQUIRE_LIVE_SERVER=1）。`);
  return false;
}

/** 供断言/日志用：当前是否处于"强制 live"模式 */
export function isLiveServerRequired(env: LiveServerEnv = process.env): boolean {
  return String(env.REQUIRE_LIVE_SERVER ?? '') === '1';
}
