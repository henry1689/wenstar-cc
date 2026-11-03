# sql.js → 原生 SQLite 迁移评估报告

> **模块**: M1-Storage / MemArch-v2.0.0
> **基线**: MemArch-v2.0.0-Baseline (MD5: C3DCBFC83B96EBE88D06D230F26CF503)
> **评估日期**: 2026-11-03
> **状态**: ⏳ 待业主裁决（R-M1-DB-ENGINE）
> **结论摘要**: **强烈建议迁移**，sql.js 是本设计 FTS5 / sqlite-vec / WAL 能力的硬性阻塞项

---

## 一、现状盘点

| 维度 | 当前实现（sql.js） | 本设计要求 | 差距 |
|---|---|---|---|
| 运行形态 | WASM 内存库，整库导出 `.db` 文件 | 嵌入式磁盘库，WAL 模式 | 🔴 致命 |
| 持久化 | 每次写操作后 `export()` 整库写回 | 实时 fsync | 🔴 崩溃丢数据 |
| 并发 | 单线程、无锁、整库序列化 | 多读单写、WAL 并发 | 🟡 可接受 |
| FTS5 | ❌ 编译进 WASM 但未启用 | ✅ 必须（BM25 检索） | 🔴 致命 |
| 向量索引（vec0） | ❌ WASM 无法动态加载扩展 | ✅ 必须（语义+情感双向量） | 🔴 致命 |
| 中文分词 | ❌ 无 | ✅ trigram / simple 扩展 | 🔴 致命 |
| 触发器 | ✅ 支持（审计账本 append-only） | ✅ 必须 | ✅ 无差距 |
| 事务 | 内存事务，导出前才持久化 | 磁盘事务 + WAL | 🔴 持久性差 |
| 单条写入延迟 | ~5–20ms（含序列化导出） | ≤5ms（含索引） | 🟡 待优化 |

**核心结论**：sql.js 不是"选型偏好"问题，而是本设计三大能力（FTS5、vec0、WAL）的**硬性阻塞项**。不迁移则任务书 §2.2 索引体系、§4.1 性能验收全部无法达成。

---

## 二、候选方案对比

### 2.1 三候选矩阵

| 维度 | 方案A: `better-sqlite3` | 方案B: `node:sqlite`（Node 22+ 内置） | 方案C: 继续 sql.js（不迁移） |
|---|---|---|---|
| **API 形态** | 同步、C++ 绑定 | 同步、实验性内置 | 同步、WASM |
| **FTS5** | ✅ 官方预编译含 FTS5 | ✅ Node 22.5+ 含 | ⚠️ 需自编译 WASM |
| **sqlite-vec 扩展** | ✅ 可 `.loadExtension()` | ⚠️ 实验 API，扩展加载受限 | ❌ 无法加载 |
| **WAL 模式** | ✅ 完整支持 | ✅ 支持 | ❌ 不支持 |
| **中文分词** | ✅ simple/trigram 可加载 | ⚠️ trigram 内置，simple 需扩展 | ❌ |
| **磁盘持久化** | ✅ 原生 | ✅ 原生 | ⚠️ 整库导出 |
| **崩溃恢复** | WAL checkpoint + 回滚日志 | 同左 | ❌ 最近一次导出后全丢 |
| **npm 依赖体积** | ~30MB（含 prebuild） | 0（Node 内置） | ~2MB |
| **生产稳定性** | ⭐⭐⭐⭐⭐ 广泛使用 | ⭐⭐ 仍在实验（Node 22.5+） | ⭐⭐⭐ |
| **Windows 兼容性** | ✅ prebuild 支持 | ✅ 跟随 Node | ✅ |
| **迁移改造量** | 中（API 90% 相似） | 中（API 几乎一致） | 0 |
| **授权** | MIT | 内置（Node 许可） | MIT |
| **推荐度** | 🟢 **首选** | 🟡 备选（等 Node 24 LTS） | 🔴 否决 |

### 2.2 推荐：方案A `better-sqlite3`

**理由**：
1. **扩展加载能力是硬门槛**：sqlite-vec 必须通过 `.loadExtension()` 加载，`node:sqlite` 当前（Node 22/23）扩展加载 API 仍标记为实验性，未来行为不稳定。
2. **生产验证度**：better-sqlite3 在 Node 生态是事实标准，prebuild 二进制避免本地编译。
3. **性能**：同步 API 无 Promise 开销，单条写入 <1ms，预留充足索引更新余量。
4. **API 平滑**：与 sql.js 的 `stmt.run()/get()/all()` 接口风格高度相似，改造量集中在"移除整库导出"这一层。

**备选**：若业主追求"零 npm 依赖"，可在 Node 24 LTS 发布后切换到 `node:sqlite`，但需放弃 sqlite-vec（改为外部向量库，如 hnswlib-node），代价更大。

---

## 三、迁移成本评估

### 3.1 改造点清单（预计 3–5 人日）

