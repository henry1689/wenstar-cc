# P0-3 存量清洗（记忆体系止血 · 第三批）

> 依据：`docs/P0-记忆体系止血任务书-V3.md` §3
> 背景诊断：`docs/P0-5-钙化升级机制调查报告.md`、`docs/P0-4-全零向量根因调查报告.md`
> 日期：2026-10-07 ｜ 执行人：业主 ｜ 脚本：`run-p0-v3-cleanup.cjs` / `p0-v3-cleanup.sql`

---

## 一、本批做什么

| 项 | 动作 | 条数（2026-10-07 复核） |
|---|---|---|
| **A** | `memories.belong_entity_uuid` 的字符串 `'null'` → SQL NULL | **24** |
| **A′** | `black_diamond.belong_entity_uuid` 的字符串 `'null'` → SQL NULL | **19** |
| **C** | `vault_log` 归属回填（`source_id → memories.id`） | **353** |

### B / D 刻意不动作（**这是结论，不是遗漏**）

| 项 | 内容 | 为什么不动 |
|---|---|---|
| **B** | `memories` 的 142 条 SQL NULL 归属 | B3（`global_uid` 关联）实测救回 **0/166**；按正文人名推断会让 **29.2%** 串档（全表对照实测）⇒ **保持 NULL 是正确答案** |
| **D** | `vault_log` 的 `promote_sand`(139) / `auto_promote`(5) | 根因已查明：这两类是**批次汇总日志**（detail 形如「砂金晋升金库 N 条」），`source_id` 从未被写入 ⇒ **源信息不可恢复**，强行赋值 = 编造 |

---

## 二、执行（必须停服）

🔴 **本库是 sql.js 全量驻内存 + 整库写回。服务运行期间的外部改动会被内存态 flush 静默覆写**
（见 `src/app/locking/ServerLock.ts` 头注释）。runner 会自行检查 `server.lock`，
但**端口检查请人工确认一遍**。

```bash
# 1) 停服
pm2 stop wenstar-webui
# 确认端口 3000 无监听（Windows）：
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue"

# 2) 预览（默认 dry-run，不写任何数据）
node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs

# 3) 执行
node scripts/migration/p0-v3/run-p0-v3-cleanup.cjs --apply \
  --operator owner --reason "P0-3 存量清洗：字符串null归一 + vault_log归属回填" \
  --ticket <harness 任务单号> --confirm <确认令牌>

# 4) 重启并复核
pm2 restart wenstar-webui
```

**runner 的内置安全契约**（沿用本仓 `scripts/_governance-gate.cjs`）：
`riskLevel=HIGH` · `operationType=update`（破坏性）· 有界 scope ⇒ 触发 R001–R003 / R008–R010+R013 / R011。
另加两道自查：**停服检查**（存活进程持有 lock 即拒绝）、**备份大小校验**（不一致即中止，绝不带未校验的备份往下走）。

执行成功会产出：
- 备份 `data/backups/p0-v3/p0-v3-preapply-<ts>.db`
- 报告 `data/backups/p0-v3/p0-v3-report-<ts>.json`（含 preview / applied / verify / 不动作项清单）

---

## 三、验收标准（V3 §3.3）

- [ ] **B3：执行前后 NULL 数一致（预期 166 → 166）** —— 本批对 B **零改动**，属预期 ✅
- [ ] B3 不含任何按正文推断的逻辑 ✅（无此类 SQL）
- [ ] B4：`landmark` null **327 → ≤17**、`promote` null **60 → ≤19**、`merge_promote` **2 → 0**
- [ ] `promote_sand` / `auto_promote` 有根因分析报告 ✅（见上表 D 行）
- [ ] SQL 与 runner 存档到 `scripts/migration/p0-v3/` ✅
- [ ] 无回归（`npx vitest run`）
- [ ] **（本批新增）全表「字符串 `'null'`」残留归零**：`memories` 24 → 0、`black_diamond` 19 → 0

---

## 三之二、执行结果（2026-10-07 01:35，已实际执行）

```
停服检查 ✅（锁的持有进程 40776 已不存在 → 残留锁，放行）
备份      ✅ data/backups/p0-v3/p0-v3-preapply-2026-10-06T17-35-54-766Z.db（271.2 MB，大小校验一致）
治理闸门  ✅ 契约通过（HIGH / update / 有界 scope / 备份已校验）

dry-run 预览：A=24（基线 24 ✅） A2=19（基线 19 ✅） C=353（基线 353 ✅）
执行：      A 影响 24 行 · A2 影响 19 行 · C 影响 353 行
复核：      三项剩余待处理均为 0 ✅

全表「字符串 'null'」残留：memories 0 · black_diamond 0 · vault_log 0    ← 归零
memories SQL NULL：166（与执行前一致 —— 达成 V3 §3.3「166 → 166」验收判据 ✅）
vault_log SQL NULL：533 → 180（回填 353 条）

报告：data/backups/p0-v3/p0-v3-report-2026-10-06T17-35-54-766Z.json
```

