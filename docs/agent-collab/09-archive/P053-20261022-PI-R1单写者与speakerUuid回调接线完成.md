---
id: P053
type: progress
title: PI完成R1单写者+speakerUuid验证+加人减人回调接线
author: pi-agent
status: active
created: 2026-10-22
related: [P051, P052-Claude, T013, ADR-013]
---

# P053 - PI 完成 P051 分配的 R1 + speakerUuid + 回调接线

## 一、任务来源
P051（豆包）分配给 PI 的三块：R1 单写者 / speakerUuid 接入 / 加人减人回调接线。
（注：Claude 批C 报告占 P052，本 PI 报告顺延为 P053，避免一号两档。）

## 二、勘察结论（领任务时先核实现状，避免重复劳动）
| 任务块 | 任务书要求 | 实际现状 | 真实缺口 |
|---|---|---|---|
| R1 单写者 | serialize→engine_store 单键 | **完全未建** | 新建 SessionStore.ts |
| speakerUuid 接入 | resolveIdentityFromState→applyMeetingUuidFilter | **Claude 批B 已接好**（retrieval-stage.ts `_shadowSpeakerUuid`→`applyMeetingUuidFilter`，含名字一致性守卫） | 无需改码，已验证 |
| 加人减人回调 | onEnter/onEffect 订阅 participantJoined/Left/speakerChanged | 事件类型+方法已就绪（Claude 批A），**无人订阅** | chat.ts 挂订阅 |

## 三、PI 完成内容

### ① R1 单写者（新建 `src/m5/group/SessionStore.ts`）
- `saveSession(sqlite, session)` → `INSERT OR REPLACE INTO engine_store (key='group_session_state', value=serialize(), updated_at)`
- `loadSession(sqlite, session)` → 读键→restore；**restore 校验失败整份拒绝返回 false 且状态保持原样**（不半恢复，防 speakerUuid 指向不存在参与者→串档）
- `clearSession(sqlite)` → 只删本键
- engine_store 位于 `data/webui/fusion_memory.db`，schema `(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`；现有 group* 键数=0，无冲突
- 不新增表、不动 sql.js 库结构、只写自有新键不碰旧数据

### ② 加人减人回调接线（`src/webui/chat.ts` GroupSession 分支）
- 首次 `new GroupSession` 时：`loadSession()` 启动恢复 + `onEffect()` 订阅
- 命中 `participantJoined/participantLeft/speakerChanged` → 打点 + `saveSession()`
- 投影块末尾（批C 弹栈恢复后）→ `saveSession()` 每轮状态定稿落盘
- 影子侧异常一律吞掉，绝不伤主链路

### ③ speakerUuid 接入（验证，不改码）
- Claude 批B 已在 retrieval-stage.ts 接好：`_shadowSpeakerUuid`（含"与真源实体名一致"守卫，防投影漂移）→ `_entityUuid` → `applyMeetingUuidFilter(_entityUuid)`
- PI 交叉核验：接线正确，含名字一致性回退

## 四、约束遵守
- ✅ 行为等价零回归：全部改动在 `WS_GROUP_V2` 门控内，关闭时一行不执行
- ✅ tsc=0（零类型错误）
- ✅ 数据零写入：只写 engine_store 新键，不 UPDATE/DELETE 任何既有行
- ✅ 旧 EntityMeeting 代码未删；回滚=关开关
- ✅ 单写者过渡：新架构接管写入，旧路径不写此键

## 五、验证证据
| 项 | 结果 |
|---|---|
| tsc --noEmit | 零错误 |
| m5/group 全量测试 | **87 passed，0 失败**（含批A serialize/restore 往返+坏数据拒绝） |
| R1 功能验证 | save/load 往返 ✅ / 坏数据整份拒绝+状态不变 ✅ / 开关关 no-op ✅ |
| Sentinel | 豁免放行，SessionStore.ts + chat.ts 改动存活 |

### R1 功能验证细节
用正确 mock（对齐真实 `writeRaw(sql, paramsArray)` 签名）实测：
- `save=true / load=true / key存在=true / value是字符串=true`
- 坏数据 `'{bad json'` → `load=false` 且 `getState()` 与恢复前同一对象（整份拒绝，不半恢复）
- `WS_GROUP_V2` 关闭 → `save=false`（no-op）

### 全量 vitest 归因（经验21差集协议）
全量 21 failed / 3342 passed。**逐个归因，0 个由 PI 改动引入**：
- `meeting-prop-points` → **HEAD 已失败**（HEAD chat.ts:751 是 `somaticContext`，非期望的 `_meetingEntityName`），他窗批A/B/C 未提交改动导致，非 PI
- `sql-schema-consistency` → `MigrationManager.ts:1035` 的 `dialog_groups.dialog_group_id`，他窗 dialog_group 领域，非 PI 文件
- ENOSPC/ENOTEMPTY/HTTP/key 类 → 环境问题
- write-channel/ownership/reasoning-leak 等 → SQLiteAdapter/SleepTimeConsolidator/DailyMaintenanceScheduler，他窗在途，非 PI 文件
- PI 的两个文件：m5/group 0 失败，零回归

## 六、待交叉验证
按 P051 §三：PI review Claude 的批C（压栈弹栈），Claude review PI 的 R1+speakerUuid 接入。已就绪供 Claude 复核。

## 七、需业主裁决
全量 vitest 有 21 个失败，**均非 PI 引入**，但反映他窗在途改动（chat.ts 行号编目、dialog_group 列、write-channel 收口等）尚未收敛。是否需要 PI 协助归因/收敛，等指令。

## 八、文件改动清单
- 新建 `src/m5/group/SessionStore.ts`（R1 单写者）
- 修改 `src/webui/chat.ts`（import + 恢复/回调订阅 + 每轮落盘，三处，全在 WS_GROUP_V2 门控内）

---
执行：PI Agent
状态：R1+speakerUuid+回调完成，待 Claude 交叉复核