| 改造项 | 文件/位置 | 复杂度 | 说明 |
|---|---|---|---|
| DB 连接初始化 | `src/db/index.ts` 类似位置 | S | `new Database('memarch.db')` 替代 `initSqlJs()` |
| 移除 `export()` 整库写回 | 所有写操作收尾处 | M | 每写一次就 export 一次的逻辑全部删除 |
| 开启 WAL | DB 初始化 | S | `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` |
| 扩展加载 | DB 初始化 | S | `.loadExtension('vec0')` + simple tokenizer |
| WriteQueue 重构 | `storage/write_queue/` | M | 从"整库序列化写队列"改为"原生单写者队列" |
| 现有 DAO 适配 | `src/dao/*` | M | `stmt.getAsObject()` → `stmt.get()`；其余几乎不变 |
| 数据导入 | 一次性脚本 | S | 旧 `.db` 文件直接 `ATTACH` + `INSERT SELECT` 即可 |

### 3.2 存量数据迁移

**好消息**：sql.js 产出的 `.db` 文件本身就是标准 SQLite 3 格式，**无需数据转换**：

```sql
-- 一次性导入脚本（migrations/M00_import_from_sqljs.sql）
ATTACH DATABASE 'memarch_legacy.db' AS legacy;
INSERT INTO main.conversations SELECT * FROM legacy.conversations;
INSERT INTO main.memories      SELECT * FROM legacy.memories;
-- ... 其余表
DETACH legacy;
VACUUM;
```

**风险**：旧库若由 sql.js 导出时损坏（WASM 边界 bug），需先 `PRAGMA integrity_check`。

---

## 四、性能影响预估

| 指标 | sql.js 现状 | better-sqlite3 + WAL | 验收标准 | 结论 |
|---|---|---|---|---|
| 单条写入（含索引） | ~15ms | **0.8–2ms** | ≤5ms | 🟢 超预期 |
| FTS5 万级 p95 | 未实现 | 30–50ms | ≤50ms | 🟢 达标 |
| vec0 KNN 万级 p95 | 未实现 | 50–100ms | ≤100ms | 🟢 达标 |
| 50 万条迁移 | 估算 >2h | **15–25 分钟** | <30 分钟 | 🟢 达标 |
| 崩溃后数据丢失窗口 | 上次 export 至今 | ≤1 个事务（WAL） | 接近零 | 🟢 大幅改善 |

---

## 五、风险点与缓解

| # | 风险 | 等级 | 缓解措施 |
|---|---|---|---|
| R1 | Windows 下 better-sqlite3 prebuild 下载失败 | 🟡 | 锁版本 `v11.x`，预下载二进制到 `node_modules` 离线缓存；CI 加 fallback |
| R2 | sqlite-vec ABI 与 better-sqlite3 编译版本不匹配 | 🟡 | 锁定 vec0 预编译二进制版本；启动时 `PRAGMA compile_options` 校验 |
| R3 | 迁移期间旧库仍在被写入（双写窗口） | 🔴 | 停服窗口执行；或先用 sql.js 导出冻结快照再导入 |
| R4 | WAL 文件在 Windows 被杀软扫描导致锁文件 | 🟡 | 将 `.db-wal`/`.db-shm` 加入杀软白名单；路径放 `D:\tools\wenstar-cc\data\` |
| R5 | 现有代码对"写后立即 export"有隐式依赖（如写后立即读） | 🟡 | 写后读走同一连接，better-sqlite3 天然可见；不依赖 export |
| R6 | Node 版本要求 ≥18，better-sqlite3 v11 要求 | 🟢 | 业主当前 Node 已 22+，无影响 |
| R7 | 扩展（vec0、simple）在打包（pkg/electron）时丢失 | 🟡 | 扩展 `.dll/.so` 独立放 `storage/ext/`，运行时显式加载路径 |

---

## 六、裁决建议（呈业主）

**请业主在以下三项中勾选一项：**

- [🟢 **A. 批准迁移到 better-sqlite3**（推荐，预计 3–5 人日，P0 阶段完成）
- [🟡 B. 等 Node 24 LTS 后切 `node:sqlite`，P0 阶段继续 sql.js 但**禁用 FTS5/vec0**（延期到 P1）
- [🔴 C. 不迁移，放弃 FTS5 / 向量索引 / WAL 三大能力（**否决**，任务书验收不通过）

**回滚预案**：迁移期间保留旧 `memarch_legacy.db` 只读快照 ≥ 2 个版本周期，新库若出现异常可直接切回旧 WASM 路径（代码层 Feature Flag `DB_ENGINE=sqljs|better-sqlite3`）。

---

## 七、实施路线（批准后）

1. **D0**：冻结旧库，`VACUUM INTO memarch_snapshot_20261103.db`
2. **D1**：接入 better-sqlite3，跑通既有 DAO 冒烟测试
3. **D2**：加载 vec0 / trigram，建立 14 表 DDL
4. **D3**：执行 M1–M5 迁移脚本
5. **D4**：性能基准测试，对比 §四指标
6. **D5**：Feature Flag 切换，旧库转只读归档

> 本报告为前置项，业主裁决前不实施迁移。DDL / 迁移脚本按" better-sqlite3 + WAL + vec0 + FTS5"假设编写，若最终选 B 则在 P1 再补。
