/**
 * persistence-write-guard.test.ts — P0-2.1：会晤路由指令跳过 memories 写入守卫（2026-10-17）
 * ============================================================
 * 被守的缺陷（V3 任务书 §2.1 实测）：
 *   「找XX聊聊」类会晤路由指令被当普通对话写进 memories（145 条污染检索）。
 *   根因是判据缺失 —— 旧方案想用正则扫正文猜指令（会漏会误，V3 明令禁止）。
 *
 * 修复契约（本测试锁定）：
 *   B1. shouldSkipMemoryWrite 是纯判据：entry/exit 任一为真 ⇒ 跳过 memories（conversations 照记）；
 *   B2. 判据必须消费**结构信号**（chat.ts 会晤状态机输出），不得扫正文；
 *   C2. chat.ts 的 _meetingEntered 只在显式 enter/enterMulti 置位 ——
 *       restoreLastMeeting（重启自动恢复）不得置位（那是普通对话，不能跳写记忆）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSkipMemoryWrite } from '../persistence-stage.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// ── B1: 纯判据行为 ─────────────────────────────────────
describe('B1 — shouldSkipMemoryWrite 判据', () => {
  it('会晤进入指令 ⇒ 跳过', () => {
    expect(shouldSkipMemoryWrite({ isMeetingEntry: true, isMeetingExit: false })).toBe(true);
  });

  it('会晤退出指令 ⇒ 跳过', () => {
    expect(shouldSkipMemoryWrite({ isMeetingEntry: false, isMeetingExit: true })).toBe(true);
  });

  it('进入+退出同时为真 ⇒ 跳过', () => {
    expect(shouldSkipMemoryWrite({ isMeetingEntry: true, isMeetingExit: true })).toBe(true);
  });

  it('普通对话（两信号皆假）⇒ 不跳过', () => {
    expect(shouldSkipMemoryWrite({ isMeetingEntry: false, isMeetingExit: false })).toBe(false);
  });

  it('信号缺省（undefined）⇒ 不跳过（默认写入，fail-open 不丢记忆）', () => {
    expect(shouldSkipMemoryWrite({})).toBe(false);
    expect(shouldSkipMemoryWrite({ isMeetingEntry: undefined, isMeetingExit: undefined })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// B2/C2: 源码级能力断言（与 no-text-inferred-belong 同款守法）
// ════════════════════════════════════════════════════════════════════
describe('B2/C2 — 结构信号链路（能力断言）', () => {
  const persistSrc = readFileSync(join(REPO, 'src', 'webui', 'chat', 'persistence-stage.ts'), 'utf8');
  const chatSrc = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');

  it('B2: persistence-stage 必须用 shouldSkipMemoryWrite(input) 门控 writeMemory —— 不得扫正文', () => {
    expect(persistSrc).toMatch(/const _skipMemWrite = shouldSkipMemoryWrite\(input\)/);
    // 两个 writeMemory 调用点都必须受门控
    const gated = persistSrc.match(/_skipMemWrite/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(3); // 定义1 + user门控1 + asst门控1（+验证跳过）
    // 防回归：不得引入按正文猜指令的正则（V3 明令禁止的旧方案）
    expect(persistSrc).not.toMatch(/找.{0,4}(聊聊|谈谈|说说话)/);
  });

  it('B2: 跳过轮次的写后验证必须一并跳过 —— 否则对未写行报假失败', () => {
    expect(persistSrc).toMatch(/if \(!_skipMemWrite\) \{\s*\n\s*const verifySqlite/);
  });

  it('B2: skip 轮的 40D 写入/作品检测/瑶光回填必须一并门控 —— 防悬空引用与假日志（S4 评审 P2）', () => {
    // 两个 40D 写入点 + 作品检测 try + 回填 try 都必须受 _skipMemWrite 门控
    expect(persistSrc).toMatch(/if \(!_skipMemWrite\) writePerceptionV40Dual\(sqlite, idUser/);
    expect(persistSrc).toMatch(/if \(!_skipMemWrite\) writePerceptionV40Dual\(sqlite, idAssist/);
    expect(persistSrc).toMatch(/if \(!_skipMemWrite\) try \{\s*\n\s*const workRepo = new WorkRepository/);
    expect(persistSrc).toMatch(/if \(!_skipMemWrite\) try \{\s*\n\s*const v40Semantic =/);
  });

  it('C2: _meetingEntered 只在显式 enter/enterMulti 置位（restoreLastMeeting 不置位）', () => {
    const setPoints = chatSrc.match(/_meetingEntered = true/g) ?? [];
    // 恰好两处置位：enterMulti 分支 + 单人 enter 分支；不得多（多 = 有路径误跳写记忆）
    expect(setPoints.length).toBe(2);
    // restoreLastMeeting 的**实际调用块**内不得置位（锚定调用表达式，而非首次出现的文档注释 ——
    //   S4 评审 F 指出原断言锚在注释上近乎空转，现改正）
    const restoreCall = chatSrc.indexOf('_em.restoreLastMeeting?.()');
    expect(restoreCall).toBeGreaterThan(-1);
    const nearby = chatSrc.slice(restoreCall, restoreCall + 400);
    expect(nearby).not.toMatch(/_meetingEntered = true/);
  });

  it('C2: _meetingExited 声明后紧随 _meetingEntered（两会晤指令信号成对存在）', () => {
    expect(chatSrc).toMatch(/let _meetingExited = false;[\s\S]{0,300}?let _meetingEntered = false;/);
  });
});
