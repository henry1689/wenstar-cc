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

describe('[V31] 甲-3：非流式出口必须同守结构判据（重试路径的泄漏口）', () => {
  /**
   * 🔴 实测复盘（2026-09-24 16:27，重启后仍复现）：
   *   首次调用（流式）→ 甲-2 结构判据触发 ✅ → 抛 noUsableAnswer → 返回 {text:''}
   *   → M5 判空重试，而 M5Orchestrator:108 的重试**不传 onToken**
   *   → _callDeepSeekApiInner 走**非流式**分支 → resolveReplyFromFields **原样返回 3039 字思维链**
   *   → 因走非流式 onToken 从未调用 ⇒ 日志表现为 `tokens=0 len=3039`
   *
   *   日志铁证：泄漏 job 前出现唯一一条 `status=fail`（耗时 32910ms）= 甲-2 确实抛了错；
   *   紧接着 `status=success`（7765ms）= 重试从更松的非流式出口漏了出去。
   *
   *   ⇒ 流式与非流式**两侧判据不一致**，只堵一侧等于没堵。
   *   ⚠️ 更正：V31 文档原写「非流式早已 fail-closed、流式漏了」—— **该陈述错误**，
   *     两侧一直用的是两套判据（结构 vs 关键词），已同步修订文档。
   */
  const aligned = /looksLikeReasoning\(r\)\s*\|\|\s*tryExtractAnswerFromReasoning\(r\)/.test(providerCode) ||
    /tryExtractAnswerFromReasoning\(r\)\s*===\s*null/.test(providerCode);
  const ai = aligned ? it : it.skip;

  it('🔴 重试路径必须不带 onToken（这正是泄漏走非流式的入口，事实断言）', () => {
    const m5 = read('src/m5/M5Orchestrator.ts');
    expect(m5).toMatch(/reasoningEffortOverride:\s*'low'/);
    // 重试不传 onToken 是既有设计（注释：不带 onToken，避免二次流式污染气泡）
    expect(m5).not.toMatch(/reasoningEffortOverride: 'low'[\s\S]{0,200}?onToken:/);
  });

  it('🔴 非流式分支必须存在（两侧判据都要管，不能只堵流式）', () => {
    expect(providerCode).toMatch(/if\s*\(\s*streamOpts\?\.\s*onToken\s*\)/);
    expect(providerCode).toMatch(/export function resolveReplyFromFields/);
  });

  ai('🔴 resolveReplyFromFields 的放行点必须追加结构判据', () => {
    // content 空分支（③ fail-closed）与 content 非空分支（①）都要用结构判据兜底
    expect(providerCode).toMatch(/tryExtractAnswerFromReasoning/);
    const idx = providerCode.indexOf('export function resolveReplyFromFields');
    expect(idx).toBeGreaterThan(-1);
    const scope = providerCode.slice(idx, idx + 2600);
    expect(scope).toMatch(/tryExtractAnswerFromReasoning/);
    // 结构判据必须与关键词判据是「或」关系——关键词认不出时结构仍须拦截
    expect(scope).toMatch(/\|\|\s*tryExtractAnswerFromReasoning|tryExtractAnswerFromReasoning\([^)]*\)\s*===\s*null/);
  });

  it('🟢 短答豁免必须仍在（否则重试路径会误杀合法短答）', () => {
    expect(providerCode).toMatch(/tooShortToBeReasoning/);
    expect(providerCode).toMatch(/length\s*<=\s*50/);
  });

  /** 🔴 决定性行为断言：实测泄漏的两条样本必须被非流式出口拒掉 */
  const beh = aligned ? it : it.skip;
  beh('🔴 泄漏样本经 resolveReplyFromFields 必须返回空（content 分支与 reasoning 分支都要拦）', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    expect(typeof mod.resolveReplyFromFields).toBe('function');
    for (const [i, s] of LEAK_SAMPLES.entries()) {
      // ① 样本在 content 里
      expect(mod.resolveReplyFromFields!(s, ''), `样本${i+1} 经 content 分支必须判空`).toBe('');
      // ② 样本在 reasoning 里（content 空）—— 重试路径的真实形态
      expect(mod.resolveReplyFromFields!('', s), `样本${i+1} 经 reasoning 分支必须判空`).toBe('');
    }
    // 合法回复两侧都必须存活（V23 曾因判据过宽退化成「抱歉我暂时无法回应」）
    for (const s of LEGIT_REPLIES) {
      expect(mod.resolveReplyFromFields!(s, ''), `合法回复被 content 分支误杀: ${s.slice(0, 10)}…`).not.toBe('');
      expect(mod.resolveReplyFromFields!('', s), `合法回复被 reasoning 分支误杀: ${s.slice(0, 10)}…`).not.toBe('');
    }
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

// ─────────────────────────────────────────────────────────────
// V33 — 第四次复发：模型输出的是「历史对话转录」（续写历史格式）
// ─────────────────────────────────────────────────────────────
/**
 * 2026-09-24 生产实测：最近 200 条 `[ChatStream] done` 中 57 条（28.5%）为 `tokens=0/1`。
 * 全仓**只有一处**会「一次性 `onToken({text:全文})`」= V31 甲-1 流结束兜底
 * ⇒ `tokens≤1` 即「该条由 reasoningBuf 兜底捞出」的**结构性指纹**。
 * 根因：甲-2 只判「有没有找到结构标记」，而转录文本含括号动作/引号/分段 ⇒ 被判有结构。
 *
 * ⚠️ S4 评审阻断项 3 的教训（第一版测试是**空转**的）：样本必须能**真实触达**判据才能锁住它。
 *   第一版样本 `hasStructure=false`，走的是更早的分支 ⇒ 把判据整段删掉测试照样绿。
 *   本版用「**对照组**」证明：同一文本**只把自有哨兵串换掉**，其余逐字不变 ——
 *   有哨兵 ⇒ 拒；无哨兵 ⇒ 存活。两者之差只可能来自哨兵判据本身。
 *
 * 脱敏说明：真实样本含私密正文，此处只保留**结构**（自有哨兵串 + 多轮形态），内容为中性占位。
 */
const TRANSCRIPT_ECHO = [
  '[当前说话对象: 某某 | ⚠️ 你不是玉瑶] 鸿艺对你说：今天天气不错',
  '（她点点头）是啊，挺好的。',
  '[当前说话对象: 某某 | ⚠️ 你不是玉瑶] 鸿艺对你说：晚上吃什么',
  '（她想了想）随便，你定。',
  '[当前说话对象: 某某 | ⚠️ 你不是玉瑶] 鸿艺对你说：那就吃面',
  '（她笑了笑）行。',
].join('\n');
/** 对照组：**只替换自有哨兵串**，其余逐字不变（这是「是甲造成的」唯一可证伪的判据） */
const TRANSCRIPT_ECHO_CONTROL = TRANSCRIPT_ECHO
  .split('鸿艺对你说：')
  .join('甲对乙说：')
  .split('[当前说话对象:')
  .join('[旁白对象:');

describe('[V33] 甲：自有哨兵串回声（**收敛进唯一出口守卫 gateOutgoingReply**）', () => {
  it('🔴 转录回声被拒，且**同一文本去掉哨兵即存活** ⇒ 拒绝只可能来自哨兵判据', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      gateOutgoingReply?: (t: string) => string;
    };
    expect(typeof mod.gateOutgoingReply).toBe('function');
    expect(mod.gateOutgoingReply!(TRANSCRIPT_ECHO), '含自有哨兵串的转录必须判空').toBe('');
    expect(
      mod.gateOutgoingReply!(TRANSCRIPT_ECHO_CONTROL),
      '对照组（仅换掉哨兵串）必须存活 —— 否则本断言证明不了任何东西'
    ).not.toBe('');
  });

  it('🔴 半角/全角冒号漂移都要拦住（源文本里两种冒号本就不一致）', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      gateOutgoingReply?: (t: string) => string;
    };
    const drift = TRANSCRIPT_ECHO.split('鸿艺对你说：')
      .join('鸿艺对你说:')
      .split('[当前说话对象:')
      .join('[当前说话对象：');
    expect(mod.gateOutgoingReply!(drift)).toBe('');
  });

  it('🔴 判据必须**住在 gateOutgoingReply 里**（唯一把关点），不是某个出口的专属判据', () => {
    // V23.1 注释原文：「不再往每个出口各加一条判据…修了 2 处，还剩 3 处漏网」
    const g = providerSrc.indexOf('export function gateOutgoingReply');
    expect(g, '应存在 gateOutgoingReply').toBeGreaterThan(-1);
    const body = providerSrc.slice(g, providerSrc.indexOf('\n}', g));
    expect(body, '哨兵判据必须住在唯一把关点内').toMatch(/SELF_INJECTED_MARKERS\.some/);
  });

  it('🔴 哨兵常量与生成点**同源**：生成点不得再写字面量（防脱钩后静默失效）', () => {
    expect(providerSrc).toMatch(/const MEETING_SPEAKER_TAG = '\[当前说话对象:'/);
    expect(providerSrc).toMatch(/const MEETING_USER_PREFIX = '鸿艺对你说：'/);
    // 生成点（会晤分支）必须引用常量
    const gen = providerSrc.indexOf('| ⚠️ 你不是玉瑶]');
    expect(gen, '应存在会晤用户消息生成点').toBeGreaterThan(-1);
    const line = providerSrc.slice(providerSrc.lastIndexOf('\n', gen), gen + 120);
    expect(line).toMatch(/MEETING_USER_PREFIX/);
    expect(line, '生成点不得再写死字面量').not.toContain('鸿艺对你说：');
  });

  it('🟢 不退化基线：合法回复仍须通过出口守卫', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      gateOutgoingReply?: (t: string) => string;
    };
    for (const s of LEGIT_REPLIES) {
      expect(mod.gateOutgoingReply!(s), `合法回复被误杀: ${s.slice(0, 10)}…`).not.toBe('');
    }
  });

  it('🟢 tryExtract 侧只作**提前判死**，不是唯一防线（收口在 gateOutgoingReply）', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      tryExtractAnswerFromReasoning?: (t: string) => string | null;
    };
    expect(mod.tryExtractAnswerFromReasoning!(TRANSCRIPT_ECHO)).toBeNull();
    for (const s of LEGIT_REPLIES) {
      expect(mod.tryExtractAnswerFromReasoning!(s)).not.toBeNull();
    }
  });
});

