---
id: P153
type: progress
title: Harness hook 覆盖缺口修复 + 判据测试收口
author: claude-code
status: done_waiting_review
created: 2026-11-08
updated: 2026-11-08
---

# P153 Harness hook 覆盖缺口 + 测试收口

## 一、hook 缺口（重要，如实记录）

**根因**：Harness 的 PreToolUse/PostToolUse 只在**项目级** settings 配置。
会话 cwd 不是 `D:\tools\wenstar-cc` 时（本次从 `C:\Users\henry` 启动），项目级 hooks 不加载
⇒ 令牌校验/消费、BYPASS 检测、写入审计全部静默失效。

**证据**：同一 run 内对同一文件连写 6 次，令牌 `consumed=false`；当日 BYPASS 审计 0 条；
历史 `*.consumed`（2026-11-05）证明项目内会话正常。

**影响**：批1–批6 的代码改动在 hook 层闸门未生效状态下完成（MCP S1–S7 流水线本身仍执行）。

**修复**：`hooks/harness-hook-dispatch.cjs` + 用户级 settings 挂载；
非本项目路径放行｜项目内 cwd 让位项目级 hooks（防双跑）｜项目外 cwd 转交 Harness｜转交失败 fail-closed。
实测三例通过。**需重启会话生效**。

**给 Harness 的自进化建议**：启动自检「hook 是否真的加载」（探针写入 + `.consumed` 核验）。

## 二、判据测试收口

`grader-non-name-tail.test.ts` 的「已知垃圾候选集拦截率」是**数据驱动信息性断言**：
把 `entities` 中 `uuid IS NULL` 的 person 行当作垃圾集。批5 清理后该集合语义失效
⇒ 24.3% 是**群体变化**，不是拦截能力退化。

**与性/亲密内容无关**：该判据只识别「跨词边界名字碎片」（习累/秋节快/马上）。
亲密内容是实体合法信息资产，未做任何内容审查或删改。

改为固定样本断言 → 测试套件 **1155 passed / 0 failed**（1 skipped 既有）。
