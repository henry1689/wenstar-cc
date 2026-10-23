---
name: group-session-v2-impl
description: T013 统一群聊模式 V2 蓝皮书 — src/m5/group/ 实现细节与不变量
metadata:
  node_type: implementation
  type: blueprint
  version: V2.0
  last_updated: 2026-10-22
  stage: phase2-batch-a-skeleton
  tests: src/m5/group/__tests__/group-session.test.ts (51 例)
  s4_verified: true
  s4_notes: >
    tsc --noEmit = 0 错误；51/51 单测全绿。
    grep -rn "m5/group" src/ 仅命中本目录自身 ⇒ 零调用方已核实。
    对 SceneAnchor / ContextSnapshot / RoleType / MessageIntent 均为 import type ⇒ 运行时零依赖。
  source_files:
    - src/m5/group/types.ts
    - src/m5/group/sessionReducer.ts
    - src/m5/group/GroupSession.ts
    - src/m5/group/speakerResolver.ts
    - src/m5/group/outputGuard.ts
    - src/m5/group/identityFromState.ts
---

# T013 统一群聊模式 V2 蓝皮书（Phase 2 批A 实现）

## 一、模块依赖图

```
                     ┌─────────────────────────┐
                     │  types.ts（纯类型 + 常量） │  ← 全目录唯一出口
                     └────────────┬────────────┘
                                  │ import type（编译期擦除，运行时零依赖）
      ┌───────────────┬───────────┼────────────┬──────────────┐
      ▼               ▼           ▼            ▼              ▼
sessionReducer   identityFrom  speakerReso  outputGuard   GroupSession
（纯函数核心）    State          lver        （纯函数）     （门面/IO 边界）
      ▲               │           │            │              │
      └───────────────┴───────────┴────────────┴──────────────┘
                          全部只依赖 sessionReducer 的纯函数
```

**层级规则**（违反即重构）：
- `types.ts` 不依赖本目录任何其它模块；
- `sessionReducer.ts` 只依赖 `types.ts`；
- `speakerResolver.ts` / `outputGuard.ts` / `identityFromState.ts` 只依赖 `types.ts` + `sessionReducer.ts`；
- `GroupSession.ts` 是**唯一**聚合点（也是唯一允许 console.log 埋点的地方）。

## 二、变更条目

### 变更 1：reducer 语义 —— 「不操作」返回同一引用

`reduce()` 对「无变化」的返回契约是**与入参同一个对象**（`prev === next`），而非等价的新对象。

```ts
// SPEAK 目标不是参与者
const s1 = reduce(s0, { type: 'SPEAK', target: 'TXS-99' });
s1 === s0   // true —— 引用比较即可判定，无需深比较
```

带来的实际收益：
- `GroupSession.dispatch` 用 `next === prev` 判定「门卫拒绝 / 模糊不操作」，**不记审计轨迹、不触发任何监听者**；
- 这是 ADR-013 §4.3「模糊情况 100% 不操作」的机械保证 —— 不依赖人写对条件分支。

各 action 的不操作条件（全部返回 `prev`）：

| action | 不操作条件 |
|---|---|
| `WAKE` | 解析后 targets 为空 / uuid 全空 / 全重复 |
| `JOIN` | uuid 为空 / 已在参与者中（幂等） |
| `SPEAK` | 目标不是参与者（按 uuid 或主名都找不到）/ 同人切换且未带新现场 |
| `LEAVE` | 本就无参与者 / 指定目标不在参与者中 |
| `RESUME` | `normalizeState` 校验失败 |

### 变更 2：副作用派生 —— reducer 零 IO，压栈/弹栈靠 diff

`diffEffects(prev, next)` 由状态差分推导副作用，**reducer 本身不读栈、不写库、不调门阀**：

| 触发条件 | 产出副作用 |
|---|---|
| `participants` 0 → ≥1 | `meetingStarted{uuids}` |
| `participants` ≥1 → 0 | `meetingEnded` +（栈上若有 `uuid=null` 槽）`restoreSlot` |
| 新增参与者 | `participantJoined{uuid}` |
| 减少参与者 | `participantLeft{uuid}` |
| 现场被保存/更新（`pushSlot` 返回新数组） | `saveSlot{slot}` |
| `speakerUuid` 变化 | `speakerChanged{from,to}` |

由此「LEAVE 弹栈恢复」不需要 reducer 知道现场存在 —— `GroupSession.dispatch` 收到 `restoreSlot`
后经 `onSlot(slot, 'restore')` 交给适配层去恢复 `ContextMemory` / `SceneAnchor`。

**为什么这样设计**：reducer 纯 ⇒ 可单测、可重放（第七层校验失败回滚一轮只需重放 action 序列）、
可审计（`getTrail()` 就是 action 序列，零额外日志代码）。

### 变更 3：现场槽的两条栈不变量