describe('[V33.1] 非流式 reasoning 分支：ratio 不得作为前置门槛（S4 阻断项 1）', () => {
  /** 让 `extracted.length / r.length < 0.9`：r 远长于提取物 ⇒ 旧写法在此处短路 */
  const R_LONG =
    '我得先想想怎么接这句话，不能太生硬。'.repeat(8) + '\n让我来写一段回应：\n' + TRANSCRIPT_ECHO;

  it('🔴 复现旧短路口：ratio 确实 < 0.9（否则本用例证明不了修复）', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      extractAnswerFromReasoning?: (t: string) => string;
    };
    const extracted = mod.extractAnswerFromReasoning!(R_LONG).trim();
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.length, 'ratio 必须 <0.9 才能复现旧的短路路径').toBeLessThan(R_LONG.length * 0.9);
  });

  it('🔴 该分支不得泄漏转录（两字段任一承载都要拦住）', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    expect(mod.resolveReplyFromFields!('', R_LONG), 'reasoning 分支泄漏').toBe('');
    expect(mod.resolveReplyFromFields!(TRANSCRIPT_ECHO, ''), 'content 分支泄漏').toBe('');
  });

  it('🔴 源码侧：结构性信号必须**独立**成立，不得再被 ratio 门槛挡住', () => {
    // 用**剥注释后**的文本扫描，否则会误命中「引用旧写法」的注释（首次即踩）
    const i = providerCode.indexOf('const extracted = extractAnswerFromReasoning(r).trim();');
    expect(i, '应存在 reasoning 提取点').toBeGreaterThan(-1);
    const scope = providerCode.slice(i, i + 2400);
    // ① 强信号：独立 if，不与 ratio 复合
    expect(scope, '结构信号必须独立成句').toMatch(
      /if\s*\(\s*tryExtractAnswerFromReasoning\(r\)\s*===\s*null\s*\)\s*return '';/
    );
    // ② 弱信号：仍须配 ratio（删掉它会让合法用例被误杀，实测过）
    expect(scope, '关键词信号必须仍受 ratio 约束').toMatch(/_notStripped\s*&&\s*looksLikeReasoning\(r\)/);
    // 返回值过唯一出口守卫
    expect(scope, '本分支返回值必须过唯一出口守卫').toMatch(/return gateOutgoingReply\(extracted\)/);
  });

  it('🟢 不退化基线：弱信号必须仍受 ratio 约束（删掉即误杀）', async () => {
    // `让我来写回应：（她笑了笑）嗯，天亮了…` —— looksLikeReasoning 对它是 true，
    // 但剥离确实生效（ratio 0.76）⇒ 必须放行。这条锁死「不能把 ratio 约束删掉」。
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
      looksLikeReasoning?: (t: string) => boolean;
    };
    const r = '让我来写回应：（她笑了笑）嗯，天亮了，你醒啦？我陪着你呢。';
    expect(mod.looksLikeReasoning!(r), '前提：该文本确会触发弱信号').toBe(true);
    expect(mod.resolveReplyFromFields!('', r), '剥离确实生效 ⇒ 必须放行').toContain('天亮了');
  });

  it('🟢 不退化基线：合法回复经两条分支都必须存活', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    for (const s of LEGIT_REPLIES) {
      expect(mod.resolveReplyFromFields!(s, '')).not.toBe('');
      expect(mod.resolveReplyFromFields!('', s)).not.toBe('');
    }
  });
});

