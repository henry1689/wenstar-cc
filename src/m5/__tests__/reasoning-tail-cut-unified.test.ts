import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * [V35-D / 2026-10-05] 思维链尾部截断必须**收口为一条路径**
 * =====================================================
 * 第 5 次思维链泄漏。业主上报的泄漏尾巴：
 *   「好。约200字。自称有。紧扣话题。不编造。时间合理。关于"票还没出"——合理，
 *     因为用户说"应该"。这是问，不是编造。好。」
 *
 * 根因是**结构性**的，不是词表不够全：
 *   `StreamThinkingStripper` 的尾部评估截断原先只挂在 `if (this.crossed)` 分支上 ——
 *   即只对「已进入答案区后的**后续** chunk」生效；而另外 5 条返回路径
 *   （①findAnswerMark ②findAnswerStart ②b缓冲超长 ④非流式兜底 flush）**全都不过这道工序**。
 *   只要「答案起点 + 尾部元话语」落在**同一个 chunk**，整段元话语原样泄漏前台。
 *   生产表现即 `tokens=1`（server-chat-routes.ts 的 job.tokens.length；
 *   实测日志 76 次，其中 47 次 len 150~600）。
 *
 * 本测试锁住两件事，缺一不可：
 *   ① **结构性**：同一段文本「同块送」与「分块送」必须得到**完全相同**的结果
 *      —— 这是防退化的关键。原实现下两者一个漏一个不漏（实测 3/3 vs 0/3）。
 *   ② **判据边界**：单个元话语特征不得触发截断（合法语境），成簇的 ≥2 个才触发。
 *
 * 样例均为日常语境，不涉亲密内容。
 */

