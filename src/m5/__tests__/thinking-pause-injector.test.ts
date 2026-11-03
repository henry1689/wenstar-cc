// ThinkingPauseInjector — 插入位置正确性（2026-10-27 业主实测缺陷的回归）
//
// 🔴 缺陷形态：原实现 `idx = text.length * pos` 纯比例插入，零词边界意识 ⇒
//    把「东西」劈成「东…（语气放缓了些）西」、「起身」劈成「站起…（…）身」；
//    外加 `offset` 双重计算（idx 取自已变长的 result，又再加一次 offset）
//    导致第 2、3 个插入点持续右漂。
import { describe, it, expect } from 'vitest';
import { injectThinkingPause, injectVocalTic } from '../expression/ThinkingPauseInjector.js';

/** 原文中不含任何停顿标记字符，故剥离后应逐字还原 */
const SAMPLE =
  '嗯，诗雨这就收，马上就完。合上抽屉，抬眼看了看，就这一沓单子归个档。对了，是就咱们俩走，还是阿珍也一块儿？';

/** 与实现同源的边界集合（断言侧独立枚举，避免与实现共用同一错误） */
const BOUNDARY = new Set([
  '，', '。', '！', '？', '；', '：', '、', '…', '—', '·', '-',
  '（', '）', '(', ')', '【', '】', '[', ']', '“', '”', '‘', '’', '"', "'",
  ' ', '\t', '\n', '\r',
]);
const VOCAL = ['嗯…', '唔…', '诶…', '哈…'];

/** 剥离注入产物，还原原文（标记池里的括号内容与裸省略号/破折号） */
function stripInjected(s: string): string {
  let out = s;
  for (const tic of VOCAL) if (out.startsWith(tic)) out = out.slice(tic.length);
  // 依次剥掉「…（…）」「——（…）」「…」「——」
  out = out.replace(/…（[^）]*）/g, '').replace(/——（[^）]*）/g, '');
  out = out.replace(/…/g, '').replace(/——/g, '');
  return out;
}

describe('ThinkingPauseInjector — 插入位置（不得劈词）', () => {
  it('🔴 回归：无论强度与随机结果，剥离标记后必须逐字还原原文', () => {
    for (let i = 0; i < 400; i++) {
      const intensity = i % 2 === 0 ? 0.8 : 0.5;
      const out = injectThinkingPause(SAMPLE, intensity);
      expect(stripInjected(out), `intensity=${intensity} 第${i}次`).toBe(SAMPLE);
    }
  });

  it('🔴 回归：每个注入标记都紧跟在边界符之后（中文无空格，标点是唯一安全位）', () => {
    for (let i = 0; i < 400; i++) {
      const intensity = i % 2 === 0 ? 0.9 : 0.45;
      const out = injectThinkingPause(SAMPLE, intensity);
      // 逐字符扫描：凡是「…」或「—」且其后紧跟「（」的，视为注入起点
      for (let p = 0; p < out.length; p++) {
        const isMarkerStart =
          (out[p] === '…' && out[p + 1] === '（') || (out[p] === '—' && out[p + 1] === '—' && out[p + 2] === '（');
        if (!isMarkerStart) continue;
        // 标记前一位必须是边界符（不能落在词中间）
        const prev = out[p - 1];
        expect(BOUNDARY.has(prev), `标记出现在非边界位置「${prev}${out.slice(p, p + 8)}」`).toBe(true);
      }
    }
  });

  it('🔴 回归：高强度的 3 个插入点不得因 offset 双算而右漂聚堆', () => {
    // 原实现第 2、3 个插入点会一路向右推；修复后三点应分散在前中后
    let seenDistributed = 0;
    for (let i = 0; i < 200; i++) {
      const out = injectThinkingPause(SAMPLE, 0.9);
      const idxs: number[] = [];
      for (let p = 0; p < out.length; p++) {
        // 🔴 2026-11-03 修测量误差（业主批准批4）：原判据**只数 `…（`**，而 PAUSES.heavy
        //   5 项里有 2 项是 `——（…）` ⇒ 40% 的插入点被漏计。P(两点都选到 `…（`)=(3/5)^2=36%，
        //   与实测 81/200=40.5% 吻合 —— 不是「右漂聚堆」，是**没数到**。
        //   改为数**两种标记形态的起始位**；spread 阈值(>SAMPLE.length*0.2)、idxs>=2、
        //   200 轮、阈值 100 全部不动，断言强度不变。
        const isPauseMarker =
          (out[p] === '…' && out[p + 1] === '（') ||
          (out[p] === '—' && out[p + 1] === '—' && out[p + 2] === '（');
        if (isPauseMarker) idxs.push(p);
      }
      if (idxs.length >= 2) {
        const spread = idxs[idxs.length - 1] - idxs[0];
        if (spread > SAMPLE.length * 0.2) seenDistributed++;
      }
    }
    // 绝大多数情况下多个插入点应当分散，而不是挤在同一处
    expect(seenDistributed).toBeGreaterThan(100);
  });

  it('低强度（≤0.3）不注入停顿，只把句末标点换成省略号', () => {
    expect(injectThinkingPause(SAMPLE, 0.2)).toBe(SAMPLE.replace(/[。，]$/, '…'));
    expect(injectThinkingPause('今天天气不错。', 0)).toBe('今天天气不错…');
  });

  it('空串与单字符不抛出', () => {
    expect(injectThinkingPause('', 0.8)).toBe('');
    expect(() => injectThinkingPause('嗯', 0.9)).not.toThrow();
  });

  it('无标点的长文本退到末尾，绝不落在词中间', () => {
    const noPunct = '今天天气真好啊我们一起去公园走走吧然后再去喝杯咖啡好不好';
    for (let i = 0; i < 100; i++) {
      const out = injectThinkingPause(noPunct, 0.8);
      // 剥离后必须仍是原文（不丢字），且标记只可能出现在末尾区域
      expect(stripInjected(out)).toBe(noPunct);
      for (let p = 0; p < out.length - 1; p++) {
        if (out[p] === '…' && out[p + 1] === '（') {
          expect(p, '无标点文本中出现了非末尾插入').toBeGreaterThan(noPunct.length - 5);
        }
      }
    }
  });
});

