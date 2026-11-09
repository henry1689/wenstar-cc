# MemArch Module 1 — 存储层（Storage）任务书

> **模块编号**: M1-Storage
> **版本**: v1.0 任务书
> **日期**: 2026-11-03
> **基线溯源**: 基于 **MemArch-v2.0.0-Baseline** (MD5: `C3DCBFC83B96EBE88D06D230F26CF503`) 拆分
>
> ---
> **📊 任务书三级要素**
>
> | 要素 | 内容 |
> |---|---|
> | **P 优先级** | 🔴 **P0** — 最高优先级，所有其他模块的底座 |
> | **交付物清单** | ① 14 张表 DDL + 迁移脚本<br>② FTS5 / 向量索引搭建<br>③ 命名空间隔离视图 + CI lint<br>④ sql.js 迁移评估报告<br>⑤ WriteQueue 写队列实现<br>⑥ 单元测试 + 集成测试 |
> | **依赖关系** | 前置：无（可立即启动）<br>并行：M6 治理与安全（视图部分）<br>下游：M2/M3/M4/M5 全部依赖 |
> | **执行权限** | 🤖 **Claude Code 主导**<br>（内核修改、DDL 重构、迁移脚本属于高风险重构）<br>👥 **Pi 辅助**（测试用例、CI lint 脚本、文档） |
> ---

---

## 一、模块概述与边界

### 1.1 模块定位

存储层是整个记忆系统的物理底座，负责所有数据的持久化、索引、迁移和一致性保障。它**不包含任何业务逻辑**（不做检索、不做巩固、不做门控），只提供：
- 标准化的数据模型（表结构）
- 统一的时间口径与命名空间隔离
- 高效的索引（全文、向量、实体图）
- 安全的存量迁移能力
- 对外的只读/写接口

### 1.2 模块边界

**本模块负责**：
- 所有表的 DDL 定义与迁移
- FTS5 全文索引搭建
- 向量索引（sqlite-vec 或等效）
- 实体图边表
- 命名空间隔离视图
- 存量数据迁移脚本（影子列→校验→切换）
- 数据库连接与写队列

**本模块不负责**：
- 写入时的门控逻辑（→ M2）
- 睡眠巩固的业务流程（→ M3）
- 检索与排序（→ M4）
- 记忆呈现与守卫（→ M5）
- 用户主权与审计账本的业务触发（→ M6）

---

## 二、核心功能清单

### 2.1 表结构新建/改造

| 序号 | 表名 | 操作 | 说明 |
|---|---|---|---|
| T1 | conversations | 改造 | 新增 ts_utc / episode_id / lifecycle_state / sensitivity 列 |
| T2 | episodes | 新建 | L2 事件层，含 gist / 情绪曲线 / 显著性 / 锚点豁免 |
| T3 | memories | 改造 | 新增 consolidation / n_refs / recent_refs / activation_cache / suppressed 等 18 列 |
| T4 | semantic_facts | 新建 | L4 双时态语义事实，valid_from / valid_to / superseded_by |
| T5 | entity_edges | 新建 | 实体图边表，供 PPR 检索 |
| T6 | trace_entities | 新建 | 痕迹与实体的多对多映射 |
| T7 | black_diamond_v2 | 新建 | L5 黑钻指针表，只存引用不存内容 |
| T8 | prospective_items | 新建 | 前瞻记忆（承诺/提醒/纪念日） |
| T9 | tombstones | 新建 | 墓碑表，记录已删除记忆的元数据 |
| T10 | forget_requests | 新建 | 用户遗忘请求记录表 |
| T11 | audit_ledger | 新建 | 哈希链审计账本（只追加，触发器禁止 UPDATE/DELETE） |
| T12 | sleep_runs | 新建 | 睡眠运行记录表（断点续跑） |
| T13 | reinforcement_events | 新建 | 强化事件遥测（滚动保留 180 天） |
| T14 | wm_buffer | 新建/改造 | 工作记忆持久化缓冲表 |

### 2.2 索引体系

| 序号 | 索引类型 | 绑定表 | 用途 |
|---|---|---|---|
| I1 | FTS5 外部内容表 | conversations + episodes.gist | 全文检索（BM25） |
| I2 | 向量虚表（vec0） | memories / episodes | 语义向量检索 |
| I3 | 向量虚表（vec0） | memories / episodes | 情感 40D 向量检索 |
| I4 | B-tree 复合索引 | memories(consolidation, lifecycle_state) | 巩固度+状态过滤 |
| I5 | B-tree 复合索引 | memories(last_reinforced_at) | 激活度计算 |
| I6 | B-tree 复合索引 | conversations(episode_id, ts_utc) | 事件内原文查询 |
| I7 | B-tree 复合索引 | semantic_facts(subject_uuid, predicate, valid_to) | 事实查询 |
| I8 | 命名空间视图 | v_conv_real / v_mem_real | 业务代码只读入口 |

### 2.3 存量迁移脚本

| 序号 | 迁移项 | 说明 |
|---|---|---|
| M1 | 时间戳统一 | conversations ISO → epoch ms；memories 本地时间 → UTC 减 8h |
| M2 | is_summary 误标修复 | 同时 is_summary=1 且 is_compacted=1 的行改回原文 |
| M3 | 钙化分归一 | 三量纲 → consolidation [0,1]，歧义行标记并记账 |
| M4 | 激活历史回填 | n_refs / first_ref_at / recent_refs 从 recall_count 反推 |
| M5 | 黑钻旧表迁移 | 旧 black_diamond 数据 → consolidated 状态 + 新指针表 |

---

## 三、技术实现要点

### 3.1 sql.js 迁移评估（前置）

