/**
 * reasoning-leak-v22.test.ts — V22 英文起草泄漏回归测试
 * ======================================================
 * 现象（2026-09-12 生产实测，会晤回复）：
 *   LLM 先输出**完整中文真答案**，随后**继续用英文输出起草自检**
 *   （"Count: let me count roughly." → "Revised: …" → "~68 chars." → "Final: …"），
 *   整段被当作答案推送前台 → 思维链/内部分析泄漏给用户。
 *
 * 根因：
 *   ① 流式路径：`findAnswerStart` 命中真答案 → crossed=true 进入"直推模式"，
 *      之后所有 content 增量直推；唯一防线 tailEvalRe 只枚举**中文**评估措辞
 *      （这个长度很合适/语气也贴合/最终确认…）→ 英文起草段无一命中 → 全量泄漏。
 *   ② 非流式路径：`extractAnswerFromReasoning` 五条策略链均无"尾部起草截断"，
 *      答案在前的形态会连同后续英文草稿一起返回 → 同样泄漏。
 *
 * 修复（V22）：新增语言无关判据 findLatinMetaStart（词法签名 + 连续≥4英文词结构），
 *   流式 tailBuf 与 tailEvalRe 取**更早**截断点；非流式在 extractAnswerFromReasoning
 *   出口统一经 truncateLatinMetaTail 兜底。
 *
 * 样例已脱敏：仅保留元推理/起草段落，不涉及任何亲密或未成年内容。
 */
import { describe, it, expect } from 'vitest';
import {
  extractAnswerFromReasoning,
  findLatinMetaStart,
  truncateLatinMetaTail,
} from '../DeepSeekLLMProvider.js';

/** 生产泄漏实样（脱敏）：真答案在前 + 全英文起草自检在后 */
const LEAK_SAMPLE = [
  '（我看向窗外，晨光已经明晃晃的了）是啊，天亮了，都八点多了。你前头还说"有点晚了"——这一晃，夜就过去了。你这一宿歇着没有？要是没睡够，就再眯会儿。',
  'Count: let me count roughly. Let me shorten the parenthetical. Good.',
  'Revised: that reads better. ~68 chars.',
  'Hmm, but wait — is it appropriate to claim that?',
  'Final: keep it gentle and short.',
].join('\n');

describe('V22 — findLatinMetaStart 英文起草起点判据', () => {
  it('英文起草签名（Count:/Revised:/Final:）→ 能定位起点', () => {
    const idx = findLatinMetaStart(LEAK_SAMPLE);
    expect(idx).toBeGreaterThan(0);
    // 起点应落在真答案之后（答案段约 70 字）
    expect(idx).toBeGreaterThanOrEqual(60);
    // 起点之后即为元推理内容
    expect(LEAK_SAMPLE.slice(idx)).toMatch(/Count|Revised|Final|let me/i);
  });

  it('纯中文正常回复（最多一个英文词）→ 不误判', () => {
    expect(findLatinMetaStart('（我看向窗外）是啊，天亮了。你这一宿歇着没有？')).toBe(-1);
    expect(findLatinMetaStart('嗯，OK，那就这样吧，你先去补个觉。')).toBe(-1);
  });

  it('空输入 → -1（不抛异常）', () => {
    expect(findLatinMetaStart('')).toBe(-1);
  });

  it('连续 ≥4 英文词（无签名）→ 仍判为元推理', () => {
    expect(findLatinMetaStart('（她笑了笑）the model keeps drafting here')).toBeGreaterThan(0);
  });
});

describe('V22 — truncateLatinMetaTail 尾部截断', () => {
  it('保留真答案、丢弃其后英文起草', () => {
    const out = truncateLatinMetaTail(LEAK_SAMPLE);
    expect(out).toContain('天亮了');
    expect(out).not.toContain('Count:');
    expect(out).not.toContain('Revised:');
    expect(out).not.toContain('Final:');
    expect(out).not.toContain('chars');
  });

  it('正常中文回复 → 原样返回（不截断）', () => {
    const normal = '（我看向窗外）是啊，天亮了，都八点多了。你这一宿歇着没有？';
    expect(truncateLatinMetaTail(normal)).toBe(normal);
  });

  it('空输入 → 空串', () => {
    expect(truncateLatinMetaTail('')).toBe('');
  });

  it('整段皆为英文起草（命中签名）→ 返回空（宁可空也不泄漏）', () => {
    expect(truncateLatinMetaTail('Count: let me count. Final: done.')).toBe('');
  });
});

describe('V22 — extractAnswerFromReasoning 非流式出口兜底', () => {
  it('答案在前 + 英文起草在后 → 只返回真答案', () => {
    const out = extractAnswerFromReasoning(LEAK_SAMPLE);
    expect(out).toContain('天亮了');
    expect(out).not.toContain('let me count');
    expect(out).not.toContain('Revised');
    expect(out).not.toContain('Final');
  });

  it('纯中文回复不受影响', () => {
    const normal = '（我看向窗外）是啊，天亮了，都八点多了。';
    expect(extractAnswerFromReasoning(normal)).toContain('天亮了');
  });
});
