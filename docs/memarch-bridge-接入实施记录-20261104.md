# MemArch Bridge 接入实施记录（2026-11-04）

> 本文档对应 ADR-016 的落地实施，涵盖服务层变更所需的部署拓扑、启动流程、配置项清单、回滚方案，
> 以及流水线要求留存的提案审计轨迹。
> **状态**：🟡 实施中（文档先行，代码随流水线令牌落地）

---

## 一、服务层变更（部署拓扑）

### 1.1 变化点

| 项 | 变更前 | 变更后 |
|---|---|---|
| 进程数 | 1 个 webui 进程（sql.js 内存库） | **不变**（bridge 在同一进程内旁路初始化） |
| 数据库连接数 | 主库 1 个 sql.js 实例 | **+1 个 better-sqlite3 只读/写连接** → `data/memarch-v2.db` |
| 端口 | 3000（webui） | **不变**；新增 HTTP 端点复用同一端口 |
| 外部依赖 | 无 | **无**（better-sqlite3 已在本仓 devDependencies） |
| 数据流向 | 旧链路：`sql.js` → `data/webui/fusion_memory.db` | **不变**（灰度 0%）；新链路待灰度开启后才写 `memarch-v2.db` |

### 1.2 🔴 驱动并存的边界（必须遵守）

主系统用 **sql.js**（内存库 + `flushNow()` 整库 export 覆盖磁盘），bridge 用 **better-sqlite3**（原生直连）。
两者对**同一个库文件**并发操作会导致整库覆盖事故（本仓历史事故，见 `SQLiteAdapter.ts:402` 注释「无空库保护」）。

**因此硬性规定：**
1. bridge 的 `v2Db` **只能**指向 `data/memarch-v2.db`，**禁止**指向 `data/webui/fusion_memory.db` 或任何 sql.js 正在使用的库；
2. 任何迁移脚本在读取主库时必须以 `readonly: true` 打开；
3. 改库前必须停整条进程链。

---

## 二、启动流程

### 2.1 时序（initPipeline 内）

```
initPipeline()
  ├─ 关闭旧实例释放 WASM 内存
  ├─ 建目录 / 检查可写
  ├─ …（原有初始化，完全不变）…
  └─ 【新增】MemArchBridge 旁路初始化
       ├─ 判断 data/memarch-v2.db 是否存在 ── 否 → 记 warn，跳过（不影响主流程）
       ├─ new better-sqlite3(v2DbPath)
       ├─ 构造 LegacyConfig 适配器（读 MEMORY_CONFIG，写走内存覆盖，不改原常量）
       ├─ initBridge({ v2Db, legacyConfig })
       └─ 任何异常 → console.warn，**不抛出**
```

### 2.2 失败降级

| 失败场景 | 行为 |
|---|---|
| `memarch-v2.db` 不存在 | 记 warn，bridge 不初始化，运维端点返回 503，主流程完全不受影响 |
| better-sqlite3 加载失败 | 同上 |
| initBridge 内部异常 | 同上（整个块包在 try/catch 内） |

**设计原则：bridge 是旁路增强，绝不能成为主流程的单点故障。**

---

## 三、配置项清单

| 配置 | 来源 | 默认 | 说明 |
|---|---|---|---|
| `MEMARCH_V2_DB` | 常量路径 | `<DATA_DIR>/memarch-v2.db` | 新库路径 |
| `globalFeatureFlag.globalRatio` | 内存（FeatureFlag） | `0` | 全局新链路比例 |
| `globalFeatureFlag.namespaceRatios` | 内存（FeatureFlag） | `{}` | 按 namespace 的比例 |
| `globalFeatureFlag.forceLegacy` | 内存（FeatureFlag） | `Set()` | KILL SWITCH 生效集 |
| 运维端点鉴权 | 代码内置 | **仅 loopback** | 非 127.0.0.1/::1 一律 403 |

**灰度开关当前没有持久化** —— 进程重启后回到全旧（比例 0）。这是**保守默认**，符合"从未验证过的新链路不应自动接管"。

---

## 四、回滚方案

### 4.1 三级回滚

