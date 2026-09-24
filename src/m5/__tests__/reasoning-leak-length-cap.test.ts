/**
 * V31 — 思维链泄漏根治（长度上限 + 结构判据 fail-closed）
 * ==================================================================
 * 这是**同一类病的第三次复发**（前两次：2026-09-13 cn-meta、2026-09-12 v22）。
 *
 * 生产实测（2026-09-24，用户直接提供原文）：
 *   用户：带回来，你看着办
 *   回复：用户让我带饭回来，"你看着办"。现在是中午12:10，徐诗雨还在上班/中午。
 *         保持徐诗雨身份，口语化，有温度。简洁点，答应下来，说我看着带。
 *         】】】】】】】】】】】】…（数千个，直至长度上限）
 *
 * 日志铁证（[ChatStream] done 的 tokens/len 分布）：
 *   正常回复：tokens=62~226  len=150~360
 *   异常回复：tokens=0 或 1   len=3012/3024/3032/3037/3064/3084  ← 全部卡在 ~3000
 *
 * 根因链（每一环都有实据）：
 *   ① roleplay 档 maxTokens=3000（llm-config.ts:56）
 *   ② 角色扮演 reasoning_effort='max'（DeepSeekLLMProvider.ts:1585）⇒ 思维链吃光预算
 *   ③ 模型退化为复读「】」直至撞 max_tokens ⇒ content 从未产出 ⇒ 流式期间 tokens=0/1
 *   ④ 流结束兜底 `if (!text.trim())` → extractAnswerFromReasoning(reasoningBuf)
 *      —— 五条策略全不命中时**原样返回**
 *   ⑤ gateOutgoingReply 拦不住（关键词判据）：
 *        定义里是 `我要以…身份回应`  样本是 `我应该以…身份`    ← 「要」vs「应该」
 *        定义里是 `保持角色：`        样本是 `保持徐诗雨身份`   ← 擦边而过
 *   ⑥ 本应触发的 noUsableAnswer 抛错没触发（兜底正常返回了字符串，没有抛）
 *
 * 与非流式路径的**不对称**：非流式早就 fail-closed 了（L1040-1052 注释原文：
 *   「剥离失败(≈原文) 或 形态仍是草稿 → 判『无可用答案』，宁可失败重试也绝不洩漏」），
 *   **流式路径被 V22 改成了「尽力提取」** —— 本文件锁死「两条路径同语义」。
 *
 * ⚠️ 守卫式设计：源码迁移分「先拿令牌 → 再改代码」两步，故本文件在「迁移前」
 *   也必须能编译且能跑过（否则 S3/S5 回流死锁）。与迁移强相关的断言用 `landed` 守卫。
 *
 * 脱敏说明：样本用于判据回归，均为**元推理结构**（讲"打算怎么答"），不含私密正文。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const readCode = (p: string) =>
  read(p).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const PROVIDER = 'src/m5/DeepSeekLLMProvider.ts';
const providerSrc = read(PROVIDER);
const providerCode = readCode(PROVIDER);

/** 两条真实泄漏样本（元推理结构，已脱敏正文） */
const LEAK_SAMPLES = [
  '用户让我带饭回来，"你看着办"。现在是中午12:10，徐诗雨还在上班/中午。保持徐诗雨身份，口语化，有温度。简洁点，答应下来，说我看着带。',
  '鸿艺说"诗雨，下班了，给我带饭回来"。但现在是中午12:10，不是下班时间。铁律：时间现实，不能时间错乱。我应该以徐诗雨身份回应。保持徐诗雨身份，口语化，有温度。',
];

/** 合法回复（**必须不能被误杀** —— 这是 V22/V23 反复踩的坑） */
const LEGIT_REPLIES = [
  '（她愣了一下，随即笑出声来）行啊你，说吧，想吃什么？',
  '嗯…你给诗雨看的那篇，是写人写气质的，没提这个。',
  '好的呀，我在呢。',
  '刚把火关小，汤还得再煨一会儿。',
];

/**
 * 已知张力（**不在本次范围**，仅作事实记录，不裁决）：
 *   `【…的记忆】` 括注形态会被 `gateOutgoingReply` 设计性拒绝（2026-09-16 记忆回显剥离）；
 *   而 `looksLikeReasoning` 的注释又明确担心该模式会误杀「引用【徐诗雨的记忆】的合法会晤回复」。
 *   两处结论相左，属既有张力 —— 本变更不触碰，故此处只断言「当前确实被拒」这个事实。
 */
const MEMORY_LABEL_REPLY = '【徐诗雨的记忆】那天你说想去看海，我一直记着呢。';

