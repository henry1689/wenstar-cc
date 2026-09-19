/**
 * 真实链路能力断言：**强制模式是否真的注入了进程**
 *
 * 只在使用 smoke 启动器时有效（`npm run smoke:api` / `smoke:checkpoint`）。
 * 在普通全量 run 下显式跳过（`it.skipIf`），不制造假红。
 *
 * 为什么需要它：如果哪天有人把 package.json 的 smoke 脚本改回 `set X=1&& ...` 之类
 * **依赖 shell 的写法**，环境变量会静默失效 —— 表现就是"又退回静默跳过"。
 * 这条用例让那种退化**立刻可见**（能力断言，而不是靠人读文档）。
 */
import { describe, it, expect } from 'vitest';

import { guardLiveServerOrSkip } from './helpers/live-server-guard.js';

const IN_FORCED_MODE = process.env.REQUIRE_LIVE_SERVER === '1';

describe('smoke 强制模式（经启动器运行时的真实链路）', () => {
  it.skipIf(!IN_FORCED_MODE)('启动器必须把 REQUIRE_LIVE_SERVER=1 注入进程（否则保证失效）', () => {
    expect(process.env.REQUIRE_LIVE_SERVER, '启动器未注入 ⇒ 强制模式形同虚设').toBe('1');
  });

  it.skipIf(!IN_FORCED_MODE)('在强制模式下，服务不可达 ⇒ 抛错（而不是返回 false 让用例静默通过）', () => {
    expect(() => guardLiveServerOrSkip('[E2E-PROOF]', false, 'simulated-unreachable')).toThrow(/不允许静默通过/);
  });

  it.skipIf(IN_FORCED_MODE)('普通模式：服务不可达 ⇒ 显式跳过（返回 false），绝不抛错', () => {
    expect(guardLiveServerOrSkip('[E2E-PROOF-NORMAL]', false, 'simulated-unreachable')).toBe(false);
  });
});
