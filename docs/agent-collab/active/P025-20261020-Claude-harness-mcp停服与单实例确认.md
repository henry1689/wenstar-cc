---
id: P025
type: progress
title: R023 任务 — harness-mcp 停服（stop 不 delete）+ 单实例三判据确认
author: claude-code
status: done_waiting_review
created: 2026-10-20
updated: 2026-10-20
related: [R023, I009, T006, P023]
---

# P025 · harness-mcp 停服与单实例确认

**结论：✅ 已停服（stop 不 delete），三条单实例判据全部通过，2.4 停服窗口的前置条件已就绪。**

## 一、前置条件（按 R023 §四：等 PI 任务J 提交后执行）

| 项 | 状态 |
|---|---|
| PI 任务J 第一步提交 | ✅ `6495795 fix(governance,m4): 任务J第一步(选项A)——两处治理正则容忍T003时间后缀`（4 文件 +102/−3，含 10 例新测试） |
| PI 在途改动 | ✅ 无（`git status` 中 governance/m4/测试域均为空） |
| 执行窗口 | 2026-10-20 20:31 起 |

## 二、动作

```bash
pm2 stop harness-mcp     # 保留应用配置，不 delete（业主裁决）
```

## 三、停服前 → 停服后（留证）

| 判据 | 停服前 20:21:42 | 停服后 20:35:07 | 结论 |
|---|---|---|---|
| ① 3000 监听 | 1 行：PID **48108** | 1 行：PID **48108** | ✅ 唯一 |
| ② `server.lock` | pid **48108** | pid **48108** | ✅ 与监听者一致 |
| ③ wenstar 进程链 | **2 条**：`36196→55920→36496`（harness-mcp）+ `36164→39956→48108`（webui） | **1 条**：`36164→39956→48108` | ✅ 只剩 webui |

`pm2 list` 现状：`harness-mcp` = **stopped**（pid 0，应用仍在列表，重启计数 3 保留）；
`wenstar-webui` = online（36164，115 分钟）。**未被 `harness-watchdog` 拉活**（停后观察 45s + 60s 两次确认）。

```
ProcessId ParentProcessId cmd
   36164           17104  …\node.exe D:\tools\wenstar-cc\start.cjs
   39956           36164  …\tsx\dist\cli.mjs src/webui/server.ts
   48108           39956  …\tsx\dist\preflight.cjs   ← 0.0.0.0:3000 LISTENING
```
（`23528 sentinel-service.cjs` 是监控进程，不是服务器链。）

## 四、影响与恢复

- ⚠️ **本会话的 Harness MCP 工具随之失效**（`harness_run_flow` / `harness_evolution_*` 等），
  后续需要时执行 **`pm2 start harness-mcp`** 即可恢复（配置未删）。
- webui 不受影响：仍在线、仍是唯一监听者，`server.lock` 未变。
- 该进程持有的 sql.js 内存副本已随进程退出释放 ⇒ **2.4 停服窗口内改库不会被它覆盖**。

## 五、给 2.4（任务I）的交接

进入垃圾数据物理清除窗口前，再跑一次本次的三条判据并截图留证即可；
若期间有人 `pm2 start harness-mcp`，必须重新 stop 并复核。
