/**
 * reasoning-leak-cn-meta.test.ts — 中文「元指令型」思维链泄漏回归测试
 * ==================================================================
 * 现象（2026-09-13 生产实测，用户直接提供原文）：
 *   会晤模式下，回复**整条**就是 reasoning 原文 —— 里面把「打算怎么答」写得清清楚楚，
 *   却没有一个字是真正给用户的回答。两个真实实例：
 *
 *   实例①（用户重复问同一句，两次得到同样的"思考过程"）
 *     用户：不是我在给你写的那篇文章里就说到拉丝的话语吗
 *     回复：鸿艺问：…他在确认：…我要以徐诗雨身份回答。这是事实回忆。…要诚实。…
 *           按规则：事实优先，不确定就说不记得或不知道，不要编造。
 *           回应：…要带自称，简洁，40-80字。以徐诗雨口吻。
 *           可以稍微说：你给诗雨看的那篇，是写人写气质的，没提这个。
 *           ← 答案已经想好了（"可以稍微说：…"），却从未进入 content
 *
 *   实例②（草稿迭代全过程泄漏）
 *     用户：再来一次
 *     回复：用户说"再来一次"——指的是刚才那个吻。我是徐诗雨…要自然回应…
 *           长度按亲密互动，200-400字左右。…写：…不错。但要控制长度和自然度。
 *           再调整。…最终版本：…
 *
 * 根因：
 *   2026-09-12 为修「会晤回复退化成『抱歉，我暂时无法回应』」，把
 *   resolveReplyFromFields 的 fail-closed 削弱成 fail-open（"无论如何不得整体判空"，
 *   剥不动就把原文返回），同时从 looksLikeReasoning 中**移除了** SYSTEM_REFERENCE_RE。
 *
 *   移除理由本身成立（该正则含 `【…记忆…】` 模式，会误杀引用「【徐诗雨的记忆】」的
 *   合法会晤回复）。**但连带后果是：中文元指令型思维链再无任何判据认领** ——
 *   findLatinMetaStart 只认英文起草，isDraftShapedReply 只认草稿列表形态，
 *   于是 looksLikeReasoning 对纯中文元指令恒返回 false，
 *   fail-closed 闸门（L202）永不触发 → reasoning 原文被当回复返回。
 *
 * 修复方向：恢复 fail-closed 语义，并把判据做「准」而非做「松」——
 *   新增 CN_META_PLAN_RE，只匹配**正常角色回复绝不可能出现**的元指令句式，
 *   且**刻意排除** `【…】` 括注（保住当初修复误杀的那个成果）。
 *
 * 脱敏说明：以下样本保留元指令**结构**，已剥离全部亲密/私密正文内容。
 */
import { describe, it, expect } from 'vitest';
import { looksLikeReasoning, resolveReplyFromFields } from '../DeepSeekLLMProvider.js';

// ── 生产泄漏实样（元指令骨架，脱敏） ──

/** 实例①：事实回忆型 —— 答案已想好但未输出 */
const LEAK_FACT_RECALL = [
  '鸿艺问：不是我在给你写的那篇文章里就说到拉丝的话语吗？',
  '他在确认：那篇写徐诗雨的文章里，是不是提到了那段话。',
  '我要以徐诗雨身份回答。这是事实回忆。档案里有那篇文章。',
  '要诚实。我看不到那篇文章里有这两个字。',
  '按规则：事实优先，不确定就说不记得或不知道，不要编造。',
  '回应：徐诗雨不记得那篇文章里写过。',
  '要带自称，简洁，40-80字。以徐诗雨口吻。',
  '可以稍微说：你给诗雨看的那篇，是写人写气质的，没提这个。',
].join('\n');

/** 实例②：草稿迭代型 —— 含"写：/不错。/再调整。/最终版本："全过程 */
const LEAK_DRAFT_ITER = [
  '用户说"再来一次"——指的是刚才那个吻。我是徐诗雨，正在亲密互动中。',
  '要自然回应，深情一点但不过火。长度按亲密互动，200-400字左右。',
  '保持角色：徐诗雨，清纯温柔。他说再来一次。',
  '注意自称铁律：正文里带上"徐诗雨"或"诗雨"。',
  '写：',
  '——他这回是真的深。',
  '不错。但要控制长度和自然度。避免太文艺。口语化一点。',
  '再调整。也要有温度。',
  '最终版本：',
].join('\n');

/** 实例③：轮次规划型 */
const LEAK_TURN_PLAN = [
  '鸿艺说被电话吵醒了，昨晚在诗雨怀里睡得好香。他有点烦。诗雨要温柔安抚。',
  '另外他还问了那个角色名，之前记忆里有这条，所以可以回答。',
  '按会晤模式，要带自称"诗雨"。简短自然，30-80字左右。',
  '情绪：温柔安抚，心疼他被吵醒。',
  '回复：诗雨在呢，被吵醒了吧。',
].join('\n');

