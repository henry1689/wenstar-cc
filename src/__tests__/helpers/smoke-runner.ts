/**
 * live 冒烟统一启动器 —— 跨 shell 可靠地注入 `REQUIRE_LIVE_SERVER=1`
 *
 * ## 为什么不用 `set X=1&& node ...`
 * 那种写法依赖调用方的 shell（cmd / bash / PowerShell 语义各不相同），
 * 一旦 npm 的 `script-shell` 变了或换到 WSL，**环境变量不会生效**，
 * 而失效表现恰好是"退回静默跳过"—— 正是我们要消灭的**静默降级**。
 * 用 Node 启动器：环境变量注入、退出码透传都是确定的，与 shell 无关。
 *
 * ## 用法（见 package.json 的 smoke:api / smoke:checkpoint）
 * ```
 * node ./node_modules/tsx/dist/cli.mjs src/__tests__/helpers/smoke-runner.ts <测试文件...>
 * ```
 * 退出码 = vitest 的退出码（0 绿 / 非 0 红），保证 CI 与人工都能据此判断。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：本文件位于 <root>/src/__tests__/helpers/ */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('[smoke-runner] 用法：<runner> <测试文件...>（至少一个）');
  process.exit(2);
}

console.log('[smoke-runner] REQUIRE_LIVE_SERVER=1 —— 服务不可达将**判定失败**（不再静默跳过）');
console.log(`[smoke-runner] 目标文件 ${files.length} 个`);

const r = spawnSync(process.execPath, [VITEST, 'run', ...files], {
  stdio: 'inherit',
  cwd: REPO,
  env: { ...process.env, REQUIRE_LIVE_SERVER: '1' },
});

if (r.error) {
  console.error('[smoke-runner] 启动 vitest 失败：', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
