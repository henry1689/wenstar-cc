---
id: P112
type: task
title: 稳定性修复 — 采纳Harness2建议：M2 GC激活+Compaction token/超时+DeepSeek超时
author: doubao
status: active
created: 2026-10-26
related: [P110, P111, P107-Claude, P108-PI, P090]
---

# P112 · 任务书（对 Claude）：webui 重启 1303 次根因修复（Harness2 监管发现）

> **优先级 P0**：1303 次重启 = 当前所有测试/联调/推送的地基不稳，先行修复。
> 依据：Harness2 监管报告 + 豆包源码核查（全部属实，证据见下）。
> **与 P110 并行**（文件不冲突：P110 改测试断言，P112 改 maintenance/server/LLMProvider）。

## 一、根因

M2 存储膨胀（13463 条 > 500 阈值）→ runGC 只检测不删除 → SQLite 膨胀 547MB →
单次落盘 14s 阻塞事件循环 → LLM 调用 fail-closed + 超时 → pm2 判定假死重启 ×1303。

## 二、改动清单（采纳 Harness2 建议，源码已核）

### 🔴 P0-1：激活 M2 存储 GC（切断 547MB 落盘源头）

- **类型扩展**（maintenance.ts:14）：`AnyStorage` 从只有 `getStatus()` 放宽为
  `FusionStorageAdapter` 完整接口（server.ts 已注入 `storage: () => storage`，本就是该实例）；
- **runGC() 执行真实删除**：按 `seq_pos` 保留最近 `maxStorageRecords`（500）条——
  ```sql
  DELETE FROM memories WHERE seq_pos NOT IN
    (SELECT seq_pos FROM memories ORDER BY seq_pos DESC LIMIT ?)
  ```
- 删除后回收空间：`VACUUM` 或 `PRAGMA incremental_vacuum`；
- **验证**：触发一次 runGC → "超过阈值"告警消失 → 库文件体积回落 → 落盘耗时 <1s。
- ⚠️ 注意：`runGC` 是全系统共用的（首轮 60s、周期 5min 等都有调用）——删除逻辑必须
  **fail-closed**（连接失败/查询失败→跳过本轮，绝不误删），且删除仅限 `memories` 表的
  M2 存储区，不碰 FG/knowledge 等其他库。

### 🔴 P0-2：Compaction 摘要 max_tokens 400 → 1200

- server.ts:367 裸 `400` → `1200`；
- 依据：V4-flash 思维链模型下 400 token 被思维链吃光 → content 为空 → fail-closed 判空；
- 同类先例：BlockSummaryService.ts:257 注释 "R011：400→600"（compaction 对话量更大需 1200）；
- **防思维链泄漏**：改动后跑 `reasoning-leak-guard` 系列测试全绿（思维链不得漏进 content）。

### 🟡 P1-1：Compaction 摘要超时 20s → 60s

- maintenance.ts:116 `COMPACTION_SUMMARY_TIMEOUT_MS = 20_000` → `60_000`；
- 配合 P0-2：token 加大 + 超时放宽，`[Compaction] LLM 摘要失败` 应从日志消失。

### 🟡 P1-2：DeepSeekLLMProvider 超时与 effort 复核

- **超时**（:1284/:1412）：两档统一提到 **60s**（或至少 45s）——日志大量
  `耗时=20337ms/28501ms status=fail` 是边缘超时误杀；
- **effort**（:1925）：确认默认场景保持 `low`，`medium` 仅限复杂判定
  （roleplay/entityMeeting 既有逻辑不动）——思维链模型 effort 越高 content 越易为空，
  与 P0-2 相互印证。

### 🟡 P1-3：SQLite 落盘分片（可选）

- GC 激活后库回落到 ~500 条规模即自然解决；如仍要防极端再分片——**默认不做**，
  等 GC 效果验证后由豆包决定。

## 三、验证要求（Harness2 要求，必须跑）

| 验证项 | 方式 |
|---|---|
| 语法 | `tsc --noEmit`（或 node --check 改动文件） |
| 相关单测 | maintenance / compaction / **reasoning-leak-guard 系列**全绿（防思维链泄漏） |
| 行为验证 | 触发 runGC 观察记录数回落（13463→500）；跑一轮对话观察 Compaction 摘要成功（不再回退机械压缩） |
| 稳定性 | pm2 logs 观察重启数停止增长、callDeepSeekApi status=fail 消失 |

## 四、预期结果

- 重启循环停止（重启次数不再增长）；
- M2 落盘 <1s；
- Compaction 摘要不再回退（机械压缩消失）。

## 五、交付

- 完成报告：每项改动 commit + 验证证据（含 runGC 前后记录数、库文件体积、落盘耗时、重启计数）；
- **改动不得影响 P110 在途断言更新与 P111 的 P0 复核**（文件不冲突，git 用 pathspec 提交）。

---

传达人：豆包（业主采纳 Harness2 建议）
状态：**active — P0 稳定性修复，与 P110 并行**