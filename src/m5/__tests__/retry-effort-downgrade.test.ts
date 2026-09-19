/**
 * retry-effort-downgrade.test.ts — V25 重试降级回归测试
 * =======================================================
 * 背景（2026-09-13）：
 *   思维链泄漏的**根因**不是出口判据不够，而是 **content 为空** —— V4-flash 把
 *   "打算怎么写"整段写进 reasoning，思维链吃光 max_tokens，最终稿无处安放。
 *   出口守卫只能在"空"和"泄漏"之间二选一，无论怎么选都是输。
 *
 *   而 M5Orchestrator 原本**已有**重试，却是**同参重试** —— 同样的 reasoning_effort
 *   只会复现同样的输出。"重试了还是空"的成因就在这。
 *
 * 本文件钉死的行为契约：
 *   ① 重试必须**换参数**（reasoningEffortOverride='low'）—— 否则此测试红
 *   ② 首次成功时**不得**多打一次 API —— 重试是救援路径，不能变成常态开销
 *   ③ 重试仍空 → 走明确降级提示，绝不返回思维链
 */
import { describe, it, expect, afterEach } from 'vitest';
import { M5Orchestrator } from '../M5Orchestrator.js';
import { DeepSeekLLMProvider } from '../DeepSeekLLMProvider.js';
import { CognitionAssembler } from '../CognitionAssembler.js';
import { StrategySelector } from '../StrategySelector.js';
import type { M4Context } from '../../m4/types/index.js';
import type { M3Decision } from '../../m3/types/perception.js';

interface CallRecord {
  hasOnToken: boolean;
  reasoningEffortOverride?: string;
}

/** 按脚本依次作答的假 Provider（同时记录每次调用的参数） */
class ScriptedLLM {
  readonly calls: CallRecord[] = [];
  constructor(private readonly script: string[]) {}
  async generate(params: any): Promise<{ text: string }> {
    const idx = this.calls.length;
    this.calls.push({
      hasOnToken: typeof params?.onToken === 'function',
      reasoningEffortOverride: params?.reasoningEffortOverride,
    });
    return { text: this.script[idx] ?? '' };
  }
}

function makeMockM4Context(): M4Context {
  return {
    decision: {
      actions: ['comfort'],
      enhanced: {
        branch_id: 'evt_20260913_001',
        locus_path: 'user.family.general',
        raw_input: '今天在公司怎么样',
        entity_genes: [],
        perception: {
          pleasure: 0, arousal: 0.2, dominance: 0, aggression: 0,
          sincerity: 0.6, humor: 0,
          factual: 0.5, logical: 0.3, certainty: 0.6, abstract: 0.1,
          temporal_focus: 0, self_ref: 0.5,
          intimacy: 0.3, power_diff: 0, dependency: 0.2,
          moral_judgment: 0, etiquette: 0.2, belonging: 0.3,
          sexual_attraction: 0, sensory_craving: 0, energy_merge: 0,
          possessiveness: 0, ecstasy: 0, safety: 0.5,
        },
        calcium_score: 0.7,
        calcium_level: 2,
      },
      timestamp: '2026-09-13T08:00:00.000Z',
    } as unknown as M3Decision,
    memory_summary: { timeline: [], frequentEntities: [], timeSpan: { earliest: '', latest: '' } },
    current_time: '2026-09-13T08:00:00.000Z',
    meta: { has_history: false, has_family_context: true, calcium_level: 2, dominant_action: 'comfort' },
  };
}