/** 括号深度（断言侧独立实现，避免与实现共用同一错误） */
function depthAt(s: string, idx: number): number {
  let d = 0;
  const end = Math.min(idx, s.length);
  for (let i = 0; i < end; i++) {
    const c = s[i];
    if (c === '（' || c === '(') d++;
    else if (c === '）' || c === ')') d = Math.max(0, d - 1);
  }
  return d;
}

/**
 * 是否是**停顿标记**的起点。
 *
 * 🔴 必须要求前一位是边界符 —— 否则会把语气词前缀 `嗯…` 的省略号误判成标记：
 *   输出开头是 `嗯…（停顿了一下）`，`…` 后面正好跟 `（`，形态与真标记一模一样。
 *   真标记由 `snapToBoundary` 保证**紧跟边界符**插入，语气词的 `…` 前面是 `嗯`（非边界）。
 */
function isPauseMarkerStart(out: string, p: number): boolean {
  const hit =
    (out[p] === '…' && out[p + 1] === '（') ||
    (out[p] === '—' && out[p + 1] === '—' && out[p + 2] === '（');
  if (!hit) return false;
  return p > 0 && BOUNDARY.has(out[p - 1]);
}

describe('ThinkingPauseInjector — 括号深度（不得插进 LLM 动作描写内部）', () => {
  /**
   * 🔴 缺陷形态（2026-10-27 业主实测）：
   *   `（缓了一下，——（好像在斟酌用词）声音温温的）`
   *   标记被插进了 LLM 的动作描写括号**里面**。
   *   根因：BOUNDARY_CHARS 含 `（`，「插在 `（` 之后」被判为合法边界。
   *   上一轮 3cc56fe 只保证不劈词，**不保证不进括号**。
   */
  const WITH_PARENS =
    '（缓了一下，声音温温的）诗雨这就去，不磨蹭了。（顿了顿，小声）那你快点回来，我在这儿等你。';

  it('🔴 回归：400 轮随机下，每个注入标记在**原文**中的插入位点括号深度必须为 0', () => {
    let markersSeen = 0;
    for (let i = 0; i < 400; i++) {
      const out = injectThinkingPause(WITH_PARENS, 0.9);
      // ① 不丢字、不改字
      expect(stripInjected(out), `第${i}次`).toBe(WITH_PARENS);

      for (let p = 0; p < out.length; p++) {
        if (!isPauseMarkerStart(out, p)) continue;
        markersSeen++;
        // ② 由**输出前缀**剥离标记后反推原文位点 —— 这样算的是「插入点在原文里的位置」，
        //    不受输出中新增括号的干扰（直接在输出上算深度会被标记自己的括号带偏）。
        const origIdx = stripInjected(out.slice(0, p)).length;
        const d = depthAt(WITH_PARENS, origIdx);
        expect(d, `第${i}次：标记插进了深度 ${d} 的位置（原文下标 ${origIdx}）`).toBe(0);
      }
    }
    // 断言不能空转：必须真的观察到过标记
    expect(markersSeen).toBeGreaterThan(100);
  });

  it('含未闭合括号的脏文本：两头都无合法位置时宁可不插，绝不硬插进内部', () => {
    const unbalanced = '（这是一段没闭合的旁白诗雨这就去不磨蹭了那你快点回来我在这儿等你等你';
    for (let i = 0; i < 200; i++) {
      const out = injectThinkingPause(unbalanced, 0.9);
      expect(stripInjected(out), `第${i}次`).toBe(unbalanced);
      let markers = 0;
      for (let p = 0; p < out.length; p++) {
        if (!isPauseMarkerStart(out, p)) continue;
        markers++;
        const origIdx = stripInjected(out.slice(0, p)).length;
        expect(depthAt(unbalanced, origIdx), `第${i}次`).toBe(0);
      }
      // 未闭合 ⇒ 全文深度恒 ≥1 ⇒ 一个合法位点都没有 ⇒ **一个停顿标记都不该有**
      // （语气词前缀 `嗯…` 不算停顿标记，故此处数的是 markers 而非 out 原样）
      expect(markers, `第${i}次：脏文本仍被注入了停顿标记`).toBe(0);
    }
  });
});

describe('injectVocalTic — 行为未改动', () => {
  it('只在前缀加语气词，不改动正文', () => {
    for (let i = 0; i < 200; i++) {
      const out = injectVocalTic(SAMPLE, 0.9);
      expect(out === SAMPLE || VOCAL.some((t) => out === t + SAMPLE)).toBe(true);
    }
  });

  it('低强度恒返回原文', () => {
    expect(injectVocalTic(SAMPLE, 0.3)).toBe(SAMPLE);
  });
});
