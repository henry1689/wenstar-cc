# ADR-017 存储底座迁移：sql.js → better-sqlite3

- **状态**: ✅ 已落地（业主 2026-11-06 批准「一次性做完、彻底治本」，并同意推翻 REDLINE `sqlite-persistence-rules` 中两条）
- **日期**: 2026-11-07
- **影响面**: `src/m2/`（主库/会话库）、`src/m4/household/FamilyGraph.ts`（FG 库）、`src/app/memory-vault/MemoryVault.ts`（金库）、`src/webui/server.ts`（关闭路径）、运维检查与红线

---

## 1. 背景：为什么必须换

sql.js 的架构是「**整库载入 WASM 内存**」，落盘靠 `db.export()` 把**整个内存库序列化**后覆盖磁盘文件。

| 实测代价 | 数据 |
|---|---|
| 单次整库导出 | 126.5MB / **1854~5155ms**，同步执行在主线程 |
| 一轮对话触发的整库重写 | 曾达 **19 次**（224MB×19 ≈ 4.16GB） |
| 数据丢失事故 | 229MB → 3.9MB（空内存库 export 覆盖真实文件） |
| 直接业务后果 | MemArch v2 的 8 条召回腿预算 300ms，被导出抢占后**全部撞线**；`withTimeout` 静默返回 `[]` ⇒ **切流恒返 0** |

为这个架构打的补丁越堆越多：`_dirtyCount` + 60s 防抖 + 50 次上限 + 同步/异步原子写 + 空库守卫 + 写代次 + 双库 ServerLock。**四套 flush 机制并存**（SQLiteAdapter / ConversationDB / FusionStorageAdapter 外壳 / FamilyGraph），health-check、agent-cnc meter、structure-guard 测试与红线文件都在维护 `_FLUSH_BATCH`/`_FLUSH_INTERVAL`。

这些补丁降低的是「撞线概率」，不是消除根因。

## 2. 决策

**换引擎，不换 API。**

```
651 处 writeRaw/queryAll 调用 + 全部业务逻辑   ← 零改动
                ↓
      SqlJsCompat（新增兼容壳，~140 行）
                ↓
           better-sqlite3（原生驱动）
```

- 兼容壳只映射 6 个方法：`run / exec / prepare(bind/step/getAsObject/free) / getRowsModified / close`。
- **刻意不提供 `export()`**：任何漏删的整库导出调用都会在编译期报错。
- 三个库（`fusion_memory.db`、`family_graph.db`、`vault.db`）全部切换；同一个 `.db` 文件直接复用，**零数据迁移**。

### 2.1 落盘策略：WAL + synchronous=NORMAL

理由：启动回填/衰减维护是「逐行 run、无事务」的万级批量循环。回滚日志模式下每条都要 fsync，会把秒级任务拖成分钟级；WAL + NORMAL 无 fsync，批量写快一个量级。

配套约束（已内建在 `SqlJsCompat`）：
- `wal_autocheckpoint = 1000`（≈4MB），避免 `-wal` 无界增长；
- `close()` 前 `wal_checkpoint(TRUNCATE)`，保证停服后 `.db` 是**自包含的完整单文件**；
- 主库文件不存在但残留 `-wal/-shm` 时先清除（否则旧 WAL 会被重放进新建空库）；
- `busy_timeout = 5000`（多进程短暂写锁不直接报错）。

### 2.2 语义对齐（迁移必须等价的三处）

| 差异 | sql.js | better-sqlite3 默认 | 处置 |
|---|---|---|---|
| `exec()` 返回值 | `[{columns, values}]` | 返回 Database 对象 | 兼容层用 `prepare().raw().all()` 重塑 |
| 多语句脚本 | `run()` 可执行整段 DDL | `prepare()` 拒绝多语句 | 无参数时回落 `raw.exec()` |
| **外键约束** | **默认 OFF** | **默认 ON** | 显式 `PRAGMA foreign_keys = OFF`（实测开启后出现 `FOREIGN KEY constraint failed`） |

## 3. 被推翻的红线

`REDLINE sqlite-persistence-rules`（S 级）原有两条：

1. ~~「`scheduleFlush()` 防抖落盘机制不可移除」~~
2. ~~「`export()` 导出函数必须保持与 save() 格式兼容」~~

**业主裁定理据**：「写代码也要与时俱进……敢于打破红线、打破过去的一些规则，把系统设计制造的更优」。

