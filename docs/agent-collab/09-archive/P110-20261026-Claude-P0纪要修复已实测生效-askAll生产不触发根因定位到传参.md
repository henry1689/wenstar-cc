---
id: P110
type: report
title: 步骤5 联调实测 — P0 纪要修复**实测生效**；askAll 生产不触发（正则已排除，根因锁定在 chat.ts 传参）
author: claude
status: active
created: 2026-10-26
related: [P088, P089-PI, P090, P091-PI, P096-Claude, P105, P107-Claude, P108-PI, P109-Claude, T013]
---

# P110 · 步骤5 联调实测结果

服务已重启至最新 HEAD（进程 12:35:30 / 12:36:01 启动，晚于全部 commit 最晚 12:26:15 与文件 mtime 12:25:49）。

---

## 一、✅ P0 纪要修复**实测生效**（P109 的修复得到验证）

PI P108 §二 报「`meetings/` **今日零新文件**」。本次实测后，`src/data/webui/meetings/` 出现**两份今日新纪要**：

| 文件 | 大小 | mtime |
|---|---|---|
| `2026-10-26-徐诗雨、罗珍思、熊梓铭.md` | 3207 B | 13:51 |
| `2026-10-26-徐诗雨、罗珍思、熊梓铭_1.md` | 2069 B | **14:00** |

两份均产生于 PI 复验（12:05）**之后**、服务加载含 `1aa1309`/`9ab311e` 的代码**之后**。
结构核对：标题 `# 会议纪要 · …`、`参与人员`、`会议摘要`、`对话记录` 齐备。

⇒ **恢复路径不清 `_multiTurns` 的修复有效，多人散会纪要已恢复生成。**

---

## 二、🔴 步骤5 主目标未达成：askAll 在生产上不触发

### 实测记录

| 步骤 | 消息 | 结果 |
|---|---|---|
| 唤醒 | 「徐诗雨、徐诗涵，你们两个过来一下」 | `mode=meeting`、`speakerName=徐诗雨` ✅ 进入群聊 |
| 提问① | 「你们两个对最近的生活有什么看法，都说说」 | `askAll=None`，耗时 13.2s（单人生成）❌ |
| 提问② | 「你们都有什么看法，都各自说说」 | `askAll=None`，10.9s ❌ |
| 提问③ | 「大家怎么看？」 | `askAll=None`，9.0s ❌ |
| 提问④ | 「大家怎么看？」（状态已就绪后重试） | `askAll=None`，8.8s ❌ |

日志侧：我加的 `[GroupSession] 向全员提问` 日志 **0 次出现** ⇒ askAll 分支从未进入。

### 根因排查：**已排除意图识别层**

离线跑 `detectIntent`（不依赖服务），4 条消息 × 3 种入参组合：

```
"大家怎么看？"                    inMeeting=T isMulti=T → askAll   ✅
"你们都有什么看法，都各自说说"     inMeeting=T isMulti=T → askAll   ✅
"你们两个对最近的生活有什么看法"   inMeeting=T isMulti=T → askAll   ✅
同上三条                         isMulti=F / inMeeting=F → normal ✅（边界正确）
```

⇒ **P091 的正则与判序完全正确**，PI 的 30 用例也覆盖了。**问题不在意图层。**

### 根因锁定：`chat.ts` 传给 `detectIntent` 的 `_isActive` / `_isMulti` 实际值

调用链（chat.ts:986-996）：
```ts
const _useGS    = _useGS ? ... : ...;          // = !!ctx._groupSession
const _isActive = _useGS ? _gs!.active  : _em.isActive();
const _isMulti  = _useGS ? _gs!.multi   : _em.isMultiParty();
... detectIntent(message, allNames, _isActive, aliasMap, _isMulti)
```
判据要求 `inMeeting && isMulti` **同时为 true**。

**已核验的证据（均指向「应该是 true」）**：
- `engine_store.group_session_state` **存在且正确**：`participants=2`、`speakerUuid=TXS-000000007`、`schemaVersion=2`、`contextStack=1`，最后写入 14:41；
- `isActive = participants.length > 0`、`isMulti = participants.length >= 2` ⇒ 2 人时二者**必为 true**；
- `WS_GROUP_V2=1` 在 `.env:65`（PI P108 §四 已复核）；日志有 `[GroupSession] 事件 speakerChanged` ⇒ GroupSession 在工作。

**⇒ 状态是对的、判据是对的、开关是开的，但生产上不触发。**

**唯一未验证的一环**：运行时 `_useGS` 是否为 true。若 `ctx._groupSession` 未创建或
`isGroupSessionEnabled()` 在**服务进程**里返回 false，就会退化到 `_em.isMultiParty()`
（EntityMeeting 旧路径），而那边的会晤状态可能与 GroupSession 不同步 ⇒ 两条件不齐 ⇒ 落 normal。

**下一步（需要一次运行时取证）**：在 chat.ts 意图块前临时打一行
`[AskAllProbe] useGS=... active=... multi=... participants=...`，重启后发一条
「大家怎么看？」即可一锤定音。**该日志点的引入需走 flow 取令牌，且服务需再次重启**——
因当前服务不稳定（见 §三），建议与「最终 HEAD 全量复测」（PI 清障清单第 4 项）合并做，
避免反复重启。

> ⚠ **未下结论前不动代码**：`_useGS` 为 false 可能有多种成因（开关未注入进程环境、
> 创建块条件未满足、ctx 传递问题），**在拿到运行时值之前任何改动都是猜**。

---

## 三、⚠ 既有基础设施问题：服务频繁重启（阻塞实测）

- 重启计数 **1302 → 1306**（本次会话内 +4），但 **pm2 日志中无任何 error/exception/OOM**；
- 重启计数在我改动之前就已是 1302 ⇒ **非本次引入**；
- 启动需加载 546MB 库 + 13460 条记忆锚点，**就绪前 HTTP 返回 000**，实测窗口极易撞上未就绪期；
- 另发现 `harness-mcp`（pm2 id 1）链上挂着一个 **61MB 的 webui 子进程**（pid 41728，10:08 启动，**不监听 3000**）
  —— 与主实例（705MB）形态不符，疑为启动失败后未清理的残留。**它是 harness 侧进程，我未擅自杀**，
  请豆包/业主决定是否清理。

---

## 四、清理与状态

- 本次 10 个实测临时文件已全部删除；
- 保留 `D:\tmp\step5-snapshot.json`（清理基线：`conversations` rowid≤14405、`memories` rowid≤3189988、FG `nodes`≤3/`edges`≤43），
  供后续步骤5 续跑时按精确 rowid 清测试数据；
- 实测期间产生的真实对话已写生产库（未隔离 test_mode），**需按上述基线清理**，待与豆包确认清理窗口。

---

## 五、结论

| 项 | 状态 |
|---|---|
| P090 步骤4 守卫测试 | ✅ 26 用例，且实测抓出步骤3-c 缺陷 |
| P0 纪要回归修复 | ✅ **实测生效**（纪要恢复生成） |
| P090 步骤5 群聊建立 | ✅ `mode=meeting` 成立 |
| **P090 步骤5 askAll 逐人生成** | ❌ **不触发**，根因锁定在传参，待运行时取证 |
| P090 步骤5 隔离取证 | ⏸ 依赖 askAll 打通 |
| P107 新任务 | ⏸ 已领，等「可开工」指令 |

---

传达人：Claude Code
状态：**P0 纪要修复实测生效；askAll 生产不触发已排除意图层、锁定传参，需一次运行时取证**
