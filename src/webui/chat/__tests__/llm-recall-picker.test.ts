import { describe, it, expect } from 'vitest';
import * as MR from '../../../m4/retrieval/meeting-recall.js';
import * as RS from '../retrieval-stage.js';

// C：LLM 兜底挑选回归测试（2026-09-12）
//
// 场景：用户问"还记得我们的中秋之约吗"，关键词/向量都拿不准时，把候选交 LLM 挑选。
// 触发（两者取或，业主 2026-09-12 定 (c)）：
//   ① 回忆问句 —— 复用既有 RECALL_TRIGGER_RE（含"还是X的事/继续说"等续聊引导）
//   ② 候选稀疏 —— 候选条数 < 3
// 候选上限 30（业主定）；LLM 走 rawCall（提取/分析通道，绕过 persona 与角色路由，
//   见 LLMProvider 接口注释与 FGRelationExtractor 既有先例）。
// 异常（超时/解析失败/无命中/无 rawCall 能力）→ 返回空，由调用方回退原候选，不阻塞主流程。
//
// 红测试写法说明：待实现的导出用「Record 断言 + 可选类型」取用，而非直接 import 具名成员 ——
// 后者会在实现落地前让 S3 的 tsc 前置检查失败（B1 踩过该坑）。
// 样例为日常语境，不涉亲密内容。

type EscalateFn = (message: string, candidateCount: number, threshold?: number) => boolean;
type RawCall = (
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
) => Promise<string>;
type PickFn = (
  llm: { rawCall?: RawCall },
  message: string,
  candidates: Array<{ id: string; text: string }>,
  maxCandidates?: number,
) => Promise<string[]>;

const mrMod = MR as unknown as Record<string, unknown>;
const rsMod = RS as unknown as Record<string, unknown>;
const shouldEscalate = mrMod.shouldEscalateToLlmPicker as EscalateFn | undefined;
const pickRelevantByLlm = rsMod.pickRelevantByLlm as PickFn | undefined;

describe('[C] LLM 兜底挑选 — 触发判定（回忆问句 或 候选稀疏）', () => {
  it('导出 shouldEscalateToLlmPicker', () => {
    expect(typeof shouldEscalate).toBe('function');
  });

  it('回忆问句触发 —— 即便候选充足', () => {
    expect(shouldEscalate!('你还记得我们的中秋之约吗', 50)).toBe(true);
  });

  it('候选稀疏触发 —— 即便不是问句', () => {
    expect(shouldEscalate!('今天天气不错', 2)).toBe(true);
  });

  it('候选充足且非回忆问句 → 不触发（不该无谓增加延迟与成本）', () => {
    expect(shouldEscalate!('今天天气不错', 10)).toBe(false);
  });
});

describe('[C] LLM 兜底挑选 — 挑选与解析', () => {
  const cands = [
    { id: 'm0', text: '零号候选' },
    { id: 'm1', text: '一号候选' },
    { id: 'm2', text: '二号候选' },
    { id: 'm3', text: '三号候选' },
  ];

  it('导出 pickRelevantByLlm', () => {
    expect(typeof pickRelevantByLlm).toBe('function');
  });

  it('LLM 返回编号数组 → 映射回候选 id', async () => {
    const llm = { rawCall: async () => '[1, 3]' };
    expect(await pickRelevantByLlm!(llm, '还记得那个约定吗', cands)).toEqual(['m1', 'm3']);
  });

  it('LLM 输出无编号（含思维链散文）→ 返回空，不抛错', async () => {
    const llm = { rawCall: async () => '让我想想……这些候选看起来都不太相关。' };
    expect(await pickRelevantByLlm!(llm, '还记得那个约定吗', cands)).toEqual([]);
  });

  it('LLM 抛错 → 返回空，异常不外溢', async () => {
    const llm = { rawCall: async () => { throw new Error('network down'); } };
    expect(await pickRelevantByLlm!(llm, '还记得那个约定吗', cands)).toEqual([]);
  });

  it('越界编号被丢弃（不返回不存在的候选）', async () => {
    const llm = { rawCall: async () => '[1, 99, -1]' };
    expect(await pickRelevantByLlm!(llm, '还记得那个约定吗', cands)).toEqual(['m1']);
  });

  it('候选超过上限 → 只提交前 N 条（成本控制）', async () => {
    let submitted = '';
    const llm = {
      rawCall: async (messages: Array<{ role: string; content: string }>) => {
        submitted = messages[messages.length - 1].content;
        return '[]';
      },
    };
    const many = Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, text: '候选' + i }));
    await pickRelevantByLlm!(llm, '还记得那个约定吗', many, 30);
    expect(submitted).toContain('[29]');
    expect(submitted).not.toContain('[30]');
  });

  it('provider 无 rawCall 能力 → 返回空（降级，不抛错）', async () => {
    expect(await pickRelevantByLlm!({}, '还记得那个约定吗', cands)).toEqual([]);
  });
});
