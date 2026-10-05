import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recallSandboxConversations } from '../m4/retrieval/meeting-recall.js';
import { getRetrievalFusionConfig } from '../config/retrieval-fusion-config.js';

/**
 * [V35-C / 2026-10-05] 对话是主体，记忆是补充
 * ===========================================
 * 背景（S1 实测）：注入的记忆块体量压过对话本身 —— 记忆均值 8836 字符 vs 历史均值 4740 字符
 * （1.9 倍，极端样本 6 倍），95% 的会晤调用 est_tokens 超 10000。其中砂金库兜底独大：
 *   ① 时间窗兜底的触发条件是 `hits.length < limit`（"不满额"），而倒排索引几乎永远凑不满 12
 *      ⇒ **每轮都兜底**；实测 109 次触发全部返回满额 12 条，占记忆预算均值 66.7%（峰值 84%）。
 *   ② 该批片段标签【对话· 被判 kind=context ⇒ **同时豁免**相关性精筛与条数上限。
 * 后果：模型注意力被"过去的素材"带走 ⇒ 话题惯性弱、说几句就漂到别的事上。
 *      代码注释里记着 2026-08-21 同源事故「早期无关记忆默认注入 ⇒ 一会东一会西」。
 *
 * 样例均为日常语境，不涉亲密内容。
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const codeOf = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const U = 'TXS-000000007';
const LONG = '这是一条足够长的旧对话原文用于通过长度门槛，内容与当前话题无关。';
const row = (content: string, ts: string) => ({ role: 'assistant', content, timestamp: ts });

/** 按 SQL 形态分派的假数据源：索引查询 vs 会话表查询 */
const mkSrc = (indexRows: any[], timeRows: any[]) => ({
  queryAll: (sql: string) =>
    /FROM search_index/.test(sql) ? indexRows
      : /FROM conversations/.test(sql) ? timeRows
        : [],
});

describe('[V35-C] 砂金库兜底必须是「索引零命中」的最后手段，且条数封顶', () => {
  it('🔴 索引已命中 → 不触发时间窗兜底（哪怕远未满额）', () => {
    const src = mkSrc(
      [row('索引命中：我们说好周三下午三点去杭州。' + LONG, '2026-09-01T00:00:00Z')],
      [row('时间窗无关一：' + LONG, '2026-09-02T00:00:00Z'),
       row('时间窗无关二：' + LONG, '2026-09-03T00:00:00Z')],
    );
    const hits = recallSandboxConversations(src, U, '杭州 周三', { limit: 12, windowDays: 21, fallbackLimit: 2 });

    expect(hits.length, '索引已命中即足够，不得再补与话题无关的时间窗内容').toBe(1);
    expect(
      hits.some(h => String(h.content).includes('时间窗无关')),
      '这正是「早期无关记忆默认注入 ⇒ 一会东一会西」的复发路径，必须堵死',
    ).toBe(false);
  });

  it('🔴 索引零命中 → 兜底触发，但条数不超过 fallbackLimit（不是倒满 12 条）', () => {
    const timeRows = Array.from({ length: 10 }, (_, i) => row(`时间窗旧原文${i}：` + LONG, `2026-09-0${(i % 9) + 1}T0${i % 10}:00:00Z`));
    const src = mkSrc([], timeRows);
    const hits = recallSandboxConversations(src, U, '杭州 周三', { limit: 12, windowDays: 21, fallbackLimit: 2 });

    expect(hits.length, '兜底是"给出历史轮廓"，不是把 12 条旧原文倒进提示词').toBeLessThanOrEqual(2);
    expect(hits.length, '零命中时仍应给出至少一条轮廓').toBeGreaterThan(0);
  });

  it('🔴 兜底条数由配置决定，且明显小于记忆召回上限', () => {
    const b = getRetrievalFusionConfig().budget;
    expect(b.sandbox_fallback_limit).toBeGreaterThan(0);
    expect(b.sandbox_fallback_limit, '兜底条数必须远小于常规召回上限').toBeLessThanOrEqual(3);
  });
});

describe('[V35-C] 记忆预算必须与对话体量挂钩（历史 ≥ 记忆）', () => {
  it('🔴 配置存在「记忆相对历史的上限比例」，且 ≤ 1', () => {
    const v = getRetrievalFusionConfig().budget.memory_max_ratio_of_history;
    expect(Number.isFinite(v) && v > 0, '必须配置为有效正数').toBe(true);
    expect(v, '业主裁定「历史 ≥ 记忆」⇒ 比例不得超过 1').toBeLessThanOrEqual(1);
  });

  it('🔴 砂金库必须有子预算，且明显小于整个记忆预算', () => {
    const v = getRetrievalFusionConfig().budget.sandbox_max_ratio_of_memory;
    expect(Number.isFinite(v) && v > 0, '必须配置为有效正数').toBe(true);
    expect(v, '砂金库实测曾占记忆预算 84%，子预算必须显著收紧').toBeLessThanOrEqual(0.5);
  });
});

describe('[V35-C] 源码守卫', () => {
  it('🔴 时间窗兜底不得再以「不满额」为触发条件', () => {
    const seg = codeOf('src/m4/retrieval/meeting-recall.ts');
    expect(seg, '兜底触发必须是「索引零命中」，不得是 hits.length < limit')
      .toMatch(/if\s*\(\s*hits\.length\s*===\s*0/);
    expect(seg, '不得回退到不满额触发').not.toMatch(/hits\.length\s*<\s*_limit\s*&&\s*_since/);
  });

  it('🔴 【对话· 不得再被并入 context（那会同时豁免精筛与条数上限）', () => {
    const seg = codeOf('src/m4/MemoryInjector.ts');
    expect(seg, '【对话· 必须独立成 kind').toMatch(/'\s*conversation\s*'/);
    // 直接盯住那条 kind 判据所在的行：它归入 context，就不得再含 【对话·
    const ctxLine = seg.split('\n').find(l => l.includes("'context'") && l.includes('【'));
    expect(ctxLine, '未找到 context 的 kind 判据行').toBeTruthy();
    expect(ctxLine!, 'context 判据里不得再含 【对话·（否则两道闸门又被绕过）').not.toContain('【对话·');
  });

  it('🔴 记忆注入上限不得直接取 hardCap —— 必须经对话体量派生', () => {
    const seg = codeOf('src/webui/chat.ts');
    expect(seg, '必须存在由历史体量派生的记忆上限').toMatch(/_memCap\s*=/);
    expect(seg, 'injectMemories 必须接收派生后的上限').toMatch(/maxChars:\s*_memCap/);
    expect(seg, '不得再直接把 hardCap 交给 injectMemories').not.toMatch(/maxChars:\s*_hardCap/);
  });
});
