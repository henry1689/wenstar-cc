/**
 * 流式聊天 job 终态契约测试 — 阶段 A（2026-09-24）
 * ==========================================================
 * 事故背景：压测下前端气泡反复只显示 `…`、且输入框卡在禁用态（「卡死不回复」）。
 *
 * 三种完全不同的结局此前坍缩成同一个裸占位符：
 *   ① LLM 报错        → status='error'，前端只 clearInterval，不 clearBusy、不渲染原因
 *   ② job 被 TTL 回收 → 端点返回 {ok:false}（无原因），前端空转到 60s 硬超时
 *   ③ 任务一直 running → 无 deadline，空转到 60s 硬超时
 *
 * 本文件锁定「终态必须可归因」这条不变量，防止回退到裸占位符实现。
 *
 * ⚠️ 导入方式说明（诚实标注）：源码侧的 classifyJobError / nextJobStateForSweep
 *    与 status 的 deadline_exceeded 由**同一变更集**落地；哨兵对中高风险源文件
 *    只认令牌（mcp/server.ts:1315），令牌在流水线 S7 才签发，故本测试在源码
 *    尚未落地时按 skip 处理，源码落地后自动激活。采用动态导入 + 类型守卫，
 *    保证在两个阶段都能通过 tsc（不产生「测试引用未存在导出」的回流死锁）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/**
 * 读**源码**（剥掉行注释后再断言）。
 * 必须剥注释：本文件与实现文件里都会有「原实现三处都写 xxx」这类说明文字，
 * 若直接对全文跑正则，注释会把「已修好」误判成「没修」（实测踩过）。
 */
const readCode = (p: string) =>
  read(p)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

/** 源码侧纯函数（源码落地后为函数；未落地为 undefined → 对应用例 skip） */
type TerminalModule = {
  classifyJobError?: (err: unknown) => { error_code: string; reason: string };
  nextJobStateForSweep?: (job: unknown, now: number, ttl: number) => { action: string; patch?: Record<string, unknown> };
};
const mod = (await import('../server-chat-routes.js')) as TerminalModule;
const hasTerminalApi = typeof mod.classifyJobError === 'function' && typeof mod.nextJobStateForSweep === 'function';
const ti = hasTerminalApi ? it : it.skip;

const ROUTES = 'src/webui/server-chat-routes.ts';
const UI = 'src/webui/index.html';

