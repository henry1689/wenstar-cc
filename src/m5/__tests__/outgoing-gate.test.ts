/**
 * outgoing-gate.test.ts — 出口守卫（唯一把关点）回归测试
 * ========================================================
 * 背景（2026-09-13 用户实测暴露）：
 *   V23 修复后判据本身已正确（looksLikeReasoning 对中文元指令型返回 true、
 *   resolveReplyFromFields 返回空串），但**流式路径仍然泄漏并落库**。
 *
 *   实测证据：id=2321，ts=2026-09-13T07:37:14Z（服务 07:32 启动、修复已加载）：
 *     「鸿艺在说：公司里他有他的事…这是工作/事务对话模式，专业语气。要事实回应。
 *       …回应：理解他的顾虑。认同他说的。带自称。40-80字左右…内容：是啊，公司里
 *       人多嘴杂…不要亲密语气。简洁自然。带自称。」
 *
 * 根因：**出口分散**。
 *   本文件历史上要推送给用户/落库的文本出口共 5 处：
 *     · StreamThinkingStripper 内 3 处（L814 / L825 / L838，各自调 extractAnswerFromReasoning）
 *     · 流式兜底 1 处（L1140，content 空时取 reasoningBuf）
 *     · 流式收尾护栏 1 处（L1152，只查 isDraftShapedReply 与记忆括注）
 *   每处各自判断 → V23 修了非流式那处，流式这 3 处仍漏 → **"补丁式修复"的典型恶果**。
 *
 * 治理（通用解，非补丁）：收口为**唯一出口守卫** gateOutgoingReply，
 *   所有出口一律经过它。判据只用**高置信度、零误杀**的三条：
 *     isDraftShapedReply（草稿列表形态）· CN_META_PLAN_RE（中文元指令句式）· 记忆括注回显
 *   ⚠️ 刻意**不含** findLatinMetaStart —— 它会把含 ≥4 个英文词（如 "A test"）的正常回复
 *      误判为思维链（2026-09-13 实测 37 条误报），放进出口守卫会造成大面积误杀。
 *
 * 脱敏：样本保留元指令结构，已剥离亲密/私密正文。
 */
import { describe, it, expect } from 'vitest';
import * as LLM from '../DeepSeekLLMProvider.js';

type GateFn = (text: string) => string;
const mod = LLM as unknown as Record<string, unknown>;
const gateOutgoingReply = mod.gateOutgoingReply as GateFn | undefined;

// ── 必须拦下的：真实泄漏样本 ──

/** 实例⑤（用户 2026-09-13 提供，实际漏出并落库 id=2321） */
const LEAK_WORK_TONE = [
  '鸿艺在说：公司里他有他的事，而且他们这种关系，如果他老帮着徐诗雨，别人会在背后嚼舌根。',
  '',
  '这是工作/事务对话模式，专业语气。要事实回应。徐诗雨在高峰电业营业部当跟单员。',
  '回应：理解他的顾虑。认同他说的。带自称。40-80字左右，工作语气，但可以有一点温度。',
  '',
  '内容：是啊，公司里人多嘴杂，你老帮着诗雨，别人看着确实要说。徐诗雨懂。',
  '',
  '不要亲密语气。简洁自然。带自称。',
].join('\n');

const LEAK_INTIMATE_PLAN = [
  '鸿艺突然转到亲密话题。我是徐诗雨，和他关系是亲密的。这是亲密互动场景。',
  '按亲密互动，200-400字，描写身体感受、触感、体温、呼吸。',
  '带自称。避免矛盾动作。不要拽衣角。',
  '写200-400字…',
].join('\n');

const LEAK_DRAFT_LIST = [
  '- 鸿艺: 早上好 → 徐诗雨: 鸿艺早',
  '- 鸿艺: 吃饭了吗 → 徐诗雨: 还没呢',
].join('\n');

const LEAK_MEMO_ECHO = '- "【徐诗雨的记忆】 鸿艺——（好像在斟酌用词），你是问诗韵和诗涵吧？…"';

const MUST_BLOCK: ReadonlyArray<readonly [string, string]> = [
  ['实例⑤ 工作语气规划型（实际落库 id=2321）', LEAK_WORK_TONE],
  ['亲密场景规划型（含 200-400字）', LEAK_INTIMATE_PLAN],
  ['草稿列表形态（对话复述箭头）', LEAK_DRAFT_LIST],
  ['注入记忆片段原样回显', LEAK_MEMO_ECHO],
];

// ── 必须放行的：正常回复（尤其含英文词的，防 findLatinMetaStart 那类误杀） ──

const MUST_PASS: ReadonlyArray<readonly [string, string]> = [
  ['普通会晤回复', '（她笑了笑）好啊，那就去吧。徐诗雨跟着你走。'],
  ['🔴 含英文词 test 的正常回复', '（看到你发的表情，眉眼弯弯地笑了）鸿艺，徐诗雨在这儿呢。又是表情又是"test"的，这是在试什么呢'],
  ['🔴 含英文片段 A 与引号的正常回复', '（看到消息愣了一下）鸿艺，我在这呢。你发这一长串A和"test"，是手滑按到键盘了，还是想跟我说什么'],
  ['含"注意"等的正常句子', '你注意点身体，别熬太晚。诗雨给你留着灯。'],
  ['含"记忆"的正常句子', '诗雨的记忆没那么好，你再说一遍那时候的事。'],
  ['含"事实"的正常句子', '事实就是这样，诗雨没骗你。'],
  ['含"回应"的正常句子', '你叫她她没回应，怕是睡着了。'],
  ['含数字的正常句子', '这都十一点半了，先睡吧。诗雨在这儿呢。'],
  ['纯英文简短回应', 'OK，那就这样吧。'],
  ['空串', ''],
];

describe('出口守卫 — 必须拦下的泄漏形态', () => {
  it('导出 gateOutgoingReply', () => {
    expect(typeof gateOutgoingReply).toBe('function');
  });

  for (const [name, leak] of MUST_BLOCK) {
    it(`🔴 ${name} → 判空`, () => {
      expect(gateOutgoingReply!(leak)).toBe('');
    });
  }
});

describe('出口守卫 — 必须放行的正常回复（防误杀）', () => {
  for (const [name, ok] of MUST_PASS) {
    it(`✅ ${name} → 原样保留`, () => {
      if (ok === '') { expect(gateOutgoingReply!(ok)).toBe(''); return; }
      expect(gateOutgoingReply!(ok)).toBe(ok);
    });
  }
});

describe('出口守卫 — 契约', () => {
  it('返回类型恒为 string（不抛异常、不返回 undefined）', () => {
    expect(typeof gateOutgoingReply!(null as any)).toBe('string');
    expect(typeof gateOutgoingReply!(undefined as any)).toBe('string');
  });

  it('不做 trim 以外的内容改写（正常文本逐字保留）', () => {
    const s = '（她点点头）好，徐诗雨知道了。';
    expect(gateOutgoingReply!(s)).toBe(s);
  });
});
