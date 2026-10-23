---
name: group-session-v2
description: T013 统一群聊模式 V2 白皮书 — 群聊状态机主体工程（Phase 2 批A）
metadata:
  node_type: architecture
  type: blueprint
  version: V2.0
  last_updated: 2026-10-22
  stage: phase2-batch-a-skeleton
  gate: ws_group_v2_default_off
  source_files:
    - src/m5/group/types.ts
    - src/m5/group/sessionReducer.ts
    - src/m5/group/GroupSession.ts
    - src/m5/group/speakerResolver.ts
    - src/m5/group/outputGuard.ts
    - src/m5/group/identityFromState.ts
---

# T013 统一群聊模式 V2 白皮书（Phase 2 批A）

> 依据：`docs/agent-collab/active/ADR-013-20261021-统一群聊模式架构重构共识.md`（业主已批准）
> 任务：`docs/agent-collab/active/P046-20261022-豆包-Phase2主体工程任务分配.md`
> 三大红线：**数据零丢失 · 人格零串档 · 加人减人零误操作**

## 一、变更条目

### 变更 1：会话状态由 6 份可变副本收敛为单一可序列化对象

**改之前**：会话状态散在 6 处且各自可被独立修改 ——
`EntityMeeting` 内的 `_meeting` / `_multiParticipants` / `_multiTurns` / `_multiMeetingName` / `_isFirstTurn`，
加上 `chat.ts` 的 `_currentRole`（12 个读写点）。任意一份被单独改写都会造成身份与状态错位，
这是 T012 摸底十项缺陷（P037/P039）的共同形态。

**改之后**：单一 `SessionState`（`src/m5/group/types.ts`），全部变更走
`reduce(state, action)` 这**唯一写入口**。三条硬约束由此结构性成立：

| 硬约束 | 落地方式 |
|---|---|
| ① 禁止冗余派生字段 | `mode` / `isMulti` / `isActive` 一律由 `participants.length` **派生**，不落库（落库即第二真源，必然漂移） |
| ② 状态只有一处写 | 只有 `reduce` 可返回新状态；`diffEffects` 把副作用（压栈/弹栈/门阀/日志）交适配层，reducer 零 IO |
| ③ 身份解析在状态之后 | `resolveIdentityFromState(state)` 只接受 `SessionState`，委托第 0 步的 `resolveIdentity`，**不可能出现「会晤态 + 玉瑶角色」** |

### 变更 2：退出从「reset 归零」改为「ContextSlot 弹栈恢复」

**改之前**：退出会晤时 `resetSession()` / `resetContext()` / `resetAnchor()` 把玉瑶现场**归零**，
导致退会后玉瑶的场景、情感基线、角色现场全部丢失（P039 缺陷②），且普通会晤退出被
`_savedHumanRole` 分支包裹成**无条件硬置 secretary**。

**改之后**：`ContextSlot` 栈。WAKE 时把玉瑶现场（`uuid=null`）压栈保存；LEAVE 至参与者为空时
`diffEffects` 产出 `restoreSlot` 交适配层**恢复**而非重置。换人（SPEAK）不新增层级，按 uuid 原位覆盖
（`pushSlot` 语义），栈不随切换次数膨胀。`popSlot` 找不到即不动 —— 绝不用默认值覆盖现场。

### 变更 3：会晤状态可序列化，多人会晤重启可恢复

**改之前**：`saveLastMeeting()` 只在 `enter()` 一处调用，且只存 `{entityName, entityUUID}` ——
**多人会晤重启永不恢复**（P039 缺陷①）。

**改之后**：`serializeState` / `normalizeState`（纯函数，零 IO），整份 `SessionState` 可 JSON 序列化。
`normalizeState` 采取**保守策略**：schemaVersion 不符、参与者缺 uuid、uuid 重复、
`speakerUuid` 不在参与者内、现场栈含非参与者 uuid —— 任一命中即**整份拒绝返回 null**。
理由：半错状态意味着 `speakerUuid` 指向不存在的参与者 → 检索白名单错 → **串档（I007 形态）**。
宁可不恢复，也不恢复出一个会串档的状态。

### 变更 4：发言者判断分层，默认路径零 LLM

**改之前**：`EntityMeeting.inferSpeaker` 两段式（提及命中 → 直接问 LLM），多人会晤在无提及时
**每轮都问一次 LLM**（≈1–2s + 一次调用），延迟与成本随轮数线性增长。

**改之后**（`src/m5/group/speakerResolver.ts`）三层：