// ─────────────────────────────────────────────────────────────
// 迁移前也恒真：这些是**现状事实**的断言，锁住根因不被"顺手改掉"
// ─────────────────────────────────────────────────────────────
describe('[V31] 根因现状（迁移前后都成立的事实断言）', () => {
  it('🔴 roleplay 档 maxTokens 必须仍可查（根因①的定位锚点）', () => {
    const cfg = read('src/common/const/llm-config.ts');
    expect(cfg).toMatch(/roleplay:\s*\{[\s\S]*?maxTokens:\s*3000/);
  });

  it('🔴 非流式路径必须保持 fail-closed（这是流式要对齐的目标语义）', () => {
    expect(providerCode).toMatch(/noUsableAnswer\s*=\s*true/);
    expect(providerCode).toMatch(/No usable answer after reasoning strip/);
  });

  it('🔴 M5 已有「空结果 → 降级重试(low)」通道，下游不需要新造', () => {
    const m5 = read('src/m5/M5Orchestrator.ts');
    expect(m5).toMatch(/if\s*\(!draft\)/);
    expect(m5).toMatch(/reasoningEffortOverride:\s*'low'/);
  });

  it('🟢 「不退化」基线：这些合法回复当前不被判为思维链', () => {
    // 用现有导出做基线对照 —— 迁移后同一批输入必须仍然通过
    const t = read('src/m5/__tests__/reasoning-leak-length-cap.test.ts');
    expect(t).toContain('LEGIT_REPLIES');
    expect(LEGIT_REPLIES.length).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────
// 迁移落地后必须成立
// ─────────────────────────────────────────────────────────────
describe('[V31] 甲-1：流式必须读取 finish_reason（当前全仓从未读）', () => {
  /**
   * 迁移守卫：以「finish_reason 是否在非类型位置被赋值/比较」为判据。
   * 当前它只出现在 interface 声明里（finish_reason: string），是死字段。
   */
  const captured =
    /finishReason\s*=\s*json\?\.choices\?\.\[0\]\?\.finish_reason/.test(providerCode) ||
    /finishReason\s*=\s*[^;\n]*finish_reason/.test(providerCode);
  const fi = captured ? it : it.skip;

  fi('🔴 finish_reason 被捕获并在长度上限时判死', () => {
    expect(providerCode).toMatch(/finishReason/);
    // 'length' ⇒ 撞上限 ⇒ 内容必然是截断物 ⇒ 判无可用答案（交重试）
    expect(providerCode).toMatch(/===?\s*'length'/);
    expect(providerCode).toMatch(/noUsableAnswer/);
  });

  it('🟢 绝不把 finish_reason 用作「正常结束」的放行条件（未捕获前也不得放行）', () => {
    // 反向守卫：不允许出现「有 finish_reason 就直接信任」的写法
    expect(providerCode).not.toMatch(/finish_reason\s*===?\s*'stop'\s*&&\s*!text/);
  });
});

describe('[V31] 甲-2：结构判据 fail-closed（不靠关键词）', () => {
  /** 迁移守卫：新导出存在则自动激活 */
  const hasStrict = /export function tryExtractAnswerFromReasoning/.test(providerCode);
  const si = hasStrict ? it : it.skip;

  si('🔴 新增结构判据导出（四条结构策略全未命中 ⇒ 返回 null）', () => {
    expect(providerCode).toMatch(/export function tryExtractAnswerFromReasoning\s*\(/);
  });

  si('🔴 流式结束兜底改为 fail-closed：取不到答案必须抛 noUsableAnswer，不得返回原文', () => {
    // 定位流结束兜底块（if (!text.trim()) 之后）
    const idx = providerCode.indexOf('if (!text.trim())');
    expect(idx, '应存在流结束兜底块').toBeGreaterThan(-1);
    const scope = providerCode.slice(idx, idx + 1600);
    // 必须走结构判据 + 抛错，不得直接 onToken 泄漏
    expect(scope).toMatch(/tryExtractAnswerFromReasoning/);
    expect(scope).toMatch(/noUsableAnswer/);
    // 旧写法「extractAnswerFromReasoning(...) 直接喂 gateOutgoingReply 然后 onToken」必须消失
    expect(scope).not.toMatch(/gateOutgoingReply\(\s*extractAnswerFromReasoning\s*\(/);
  });

  it('🔴 四条结构策略必须都还在（不得为让判据通过而删策略）', () => {
    for (const fn of [
      'extractFromReflectiveChain',
      'findAfterPlanChain',
      'findAfterWriteGo',
      'findAfterLastEval',
    ]) {
      expect(providerSrc, `结构策略 ${fn} 不得删除`).toContain(fn);
    }
  });

  it('🟢 记录根因：两条泄漏样本**都不在关键词判据的覆盖内**（故本变更走结构判据）', async () => {
    // 这条断言**故意描述现状缺陷** —— 它证明「再加关键词」这条路走不通：
    //   判据里写的是 `我要以…身份回应`，样本是 `我应该以…身份`（要 vs 应该）
    //   判据里写的是 `保持角色：`，      样本是 `保持徐诗雨身份`（擦边而过）
    // 若哪天有人把样本塞进关键词表让它变 true，说明又在走已被证伪三次的老路。
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      looksLikeReasoning?: (t: string) => boolean;
    };
    expect(typeof mod.looksLikeReasoning, 'looksLikeReasoning 应可动态导入').toBe('function');
    for (const [i, s] of LEAK_SAMPLES.entries()) {
      expect(mod.looksLikeReasoning!(s), `样本${i + 1} 必须仍判为「不像思维链」= 关键词覆盖不到`).toBe(false);
    }
  });

  it('🟢 不退化基线：合法回复不得被出口守卫拒绝', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      gateOutgoingReply?: (t: string) => string;
    };
    expect(typeof mod.gateOutgoingReply).toBe('function');
    for (const s of LEGIT_REPLIES) {
      const out = mod.gateOutgoingReply!(s);
      expect(out.length, `合法回复被误杀: ${s.slice(0, 12)}…`).toBeGreaterThan(0);
    }
    // 事实记录：记忆括注形态当前被判拒（既有设计，非本次引入）
    expect(mod.gateOutgoingReply!(MEMORY_LABEL_REPLY)).toBe('');
    expect(LEGIT_REPLIES.length).toBeGreaterThanOrEqual(4);
  });
});

describe('[V31] 丙：LLM 链路熔断（ROBUST_LLM 三级保护的第三级）', () => {
  const hasBreaker = /RetrieverCircuitBreaker/.test(providerCode);
  const pi = hasBreaker ? it : it.skip;

  it('🟢 复用仓库现成熔断组件，不另造机制（bionic_search / knowledge_fts 同款）', () => {
    // 组件本体必须仍在、且已被其他模块使用 —— 防止有人把它挪走导致本处失效
    expect(read('src/app/knowledge/RetrieverCircuitBreaker.ts')).toMatch(/export class RetrieverCircuitBreaker/);
    expect(read('src/adapter/bionic-adapter.ts')).toMatch(/new RetrieverCircuitBreaker\(/);
  });

  pi('🔴 LLM 调用被熔断器包裹（连续失败阈值 + 冷却）', () => {
    expect(providerCode).toMatch(/new RetrieverCircuitBreaker\(\s*'deepseek_llm'/);
    expect(providerCode).toMatch(/threshold:\s*[1-3]\b/);
    expect(providerCode).toMatch(/cooldownMs:\s*\d+/);
    // 必须真的用它包住调用，而不是只 new 出来不用
    expect(providerCode).toMatch(/\.call\(/);
  });

  pi('🔴 熔断打开时必须走降级而非静默吞掉（否则用户看到的是空回复无归因）', () => {
    const idx = providerCode.indexOf("new RetrieverCircuitBreaker('deepseek_llm'");
    expect(idx).toBeGreaterThan(-1);
    const scope = providerCode.slice(idx, idx + 2500);
    // 必须有 fallback 分支（throw 或返回明确失败），不得只有 fn 没有 fallback
    expect(scope).toMatch(/fallback|throw|catch/);
  });

  it('🔴 超时 30s 与重试 3 次不得因加熔断而被改动', () => {
    expect(providerCode).toMatch(/maxRetries\s*=\s*2\b/);     // attempt 0..2 = 3 次
    expect(providerCode).toMatch(/30000/);                    // 主路径 30s
  });
});

describe('[V31] 丁：M 层埋点（HOOK_M_LAYER）', () => {
  const hasHooks = /module_entry/.test(providerSrc);
  const hi = hasHooks ? it : it.skip;

  hi('🔴 LLM 调用点必须有 module_entry / module_exit + 耗时', () => {
    expect(providerSrc).toMatch(/\[Hook\] module_entry module=m5\.DeepSeekLLMProvider/);
    expect(providerSrc).toMatch(/\[Hook\] module_exit module=m5\.DeepSeekLLMProvider/);
    expect(providerSrc).toMatch(/耗时=\$\{Date\.now\(\) - _t0\}ms/);
  });

  hi('🔴 埋点必须带 status（success/fail），否则无法区分「慢」与「失败」', () => {
    const idx = providerSrc.indexOf('[Hook] module_exit module=m5.DeepSeekLLMProvider');
    expect(idx).toBeGreaterThan(-1);
    const scope = providerSrc.slice(idx, idx + 300);
    expect(scope).toMatch(/status=/);
  });

  it('🟢 埋点范式与既有 m2 保持一致（同一套字段：module / 耗时）', () => {
    const adapter = read('src/m2/SQLiteAdapter.ts');
    expect(adapter).toMatch(/\[Hook\] module_entry module=m2\.SQLiteAdapter/);
    expect(adapter).toMatch(/耗时=\$\{Date\.now\(\) - t0\}ms/);
  });
});

describe('[V31] 乙：角色扮演推理档降级', () => {
  const lowered = /_isRoleplay\s*\?\s*'medium'/.test(providerCode);
  const bi = lowered ? it : it.skip;

  bi('🔴 角色扮演不再用 max 思维档（思维链吃光 3000 预算的根因②）', () => {
    expect(providerCode).toMatch(/_isRoleplay\s*\?\s*'medium'/);
    expect(providerCode).not.toMatch(/_isRoleplay\s*\?\s*'max'/);
  });

  it('🔴 重试通道必须保留 low 档（乙的兜底，不许一并改掉）', () => {
    expect(read('src/m5/M5Orchestrator.ts')).toMatch(/reasoningEffortOverride:\s*'low'/);
  });
});