describe('V25 重试降级 — 空回复自救', () => {
  it('🔴 首次空 → 重试必须携带 reasoningEffortOverride=low（换参数，非同参重试）', async () => {
    const llm = new ScriptedLLM(['', '（她放下手里的文件，抬头看你）今天还好，就是有点忙。']);
    const m5 = new M5Orchestrator(llm as any);

    const reply = await m5.orchestrate(makeMockM4Context());

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].reasoningEffortOverride).toBeUndefined();   // 首次用场景默认
    expect(llm.calls[1].reasoningEffortOverride).toBe('low');       // 重试降级
    expect(reply.length).toBeGreaterThan(2);
    expect(reply).not.toContain('无法回应');
  });

  it('重试不带 onToken —— 避免二次流式污染气泡', async () => {
    const llm = new ScriptedLLM(['', '（她笑了笑）好，都听你的。']);
    const m5 = new M5Orchestrator(llm as any);

    await m5.orchestrate(makeMockM4Context(), undefined, undefined, undefined, undefined, false, {
      onToken: () => { /* 模拟流式 */ },
    });

    expect(llm.calls[0].hasOnToken).toBe(true);
    expect(llm.calls[1].hasOnToken).toBe(false);
  });

  it('✅ 首次成功 → 只调用一次（重试是救援路径，不是常态开销）', async () => {
    const llm = new ScriptedLLM(['（她点点头）徐诗雨知道了，你放心。']);
    const m5 = new M5Orchestrator(llm as any);

    const reply = await m5.orchestrate(makeMockM4Context());

    expect(llm.calls).toHaveLength(1);
    expect(reply).toContain('徐诗雨');
  });

  it('🔴 重试仍空 → 明确降级提示，绝不把思维链当回复', async () => {
    const llm = new ScriptedLLM(['', '']);
    const m5 = new M5Orchestrator(llm as any);

    const reply = await m5.orchestrate(makeMockM4Context(), undefined, undefined, undefined, undefined, true);

    expect(llm.calls).toHaveLength(2);
    expect(reply).toContain('无法回应');
  });
});

// ══════════════════════════════════════════════════════════════
// 🔴 V25.1 可达性闭环 —— 上面用 ScriptedLLM 的测试曾被独立评审判为「假信心」：
//   假 Provider 直接 `return { text: '' }`，而**真实 Provider 在同步路径上从不返回空 text**
//   （它 throw → generate 的 catch 转成非空 fallbackReply）→ M5Orchestrator 的
//   `if (!draft)` 永不成立 → 降级重试在生产默认路径上一次都不会发生。
//   本组测试用**真实 DeepSeekLLMProvider**（只 mock 掉 fetch）钉死这条链路。
// ══════════════════════════════════════════════════════════════
describe('V25.1 真实 Provider：判空必须返回空串（否则降级重试不可达）', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  /** 造一个"content 空 + reasoning 是纯元指令思维链"的真实 API 响应 */
  function mockThinkingOnlyResponse() {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '',
            reasoning_content: '鸿艺在问我公司的事。我要以徐诗雨身份回答。这是事实回忆。要带自称，简洁，40-80字。不要亲密语气。',
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 50 },
      }),
    })) as any;
  }

  it('🔴 同步路径判空 → generate 返回 { text: "" }（而非罐头 fallbackReply）', async () => {
    mockThinkingOnlyResponse();
    const provider = new DeepSeekLLMProvider();
    const assembler = new CognitionAssembler();
    const cognition = assembler.assemble(makeMockM4Context());
    const strategy = new StrategySelector().select(cognition);

    const r = await provider.generate({ strategy, cognition, userMessage: '公司里怎么样' });

    // 关键：空串才能让 M5Orchestrator 走降级重试；非空罐头句会把它挡在门外
    expect(r.text).toBe('');
  });

  it('🔴 判空错误带 noUsableAnswer 标记（区分「判空」与「故障」）', async () => {
    // 直接验证底层契约：callDeepSeekApi 判空时抛的是**被标记的**错误，
    // generate 的 catch 据此返回空串而非 fallbackReply。
    mockThinkingOnlyResponse();
    const provider = new DeepSeekLLMProvider() as any;
    const msgs = [{ role: 'user', content: '公司里怎么样' }];

    await expect(provider.callDeepSeekApi(msgs, 500, 0.9, {})).rejects.toMatchObject({
      noUsableAnswer: true,
    });
  });
});