describe('[阶段A] 源码侧 — 终态契约已存在（源码扫描，两个阶段都可跑）', () => {
  it('🔴 status 必须含 deadline_exceeded 四态', () => {
    expect(read(ROUTES)).toContain("'deadline_exceeded'");
  });

  it('🔴 必须有结构化错误码类型 JobErrorCode', () => {
    expect(read(ROUTES)).toMatch(/JobErrorCode/);
  });

  it('🔴 必须有异常归类函数（429/timeout/attempts 分别归因）', () => {
    const src = read(ROUTES);
    expect(src).toMatch(/classifyJobError/);
    expect(src).toMatch(/llm_rate_limited/);
    expect(src).toMatch(/llm_timeout/);
    expect(src).toMatch(/llm_failed/);
  });

  it('🔴 sweep 必须「先置终态、后回收」，且判定为纯函数可单测', () => {
    const src = read(ROUTES);
    expect(src).toMatch(/nextJobStateForSweep/);
    // 不允许保留「超龄即删」的旧写法（会退回 {ok:false} 歧义空值）
    expect(src).not.toMatch(/if\s*\(\s*now\s*-\s*v\.createdAt\s*>\s*ttl\s*\)\s*\{\s*CHAT_JOBS\.delete/);
  });

  it('🔴 状态端点必须给出原因，不得只回 {ok:false}', () => {
    const src = read(ROUTES);
    // 用真实路径表达式定位，不用字符串 —— 注释里也会出现该路径名（会指错位置）
    const idx = src.indexOf("url.pathname === '/api/chat/job/status'");
    expect(idx, '应存在 job 状态端点处理分支').toBeGreaterThan(-1);
    const window = src.slice(idx, idx + 1800);
    expect(window).toMatch(/reason/);
    expect(window).toMatch(/error_code/);
    // 找不到 job 时必须给原因，而不是空 {ok:false}
    expect(window).not.toMatch(/JSON\.stringify\(\{\s*ok:\s*false\s*\}\)/);
  });
});

describe('[阶段A] 前端 — 禁止裸占位符（源码扫描，剥注释）', () => {
  const src = readCode(UI);

  it('🔴 不存在「lastTxt 兜底裸省略号」这类占位', () => {
    expect(src).not.toMatch(/lastTxt\s*\|\|\s*['"]…['"]/);
  });

  it('🔴 轮询发现 error/deadline_exceeded 必须走统一终结渲染（解锁 UI，否则输入框永久禁用 = 真·卡死）', () => {
    const idx = src.indexOf("status==='error'");
    expect(idx, '应存在对 status===error 的轮询分支').toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, idx - 500), idx + 500);
    // 分支必须调用统一渲染函数（原实现只 clearInterval，不解锁也不渲染原因）
    expect(window).toMatch(/failBubble\(/);
    // 且该渲染函数本身必须解锁
    const defIdx = src.indexOf('const failBubble=');
    expect(defIdx, '应定义统一终结渲染函数').toBeGreaterThan(-1);
    expect(src.slice(defIdx, defIdx + 320)).toMatch(/clearBusy\(\)/);
  });

  it('🔴 轮询必须处理 ok:false（job 被回收），不能空转到 60s', () => {
    expect(src).toMatch(/if\s*\(\s*!dd\.ok\s*\)/);
  });

  it('🟢 60s 兜底仍保留，但必须明示是超时而非静默占位', () => {
    expect(src).toMatch(/超过\s*60\s*秒|60\s*秒内未收到/);
  });
});

// ── 行为断言：源码落地后自动激活（skip 不阻塞 tsc / 不阻塞流水线） ──
describe('[阶段A] classifyJobError 行为（源码落地后生效）', () => {
  ti('🔴 429 限流归为 llm_rate_limited（而非「重试耗尽」）', () => {
    // 真实形态：API call failed after 3 attempts: 429 (...) —— 同时含 429 与 attempts，根因是限流
    const r = mod.classifyJobError!(new Error('API call failed after 3 attempts: 429 (尝试 1/3) -> 429 (尝试 2/3)'));
    expect(r.error_code).toBe('llm_rate_limited');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  ti('🔴 超时/中止归为 llm_timeout', () => {
    expect(mod.classifyJobError!(new Error('The operation was aborted due to timeout')).error_code).toBe('llm_timeout');
    expect(mod.classifyJobError!(new Error('Request timed out')).error_code).toBe('llm_timeout');
  });

  ti('🔴 重试耗尽但非限流/超时 → llm_failed', () => {
    const r = mod.classifyJobError!(new Error('API call failed after 3 attempts: 502 (尝试 1/3) -> 502 (尝试 2/3)'));
    expect(r.error_code).toBe('llm_failed');
  });

  ti('🔴 空异常也必须给出非空 reason（否则 UI 又会退回占位符）', () => {
    expect(mod.classifyJobError!(undefined).reason.length).toBeGreaterThan(0);
    expect(mod.classifyJobError!('').reason.length).toBeGreaterThan(0);
  });
});

describe('[阶段A] nextJobStateForSweep 行为（源码落地后生效）', () => {
  const TTL = 180_000;
  const job = (s: string) => ({
    status: s, tokens: [], reply: '', result: null,
    audio: { audio_url: null, audio_urls: [], tts_job: null }, createdAt: 0,
  });

  ti('🔴 未终态且超龄 → mark（置 deadline_exceeded）而不是 delete', () => {
    const act = mod.nextJobStateForSweep!(job('running'), TTL + 1, TTL);
    expect(act.action).toBe('mark');
    expect(act.patch!.status).toBe('deadline_exceeded');
    expect(act.patch!.error_code).toBe('deadline_exceeded');
    expect(String(act.patch!.reason || '').length).toBeGreaterThan(0);
  });

  ti('🔴 已终态 → 自 terminalAt 起再保留 ttl，让前端读得到终态', () => {
    const j = { ...job('error'), terminalAt: 1000 };
    expect(mod.nextJobStateForSweep!(j, 1000 + TTL, TTL).action).toBe('keep');
    expect(mod.nextJobStateForSweep!(j, 1000 + TTL + 1, TTL).action).toBe('delete');
  });

  ti('未超龄的 running → keep（不得提前判死）', () => {
    expect(mod.nextJobStateForSweep!(job('running'), TTL - 1, TTL).action).toBe('keep');
  });

  ti('正常完成的 done（无 terminalAt）→ 回收口径与改动前一致', () => {
    const j = job('done');
    expect(mod.nextJobStateForSweep!(j, TTL, TTL).action).toBe('keep');
    expect(mod.nextJobStateForSweep!(j, TTL + 1, TTL).action).toBe('delete');
  });
});