| 级别 | 操作 | 生效时间 | 影响 |
|---|---|---|---|
| **L1 全局** | `POST /api/memarch-bridge/rollback` | 立即 | 全部流量回旧链路（KILL SWITCH） |
| **L2 单角色** | `POST /api/memarch-bridge/demote {namespace}` | 立即 | 该角色回旧链路 |
| **L3 进程** | 重启 webui | 30 秒内 | 灰度比例归 0（内存态丢失），等价于全回旧 |

### 4.2 代码级回滚

本次改动只有 2 个文件：
- `src/webui/server-memarch-bridge-routes.ts`（新增，删除即恢复）
- `src/webui/server.ts`（3 处新增，`git revert` 即可）

**旧链路一行未删，因此回滚不涉及数据恢复。**

### 4.3 数据回滚

本次**不写任何数据**（灰度 0%，`memarch-v2.db` 只是被打开连接，无写入路径接线）。
如需恢复：`data/memarch-v2.db` 保持原样即可，无脏写风险。

---

## 五、提案审计轨迹（流水线要求留存）

### 5.1 原始方案（局部方案）

> 在 `server.ts` 加 `initBridge()` + 在 `MemArchBridgeRoot.ts` 暴露 10 个 HTTP 端点。
> —— 源自 `memarch-bridge/docs/INTEGRATION-PLAN.md` 与豆包 2026-11-04 交付报告。

**核实结果**：报告点名的 `MemArchBridgeRoot.ts`、`server-bridge-routes.ts` **不存在**；
`src/webui/server.ts` **零改动**；全仓搜不到 `initMemArchBridge`。原方案描述的是"计划形态"，不是已落地状态。

### 5.2 优化方案（本次采用）

| 维度 | 原始方案 | 本次方案 | 理由 |
|---|---|---|---|
| 入口文件 | `MemArchBridgeRoot.ts`（不存在） | 用现有 `BridgeRegistry.ts` 的 `initBridge` | 不新建重复抽象 |
| HTTP 端点 | `server-bridge-routes.ts`（不存在） | 新建 `server-memarch-bridge-routes.ts` | 按实际需要重写 |
| 端点鉴权 | 未提及 | **仅 loopback，非本机 403** | 运维端点不得对外 |
| 响应体 | 未约束 | **不含记忆原文，只回计数与 id** | 避免调试通道变数据出口 |
| 失败处理 | 未提及 | 全块 try/catch，失败只 warn | bridge 不得成为单点故障 |
| 灰度默认 | 「玉瑶 10%」 | **全部 0%** | 未经真实对话验证前不接管流量 |
| 改造范围 | 含"几百个调用点替换" | **本次只做 2 个文件** | 38 个调用点分批推进，先证明新链路可用 |

### 5.3 用户审批

业主 2026-11-04 对话明确：「**一起动手**」，批准补 `src/` 接线（server.ts 三处 + HTTP 控制端点）。
更早的裁决：「**B，要最好的方案，即使设计方案不好也不勉强，必须改到高质量的系统**」—— 对应 ADR-016 的一角色一域隔离模型。

### 5.4 差异影响

本次改动**不改变任何现有记忆读写行为**：
- 灰度比例 0 ⇒ 所有读写仍走旧链路
- bridge 只是被初始化并打开一个独立连接
- 38 个调用点的替换是后续批次

---

## 六、变更摘要（供白皮书 / 蓝皮书引用）

**标题**：MemArch v2 Bridge 接入——旁路初始化与运维端点落地

**变更条目（3 条）**：
1. **新增接入层运维端点**：8 个端点（health / namespaces / ratio / promote / demote / rollback / unrollback / retrieve），仅 loopback 可访问，响应不返回记忆原文。
2. **旁路初始化**：`initPipeline` 末尾初始化 bridge，独立 better-sqlite3 连接 `data/memarch-v2.db`；任何异常只告警，不影响主流程；灰度比例默认 0。
3. **回滚能力补齐**：此前 bridge 的灰度开关没有任何运行时入口（回滚只能改代码重启），现在支持秒级 L1/L2 回滚。

**配套**：`ADR-016`（命名空间隔离模型与基线重建）、`tsconfig.memarch.json`（子项目类型检查）。