两条规则是为整库导出架构服务的补丁；架构退场后它们只会成为回退到旧链路的入口。红线已重写为**守护新架构**（见文件内 `forbidden_symbols`）。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `src/m2/SqlJsCompat.ts`**（新增）** | 兼容层；WAL/checkpoint/外键语义/孤儿 WAL 守卫 |
| `src/types/better-sqlite3.d.ts` | 补 `reader/raw()/columns()/pluck()/iterate()/allowExtension` |
| `src/m2/SQLiteAdapter.ts` | 换引擎；删除 save/scheduleFlush/flushNow/flushNowAsync/shutdownFlush/_safeWriteDbFile(+Async)/_passesEmptyDbGuard/_dirtyCount/_FLUSH_*（约 400 行）；M 层埋点迁到锚点重建自检块 |
| `src/m2/ConversationDB.ts` | 删除自有 flush（委托/150ms 防抖/export 落盘）；close 语义按共享/独立区分 |
| `src/m2/FusionStorageAdapter.ts` | flushNow/shutdownFlush 合并为 `close()` |
| `src/m4/household/FamilyGraph.ts` | 换引擎；删除 flushAsync/flush/flushAll/_dirty/_saveTimer（约 190 行）；`markDirty`→`invalidateCaches`（31 处调用点）；restoreFromBackup 适配 WAL |
| `src/app/memory-vault/MemoryVault.ts` | 换引擎；删除每次写入的整库导出；备份改 `VACUUM INTO` |
| `src/webui/server.ts` | 关闭钩子 `shutdownFlush()` → `close()` |
| `src/webui/chat/persistence-stage.ts` | 删除 `flushNow?.()` 兜底调用 |
| `src/governance/police/UUIDSupervisor.ts` | 读库改只读原生连接（WAL 感知） |
| `src/cli/health-check.ts` | 4a 段判据反转：从「必须存在 `_FLUSH_*`」改为「不得残留 initSqlJs/export()/`_FLUSH_*`」 |
| `src/agent-cnc/meters/sqlite-persist-meter.ts` | 同上判据反转（剥注释后统计，避免说明文字自命中） |
| 测试 8 份 | 迁移守卫转正、删除 flush 窗口/持久化守卫测试、FG 测试补 close-before-delete、e2e 清理容错 |
| `.agent-cnc/redlines/sqlite-persistence-rules.yaml` | 按业主裁定重写 |

## 5. 验证

- `npx tsc --noEmit` 全绿；
- 迁移守卫 6 条断言全绿（`sqlite-adapter-storage.test.ts`）；
- 兼容层功能探针：WAL、多语句 DDL、数组绑定、`exec()` 形态、`PRAGMA table_info`、`prepare` 三步、`last_insert_rowid`、checkpoint 关闭、只读连接 —— 全过；
- 全量测试：**新增失败 0**；剩余失败均为基线已有（`governance/tests` 用 node:test、`memarch-v2/presentation` 4 条、scripts 3 条）或全量并发下的环境抖动（单独跑全绿）；
- 停服窗口实测：启动 → 写入 → 杀进程 → 重启 → 数据在（见 LEDGER §6.9）。

## 6. 风险与已知边界

1. **WAL 文件语义**：运行中冷拷贝单个 `.db` 可能缺最后一段（`-wal` 未 checkpoint）。对策：关库自动 `TRUNCATE`；停服后备份是单文件完整。运行中备份需一并复制 `-wal/-shm`。
2. **外部删库必须连 `-wal/-shm` 一起删**：兼容层已兜底（主文件不存在时清理孤儿 WAL），但外部脚本仍应遵循。
3. **离线 sql.js 工具**（`src/cli/migrate-entity-relations.ts`、`scan-knowledge-intimate.ts`、`MigrationManager` 的离线分支）**必须在服务停止时运行**——它们仍会整库 export 覆盖磁盘。此为迁移前既有约束，本次未改动；后续可单独迁移。
4. **测试读写真实库**（`grader-non-name-tail` 等）：结果随数据状态变化，与本次改动无关。

## 7. 回退方案

1. `git revert <本批 commit>`（源码级回退，数据文件格式不变：better-sqlite3 写出的仍是标准 SQLite 文件，sql.js 可直接打开）；
2. 若已产生 `-wal` 残留：回退前先停服并用任意 SQLite 客户端执行 `PRAGMA wal_checkpoint(TRUNCATE)`（或直接删除 `-wal/-shm` 后从最近备份恢复）；
3. 数据零迁移 ⇒ 回退不涉及数据转换。

## 8. 后续债务（已登记 LEDGER）

- 离线 sql.js 工具迁移到 better-sqlite3（低优先级，服务停止时运行即可）。
- `src/webui/server-memarch-bridge-routes.ts` 中关于「sql.js 与 better-sqlite3 并存」的历史注释可在下次触碰时顺带更新。
