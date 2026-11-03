/**
 * preroute-order-guard.test.ts — 空间路由器「路由先于装配」次序不变量守卫
 * ============================================================
 * 【被守的缺陷】设计评审 §4「集成位置错误」：
 *   chat.ts 中原次序是
 *     装配上下文 → 检索 → 解析意图 → 换人 → 生成
 *   ⇒ 上下文在换人之前就装好了。即使换人成功，本轮喂给模型的仍是**旧发言人**的上下文。
 *   业主真机体感：「标签对了，内容不对」「和改前一样」「比之前还乱」。
 *   这不是单点 bug，是管线次序缺陷 —— 每个单独看都合理，合起来是错的。
 *
 * 【2026-10-30 第一层固化】开关 `WS_SPACE_PRE_ROUTE` 已**删除**。
 *   原先两个调用点靠 `=== '1'` / `!== '1'` 互斥，开关本身就是「退回错误次序」的口子。
 *   现在只允许**一个**调用点，且必须位于上下文装配之前 —— 没有第二处可以漂回去。
 *
 * 本测试锁定四条不变量（源码级结构断言，不依赖运行时）：
 *   G1 迁移本体必须是「函数声明」而非箭头函数 / const 赋值 ——
 *      后者没有提升，在装配前调用会撞 TDZ（ReferenceError），而且是运行时才炸。
 *   G2 唯一调用点必须**先于** enrichedHistory 装配；
 *   G3 全文件**恰好一个**调用点（多一个即意味着又出现了一条可切换的次序）；
 *   G4 开关必须彻底消失：不得残留 `WS_SPACE_PRE_ROUTE` 的 env 读取。
 *
 * 🔴 为什么用源码断言而不是行为测试：
 *   这是**语句次序**，不是函数返回值。跑真机要走 DB + LLM，秒级且不确定；
 *   源码断言 0.1 秒且确定。谁把调用点挪回去或多加一个，这里立刻红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const chatSrc = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');

/** 所有 `await _runMeetingTransition()` 调用点的字符下标 */
function callSites(): number[] {
  return [...chatSrc.matchAll(/await _runMeetingTransition\(\)/g)].map((m) => m.index ?? -1);
}

describe('G1 迁移本体必须是可提升的函数声明', () => {
  it('存在 `async function _runMeetingTransition(` 声明', () => {
    expect(chatSrc).toMatch(/\n\s*async function _runMeetingTransition\s*\(/);
  });

  it('不得退化为箭头函数或 const 赋值（无提升 ⇒ 装配前调用会撞 TDZ）', () => {
    expect(chatSrc).not.toMatch(/const\s+_runMeetingTransition\s*=/);
    expect(chatSrc).not.toMatch(/_runMeetingTransition\s*=\s*async\s*\(/);
  });
});

describe('G2 路由必须先于上下文装配', () => {
  // 🔴 2026-11-02：原锚 `enrichedHistory = _ad.turnsFor` 随空间路由器改造消失
  //   （turnsFor 已收进视图派生层 buildViewFor / 视图分支，不再是就地调用）。
  //   装配现为 5 个分支（:875 空间视图 / :916 DB / :943 玉瑶 / :953 :959 空），
  //   故改锚**首个装配赋值** `enrichedHistory =`（= :875 空间视图分支，与本用例名吻合）。
  //   G2 次序断言仍成立且可验：`await _runMeetingTransition()` 在 :795，795 < 875
  //   ⇒ 路由确实先于上下文装配；G1/G3/G4 不依赖该锚、不受影响。
  const assembleAt = chatSrc.indexOf('enrichedHistory =');

  it('装配锚点存在（空间视图分支）', () => {
    expect(assembleAt).toBeGreaterThan(0);
  });

  it('调用点在 enrichedHistory 装配之前', () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(1);
    expect(sites[0]).toBeLessThan(assembleAt);
  });
});

describe('G3 调用点必须唯一（不存在第二条可切换的次序）', () => {
  it('恰好一个 `await _runMeetingTransition()` 调用点', () => {
    expect(callSites()).toHaveLength(1);
  });

  it('该调用点不接受任何开关守卫（前面 240 字符内无 env 读取；注释提及不算）', () => {
    const [only] = callSites();
    const window = chatSrc.slice(Math.max(0, only - 240), only);
    expect(window).not.toMatch(/process\.env\.WS_SPACE_/);
  });
});

describe('G4 开关已彻底删除（无 env 读取、无死开关）', () => {
  it('源码中不存在 `process.env.WS_SPACE_PRE_ROUTE`', () => {
    expect(chatSrc).not.toMatch(/process\.env\.WS_SPACE_PRE_ROUTE/);
  });

  it('源码中不存在任何 `process.env.WS_SPACE_ROUTER_VIEW` / `WS_SPACE_GATE_OPEN` 读取', () => {
    expect(chatSrc).not.toMatch(/process\.env\.WS_SPACE_ROUTER_VIEW/);
    expect(chatSrc).not.toMatch(/process\.env\.WS_SPACE_GATE_OPEN/);
  });
});