### 🔴 重启后的复核发现（2026-10-07 回滚演练时暴露）—— 必读

runner 跑完时代码报告 `memories SQL NULL = 166`（142 原有 + 24 归一，**V3「166 → 166」判据达成**）。
但**服务重启之后**再做逐行比对（备份 vs 线上），真实结果是：

```
24 条字符串 'null' 里：
    2 条 → SQL NULL（本批 A 步做的）
   22 条 → 被赋予了**真实的归属值**            ← 不是本批做的
线上新增行 0 · 线上消失行 0 · 无任何行丢失归属
线上 memories SQL NULL：166 → 144
```

**认领那 22 条的是 `SQLiteAdapter.initialize()` 里的 V10.5 启动回填**
（`src/m2/SQLiteAdapter.ts:642-672`，开关 `SKIP_BACKFILL`，默认执行）。它有三处做的是
**按正文提及的人名推断归属**：

```
① conversations 全文匹配：  WHERE ... content LIKE '%${name}%'                  （对每个 person 实体跑一遍）
③ memories 从会话传导：     WHERE c.content LIKE '%' || substr(memories.raw_input,1,30) || '%'
④ roleplay 直接匹配：       WHERE ... memories.raw_input LIKE '%' || e.name || '%'
```

🔴 **这正是 V3 §3.1 明令禁止的做法**，其原话：「禁止按正文角色名推断（实测：166 条里 142 条根本
不提任何人名；全表对照 **29.2%** 的已归属记忆正文提到的是别人 ⇒ 名字推断会整体串档）」。
⇒ 那 22 条按实测概率**大概率含错认**，需要独立核查（**另立批次**）。

**对本批结论（B 项「保持 NULL」）的影响**：只要这条启动回填默认执行，
**任何把归属置 NULL 的清洗都会在下次重启时被推翻** ——
即 V3 §3.1 的「关联不上就保持 NULL」在**当前架构下不可达**。
这是本次清洗暴露出的**结构性阻塞**，已记入下方「已知边界」。

**验收核对**（对照 §三）：
- [x] B3：执行前后 NULL 数一致（166 → 166）✅
- [x] 不含任何按正文推断的逻辑 ✅
- [x] B4：vault_log 缺归属 **533 → 180**（回填 353）；其中 `landmark` 327→17、`promote` 60→19、
      `merge_promote` 2→0、`promote_sand` 139 与 `auto_promote` 5 **按结论保持 NULL**
- [x] `promote_sand`/`auto_promote` 有根因分析 ✅（见 §一 表 D 行）
- [x] SQL 与 runner 存档到 `scripts/migration/p0-v3/` ✅
- [x] 全表「字符串 `'null'`」残留归零 ✅

---

## 四、已知边界（如实记录）

1. **A/A′ 是纯格式归一，不改变任何行为** —— 字符串 `'null'` 与 SQL NULL 在
   deny-by-default 下都被排除。归一的价值在于**不再骗过只测 NULL 的完整性检查**。
2. **C 只回填 `landmark`/`promote`/`merge_promote` 三类**。其余 operation 的 `source_id`
   要么为空、要么指向非 memories 表，不在可关联范围。
3. **本批不引入表级 NOT NULL 约束** —— 需先清存量、且会改变写入失败语义，属独立议题。
4. **`promote_sand` / `auto_promote` 的"批次汇总日志缺逐条来源"这一设计缺口本批未修**，
   仅记录。若日后需要逐条溯源，需改 `MemoryAssessor.ts:334` 与 `server.ts:1545` 的调用方式
   （另立批次，且 `server.ts` 是 HIGH）。
5. 🔴 **启动回填与 V3 §3.1 直接冲突（本次清洗暴露的结构性阻塞）**：
   `SQLiteAdapter.initialize()` 的 V10.5 回填（`SKIP_BACKFILL` 默认关闭 ≠ 'true'）会按
   **正文提及的人名**认领无归属记录 —— 这与 V3「禁止按正文角色名推断、关联不上保持 NULL」
   直接矛盾，且**每次启动都会把上一步的 NULL 重新认领**。
   本批的 B 项结论在当前架构下**不可维持**。
   后续若要真正落地 V3 §3.1，必须先处理这条回填路径（`src/m2/SQLiteAdapter.ts`，**HIGH**），
   而它同时还有一处工程质量问题：**实体名是字符串插值进 SQL 的**（`'${_n}'` / `'%${_n}%'`），
   名字含引号即会破坏语句 —— 应当参数化。
6. **本批已执行完毕且不可逆地改变了 22 行的归属**（不是本批写的，是重启后的启动回填写的）。
   备份 `p0-v3-preapply-*.db` 保留的是**清洗前**状态；若要回到「那 22 条为 NULL」的状态，
   需恢复备份后**同时**以 `SKIP_BACKFILL=true` 启动，否则重启即被再次认领。
