import { describe, it, expect } from 'vitest';

// M1-2 归纳死代码移除行为回归测试（2026-09-07）
// 红→绿绑定: knowledge-induction.ts(inductKnowledge) 是 V10.1 迁出后从未接线的死代码——
// 全 src 零 import 零调用者, 且模式带旧 bug(地址裸"在"会抓扮演句"我在床上等你"/工作需"在"紧跟我漏常见句),
// 与 persistence-stage 内联新版(M1-1 已验证为唯一有效实现)双套漂移。
// 收敛: 删除该死代码文件, persistence 内联版为唯一归纳实现。
// 本测试断言死代码模块已移除(import 应失败)。

// 本测试断言死代码模块已移除(import 应失败)。
//
// ⚠️ 必须用**变量**做动态说明符，不能用字面量 `import('../knowledge-induction.js')`：
//  字面量会被 tsc 静态解析 → 模块已删 → TS2307 编译错误，把「测试转绿」变成「全仓编译红」。
//  变量形式 tsc 不解析（仍由 vitest/运行时尝试导入并失败），语义完全一致。
const DEAD_MODULE_SPECIFIER = '../knowledge-induction.js';

describe('[M1-2] 归纳死代码文件移除', () => {
  it('knowledge-induction.ts 死代码已移除(import 失败)', async () => {
    // 删除前: 模块存在可 import(成功) → 此断言红; 删除后: import 失败 → 绿
    await expect(import(/* @vite-ignore */ DEAD_MODULE_SPECIFIER)).rejects.toThrow();
  });
});
