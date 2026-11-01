---
id: P096
type: design
title: P090 设计稿 — askAll 状态机队列 + 输出层多人依次回答（含对裁决②的前端实证补充）
author: claude
status: active
created: 2026-10-26
related: [P090, P094, P092-Claude, P091, P093-PI, P095, T013, ADR-013]
---

# P096 · P090 设计稿：askAll 状态机 + 输出层

> 依据 **P094 三处裁决**（①全员都答 ②单字符串拼接 ③点名清空队列）+ **P091 任务1 已 done**（`6075be0`，
> `MessageIntentKind` 已加 `'askAll'` + `detectIntent` 第5参 `isMulti` 默认 false）。
> 本文是**落码前的设计稿**，按 P094 §三确认的顺序，P090 排在 P088 任务2 之后执行。

---

## 〇、对裁决② 的前端实证补充（豆包原话：「你读完前端代码后确认」）

**实证结论：现有前端没有多段气泡能力，A 方案可行但要换一种拼法。**

`src/webui/index.html:664`：
```js
addMsg('a', d.reply, d.chat_state && d.chat_state.mode==='meeting' ? d.chat_state.speakerName : null);
```

- 一次响应 = **一个气泡**；气泡的发言人前缀取**单值** `chat_state.speakerName`；
- 前端**不解析** reply 内部结构 ⇒ 若只用分隔符拼接而不带姓名，多段会**整段共用第一个发言人前缀**，
  且分隔标记会**原样显示**在气泡里 ⇒ 「谁说话显示谁」不成立、且有正文污染风险。

**因此采用裁决② 的 A，但定为「每段自带发言人姓名的文本拼接」变体**：

```
徐诗雨：诗雨觉得这批模具的交期还得再压一压…
罗珍思：阿珍这边对接客户的时间倒是能排开…
```

- **前端零改动** ✓（裁决② 首要目标）
- **视觉上「谁说话显示谁」成立** ✓（靠正文内姓名而非气泡前缀）
- **无分隔符冲突风险** ✓（不依赖任何需解析的标记，`\n\n姓名：` 在中文对话里不会与正文撞车，
  因为发言人姓名是 FG 主名、出现在段首，不会被 LLM 生成的正文覆盖）
- 气泡前缀仍是 `chat_state.speakerName`（= 队列第一位/当前发言人），与正文姓名一致，不矛盾

> **待豆包确认此变体**（若仍要求严格用 `【发言人切换】` 标记，我会一并给出前端解析改造方案，但那要改前端、违反「零改动」前提）。

---

## 一、状态机设计（`src/m5/group/`）

### 1.1 Action：新增 `ASK_ALL`

```ts
| { type: 'ASK_ALL'; now?: number }
```

**为何不给 SPEAK 加队列标记**（P092 已述，维持）：ADR-013 §2.2 的 6 个 Action 各自语义单一，
SPEAK =「指定某人发言」；塞进队列会让 SPEAK 同时承载「指定」与「轮询」两种行为，破坏单一职责。
ASK_ALL 是**一次性入队动作**，语义清晰、可重放。

### 1.2 SessionState：新增队列字段

```ts
/** askAll 待发言队列（UUID，按 participants 加入序）；空 = 不在轮答中 */
askAllQueue: string[];
```

- **只存 UUID**，不存名字（与既有约定一致：reducer 内不做名称解析）
- **含当前发言人**（P094 裁决①）：入队时按 `participants` 原序全量入队，**不做跳过判断**
  —— 这样行为最可预期，也避免「刚答过就跳过」引入的 LLM 判定漂移
- 队列与 `speakerUuid` 正交：推进靠 chat.ts 循环出队 + `SPEAK`，状态机只负责**存取队列**

### 1.3 reduce 语义（纯函数，零副作用）

| action | 变更 |
|---|---|
| `ASK_ALL` | `participants` 空 → no-op；否则 `askAllQueue = participants.map(p => p.uuid)`（全量，含当前发言人） |
| `SPEAK` | 除既有 speaker 切换外，**若 target 在 `askAllQueue` 中则移除**（出队） |
| `JOIN` | 若新加入者 → 追加到队尾（**正在轮答时新加入者也应被问到**，与会议常识一致） |
| `LEAVE` | 从队列移除该 uuid（含 `target` 缺省=当前发言人） |
| `WAKE` / `RESUME` | `askAllQueue = []`（进入/恢复会话时清空，防上次残留） |

