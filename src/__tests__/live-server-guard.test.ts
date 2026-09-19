/**
 * `live-server-guard` 的能力断言
 *
 * 要证明的能力（不是计数/位置断言）：
 * 1. 服务可达 ⇒ `proceed`（正常跑，不受 env 影响）；
 * 2. 服务不可达 + `REQUIRE_LIVE_SERVER=1` ⇒ **`fail`**（真正的保证：声称在检查服务时，服务挂了必须红）；
 * 3. 服务不可达 + 未设置 ⇒ `skip`（显式跳过，报告中可见，而非静默 passed）；
 * 4. `guardLiveServerOrSkip` 在 fail 态**抛错**（不返回 false 让调用方继续静默走）。
 */
import { describe, it, expect } from 'vitest';

import { decideLiveServerAction, guardLiveServerOrSkip, isLiveServerRequired } from './helpers/live-server-guard.js';

const REQ = { REQUIRE_LIVE_SERVER: '1' };
const NOR = { REQUIRE_LIVE_SERVER: undefined };

describe('live-server-guard · 三态判据', () => {
  it('服务可达 → proceed（即使要求强制校验也照常跑）', () => {
    expect(decideLiveServerAction(true, NOR)).toBe('proceed');
    expect(decideLiveServerAction(true, REQ)).toBe('proceed');
  });

  it('服务不可达 + REQUIRE_LIVE_SERVER=1 → fail（核心保证）', () => {
    expect(decideLiveServerAction(false, REQ)).toBe('fail');
  });

  it('服务不可达 + 未设置 → skip（显式跳过，不再静默 passed）', () => {
    expect(decideLiveServerAction(false, NOR)).toBe('skip');
  });

  it('fail 态必须抛错（不能返回 false 让调用方静默继续）', () => {
    expect(() => guardLiveServerOrSkip('[TEST]', false, '', REQ)).toThrow(/不允许静默通过/);
  });

  it('skip 态返回 false（调用方据此跳过），proceed 态返回 true', () => {
    expect(guardLiveServerOrSkip('[TEST]', false, 'status=0', NOR)).toBe(false);
    expect(guardLiveServerOrSkip('[TEST]', true, '', NOR)).toBe(true);
  });

  it('isLiveServerRequired 只认 "1"', () => {
    expect(isLiveServerRequired(REQ)).toBe(true);
    expect(isLiveServerRequired({ REQUIRE_LIVE_SERVER: 'true' })).toBe(false);
    expect(isLiveServerRequired(NOR)).toBe(false);
  });
});