```
① rule-first（同步、零 LLM）  @某人 / "某人，…" / "换某人" 三种强句式
        ↓ 未命中
② 粘性保持（零成本）          会晤中 speakerUuid 不变；玉瑶态恒 null
        ↓ 仅多人会晤首轮且无人点名才走
③ LLM 兜底                    结构化输出，confidence < 0.6 不采信；非参与者不采信
```

弱提及（正文里出现名字）**刻意不判点名**，交给 ③ —— 避免旧实现「提一个名字就换人」的误切。
「不确定时不得输出玉瑶」由结构保证：LLM 结果必须在 `participants` 白名单内，而按 ADR 玉瑶恒不入列。

### 变更 5：第七层输出校验，默认 +0 次 LLM

**改之后**（`src/m5/group/outputGuard.ts`）：主回复输出「结构化头 + 正文」，校验在同一个响应体上做：

| 情况 | 处置 | 额外 LLM |
|---|---|---|
| 头缺失 / 纯 JSON 正文 | 正文可用，按粘性归属 | 0 |
| 头声明不在参与者内 | 正文可用，改按粘性归属 + 告警 | 0 |
| 头与正文自称冲突 | 需二次 LLM 校验 | 1（仅此情况） |
| 正常 | 直接放行 | 0 |

三条实现约束直接对应既有事故：
- **字段边界解析**（逐行 `key: value`，遇到空行/分隔行终止），禁止在全文用正则枚举引号风格 ——
  V45 剥离器把纯 JSON 削成 `"[{"`（1010→3 字符）的坑；
- **纯 JSON 正文整体跳过**，一字不削 —— 宁可漏处理，不可削正文；
- 自称判据**很窄**：只认「我是X / 我叫X」，正文提到别人的名字**不算自称**（宽判据会自我抵消，P043 教训）。

## 二、回滚方案

| 层 | 措施 |
|---|---|
| **开关** | `WS_GROUP_V2`（环境变量），**默认 `false`**。适配层据此完全走旧 `EntityMeeting` 路径 |
| **旧代码** | Phase 4 之前 `EntityMeeting` **一行不删** —— 回滚 = 关开关，不涉及 git revert |
| **数据** | 本批次**零 DB 读写**；后续 SessionState 走 engine_store **新 key**（KV），旧代码不读新 key，回滚零数据丢失 |
| **物理回退** | 删除 `src/m5/group/` 即完全还原（零调用方、零运行时引用） |

**回滚演练判据**（ADR-013 §六，Phase 4 前必须过）：
1. 关开关后服务正常启动；
2. 871 对话组 / 11598 记忆 / 1036 FG 节点可读；
3. 旧会晤可继续；
4. 新架构写入的对话在旧架构下可召回。

## 三、配置变更清单

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `WS_GROUP_V2` | 环境变量 | **未设置 = false** | 群聊 V2 总开关。`1` / `true` / `on` 开启；其余一律关闭 |
| `GROUP_SESSION_FLAG` | 代码常量 | `'WS_GROUP_V2'` | 开关名单一真源（`GroupSession.ts`），勿在别处硬编码字符串 |
| `GROUP_SESSION_SCHEMA_VERSION` | 代码常量 | `2` | 序列化格式版本；`RESUME` 时版本不符整份拒绝 |
| `SPEAKER_LLM_CONFIDENCE_FLOOR` | 代码常量 | `0.6` | LLM 兜底置信度门槛（ADR-013 第一层明文） |

> 无新增 DB 表、无新增配置文件、无新增第三方依赖。

## 四、本批次边界（Phase 2 批A = 骨架层）

**已交付**：状态机 / 状态对象 / 现场槽 / 序列化 / 发言者分层 / 输出校验 / 身份解析 —— 全部为
`src/m5/group/` 下的**纯新增**，零既有文件改动、零调用方、零数据写入。

**未交付（后续批次）**：批 B = chat.ts 薄适配层接入（开关保护下并线）+ SessionStore（engine_store 单键）+
`speakerUuid` 接入 PI 的 `applyMeetingUuidFilter`；批 C = ContextSlot 与 `ContextMemory`/`SceneAnchor`
的实际压栈弹栈接线。

**已知遗留**：`src/webui/chat/process-stages.ts` 的 `runMeetingStage` 是**死代码**
（仅被 re-export，从未被调用），批 B 适配层必须接 `chat.ts:801-933` 那段真实状态机，
勿被同名函数误导。