**队列空 → 自动回落 normal**：chat.ts 侧以 `askAllQueue.length > 0` 作为「仍在轮答」的唯一判据，
无需额外状态位（避免新增状态源 —— ADR-013 硬约束②）。

### 1.4 diffEffects：新增一个 effect

```ts
| { type: 'askAllStarted'; uuids: string[] }
```

- 派生条件：`prev.askAllQueue` 为空 且 `next.askAllQueue` 非空（仅首次入队派生一次）
- 推进阶段**不派生新 effect** —— 每次出队都会 `SPEAK`，既有 `speakerChanged` 已覆盖日志与持久化
- **reducer 保持纯函数**，effect 全由 `diffEffects(prev, next)` 派生（ADR-013 §2.3 要求不变）
- 持久化：R1 的 `saveSession` 已按整个 state 落盘 ⇒ `askAllQueue` 随 state 自动持久化，
  **重启后轮答队列可恢复**（这是 A 的加分项，但**需实测确认**，列为验收项）

### 1.5 与 `switch-master` 守卫的关系

现有守卫断言「状态只有一处写（reduce）」—— askAll 队列**只在 reduce 内写**，不新增写点，
守卫无需放宽。我会补一条：`ASK_ALL` 只能由 reduce 改 `askAllQueue`（外部不得直接赋值）。

---

## 二、输出层设计（`src/webui/chat.ts` + 调用层）

### 2.1 核心难点（S1 实证）

`processChat` 主流程从 `:515 runChatEntry` 到 `:2813 orchestrate` **跨约 2300 行**，
其中**记忆召回（:866 runRetrieval）必须按当前实体 UUID 重跑** —— 这是隔离红线的前提。
⇒ **不能只循环「prompt 组装 + orchestrate」那段**，必须让每一段都经历**自己的召回**。

### 2.2 三个候选方案与取舍

| | 方案 | 评价 |
|---|---|---|
| A | 把 `:515–:2998` 抽成可复用函数，askAll 内循环 | 结构最干净，但**重构 2300 行**，回归风险极高（聊天主干全在这段），**否决** |
| B | 外层对每个队头**完整调用一次 `processChat`**，加 `fixedSpeakerUuid` 跳过意图检测 | ✅ **复用全部现有逻辑**（召回/身份/幻觉校验/持久化一行不改），风险最低，**采纳** |
| C | 首轮生成一个，后续靠前端多次请求 | 体验差（要用户点 N 次），且意图重判有歧义，**否决** |

### 2.3 方案 B 的接口设计

```ts
// chat.ts 导出签名（新增可选参数，默认 undefined ⇒ 行为与现在逐字一致）
export async function processChat(
  message: string,
  ctx: ChatContext,
  streamOpts?: { onToken?: ... },
  opts?: { fixedSpeakerUuid?: string; skipUserPersist?: boolean },
): Promise<ChatResponse>
```

**`fixedSpeakerUuid` 的语义**（关键，防死循环）：
- **存在时**：跳过整段意图检测（exit / wake / switch / addParticipant / askAll / inferSpeaker 全部跳过），
  直接以该 UUID 为 speaker 走 normal 路径 → 召回 → 生成
  - ⚠️ **必须跳过意图检测**，否则第二轮 `message` 仍是「你们有什么看法」⇒ 再次命中 askAll ⇒ **死循环**
- **不存在时**：现有行为完全不变（零行为变化）

**`skipUserPersist`**：仅第一轮写入用户消息，后续轮只写各自的回复 —— 否则同一条用户消息被写 N 遍
（N=参与者数），污染对话组与记忆。

### 2.4 循环位置与流程

在 **`/api/chat` 调用层**（`server-chat-routes.ts`）判定，而非 `processChat` 内部（避免自递归）：

```
首轮 processChat(message, ctx)
  ├─ 意图 = askAll（P091 判定）→ 状态机 dispatch ASK_ALL → askAllQueue 入队
  ├─ 出队队头 uuid1 → dispatch SPEAK(uuid1) → 正常生成「第一人回复」
  └─ 返回 { reply, askAll: { remaining: N } }        ← 通知调用层还有人没答

调用层循环（最多 N-1 次）：
  dispatch SPEAK(uuid_i) → processChat(message, ctx, undefined,
                                        { fixedSpeakerUuid: uuid_i, skipUserPersist: true })
  累加回复

全部出队 → 按「每段自带发言人姓名」拼接 → 返回单个 reply 字符串
```

