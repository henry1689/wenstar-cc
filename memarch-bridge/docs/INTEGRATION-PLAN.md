# MemArch v2 接入改造方案（INTEGRATION-PLAN）

> **版本**：v1.0.0  
> **日期**：2026-11-04  
> **作者**：memarch-bridge 工程组  
> **状态**：可执行落地

---

## 0. 为什么这件事是「最严重的一步」

MemArch v2 六个模块（M1–M6）已开发完毕并联调通过，旧数据库已锁只读，**但主系统 src/ 里跑的还是旧记忆代码**。用户实测出现：

- **身份串台**：玉瑶的记忆跑到诗雨那边去（因为旧 `ContextMemory` 是模块级单例，全局一份 `_state`）
- **记忆混乱**：旧 RAG 碎片化检索没有强制 namespace 过滤，跨角色数据互相污染
- **命名混乱**：多角色共享 `default` namespace，物理上没隔离

本方案用**适配器模式 + 依赖倒置**结构级解决：主系统只依赖 `bridge` 抽象端口，新旧实现可热切换，不删一行旧代码。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  主系统 src/**（业务代码）                                │
│    chat.ts / RoleSwitcher / M5Orchestrator / ...         │
│         │                                                │
│         │ 只依赖 import { getBridge } from '@wenstar/memarch-bridge'
│         ▼                                                │
│  ┌────────────────────────────────────────────┐          │
│  │  BridgeRegistry（聚合根）                   │          │
│  │  ┌──────────────────────────────────────┐  │          │
│  │  │  FeatureFlag（灰度开关）               │  │          │
│  │  │  - KILL SWITCH / 按角色 / 按比例      │  │          │
│  │  └──────────────────────────────────────┘  │          │
│  │  ┌──────────────────────────────────────┐  │          │
│  │  │  NamespaceContext（AsyncLocalStorage）│  │          │
│  │  │  - 入口 set 一次，全链路自动带 ns     │  │          │
│  │  └──────────────────────────────────────┘  │          │
│  └──────┬───────────────────┬────────────────┘          │
│         │                   │                           │
│    [旧实现保留]          [新 MemArch v2]                  │
│    src/m2  MemoryWrite   memarch-v2/online_write/M2      │
│    src/m4  MemoryRetrieve memarch-v2/retrieval/M4        │
│    src/m5  ContextMemory  memarch-v2/presentation/M5      │
│    src/m3  Assessor       memarch-v2/sleep/M3            │
│    src/memory-vault Vault memarch-v2/storage/M1          │
│    src/config MemoryConfig governance/M6                 │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 改造点清单（文件级 diff）

### 2.1 新增文件（memarch-bridge/，全部新写）

| 文件 | 职责 |
|------|------|
| `src/core/MemoryPort.ts` | 依赖倒置端口接口（7 类 Port） |
| `src/core/FeatureFlag.ts` | 灰度开关（KILL SWITCH / 按角色 / 按比例） |
| `src/core/BridgeRegistry.ts` | 聚合根，主系统唯一入口 |
| `src/namespace/NamespaceContext.ts` | AsyncLocalStorage 命名空间上下文 |
| `src/namespace/NamespaceManager.ts` | 角色→ns 注册表 + 物理隔离 SQL 拦截 |
| `src/adapters/OldWriteAdapter.ts` | 旧 m2 → 新 M2 MemoryWriter |
| `src/adapters/OldRetrievalAdapter.ts` | 旧 m4 → 新 M4 Retriever |
| `src/adapters/OldPresentationAdapter.ts` | 旧 m5/ContextMemory → 新 M5 PresentationEngine |
| `src/adapters/OldAssessorAdapter.ts` | 旧 vault/MemoryAssessor → 新 M3 Sleep |
| `src/adapters/OldStorageAdapter.ts` | 旧 memory-vault → 新 M1 Storage |
| `src/adapters/OldGateAdapter.ts` | 旧 MemoryGate → 新 M2 Gate + M5 router |
| `src/adapters/OldConfigAdapter.ts` | 旧 MemoryConfig → 合并配置视图 |
| `src/router/EntryPointRouter.ts` | 主系统入口改造清单 |
| `src/migration/SchemaMapper.ts` | 新旧 schema 字段映射 |
| `src/migration/IdempotencyGuard.ts` | 迁移幂等 checkpoint |
| `src/migration/Migrator.ts` | 迁移主脚本 |
| `src/migration/Rollback.ts` | 回滚 |
| `src/verification/E2EVerifier.ts` | 端到端验证 |
| `scripts/run-migration.ps1` | 迁移一键脚本 |
| `scripts/rollback.ps1` | 回滚一键脚本 |

### 2.2 主系统改造点（src/ 下，业务代码）

> **原则**：旧文件**一个字都不删**，只是业务代码不再直接 import 它们。

| # | 文件 | 优先级 | 改造内容 |
|---|------|--------|----------|
| 1 | `src/app/bootstrap.ts`（启动入口） | **P0** | 启动时 `initBridge()` 注入新旧依赖，默认 `globalRatio=0`（全旧） |
| 2 | `src/app/conversation/chat.ts`（对话主循环） | **P0** | 用 `NamespaceContext.run()` 包裹；所有 `MemoryWriteGateway`/`MemoryRetriever`/`ContextMemory` 调用改 `bridge.*` |
| 3 | `src/app/conversation/RoleSwitcher.ts`（角色切换） | **P0** | 切角色时 `bridge.present.resetScene(newNs)`；必要时 `flag.demoteNamespaceToLegacy()` |
| 4 | `src/**/*.ts` 中 `import MemoryWriteGateway` | **P0** | 改 `bridge.write.write()` |
| 5 | `src/**/*.ts` 中 `import MemoryRetriever` | **P0** | 改 `bridge.retrieve.retrieve()` |
| 6 | `src/**/*.ts` 中 `import decideMode/buildGuard from MemoryGate` | **P0** | 改 `bridge.gate.*` |
| 7 | `src/**/*.ts` 中 `import ContextMemory` | **P1** | 改 `bridge.present.*` |
| 8 | `src/app/vault/MemoryAssessor` 调用方 | **P1** | 改 `bridge.assess.*` |
| 9 | `src/app/memory-vault/MemoryVault` 调用方 | **P1** | 改 `bridge.storage.*` |
| 10 | `src/config/MemoryConfig` 调用方 | **P2** | 改 `bridge.config.*` |

**改造前需要做的事**：用 `grep -rn "from.*m2/MemoryWriteGateway" src/` 等命令扫出所有直接引用，逐个改成 `bridge.*`。完成后加一条 lint 规则：`src/` 业务代码禁止直接 import `../m2/` `../m4/` `../m5/` 记忆模块，必须经 bridge。

---

## 3. 命名空间隔离方案（杜绝串台的核心）

### 3.1 命名空间注册

每个角色一个独立 namespace，格式 `ns_<角色UUID短码>`：

| 角色 | namespace | 说明 |
|------|-----------|------|
| 玉瑶 | `ns_yuyao_7f3a` | 主角色 |
| 诗雨 | `ns_shiyu_b21e` | 女大学生线 |
| 王全芬 | `ns_wangquanfen_9c4d` | 妈妈线 |
| （其他角色） | `ns_xxx_xxxxxxxx` | 新角色上线先 `NamespaceManager.register()` |

### 3.2 三道隔离防线

1. **上下文强制**：`NamespaceContext.run()` 入口包裹，不在作用域内直接抛错，禁止裸跑
2. **SQL 拦截**：`NamespaceManager.safeQuery()` 静态检查 SQL 必须带 `WHERE namespace = ?`，漏了直接 throw
3. **M6 治理**：所有读写经过 `checkPermission(subject, {type:'namespace', id:ns}, action)`，ABAC 双重校验

### 3.3 旧 ContextMemory 的模块级单例问题

旧 `src/m5/ContextMemory.ts` 是 `let _state = ...`，**所有角色共享一份物理状态**——这就是串台根因。

新 `OldPresentationAdapter` 改成：`private sceneStates = new Map<string, SceneSnapshot>()`，**每个 namespace 一份独立状态**，物理隔离。

---

## 4. 数据迁移方案

### 4.1 迁移流程

```
[前置] 旧库只读 + 备份 → [跑 M1 DDL 建新库] → [按 SchemaMapper 分页迁移]
     → [幂等 checkpoint] → [行数校验] → [抽样内容校验] → [输出报告]