/** 实例④：亲密场景规划型 —— 明确写了"200-400字"却一字正文未出（2026-09-13 用户补充） */
const LEAK_INTIMATE_PLAN = [
  '鸿艺突然转到亲密话题。我是徐诗雨，和他关系是亲密的。这是亲密互动场景。',
  '要自然回应，深情但不越界到太露骨。时间下午2点多。',
  '按亲密互动，200-400字，描写身体感受、触感、体温、呼吸。',
  '带自称。避免矛盾动作。不要拽衣角。',
  '场景：刚才在聊文章，现在他说想摸奶子。要自然过渡，温柔回应。',
  '不要写得太露骨，但可以亲密。她清纯温柔的性格——会害羞但不会拒绝。',
  '写：他从聊文章突然转到这个。她脸红，但愿意。可以靠过去。写触感、温度。',
  '写200-400字…',
].join('\n');

const ALL_LEAKS = [
  ['实例①事实回忆型', LEAK_FACT_RECALL],
  ['实例②草稿迭代型', LEAK_DRAFT_ITER],
  ['实例③轮次规划型', LEAK_TURN_PLAN],
  ['实例④亲密场景规划型', LEAK_INTIMATE_PLAN],
] as const;

// ── 合法回复对照组（必须不被误杀） ──

/** 真实形态的会晤回复（作为对照，必须不被误杀） */
const OK_REPLIES = [
  ['普通会晤回复', '（她笑了笑）好啊，那就去吧。徐诗雨跟着你走。'],
  ['含"注意"等词的正常句子', '你注意点身体，别熬太晚。诗雨给你留着灯。'],
  ['含"规则/优先"的正常句子', '按咱们说好的规矩来，先吃饭。诗雨不催你。'],
  ['含"记忆"的正常句子', '诗雨的记忆没那么好，你再说一遍那时候的事。'],
  ['含数字的正常句子', '这都十一点半了，先睡吧。诗雨在这儿呢。'],
  ['含"回应"的正常句子', '你叫她她没回应，怕是睡着了。'],
  ['含"事实"的正常句子', '事实就是这样，诗雨没骗你。'],
] as const;

describe('中文元指令型思维链 — looksLikeReasoning 判据', () => {
  for (const [name, leak] of ALL_LEAKS) {
    it(`🔴 ${name} → 必须判为思维链`, () => {
      expect(looksLikeReasoning(leak)).toBe(true);
    });
  }

  for (const [name, ok] of OK_REPLIES) {
    it(`✅ ${name} → 不得误判为思维链`, () => {
      expect(looksLikeReasoning(ok)).toBe(false);
    });
  }

  it('空串 → false（不抛异常）', () => {
    expect(looksLikeReasoning('')).toBe(false);
  });
});

describe('中文元指令型思维链 — resolveReplyFromFields fail-closed', () => {
  for (const [name, leak] of ALL_LEAKS) {
    it(`🔴 ${name}：content 空、reasoning 为元指令 → 返回空串（宁可空也不泄漏）`, () => {
      expect(resolveReplyFromFields('', leak)).toBe('');
    });
  }

  for (const [name, ok] of OK_REPLIES) {
    // 核心契约：合法短答**不得被判空**（判空会让会晤退化成"抱歉，我暂时无法回应"）。
    // 注：不要求与输入逐字相等 —— 剥离器会清掉 `【…】` 括注，那是既有且正确的行为。
    it(`✅ ${name}：content 空、reasoning 为合法短答 → 不得判空`, () => {
      const out = resolveReplyFromFields('', ok);
      expect(out.trim().length).toBeGreaterThan(0);
    });
  }

  it('content 非空时优先用 content，不受 reasoning 影响', () => {
    expect(resolveReplyFromFields('（她笑了笑）好，去吧。', LEAK_FACT_RECALL)).toBe('（她笑了笑）好，去吧。');
  });

  it('content 本身裹着元指令 → 不得原样透传', () => {
    const out = resolveReplyFromFields(LEAK_FACT_RECALL, '');
    expect(out).not.toContain('我要以徐诗雨身份回答');
    expect(out).not.toContain('要带自称');
  });
});

/**
 * 📋 既有边界（**非本次引入**，另行立项跟踪）
 *
 * 现象：以 `【…】` 系统标记**开头**的合法会晤回复，会被 extractAnswerFromReasoning
 *       整条剥离掉 → extracted 为空 → resolveReplyFromFields 分支② 的 `if (!extracted) return ''`
 *       直接判空。探针实测（2026-09-13）：extractLen = 0。
 *
 * 定位：这是 V22 想覆盖的「会晤引用记忆括注被误杀」场景的一个**残留** ——
 *       V23 修的是 looksLikeReasoning 对中文元指令的漏判（泄漏方向），
 *       这条是**剥离方向**的过判，二者根因不同。
 *
 * 为何不在本次一并修：需改动 V2–V20 整条剥离判据链，风险高；且不在业主报的五个现象内。
 * 本用例只**锁定当前行为**，避免它被无意改变；真正修复另行立项。
 */
describe('📋 既有边界 — 以【…】开头的合法回复（记录现状）', () => {
  const OK_WITH_MEMO_TAG = '【徐诗雨的记忆】里是有这么一回事，诗雨记得。你说的是那次吧？';

  it('判据侧不误杀（looksLikeReasoning = false）', () => {
    expect(looksLikeReasoning(OK_WITH_MEMO_TAG)).toBe(false);
  });

  it('剥离侧当前会整条吃掉 → 判空（既有行为，待修）', () => {
    expect(resolveReplyFromFields('', OK_WITH_MEMO_TAG)).toBe('');
  });
});
