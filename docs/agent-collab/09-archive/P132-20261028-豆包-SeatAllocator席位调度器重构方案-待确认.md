---
id: P132
type: proposal
title: SeatAllocator 席位调度器重构方案 — 基于代码实读的专业评估
author: 豆包（主协调·第三视角审核）
status: pending_approval
created: 2026-10-28
related: [P131, T013, 检索v11]
---

# P132 · SeatAllocator 席位调度器重构方案（待确认）

> 🔴 本方案基于豆包逐行读代码实读得出，非转述任何一方。
> 审核方式：第三视角独立考察源码，站在全局架构视角评估。

---

## 一、背景：为什么要做这个重构

### 1.1 业主实测发现的问题

业主在实测群聊模式时，发现了六大症状：

| # | 症状 | 现象 |
|---|---|---|
| 1 | 块内多角色台词 | 一个输出块里塞了两个人的对话（【罗珍思】徐诗雨：... 罗珍思：...） |
| 2 | 跨角色记忆泄漏 | 阿珍知道了诗雨和用户的私密对话（"情趣内衣"） |
| 3 | 多人点名只匹配一个 | "找徐诗雨和阿珍一起聊" → 只徐诗雨回复，阿珍没来 |
| 4 | LLM 自切发言人不同步 | 用户说"拿什么说来听听" → 上一轮是徐诗雨，但这一轮变成罗珍思回复了 |
| 5 | "结束"没退出 | 说"结束" → 罗珍思说"嗯，在呢。你说。" |
| 6 | 角色说话内容窜 | 罗珍思回复了徐诗雨的私密台词 |

### 1.2 豆包代码实读挖出的三根深因

| # | 根因 | 文件 | 问题链条 |
|---|---|---|---|
| **根因 2（最核心）** | LLM 输出 speaker 头与系统 speakerUuid 不同步 | `chat.ts:760` + `persistence-stage.ts:213` | LLM 输出【罗珍思】→ 系统 speakerUuid 还是徐诗雨UUID → 写入对话时 belongEntityUuid 标错了 → 阿珍拿不到自己的历史对话 → 走 fallback 路径拿到全局对话 → 看到诗雨的私密对话 |
| **根因 1** | outputGuard 不检测块内多角色台词 | `outputGuard.ts:145-180` | 守卫只校验"我是X"这种自称，不扫描正文里是否混入了其他角色的台词 |
| **根因 3** | speakerResolver 多人点名只匹配一个 | `speakerResolver.ts:100-120` | "找徐诗雨和阿珍一起聊" → 只匹配句首第一个名字，另一个被忽略 |

### 1.3 为什么修补旧架构不够

旧架构的原罪：**"玉瑶为主、附加其他人"的单主体范式**。

- 会话默认绑定玉瑶，无人归属时粘性回退玉瑶
- 只有一个 speakerUuid，一轮只能有一个发言人
- 没有隐私隔离概念——所有参与者共享同一个上下文
- LLM 参与调度决策——它可以自己决定谁说话、自己切换 speaker

靠补丁永远别扭——因为问题不在某个具体的 bug，而在**架构范式本身**。

---

## 二、现状摸底：旧架构是怎么工作的

### 2.1 核心文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/m5/group/types.ts` | 154 | SessionState 类型定义 |
| `src/m5/group/sessionReducer.ts` | 384 | 状态机（WAKE/JOIN/SPEAK/LEAVE/RESUME/IDLE/ASK_ALL） |
| `src/m5/group/speakerResolver.ts` | 272 | 发言人判断（rule-first → 粘性 → LLM 兜底） |
| `src/m5/group/outputGuard.ts` | 513 | 输出校验（speaker 头解析 + 自称冲突检测） |
| `src/m5/group/contextBridge.ts` | 113 | 场景锚点桥接 |
| `src/m4/household/EntityMeeting.ts` | 1154 | 会晤实体管理（旧路径） |
| `src/webui/chat.ts` | 3729 | 主链路（路由+上下文组装+LLM调用） |
| `src/webui/chat/persistence-stage.ts` | 614 | 对话写入（belongEntityUuid 标记） |