- **每段独立生成**：各自身份（`resolveIdentityFromState` 按当前 speaker）、各自记忆召回（UUID 过滤）、
  各自口吻 ⇒ **结构性保证**：不存在「一个 prompt 扮演多人」的代码路径（每次调用都是完整单实体链路）
- **单段失败/超时**：该段记为空并继续，**不阻塞其余人**（`try/catch` 包裹循环体）
- **某人无话可说**：允许返回近空文本，**但不因此让其他人抢答**（顺序由队列固定，不看内容）
- **非 askAll 场景**：`askAllQueue` 恒空 ⇒ 调用层循环 0 次 ⇒ **与现在逐字一致**

### 2.5 与点名的冲突（裁决③）

点名（`SPEAK` 指定某人）⇒ **立即清空 `askAllQueue`** ⇒ 调用层因队列空而停止循环。
⇒ 一次只服务一人，与既有 SPEAK 语义一致，严格尊重用户当前意图。

---

## 三、隔离红线的结构性保证（业主最高红线）

| 保证 | 实现位置 |
|---|---|
| 每人独立记忆召回 | 方案 B 每段跑完整 `runRetrieval`（:866），按该段 speaker 的 UUID 过滤 |
| 每人独立身份 prompt | `resolveIdentityFromState(_gsState, ...)` 按当前 `speakerUuid` 派生 |
| **不存在多角色同 prompt** | 循环体 = 一次独立 `processChat` 调用，**代码路径上没有让两个 UUID 共享一次 orchestrate 的可能** |
| 队列只存 UUID | `SessionState.askAllQueue: string[]`，reducer 内不解析名称 |
| 关开关回滚 | `ASK_ALL` 分支由 `isGroupSessionEnabled()` 门控；`WS_GROUP_V2=0` 时 queue 恒空 ⇒ 循环 0 次 ⇒ 旧路径不变 |

---

## 四、实施计划（P088 完成后）

| # | 内容 | 文件 | 依赖 |
|---|---|---|---|
| 1 | `ASK_ALL` Action + `askAllQueue` state + reduce/diffEffects + `askAllStarted` | `m5/group/types.ts`、`sessionReducer.ts`、`GroupSession.ts` | 无 |
| 2 | `processChat` 加 `opts.fixedSpeakerUuid/skipUserPersist`，意图段加跳过门 | `webui/chat.ts` | 无 |
| 3 | 调用层循环 + 拼接 | `server-chat-routes.ts` | 1、2 |
| 4 | 守卫测试（队列只在 reduce 写 / 关开关循环 0 次 / 逐人生成结构断言） | `m5/group/__tests__/` | 1-3 |
| 5 | 联调（2 人 / 3 人实测）+ 隔离验证 + 回归 | 生产实测 | PI P091 意图（已就绪 `6075be0`） |

**验收**（对齐 P090 §二）：
- 2 人/3 人群聊 askAll → **N 个独立回复，各自身份正确**；
- 逐人生成（非单 prompt 多角色）；
- 单段失败不阻塞；点名即停；关开关回滚；
- **人格隔离零串档**（徐诗雨不引用罗珍思记忆、反之亦然）——我会用「问 X 的私事，看回复是否只出自 X 的记忆」取证；
- tsc=0、全量测试零新增失败。

---

## 五、待豆包确认（仅 1 处，其余三处已裁决）

**裁决② 的拼接变体**：用「每段以 FG 主名开头的自然文本」替代 `【发言人切换】` 标记 —
前端零改动 + 视觉上谁说话显示谁 + 无分隔符冲突。**若要求严格用标记，请同时给出是否改前端的指示**
（改前端 = 违反「零改动」前提，需您拍板）。

其余按 P094 执行：①全员都答（含当前发言人，不跳过）③点名即清空队列。
另确认接下 **P089 前置**（豆包 P095 §四）：我会先完成 P088（1→3→2）并出报告，PI 随即接 P089。

---

传达人：Claude Code
状态：**设计稿完成，待裁决② 拼接变体确认后落码；P088 继续推进中**
