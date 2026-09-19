// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-02 → V27批3 修订
//
// 🔴 V27批3（PAS v1 执行）：**移除了 DeepSeekLLMProvider → dist/ 的测试别名**。
//
// 原别名理由（已过时，2026-09-19 复核）：
//   ① "src/m5/DeepSeekLLMProvider.ts is protected by Sentinel MCP" —— 现已可通过
//      正规豁免流程修改（批1/批2 均已成功改动并有 commit）；
//   ② "dist/m5/DeepSeekLLMProvider.js has pre-fetch guards + unified isAvailable"
//      —— grep 复核：`pre-fetch`/`preFetch` 在两处**都不存在**；`isAvailable`
//      src 与 dist 都有。
//
// 该别名的实际危害（双源分叉）：
//   · dist 构建于 2026-09-19 12:24，**早于**批1/批2 对 src 的修改 →
//     测试跑的是旧副本，批1（会晤身份隔离）、批2（P-01/13/14/15）在该文件的改动
//     **在 vitest 中完全不可验证**（P-15 测试只能退化为源码字符串断言）。
//   · 同一模块存在两份实现，违反 PAS v1 的 P-01「单一真源」精神。
//
// 现统一：测试与生产（start.cjs 走 `tsx src/webui/server.ts`）**同源**，均为 src。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Longer timeout for provider tests that hit the retry/fallback path
    testTimeout: 30000,
  },
});