### 2.2 旧架构的状态机

```
SessionState {
  participants: Participant[]  // 参与者（不含玉瑶）
  speakerUuid: string | null   // 当前主发言者（单一）
  turnIndex: number            // 累计轮数
  contextStack: ContextSlot[]  // 现场栈
  askAllQueue: string[]        // 轮答队列（向全员提问时触发）
}
```

**6 个 Action**：
- WAKE：创建会晤，加入参与者，设置 speakerUuid
- JOIN：加入新参与者
- SPEAK：切换发言人
- LEAVE：移除参与者
- RESUME：恢复状态
- IDLE：空闲
- ASK_ALL：入队轮答队列

### 2.3 旧架构的核心缺陷

| 缺陷 | 说明 |
|---|---|
| 单一 speakerUuid | 一轮只能有一个发言人——多人同时说话时，LLM 自己在输出里挤一块 |
| 无隐私隔离 | 所有参与者共享同一个上下文——阿珍能看到诗雨的私密对话 |
| 无旁听概念 | 要么在场要么不在——不能"看得见但不能说话" |
| 无历史回看权限 | 新加入者自动看到全部历史——隐私保护不足 |
| LLM 参与调度 | LLM 可以自己决定谁说话、自己切换 speaker——不可控 |

---

## 三、新方案设计：SeatAllocator 席位调度器

### 3.1 核心设计理念

**唯一会话底座（一个房间）**：
- 不存在私聊 / 群聊 / 会议多模式分支
- 权限边界 = 在场席位集合 present:Set<UUID>
- 席位、发言权都是现场动态调度——临时加人、临时请人离场、点名指定发言、全员轮询应答，全部是房间内状态变更

**SeatAllocator 是确定性状态机**：
- 纯代码仲裁，LLM 无权限修改房间状态
- 无权派发令牌、无权修改隐私白名单
- 无软开关，所有规则固化

### 3.2 状态定义

```typescript
type SpeakPolicy = "free" | "point" | "round-robin" | "token-lock";
type SeatKind = "participant" | "auditor";

interface SeatEntry {
  uuid: string;
  kind: SeatKind;           // 参与者 / 旁听
  enterAt: number;
  allowHistoryBackread: boolean;  // 默认 false——新加入者看不到历史
}

interface RoomState {
  roomId: string;
  seats: Map<string, SeatEntry>;  // 在场席位表
  policy: SpeakPolicy;            // 当前发言策略
  targetSpeakers: Set<string>;    // point 模式指定发言人
  replied: Set<string>;           // round-robin 已应答者
  tokenHolder?: string;            // token-lock 当前令牌持有者
  host?: string;                  // 主持人
  auditLog: SeatAuditRecord[];    // 审计日志
}

interface AllocResult {
  ok: boolean;
  visibleUuids: Set<string>;       // 本轮可见名单（隐私域）
  permittedSpeakers: Set<string>; // 本轮授权发言人（令牌）
  policy: SpeakPolicy;
}
```

### 3.3 四种发言策略

| 策略 | 说明 | 适用场景 |
|---|---|---|
| **free** | 自由闲聊——在场参与者按需应答 | 日常闲聊 |
| **point** | 点名发言——指定 1 个或 N 个在场角色发言 | 提问某人 |
| **round-robin** | 全员轮询——在场所有人依次应答 | "大家都知道了吗？" |
| **token-lock** | 令牌锁——同一时刻只放行一个发言人 | 严肃会议 |

### 3.4 隐私隔离硬规则

1. 不在 present 的 UUID：不注入本轮对话、不接收消息分发
2. 新加入 present 的 UUID：默认看不到加入之前的历史对话
3. 移出 present 的 UUID：立刻停止后续所有消息推送
4. 旁听角色：永远不会自动分配发言令牌

---

## 四、对比分析：旧架构 vs 新方案

### 4.1 功能覆盖对比

