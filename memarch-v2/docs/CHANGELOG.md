# Changelog / M1-Storage

## v2.0.0 — 2026-11-03

### 新增
- 14 张表完整 DDL（SQLite 3.40+ 方言）
- FTS5 外部内容表（trigram 中文分词）+ AFTER INSERT/UPDATE/DELETE 同步触发器
- vec0 双向量虚表（语义 1024d / 情感 40d）
- 命名空间隔离视图 `v_conv_real` / `v_mem_real` / `v_ep_real` / `v_fact_real`
- M1-M5 存量迁移脚本（up/down 成对，含审计账本记录）
- `WriteQueue` 单写者队列（high/normal/low 优先级，≤200 行小事务）
- CI lint 脚本（bash + PowerShell 双版本）
- Harness 监管钩子 H-CK-01~04（schema 一致性 / 命名空间泄漏 / 哈希链 / 迁移进度）
- 测试用例（DDL 冒烟 / 命名空间隔离 / 迁移回滚）

### 冻结（依据主设计文档第十六章）
- TraceRow / EpisodeRow / Evidence 数据结构
- M1→M2 接口：writeConversation / writeTrace / pushWorkingBuffer
- 配置项：kappa=0.6, write_threshold=0.45, tombstone_days=30 等（见 16.3）

### 待业主裁决
- R-M1-DB-ENGINE：sql.js → better-sqlite3 迁移（见 `docs/sqljs-migration-assessment.md`）
- vec0 扩展加载路径（Windows `.dll`）

### 已知风险
- trigram 中文分词对 <3 字查询不敏感，生产环境建议切 simple/jieba 扩展
- M3 钙化分归一在量纲歧义行占比 >5% 时需人工复核（脚本已输出 `_m3_health_check`）