**现状**：当前使用 sql.js（WASM 内存库），整库导出持久化，不支持 WAL、不支持 FTS5、不支持 sqlite-vec 扩展。

**要求**：
- 评估迁移到 `better-sqlite3`（同步 API，性能好，支持扩展）
- 或评估迁移到 `node:sqlite`（Node 22+ 内置，零依赖）
- 出一份评估报告，包含：迁移成本、性能对比、扩展可用性、风险点
- 由业主裁决后再实施

### 3.2 命名空间隔离视图

所有业务代码必须通过视图访问，禁止直接查原表：

```sql
CREATE VIEW v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(namespace,'default')='default'
    AND (roleplay_char IS NULL OR roleplay_char='')
    AND COALESCE(lifecycle_state,'fresh') NOT IN ('tombstone','purged');

CREATE VIEW v_mem_real AS
  SELECT * FROM memories
  WHERE COALESCE(namespace,'default')='default'
    AND lifecycle_state NOT IN ('tombstone','purged');
```

**CI 规则**：在 `storage/` 目录之外出现 `FROM conversations` 或 `FROM memories` 原表查询，构建直接失败。

### 3.3 写队列与并发控制

- SQLite 单写者：所有写操作走统一 WriteQueue
- 睡眠流水线按 ≤200 行小事务分批提交
- 在线写入优先级高于批量迁移

### 3.4 迁移安全机制

- 迁移前 `VACUUM INTO` 全库快照备份
- 影子列先行：新列先加，数据逐步回填，校验无误后再切换
- 迁移后对比：新判据下进入 expiring 的数量超过总量 5% 则暂停
- 原始列保留只读两个版本周期

---

## 四、验收标准

### 4.1 功能验收

| 验收项 | 通过标准 |
|---|---|
| 全部 14 张表 | DDL 可执行，无报错，列齐全 |
| FTS5 索引 | 可建可查，中文分词可用 |
| 向量索引 | 语义向量 / 情感向量各一张，可 KNN 检索 |
| 命名空间视图 | v_conv_real / v_mem_real 正确过滤测试数据 |
| 迁移脚本 M1 | 时间戳统一后抽样 50 行人工核对一致 |
| 迁移脚本 M2 | is_summary 误标修复后，摘要行与原文行正确区分 |
| 迁移脚本 M3 | 钙化分归一后，consolidation 全部在 [0,1] 内，歧义行 < 5% |
| 迁移脚本 M4 | 激活历史回填后，baseLevel 计算结果合理 |
| 迁移脚本 M5 | 旧黑钻数据全部迁入新指针表，无丢失 |

### 4.2 性能验收

| 验收项 | 通过标准 |
|---|---|
| 单条写入延迟 | ≤ 5ms（含索引更新） |
| 全文检索 p95 | ≤ 50ms（万级条目） |
| 向量检索 p95 | ≤ 100ms（万级条目） |
| 迁移总耗时 | 50 万条数据 < 30 分钟 |

### 4.3 安全验收

| 验收项 | 通过标准 |
|---|---|
| 测试数据隔离 | namespace='test' 的数据在视图中完全不可见 |
| 审计账本只读 | 触发器禁止 UPDATE/DELETE 生效 |
| 迁移可回滚 | 出错后可从快照恢复到迁移前状态 |

---

## 五、⚠️ 加固防篡改要求（验收合格后强制执行）

### 5.1 加固时机

**本模块全部验收通过后**，由模块负责人执行加固，加固完成前不得交付给其他模块调用。

### 5.2 加固内容

#### 5.2.1 接口冻结

- 对外只暴露**受控的数据访问接口**（DAO 层），不允许直接执行 SQL
- 接口清单固化，新增接口必须走变更评审
- 所有接口参数校验，拒绝非法输入

#### 5.2.2 内部代码保护

- 模块核心文件（DDL 定义、迁移脚本、写队列、视图定义）**标记为只读**
- 提交时强制要求：commit message 中必须包含 `[M1-Storage-改动说明]`
- 任何对表结构的 ALTER 操作，必须先有 ADR 评审记录

#### 5.2.3 外接部分预留

- 保留以下必要外接点，供其他模块扩展：
  - `onTableCreated` 钩子：新表创建后的回调（供索引/审计扩展）
  - `onMigrationComplete` 钩子：迁移完成后的回调（供数据回填扩展）
  - 自定义索引注册接口：允许其他模块按需加索引
- 除上述预留外接点外，**模块内部逻辑不允许外部直接修改**

#### 5.2.4 Harness 监管接入

- 模块状态上报到 Harness：表数量、数据量、索引状态、迁移进度
- 每次 schema 变更自动触发审计日志（写入 audit_ledger）
- Harness 定期校验：表结构与设计文档一致性、索引完整性、数据一致性
- 发现篡改或异常 → 自动告警 + 冻结模块写入

### 5.3 修改权限

| 操作 | 权限要求 |
|---|---|
| 正常查询（读） | 所有模块可用 |
| 正常写入（业务） | 所有模块可用（通过 DAO） |
| 表结构变更（ALTER TABLE） | 必须业主书面授权 + ADR 评审 |
| 索引增删 | 模块负责人 + Harness 备案 |
| 迁移脚本修改 | 必须业主授权 |
| 内部代码修改 | 必须业主授权，否则视为篡改 |

---

## 六、依赖与协作

- **前置**：业主裁决 R1（遗忘判据）、R7（取消关键词通道）、R8（原文遗忘粒度）
- **并行**：无前置依赖，可立即启动
- **下游**：M2 在线写入、M3 睡眠巩固、M4 检索、M5 MemSym、M6 治理都依赖本模块
