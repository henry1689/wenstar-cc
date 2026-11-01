// ThinkingPauseInjector — 0.6秒思考停顿注入器
// 高强度场景下，在文本中插入"带思考动作的停顿"，
// 模拟"边想边说"的真实感，替代单纯的省略号

// 不同强度的停顿标记池
const PAUSES: Record<string, string[]> = {
  light: [
    '…',
    '…（想了想）',
    '——',
  ],
  medium: [
    '…（停顿了一下）',
    '——（好像在斟酌用词）',
    '…（语气放缓了些）',
  ],
  heavy: [
    '…（顿了顿，像是在回味）',
    '——（呼吸轻了些）',
    '…（想了很久才开口）',
    '——（声音不自觉地放轻了）',
    '…（好像被那个画面触动到了）',
  ],
};

// 拟声词/语气词开关（短回应中使用）
const VOCAL_TICS = ['嗯…', '唔…', '诶…', '哈…'];

/**
 * 🔴 2026-10-31：识别「已经存在的停顿/动作描写标记」。
 *
 * 用途：插入点若紧邻这类标记就**放弃这次插入**。原实现只判边界与括号深度，不看旁边有什么，
 * 于是 LLM 自己写过一次之后，注入器再贴一次 —— 真机出现
 * 「——（好像在斟酌用词）——（好像在斟酌用词）」。
 *
 * 覆盖面刻意宽于 PAUSES 池：LLM 会自己写「（顿了顿）」「（语气放缓了些）」等同族表达，
 * 只比对本模块的池子会漏判。
 */
const EXISTING_MARKER_RE =
  /（[^）]{0,14}(?:停顿|斟酌|想了想|顿了顿|缓了一下|放缓|轻轻|回味|放轻|想了想|琢磨)[^）]{0,14}）/;

/**
 * 可插入停顿的「安全位置」：必须落在这些字符**之后**。
 *
 * 🔴 中文没有空格，词边界只能由标点/括号/空白提供。
 * 漏掉这条规则就是把「东西」劈成「东…（…）西」——
 * 2026-10-27 业主实测到的真实缺陷（原实现按 `text.length * 0.4` 纯比例插入，零边界意识）。
 */
const BOUNDARY_CHARS = new Set([
  '，', '。', '！', '？', '；', '：', '、', '…', '—', '·', '-',
  '（', '）', '(', ')', '【', '】', '[', ']', '“', '”', '‘', '’', '"', "'",
  ' ', '\t', '\n', '\r',
]);

function isBoundary(ch: string | undefined): boolean {
  return ch !== undefined && BOUNDARY_CHARS.has(ch);
}

/**
 * 计算 `text[0, index)` 区间内的括号深度（中英文括号都算）。
 *
 * 🔴 闭括号多于开括号时按 0 夹住，避免脏文本把后面全判成负深度。
 */