1. **同一 uuid 至多一份**（`pushSlot` 原位覆盖）—— 否则换人来回切会把栈撑爆；
2. **栈内 uuid 必须是当前参与者或 null**（`normalizeState` 拒绝其他情况）——
   否则序列化恢复后栈里躺着一个已离开的人，恢复他的现场即污染当前发言者。

### 变更 4：`normalizeState` 的五条拒绝判据（整份拒绝，非尽力恢复）

| # | 判据 | 为什么必须整份拒绝 |
|---|---|---|
| 1 | `schemaVersion !== 2` | 新旧结构互读 = 字段语义漂移 |
| 2 | 参与者缺 `uuid` / 缺 `name` / uuid 重复 | 重复 uuid ⇒ 白名单集合与人数不符 |
| 3 | `speakerUuid` 不在 participants 内 | **串档根因**：白名单按不存在的 uuid 过滤 |
| 4 | 现场栈含非参与者 uuid | 恢复他人的现场 = 人格串档 |
| 5 | JSON 解析失败 / 非对象 | — |

### 变更 5：埋点只放唯一调用点

`[Hook] module_entry / module_exit` 只出现在 `GroupSession.dispatch` 一处。

**理由**：`reduce` / `diffEffects` / `speakerResolver` / `outputGuard` 全是**纯函数**，
在体内埋点（`Date.now()` + `console.log`）会破坏纯函数性与可重放性 ——
而「状态变更的唯一入口」恰好就是 `dispatch`，埋这一处即可覆盖全部状态流量。

范式照 `m2.SQLiteAdapter` / `m5.DeepSeekLLMProvider`：`[Hook] module_entry module=<名字> <参数>`
+ `[Hook] module_exit module=<名字> 耗时=<ms> status=<结果>`。

## 三、不变量速查（回归测试锁定）

| 不变量 | 锁定用例 |
|---|---|
| `reduce` 不修改入参 | WAKE 后断言 `s0.participants` 仍为空 |
| `mode`/`isMulti` 由 `participants` 派生 | JOIN 后 `isMulti` 自动为 true（无存库布尔） |
| LEAVE 弹栈恢复，不归零 | 散会后 `contextStack` 仍有 `uuid=null` 槽 |
| `popSlot` 找不到即不动 | `popSlot(stack,'TXS-2').rest` 与原栈相等 |
| `normalizeState` 整份拒绝 | 5 条判据各一例，断言返回 `null` |
| 发言者 LLM 兜底低置信不采信 | `confidence=0.3` → 回落粘性 + `needsStickyHold=true` |
| LLM 返回非参与者不采信 | `speaker_name=玉瑶` → 不采信 |
| 纯 JSON 正文一字不削 | `extractSpeakerHeader('{"a":1}')` body 全等原文 |
| 自称窄判据 | `我和徐诗雨聊过天` → 不算自称 |
| `WS_GROUP_V2` 默认关闭 | `isGroupSessionEnabled({}) === false` |
| 身份在状态之后 | 切换主发言后 `speakerName`/`speakerUuid` 同步变化 |

## 四、回滚方案

1. **运行时**：`WS_GROUP_V2` 未设置 = 关闭，适配层走旧 `EntityMeeting`，本模块零调用；
2. **物理**：删除 `src/m5/group/` 完全还原（零运行时引用，已 grep 核实）；
3. **数据**：本模块零 DB 读写，无数据回滚动作。

## 五、配置变更清单

| 项 | 默认 | 位置 |
|---|---|---|
| `WS_GROUP_V2` | 关闭 | 环境变量 |
| `GROUP_SESSION_FLAG` | `'WS_GROUP_V2'` | `GroupSession.ts` |
| `GROUP_SESSION_SCHEMA_VERSION` | `2` | `types.ts` |
| `SPEAKER_LLM_CONFIDENCE_FLOOR` | `0.6` | `speakerResolver.ts` |
| `TRAIL_CAP` | `200` | `GroupSession.ts`（审计轨迹上限） |

## 六、批 B 接线注意（交给下一步）

1. **别接 `runMeetingStage`** —— `src/webui/chat/process-stages.ts` 里的它是死代码
   （仅经 `stage-types.ts` re-export，全仓无调用），真实状态机在 `chat.ts:801-933`；
2. **`speakerUuid` 直接喂给 PI** —— `identityFromState.ts` 产出的 `speakerUuid`
   就是 `m4/retrieval/meetingIsolation.ts` 的 `meetingSpeakerUuid({speakerUuid})` 要的形状，
   无需适配；
3. **`MessageIntent` 目前借自 `EntityMeeting`**（`import type`）—— 批 B 若要解除对旧模块的类型依赖，
   应把意图类型迁到本目录或公共类型区；
4. **`_meetingKBCache`**（`chat.ts:936`，按实体名缓存的 Map）是**第 7 份状态副本**，
   批 B 应并入 `ContextSlot` 或明确留在适配层并写清理由。
