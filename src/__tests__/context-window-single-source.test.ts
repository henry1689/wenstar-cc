import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEMORY_CONFIG } from '../config/MemoryConfig.js';

/**
 * [V35-B / 2026-10-05] 上下文窗口的**单一真源**守卫
 * =================================================
 * 背景（S1 实测）：同一个「窗口」概念在本仓曾有**七套**互不知情的口径 ——
 *   MemoryConfig.compaction.contextWindowTurns = 80（配置真源）、keepFullTurns = 100、
 *   chat.ts 写死 40（4 处）与 20（5 处）、m5 的 history.slice(-20)、
 *   EntityContextStrategy 的绝对值档位 5/10/20/40/60、压缩处塌成 8~10、
 *   两处 applyTokenBudget 各自再算一遍上限。
 * 后果：「取 80 条只注入 20 条」；超过 strategy 阈值时窗口从 80 断崖掉到 10；
 *       实测徐诗雨（category='A'）被压到 40 条，与业主选定的 80 不符。
 *
 * 业主裁定（2026-10-05）：**会晤窗口 = 配置真源**，不接受第二套窗口政策。
 * 本测试锁住这一点：任何地方再写死第二个窗口数字、或让已废弃的 strategy 复活，都会在此失败。
 * 样例均为日常语境，不涉亲密内容。
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** 去掉注释后再做源码判据 —— 墓志铭里必须能写清"原来错在哪" */
const codeOf = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 配置窗口（唯一真源）—— 只为确认它是个可用正数，具体值由配置决定，测试不写死 80 */
const W = (() => {
  const v = Number(MEMORY_CONFIG.compaction.contextWindowTurns);
  return v > 0 ? v : 80;
})();

describe('[V35-B] 窗口真源必须是 contextWindowTurns', () => {
  it('配置真源存在且为正数（其余一切窗口语义都由它派生）', () => {
    expect(W).toBeGreaterThan(0);
    expect(Number.isInteger(W)).toBe(true);
  });

  it('🔴 chat.ts 构造 enrichedHistory 时不得再写死窗口数字', () => {
    const full = codeOf('src/webui/chat.ts');
    // 只锁「对话历史注入」这一条路径：从 enrichedHistory 声明到会晤增强块之间。
    // 不含 chat.ts 另一处的 `queryEntityContext(_muuid, 30, …)` —— 那条喂的是
    // buildEntityContext 的**档案背景块**（角色不同：那是"背景素材"，这是"我正在参与的对话"），
    // 强行统一会让她最近 30 轮被重复注入两遍，故不在本守卫范围内。
    // 边界标记必须取**代码**（注释已被 codeOf 剥掉，用注释做锚会恒为 -1）。
    const start = full.indexOf('let enrichedHistory');
    const end = full.indexOf('compressContext(');
    expect(start, '未找到 enrichedHistory 声明').toBeGreaterThan(-1);
    expect(end, '未找到会晤增强块边界').toBeGreaterThan(start);
    const seg = full.slice(start, end);

    expect(seg, 'queryEntityContext 的 limit 必须来自配置派生的 _window')
      .not.toMatch(/queryEntityContext\([^)]*,\s*\d+\s*,/);
    expect(seg, '不得再出现 slice(-20) 这类固定窗口').not.toMatch(/conversationHistory\.slice\(-\d+\)/);
    expect(seg, '兜底阈值不得写死').not.toMatch(/length\s*<\s*\d+/);
    expect(seg, '必须存在由配置派生的窗口变量').toMatch(/_window\s*=/);
    expect(seg, '窗口必须直接取 _window，不得再经任何策略函数二次切分')
      .not.toMatch(/computeStrategy\s*\(/);
  });

  it('🔴 m5 会晤路径不得再切固定 20；普通模式的 P-02 上限须保留', () => {
    const src = codeOf('src/m5/DeepSeekLLMProvider.ts');
    expect(src, '会晤历史不得再被 slice(-20) 二次截断（上游已按配置限好）')
      .not.toMatch(/history\.slice\(-20\)/);
    expect(src, '普通模式的 P-02 注入上限必须保留（其场景内依然成立）')
      .toMatch(/HISTORY_INJECT_CAP\s*=\s*20/);
  });

  it('🔴 applyTokenBudget 不得复活（窗口上限的第 6、7 份实现）', () => {
    expect(codeOf('src/app/entity/EntityContextManager.ts')).not.toMatch(/applyTokenBudget/);
    expect(codeOf('src/app/entity/index.ts')).not.toMatch(/applyTokenBudget/);
  });

  it('🔴 EntityContextStrategy 不得复活（窗口概念的第 7 份实现）', () => {
    const strat = codeOf('src/app/entity/EntityContextStrategy.ts');
    expect(strat, '不得再出现 computeStrategy 实现').not.toMatch(/(?:export\s+)?function\s+computeStrategy/);
    expect(strat, '不得再出现档位常量').not.toMatch(/turnsFor|RATIO\s*=/);
    expect(codeOf('src/app/entity/index.ts'), 'index 不得再导出它').not.toMatch(/EntityContextStrategy\.js/);
    expect(codeOf('src/webui/chat.ts'), 'chat.ts 不得再引用它').not.toMatch(/EntityContextStrategy/);
  });
});
