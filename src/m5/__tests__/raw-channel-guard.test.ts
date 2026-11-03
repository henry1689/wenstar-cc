/**
 * raw-channel-guard.test.ts — LLM 出口通道分流守卫（2026-10-30，业主批准）
 * ============================================================
 * 被守的缺陷（S1 取证）：
 *
 *   `rawCall`（工具型调用，共 11 处：压缩摘要 / 实体终审 / 关系抽取 / 块摘要 /
 *   记忆检索编号 / 发言人推断…）经由 `callDeepSeekApi`，而后者**无条件**套用了
 *   聊天回复的 `resolveReplyFromFields`。其中的 `isDraftShapedReply` 判据是
 *   「正常回复不会以列表项开头」—— 对摘要却是**正常形态** ⇒ 判空 ⇒ 抛
 *   `No usable answer after reasoning strip` ⇒ `rawCall` 里「取原始 content」
 *   的 V45 兜底**根本执行不到**（异常先抛出）。
 *
 *   实测：近 20 万行错误日志 1916 次（累计 2780 次）；共享熔断器 `deepseek_llm`
 *   被后台任务反复打穿，前台对话周期性降级。
 *
 * 修复（S2/S3）：
 *   · `resolveRawPayload()` —— raw 通道窄守卫：只拦「哨兵串」与「中文元指令」，
 *     其余原样返回（列表、JSON、第三人称摘要都是合法工具输出）。
 *   · 非流式出口按 `channel` 分流；窄守卫判空时**回落**原严格剥离
 *     （保证「content 为空 → reasoning 兜底」这条 V22 路径一字不变）。
 *   · 熔断分桶：`deepseek_llm`（回复）/ `deepseek_llm_tool`（工具）。
 *
 * 本测试锁定：
 *   R1-R2 raw 通道放行合法工具形态（列表 / JSON）
 *   R3-R4 raw 通道仍拒绝真泄漏形态（哨兵串 / 中文元指令）
 *   R5    同一列表在 reply 通道**仍然**判空 —— 记录这条刻意的不对称
 *   R6    reply 通道合法短回复不受影响（防回归）
 *   R7    接线与分桶的结构性断言（防被「一刀切」合并回去）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRawPayload, resolveReplyFromFields } from '../DeepSeekLLMProvider.js';

/** 列表形态 —— 压缩摘要最常见的合法输出 */
const LIST_SHAPED = '- 用户问今天天气如何\n- 玉瑶回答晴天二十四度';
/** 合法的 JSON 工具输出 */
const JSON_SHAPED = '{"entity":"阿珍","action":"update","confidence":0.92}';
/** 自有哨兵串（系统提示词标记）—— 模型在复述输入 */
const SENTINEL = '鸿艺对你说：今天天气不错';
/** 中文元指令 —— 模型在复述系统指令 */
const META_PLAN = '我要以徐诗雨身份回答这个问题，要带自称，40-80字';

describe('R1/R2 raw 通道：合法工具形态必须放行', () => {
  it('R1 列表形态摘要原样返回（修复前：被判空 → 抛错 → 熔断）', () => {
    expect(resolveRawPayload(LIST_SHAPED)).toBe(LIST_SHAPED);
  });

  it('R2 合法 JSON 原样返回', () => {
    expect(resolveRawPayload(JSON_SHAPED)).toBe(JSON_SHAPED);
  });

  it('R2b 空 content → 空串（交回上层走严格 reasoning 兜底）', () => {
    expect(resolveRawPayload('')).toBe('');
    expect(resolveRawPayload(undefined)).toBe('');
  });
});

describe('R3/R4 raw 通道：真泄漏形态仍必须拒绝', () => {
  it('R3 含自有哨兵串 → 判空', () => {
    expect(resolveRawPayload(SENTINEL)).toBe('');
  });

  it('R4 含中文元指令 → 判空', () => {
    expect(resolveRawPayload(META_PLAN)).toBe('');
  });
});

describe('R5/R6 reply 通道：行为逐字不变（记录刻意的不对称）', () => {
  it('R5 同一列表在 reply 通道**仍然**判空 —— 这是设计，不是遗漏', () => {
    // 「聊天回复不会以列表项开头」对回复成立；对工具输出不成立。
    // 两条通道策略不同，正是本次修复的全部内容。
    expect(resolveReplyFromFields(LIST_SHAPED)).toBe('');
  });

  it('R6 合法短回复不受影响', () => {
    expect(resolveReplyFromFields('好的呀，我在呢。')).toBe('好的呀，我在呢。');
  });
});

describe('R7 接线与熔断分桶（结构性断言，防被合并回去）', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const src = readFileSync(join(REPO, 'src', 'm5', 'DeepSeekLLMProvider.ts'), 'utf8');

  it('rawCall 必须显式标记 channel: raw', () => {
    const i = src.indexOf('async rawCall(');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, src.indexOf('\n  }', i));
    expect(body).toMatch(/channel:\s*'raw'/);
  });

  it('工具通道必须有独立熔断桶，且不得复用 deepseek_llm', () => {
    expect(src).toMatch(/new RetrieverCircuitBreaker\('deepseek_llm_tool'/);
    expect(src).toMatch(/channel === 'raw' \? this\._toolBreaker : this\._llmBreaker/);
  });

  it('出口判定必须按通道分流，且窄守卫判空时回落严格剥离', () => {
    expect(src).toMatch(/_rawPayload \|\| resolveReplyFromFields\(/);
  });
});