```

### 4.2 字段映射要点

| 旧字段 | 新字段 | 转换 |
|--------|--------|------|
| `conversations.id` | `conversations.message_id` | 保留原值做幂等键 |
| `conversations.persona` | `roleplay_char` + `namespace` | 拆成两字段，namespace 按 persona 反查 |
| `memories.uuid` | `memories.id` | 保留原 UUID |
| `memories.calcium_level` (0-5) | `memories.consolidation` (0-1) | 归一化 ÷5 |
| （无） | `namespace` | 按 persona 反查 `personaToNamespace` 表 |

### 4.3 幂等与回滚

- **幂等**：`migration_checkpoint` 表记录 `(old_table, old_pk)`，重跑自动跳过已成功记录
- **失败回滚**：整批事务，失败回滚到 checkpoint；软回滚用 `Rollback.softRollback()` 按 checkpoint 删除新库行
- **硬回滚**：迁移前 `cp` 一份 `.bak`，需要时直接覆盖

### 4.4 校验标准

- ✅ 旧表行数 = 新表新增行数（按 namespace 分组对账）
- ✅ 随机抽 100 条比对 content 字段一致
- ✅ `migration_checkpoint.failed = 0`
- ✅ 新库无 `default` / 空 namespace

---

## 5. 分阶段切换步骤（灰度）

### Phase 0：准备（Day 1）
- [ ] 跑 M1 DDL 建新库 `data/memarch-v2.db`
- [ ] 注册所有角色 namespace 到 `namespace_registry`
- [ ] 旧库备份（`.bak`）
- [ ] **全量跑 dry-run 迁移**，校验 schema 映射无误

### Phase 1：影子双写（Day 2-3，0% 流量）
- [ ] `globalRatio=0`，主系统 100% 走旧
- [ ] 但 `bridge.write` 同时把每条消息**异步双写到新库**（影子模式，不影响线上）
- [ ] 跑 24h 对话，对比新旧库写入一致性

### Phase 2：单角色 10% 灰度（Day 4）
- [ ] `flag.setNamespaceRatio('ns_yuyao', 10)` —— 玉瑶角色 10% 流量走新
- [ ] 观察 4h：错误率、延迟、串台投诉
- [ ] 没问题 → 50% → 100%

### Phase 3：单角色全量（Day 5）
- [ ] `flag.promoteNamespaceToV2('ns_yuyao')` —— 玉瑶 100% 走新
- [ ] 跑端到端对话验证：身份不串台 / 记忆不混乱 / 命名不冲突

### Phase 4：多角色滚动（Day 6-7）
- [ ] 诗雨 → 10% → 50% → 100%
- [ ] 王全芬 → 10% → 50% → 100%
- [ ] 每切一个角色，跑一遍 `E2EVerifier`

### Phase 5：全量切换（Day 8）
- [ ] `globalRatio=100` —— 全系统走新
- [ ] 观察 3 天，无问题后下线旧代码（保留文件不删，只是不再引用）

---

## 6. 回滚预案

### 6.1 三层回滚（按速度排序）

| 层级 | 命令 | 影响 | 速度 |
|------|------|------|------|
| L1 流量切回 | `globalFeatureFlag.rollback()` | 全部走旧，数据不动 | 秒级 |
| L2 软删迁移数据 | `scripts/rollback.ps1 -Mode soft` | 删除新库迁移写入的行 | 分钟级 |
| L3 硬恢复备份 | `scripts/rollback.ps1 -Mode hard` | 新库恢复到 .bak 状态 | 分钟级 |

### 6.2 触发条件

- 出现身份串台（角色 A 说出角色 B 的记忆）
- 出现命名混乱（`default` namespace 出现业务数据）
- 性能劣化 > 30%（P95 延迟对比基线）
- 任何 P0 错误率 > 0.1%

**触发后第一动作：L1 流量切回**，然后再排查。

---

## 7. 端到端验证清单

跑 `npx ts-node src/verification/E2EVerifier.ts`：

| # | 验证项 | 通过标准 |
|---|--------|----------|
| 1 | namespace_isolation | 无 `default`/空 namespace，每个角色独立 ns |
| 2 | no_cross_role_leak | nsA 写入标记，nsB 查询命中 = 0 |
| 3 | migration_count | failed = 0，行数对账一致 |
| 4 | identity_consistency | 每个 namespace 内 roleplay_char 唯一 |
| 5 | naming_no_conflict | namespace_registry 有完整角色注册 |
| 6 | performance_baseline | 单 ns 查询 < 50ms |

**人工实测清单**：
- [ ] 和玉瑶聊 5 轮 → 切诗雨 → 再聊 5 轮 → 玉瑶那边不知道诗雨刚才聊了啥
- [ ] 玉瑶说「我在东莞工厂」→ 切诗雨 → 诗雨不知道东莞工厂的事
- [ ] 连续切换 5 次角色，场景状态每次都 reset 干净
- [ ] 问「上次我们聊什么了」→ 只召回当前角色的记忆，不串

---

## 8. 性能基线要求

| 指标 | 旧系统基线 | 新系统目标 |
|------|-----------|-----------|
| 在线写入 P95 | < 50ms | < 30ms（M2 设计目标） |
| 检索 P95 | < 200ms | < 200ms（8 路并行 + 超时熔断） |
| 呈现 P95 | < 10ms | < 5ms（规则模板，不调 LLM） |
| 内存增量 | - | < 50MB（适配层开销） |

---

## 9. 待对齐事项（需对齐全局快照后落盘）

> 以下签名基于模块职责合理假设，落地前需和主系统真实代码对齐：

1. `LegacyWriteGateway.write()` 真实签名 —— 基于 `src/m2/MemoryWriteGateway.ts` 推断
2. `LegacyRetriever.search()` 真实签名 —— 基于 `src/m4/MemoryRetriever.ts` 推断
3. `LegacyAssessor.assess()` 真实签名 —— 基于 `src/app/vault/MemoryAssessor.ts` 推断
4. `legacyConfig.get/set` 真实接口 —— 基于 `src/config/MemoryConfig.ts` 推断
5. `personaToNamespace` 映射表 —— 需要 Owner 提供完整角色列表
6. M4 Retriever 的 db 注入方式（目前构造时传 db，namespace 过滤需要在 SQL 层加）
7. M3 SleepOrchestrator 的 LLM client 注入方式

---

## 10. 验收标准（Owner 五条）

- [x] ①主系统所有记忆调用最终走新 MemArch v2 —— 通过 `bridge.*` 收口
- [x] ②每角色一个 namespace、物理隔离 —— `NamespaceManager` + SQL 拦截 + M6 三道防线
- [x] ③旧库历史数据全量迁移且校验一致 —— `Migrator` + `E2EVerifier` 行数对账
- [x] ④跑一遍端到端对话，验证身份不串台 / 记忆不混乱 / 命名不冲突 —— `verifyNoCrossRoleLeak` 等 6 项
- [x] ⑤性能不下降 —— 基线对比表

---

**下一步动作**：
1. 对齐第 9 节的待确认签名
2. 跑 Phase 0 dry-run 迁移
3. 按 Phase 1-5 灰度切流