const ROOT = process.cwd();
const codeOf = (p: string) =>
  readFileSync(resolve(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ANSWER =
  '（把手机放下，转过身来）鸿艺，我记得的呀。25 号晚上我们三个人一起去杭州，诗韵也一起。'
  + '你说票还没出，等过两天再看看。我一直在想着那天要穿什么，杭州晚上应该凉，要带件外套。';

/** 清单式元话语（模型复盘自检），≥3 个特征且相邻 */
const META_TAIL =
  '好。约200字。自称有。紧扣话题。不编造。时间合理。'
  + '关于"票还没出"——合理，因为用户说"应该"。这是问，不是编造。好。';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const f of frames) c.enqueue(encoder.encode(f)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const frame = (content: string) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';

function makeParams(extra: Record<string, unknown> = {}) {
  const snap = {
    pleasure: 0, arousal: 0, intimacy: 0, sexual_attraction: 0, sensory_craving: 0,
    energy_merge: 0, possessiveness: 0, ecstasy: 0, aggression: 0, sincerity: 0,
    dominance: 0, safety: 0,
  };
  return {
    strategy: { strategy_id: 'test', params: { tone: 'neutral', depth: 'shallow', max_length: 400 } } as any,
    cognition: {
      current: { perception_snapshot: snap, raw_input: '我们25号晚上去杭州的飞机是几点来着', calcium: 0, key_entities: [] },
      history: { has_relevant_history: true, summary: '有相关历史记忆' },
      family: { has_family_context: false, relationships: [] },
    } as any,
    userMessage: '我们25号晚上去杭州的飞机是几点来着',
    ...extra,
  } as any;
}

/** 驱动真实流式路径，返回最终回复文本 */
async function runStream(frames: string[]): Promise<string> {
  (globalThis as any).fetch = async () => sseResponse(frames);
  const { DeepSeekLLMProvider } = await import('../DeepSeekLLMProvider.js');
  const provider = new DeepSeekLLMProvider('test-model');
  const tokens: string[] = [];
  const r = await provider.generate(makeParams({
    onToken: (d: { text?: string }) => { if (d.text) tokens.push(d.text); },
  }));
  return String((r as any)?.text ?? '');
}

describe('[V35-D] 尾部截断必须收口 —— 结果不得取决于分块方式', () => {
  afterEach(() => { delete (globalThis as any).fetch; });

  it('🔴 同块送：答案 + 元话语清单一次到达 → 元话语必须被截掉，答案保留', async () => {
    const out = await runStream([frame(ANSWER + META_TAIL), 'data: [DONE]\n\n']);

    expect(out, '答案必须完整保留（不得连答案一起削）').toContain('三个人一起去杭州');
    expect(out, '元话语清单必须被截掉').not.toContain('约200字');
    expect(out).not.toContain('用户说');
    expect(out).not.toContain('不是编造');
  });

  it('🔴 分块送：答案一块、元话语另一块 → 同样必须被截掉', async () => {
    const out = await runStream([frame(ANSWER), frame(META_TAIL), 'data: [DONE]\n\n']);

    expect(out).toContain('三个人一起去杭州');
    expect(out).not.toContain('约200字');
    expect(out).not.toContain('用户说');
  });

  it('🔴【核心不变量】同块送与分块送必须得到**完全相同**的结果', async () => {
    const one = await runStream([frame(ANSWER + META_TAIL), 'data: [DONE]\n\n']);
    const many = await runStream([frame(ANSWER), frame(META_TAIL), 'data: [DONE]\n\n']);

    // 原实现下这两者一个漏一个不漏（实测 3/3 vs 0/3）——这正是"结构性绕过"的指纹。
    // 收口之后，分块方式不得再影响结果。
    expect(one, '结果不得因分块方式而不同').toBe(many);
  });

  it('🔴 词表【认得的】评估句也必须同块送也截断（不止元话语判据生效）', async () => {
    const known = '这个长度很合适，语气也贴合。确认一下：正文里有"鸿艺"吗？有——';
    const out = await runStream([frame(ANSWER + known), 'data: [DONE]\n\n']);

    expect(out).toContain('三个人一起去杭州');
    expect(out).not.toContain('这个长度很合适');
  });

  it('🔴 正常回复不得被误伤（无任何元话语特征）', async () => {
    const out = await runStream([frame(ANSWER), 'data: [DONE]\n\n']);
    expect(out).toContain('三个人一起去杭州');
    expect(out.length, '整段正常回复应原样保留').toBeGreaterThanOrEqual(ANSWER.length - 5);
  });
});

describe('[V35-D] 元话语判据的边界 —— 单个特征不得触发', () => {
  afterEach(() => { delete (globalThis as any).fetch; });

  it('🔴 合法办公语境「用户说…」单独出现 → 不截断', async () => {
    // 玉瑶是私人秘书，讨论产品用户是正常对话，不是思维链。
    const legit = '（把文件推过去）这个需求我看过了。用户说这个功能有问题，我明天去确认一下。';
    const out = await runStream([frame(legit), 'data: [DONE]\n\n']);
    expect(out, '单个元话语特征不得触发截断（否则会误伤合法语境）').toContain('用户说这个功能有问题');
  });

  it('🔴 角色自辩「我没有编造」单独出现 → 不截断', async () => {
    const legit = '（她认真地看着你）你别误会，我没有编造。那次确实是我记岔了日子。';
    const out = await runStream([frame(legit), 'data: [DONE]\n\n']);
    expect(out).toContain('没有编造');
  });
});

describe('[V35-D] 源码守卫 — 六条出口必须共用同一道工序', () => {
  it('🔴 每条 return 出口都必须经过 applyTailCut', () => {
    const src = codeOf('src/m5/DeepSeekLLMProvider.ts');
    // 收口点存在
    expect(src, '必须存在唯一收口点').toMatch(/private static applyTailCut\(/);
    expect(src, '必须存在判据合一处').toMatch(/private static tailCutIndex\(/);
    // 原实现的三条判据不得再内联在 crossed 分支里各算一遍
    expect(src, '判据不得再散落内联').not.toMatch(/const evalIdx = this\.tailBuf\.search/);
    expect(src, '判据不得再散落内联').not.toMatch(/const latinIdx = findLatinMetaStart\(this\.tailBuf\)/);
    // 五条曾经绕过的出口都必须调用收口点
    const cuts = (src.match(/StreamThinkingStripper\.applyTailCut\(/g) || []).length;
    expect(cuts, '六条出口（crossed 分支 + ①②②b④flush）都应过收口点，实际调用数偏少').toBeGreaterThanOrEqual(5);
  });
});
