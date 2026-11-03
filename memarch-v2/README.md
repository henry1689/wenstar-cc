# MemArch-v2.0.0 / M1-Storage + M2-OnlineWrite

> **基线**: MemArch-v2.0.0-Baseline (MD5: `C3DCBFC83B96EBE88D06D230F26CF503`)
> **版本**: v2.0.0 / Module 1 + Module 2
> **定位**: 记忆系统物理底座 + 在线写入入口闸门
> **状态**: M1 ✅ 已完成 | M2 🟡 待业主验收

---

## 目录结构

```
memarch-v2/
├── storage/
│   ├── ddl/                       # DDL（按编号顺序执行）
│   │   ├── 01_schema_init.sql     # 14 张表 + 审计触发器
│   │   ├── 02_indexes.sql         # B-tree 复合索引
│   │   ├── 03_fts5.sql            # FTS5 外部内容表 + 同步触发器
│   │   ├── 04_vector_index.sql  # vec0 语义/情感双向量虚表
│   │   └── 05_views.sql           # 命名空间隔离视图（v_conv_real / v_mem_real）
│   ├── migrations/                 # M1-M5 迁移（up/down 成对）
│   │   ├── M00_baseline_snapshot.sql
│   │   ├── M01_timestamp_unify.{up,down}.sql
│   │   ├── M02_is_summary_fix.{up,down}.sql
│   │   ├── M03_calcium_normalize.{up,down}.sql
│   │   ├── M04_activation_backfill.{up,down}.sql
│   │   └── M05_black_diamond_migrate.{up,down}.sql
│   ├── write_queue/
│   │   └── WriteQueue.ts           # 单写者队列（在线高优先级 > 批量低优先级）
│   ├── ci/
│   │   ├── lint-namespace.sh       # bash 版命名空间 lint
│   │   └── lint-namespace.ps1      # Windows PowerShell 版
│   ├── tests/
│   │   ├── test_ddl_execution.test.ts
│   │   ├── test_namespace_isolation.test.ts
│   │   ├── test_migrations.test.ts
│   │   └── fixtures/test_data.sql  # namespace='test' 隔离数据
│   └── harness/
│       ├── hooks.json              # Harness 监管钩子清单（H-CK-01~04）
│       └── schema_consistency_check.ts
├── online_write/                   # 🆕 M2 在线写入链路
│   ├── config.ts                   # 全部阈值配置（16.3 节统一约定）
│   ├── types.ts                    # 统一类型定义
│   ├── SalienceCalculator.ts       # 在线显著性快速计算（规则版五因子）
│   ├── EventSegmenter.ts           # 事件分割器（四因子边界检测）
│   ├── Gate.ts                     # 三岔门控（WRITE/RAW_ONLY/DISCARD）
│   ├── WorkingMemory.ts             # 工作记忆缓冲（持久化+互斥+崩溃恢复）
│   ├── ProspectiveExtractor.ts      # 前瞻记忆在线抽取（正则库）
│   ├── MemoryWriter.ts              # 主编排器（对外唯一入口）
│   ├── index.ts                     # 导出入口
│   ├── M2-DELIVERY.md               # M2 交付说明文档
│   └── tests/
│       ├── test_salience.test.js
│       ├── test_segmenter.test.js
│       ├── test_gate.test.js
│       ├── test_prospective.test.js
│       ├── test_pipeline.test.js
│       ├── benchmark_online_write.js
│       └── helpers/db.js
└── docs/
    ├── sqljs-migration-assessment.md   # 前置项：DB 引擎迁移评估
    ├── CHANGELOG.md
    └── HARNESS-INTEGRATION.md
```

---

## 快速开始

```bash
# 1) 新库初始化（按编号顺序执行）
sqlite3 memarch.db < storage/ddl/01_schema_init.sql
sqlite3 memarch.db < storage/ddl/02_indexes.sql
sqlite3 memarch.db < storage/ddl/03_fts5.sql
sqlite3 memarch.db < storage/ddl/04_vector_index.sql   # 需先 loadExtension('vec0')
sqlite3 memarch.db < storage/ddl/05_views.sql

# 2) 存量迁移（先做快照）
sqlite3 memarch.db < storage/migrations/M00_baseline_snapshot.sql
sqlite3 memarch.db < storage/migrations/M01_timestamp_unify.up.sql
sqlite3 memarch.db < storage/migrations/M02_is_summary_fix.up.sql
sqlite3 memarch.db < storage/migrations/M03_calcium_normalize.up.sql
sqlite3 memarch.db < storage/migrations/M04_activation_backfill.up.sql
sqlite3 memarch.db < storage/migrations/M05_black_diamond_migrate.up.sql

# 3) CI lint
powershell -File storage/ci/lint-namespace.ps1 -RepoRoot D:\tools\wenstar-cc

# 4) 测试
npx vitest run memarch-v2/storage/tests/
```

---

## 14 张表清单

| # | 表名 | 操作 | 关键约束 |
|---|---|---|---|
| T1 | conversations | 改造 | 新增 ts_utc/episode_id/lifecycle_state/sensitivity |
| T2 | episodes | 新建 | consolidation [0,1] |
| T3 | memories | 改造（+18 列） | 外键 episode_id→episodes |
| T4 | semantic_facts | 新建 | domain CHECK 五值 |
| T5 | entity_edges | 新建 | 复合主键 (src,dst,rel,trace) |
| T6 | trace_entities | 新建 | 复合主键 |
| T7 | black_diamond_v2 | 新建 | ref_type CHECK 三值 |
| T8 | prospective_items | 新建 | kind/trigger_type/status CHECK |
| T9 | tombstones | 新建 | reason CHECK |
| T10 | forget_requests | 新建 | mode CHECK |
| T11 | audit_ledger | 新建 | 触发器禁止 UPDATE/DELETE |
| T12 | sleep_runs | 新建 | status CHECK |
| T13 | reinforcement_events | 新建 | 复合主键 |
| T14 | wm_buffer | 新建/改造 | status CHECK |

---

## 验收对照

- [x] 14 张表 DDL 可执行（SQLite 方言，主键/外键/索引/约束齐全）
- [x] FTS5 外部内容表 + 同步触发器
- [x] vec0 语义(1024d) + 情感(40d) 双向量虚表
- [x] v_conv_real / v_mem_real 命名空间隔离视图
- [x] CI lint 脚本（bash + PowerShell 双版本）
- [x] M1-M5 迁移 up/down 成对，回滚路径完整
- [x] 测试数据 namespace='test'，与生产视图零重叠
- [x] WriteQueue 单写者队列（≤200 行小事务）
- [x] Harness 监管钩子（H-CK-01~04）

---

## 加固（验收通过后由模块负责人执行）

1. 核心文件 `chmod 444`（DDL / migrations / WriteQueue / views / triggers）
2. commit message 强制含 `[M1-Storage-改动说明]`
3. 任何 ALTER TABLE 必须先有 ADR
4. Harness 钩子接入 `10:30 / 17:00 / 23:00` 三时段巡检

---

## 冻结接口（第十六章 16.2，禁止自行扩展）

- `writeConversation(entry): Promise<number>`
- `writeTrace(row): Promise<string>`
- `pushWorkingBuffer(payload): Promise<number>`
- `batch<T>(rows, handler): Promise<void>`（睡眠/迁移批量）