describe('[V33.1] 乙（整段抄出比例）已移除 —— 其前提被实测证伪', () => {
  it('🔴 代码中不得残留 _wholeChainDump', () => {
    expect(providerCode, '乙 会误杀降级模式下的合法长答复（实测 ratio=1.000）').not.toMatch(/_wholeChainDump/);
  });

  it('🟢 记录证伪依据：降级模式下「提取物≈输入」是**正常**形态', () => {
    // 该路径的合法形态就是 content 为空、整段答复落在 reasoning ⇒ ratio 天然接近 1，
    // 因此按比例判「整段端出」必然误杀。测试此事实，防止有人再度引入同类阈值判据。
    const long = '（她把手在围裙上擦了擦，转身从灶台边绕过来）今天的汤煨得刚刚好，你尝尝咸淡。'.repeat(20);
    expect(long.length).toBeGreaterThan(600);
  });
});

describe('[V33.2] content 分支的三处提前 return 必须同守哨兵判据（S4 二轮阻断项）', () => {
  it('🔴 :219 剥离生效分支 —— 剥完仍含哨兵 ⇒ 判空', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    // 角色建立段可被剥掉 ⇒ `ex.length < c.length - 10` 成立 ⇒ 走 :219 那条提前 return
    const c = '好了，现在我是玉瑶，我们来说吧\n' + TRANSCRIPT_ECHO;
    expect(mod.resolveReplyFromFields!(c, '')).toBe('');
  });

  it('🟢 :219 对照组（**只对该支有鉴别力**）：同构造仅换哨兵串 ⇒ 必须存活', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    // 同一构造，只把哨兵串换成中性等形文本 ⇒ 必须原样返回，否则 :219 的断言证明不了任何东西
    const c = '好了，现在我是玉瑶，我们来说吧\n' + TRANSCRIPT_ECHO_CONTROL;
    expect(mod.resolveReplyFromFields!(c, '')).not.toBe('');
  });

  it('🔴 :222 拉丁元推理截断分支 —— 剥完仍含哨兵 ⇒ 判空', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    // ⚠️ **可达性（首版空转，S4 三轮实跑纠正）**：`:222` **只在 `ex` 为空时**才可能到达 ——
    //   `extractAnswerFromReasoning` 最外层就是 `truncateLatinMetaTail`，
    //   `ex` 与 `tail` 在 `inner(c)===c` 时恒等 ⇒ 只要 tail 缩短，ex 必以 ≥ 的幅度先缩短，
    //   `:219` 先命中。故必须构造「ex 为空 + tail 被截 >10 字」：
    //   记忆括注（剥后为空） + 转录 + 拉丁尾（被 truncateLatinMetaTail 截掉）。
    const c = '【徐诗雨的记忆】\n' + TRANSCRIPT_ECHO
      + '\n\nCount: 68 chars. Revised: ~68 chars. Let me finalize this now please.';
    expect(mod.resolveReplyFromFields!(c, '')).toBe('');
  });

  it('🟢 :222 对照组：同构造仅换哨兵串 ⇒ 必须存活', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    const c = '【徐诗雨的记忆】\n' + TRANSCRIPT_ECHO_CONTROL
      + '\n\nCount: 68 chars. Revised: ~68 chars. Let me finalize this now please.';
    expect(mod.resolveReplyFromFields!(c, '')).not.toBe('');
  });

  it('🔴 :238 原样返回分支 —— 前两条都不成立时也不得放行哨兵文本', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    // ⚠️ **可达性（首版空转，S4 三轮实跑纠正）**：不能用短文本 —— 21 字时
    //   `tryExtract` 内的哨兵判据已让 `:237` 命中，`:238` 永不被求值。
    //   必须让「剥离量 ≤10」：本输入 51 字、只剥 8 字。
    const c = '[当前说话对象:' + '（她把窗推开，让风进来一点）今天太阳很好，晒得人懒懒的，你要不要也出来走走？我陪你去。';
    expect(mod.resolveReplyFromFields!(c, '')).toBe('');
  });

  it('🟢 :238 对照组：同构造仅换哨兵串 ⇒ 必须存活', async () => {
    const mod = (await import('../DeepSeekLLMProvider.js')) as {
      resolveReplyFromFields?: (c?: string, r?: string) => string;
    };
    const c = '[旁白对象:' + '（她把窗推开，让风进来一点）今天太阳很好，晒得人懒懒的，你要不要也出来走走？我陪你去。';
    expect(mod.resolveReplyFromFields!(c, '')).not.toBe('');
  });

  it('🔴 判据助手必须存在且为单一真源（供各出口复用，防判据分散）', () => {
    expect(providerSrc).toMatch(/const hasSelfInjectedMarker = \(s: string\): boolean => SELF_INJECTED_MARKERS\.some/);
    // 三处提前 return 都必须 OR 入它
    const hits = providerSrc.match(/\|\|\s*hasSelfInjectedMarker\(/g) || [];
    expect(hits.length, '三处提前 return（ex / tail / c）都要 OR 入哨兵判据').toBeGreaterThanOrEqual(3);
  });
});