function parenDepthAt(text: string, index: number): number {
  let depth = 0;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (c === '（' || c === '(') depth++;
    else if (c === '）' || c === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * 把目标位置吸附到最近的可插入点。
 *
 * 两个条件**同时**成立才算合法：
 *   ① 落在某个边界符之后（不劈词 —— 2026-10-27 `3cc56fe` 的修复）；
 *   ② **括号深度为 0**（不进括号 —— 本批次补的残留缺口）。
 *
 * 🔴 为什么必须加 ②：`BOUNDARY_CHARS` 含 `（`，于是「插在 `（` 之后」被判为合法边界，
 *   标记直接落进 LLM 的动作描写里 —— 业主实测到
 *   `（缓了一下，——（好像在斟酌用词）声音温温的）`。
 *   上一轮只保证不劈词，**不保证不进括号**。
 *
 * 两头都没有合法位置时返回 **-1**（调用方的 `i >= 5` 过滤会自然丢弃）——
 * 宁可这一轮不插，也绝不退到 `text.length` 硬插（未闭合括号时那会插进内部）。
 */
function snapToBoundary(text: string, target: number): number {
  const t = Math.max(1, Math.min(text.length, target));
  for (let i = t; i <= text.length; i++) {
    if (isBoundary(text[i - 1]) && parenDepthAt(text, i) === 0) return i;
  }
  for (let i = t; i > 1; i--) {
    if (isBoundary(text[i - 1]) && parenDepthAt(text, i) === 0) return i;
  }
  return -1;
}

/**
 * 根据强度在文本中插入思考停顿
 *
 * 【两处 2026-10-27 修复】
 * ① **插入点吸附到边界**：原实现 `idx = text.length * pos` 是纯比例，不看词边界，
 *    直接把「东西」劈成「东…（语气放缓了些）西」、「起身」劈成「站起…（…）身」。
 * ② **不再做 offset 记账**：原实现的 `idx` 取自**已经变长**的 `result.length`
 *    （上一轮插入已计入），又再加一次 `offset` ⇒ 第 2、3 个插入点持续向右漂移。
 *    现改为：先在**原文**上一次性算出全部插入点（吸附 + 去重），
 *    再**从后往前**拼接 —— 前面的索引天然不会失效，无需任何位移补偿。
 *
 * 标记池内容、强度阈值、导出签名**均未改动**（表达风格是既有设计）。
 *
 * @param text 原始文本
 * @param intensity 强度 (0-1)
 * @returns 插入停顿后的文本
 */
export function injectThinkingPause(text: string, intensity: number): string {
  if (!text) return text;

  // 低强度：无停顿或简单省略号。
  // 🔴 2026-10-31 降频：阈值 0.3 → 0.55。原阈值下**几乎每轮都插**，
  //   业主实测「回复里处处是（停顿）」，读起来像模板而不像人在说话。
  if (intensity <= 0.55) return text.replace(/[。，]$/, '…');

  const heavy = intensity > 0.75;
  const pool = heavy ? PAUSES.heavy : PAUSES.medium;
  const positions = heavy ? [0.3, 0.72] : [0.45];

  // ① 在**原文**上算出全部插入点：比例 → 边界吸附 → 去重 → **邻近已有标记则弃**
  const points = [...new Set(
    positions
      .map((p) => snapToBoundary(text, Math.floor(text.length * p)))
      .filter((i) => i >= 5 && i <= text.length - 5)
      // 🔴 2026-10-31 修重复：原实现只判「边界 + 括号深度」，不判**旁边已经有一个标记**。
      //   于是 LLM 自己写了「——（好像在斟酌用词）」之后，注入器又贴着插一次，
      //   真机出现「——（好像在斟酌用词）——（好像在斟酌用词）」连着两个。
      .filter((i) => {
        const win = text.slice(Math.max(0, i - 14), Math.min(text.length, i + 14));
        return !EXISTING_MARKER_RE.test(win);
      }),
  )].sort((a, b) => b - a); // 从后往前，避免前面的插入使后面的索引失效

  // ② 从后往前拼接
  let result = text;
  for (const i of points) {
    result = result.slice(0, i) + pool[Math.floor(Math.random() * pool.length)] + result.slice(i);
  }

  // 开头加语气词（原行为，仅高强度）
  // 🔴 2026-10-31 降频：0.5 → 0.75（原实现一半的重度回复都以语气词开头，观感很模板）
  if (heavy && Math.random() > 0.75) {
    result = VOCAL_TICS[Math.floor(Math.random() * VOCAL_TICS.length)] + result;
  }

  return result;
}

/**
 * 为短回应注入语气前缀
 */
export function injectVocalTic(text: string, intensity: number): string {
  if (intensity > 0.5 && Math.random() > 0.4) {
    const tic = VOCAL_TICS[Math.floor(Math.random() * VOCAL_TICS.length)];
    return tic + text;
  }
  return text;
}