| 功能场景 | 旧架构 | 新方案 | 缺口说明 |
|---|---|---|---|
| 单人私聊 | ✅ | ✅ | 都支持 |
| 多人闲聊 | ⚠️ 不稳定 | ✅ free | 旧架构多人对话挤一块 |
| 点名发言 | ⚠️ SPEAK | ✅ point | 都支持，新方案更清晰 |
| 全员轮询 | ✅ ASK_ALL | ✅ round-robin | 都支持 |
| 会议模式 | ❌ | ✅ token-lock | 新方案新增 |
| 旁听 | ❌ | ✅ auditor | 新方案新增 |
| 隐私隔离 | ❌ 共享上下文 | ✅ 源头切断 | **旧架构核心缺陷** |
| 历史回看权限 | ❌ 自动看到全部 | ✅ 默认 false | 新方案新增 |

### 4.2 工作量评估

| 模块 | 现有代码量 | 需要修改 | 工作量 |
|---|---|---|---|
| types.ts | 154 行 | 重写 | 2h |
| sessionReducer.ts | 384 行 | 重写 | 4h |
| speakerResolver.ts | 272 行 | 大幅修改 | 3h |
| outputGuard.ts | 513 行 | 小幅修改 | 1h |
| chat.ts | 3729 行 | 大幅修改 | 8h |
| persistence-stage.ts | 614 行 | 小幅修改 | 2h |
| 新建 SeatAllocator.ts | 0 | 新建 ~400 行 | 4h |
| **总计** | **~5600 行** | | **~24h（3-4 天）** |

---

## 五、分阶段落地计划

### Phase 0：独立开发（1 天）
- 新建 SeatAllocator.ts
- 写单元测试跑通 T01-T17
- **纯新增，不动旧代码**——风险低

### Phase 1：并行运行（1 天）
- SeatAllocator 与旧 GroupSession 并行
- 输出对比日志，不接入主链路
- **只加日志，不改行为**——风险低

### Phase 2：灰度切换（1 天）
- 新会话走 SeatAllocator，旧会话走旧逻辑
- 可配置开关
- **需要改 chat.ts 路由**——风险中

### Phase 3：彻底下线（1 天）
- 验证稳定后，删除旧 GroupSession 代码
- **等稳定后再做**——风险高

---

## 六、风险评估

| 风险 | 等级 | 说明 | 缓解措施 |
|---|---|---|---|
| v11 观察期冲突 | 🔴 高 | 现在 v11 刚切换上线，进入 3 天观察期；这个重构会动上下文组装层 | 等 v11 观察期结束（10-30）后再启动 |
| 回归风险 | 🟡 中 | 旧架构已经跑通了一些场景，重构后可能引入新 bug | 分阶段落地——先并行运行，灰度切换 |
| 指令解析不准 | 🟡 中 | 窄正则只能识别"@XX 进来"句式，用户说的是"找阿珍过来聊聊" | 先做窄正则，后续扩口语化指令 |
| 数据迁移 | 🟢 低 | 房间状态是内存态，不需要迁移数据库 | 无 |

---

## 七、待决策点

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| 1 | 启动时机 | A. 现在就开始 / B. 等 v11 观察期结束（10-30）后再开始 | **B**——避免与 v11 观察期冲突 |
| 2 | 执行方 | A. Claude 做 / B. PI 做 / C. 豆包统筹 | **A**——Claude 在做 v11 大改造，有经验 |
| 3 | 指令解析 | A. 先做窄正则 / B. 直接用 LLM 意图识别 | **A**——先跑通核心逻辑，后续再扩 |
| 4 | 是否保留旧逻辑 | A. 灰度切换 / B. 一次性替换 | **A**——有回滚路径，更安全 |

---

## 八、与现有体系的对接

| 体系 | 对接点 | 说明 |
|---|---|---|
| **UUID+DNA+40D** | 不影响——SeatAllocator 是会话层，不影响记忆层 | 记忆隔离仍然按 UUID 过滤 |
| **检索 v11** | 不影响——SeatAllocator 不动检索层 | 只是上下文组装层的重构 |
| **outputGuard（P1A/B/C）** | 对接——校验 speaker 是否在 permittedSpeakers 里 | 作为下游校验防线 |
| **EntityMeeting 旧路径** | 兼容——灰度切换期间保留 | 等稳定后再下线 |

---

**待业主确认后，下发正式任务书。**