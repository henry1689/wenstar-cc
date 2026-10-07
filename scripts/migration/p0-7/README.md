# P0-7a 找回丢失的知识库内容

> 依据：`docs/P0-6-知识库人物档案丢失调查报告.md`（commit `ff32544`）
> 业主指令（2026-10-07）：「记住知识库里的东西是不能随便被清理的，除非是我确认的或者手动的，
> 你想办法给我找回来，并设保护，然后赶快修复让这些实体都能随时查到」
> 日期：2026-10-07 ｜ 执行人：业主 ｜ 脚本：`run-restore-kb-dossiers.cjs` / `restore-kb-dossiers.sql`

---

## 一、本批做什么

| 项 | 动作 | 条数 |
|---|---|---|
| **A** | 从**塌缩前最后一个备份**还原 `knowledge_base` 行（逐列照搬） | **68** |
| **B** | 从磁盘读入 4 份【FG档案范式】全文（带正确归属） | **4** |
| **C** | 人物类 KB 行统一置 `locked = 1`（「设保护」） | 16（另随行写入若干） |

**结果：`knowledge_base 1060 → 1132`。**

### A 的来源为什么是那一份

`data/backups/pre-uid-recovery/fusion_memory_pre_uid_recovery_20260826-022456.db` ——
它是**塌缩前的最后一个快照**：08-26 02:24 时 KB=68，而四天后的 08-28 快照 KB=3。
同源的另两份（`pre_replace` / `uid_recovery_candidate`）内容一致，可互校。

### B 为什么必须单独处理

那 4 份【FG档案范式】原 `source_type='text'`，与 `MigrationManager` 的
`DELETE FROM knowledge_base WHERE source_type = 'text'`（V13 知识库净化迁移）**完全吻合**：
它们的原始 id 在 08-25 的备份里就已不存在，且该备份 `source_type='text'` 计数 = 0。
该迁移函数在 **P0-7b** 中已被整段移除。

🔴 **必须带归属**：若置空，它们会以"公共"身份参与检索，在**有自有档案的实体**里挤不进前 3 个名额
—— 那就是"找回来了却还是查不到"，等于白做。

---

## 二、执行（必须停服）

🔴 本库是 sql.js 全量驻内存 + 整库写回。服务运行期间的外部改动会被内存态 flush **静默覆写**
（见 `src/app/locking/ServerLock.ts` 头注释）。runner 会自查 `server.lock`，端口请人工确认一遍。

```bash
# 1) 停服
pm2 stop wenstar-webui
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue"

# 2) 预览（默认 dry-run；会**逐条打印将写入的 id 全清单**）
node scripts/migration/p0-7/run-restore-kb-dossiers.cjs

# 3) 执行
node scripts/migration/p0-7/run-restore-kb-dossiers.cjs --apply \
  --operator owner --reason "P0-7a restore lost knowledge_base rows" \
  --ticket P0-7a --confirm <token>

# 4) 重启
pm2 restart wenstar-webui
```

**安全契约**（沿用 `scripts/_governance-gate.cjs`）：`riskLevel=HIGH` · `operationType=insert` · 有界 scope
⇒ 触发确认/备份/有界性三道规则。另加两道自查：**停服检查**、**备份大小校验**（不一致即中止）。

产物：备份 `data/backups/p0-7/p0-7-preapply-*.db` · 报告 `data/backups/p0-7/p0-7-report-*.json`
（报告含 `insertedIds` 全清单、`skippedIds`、前后计数、各实体自有条目数）。

---

## 三、执行结果（2026-10-07，**跑了两次**）

| # | 时刻 | 动作 | 结果 |
|---|---|---|---|
| 1 | 04:20 | 首次执行 | 写入 **72** 条，KB `1060 → 1132` ✅ |
| — | 04:2x | **重启** | 🔴 被当时仍在的启动期去重删掉 **2** 条 → KB `1130` |
| 2 | 04:44 | P0-7b 停掉该去重后**重跑**（幂等） | 补回 2 条 + 置 `locked=1` 16 行 → KB **`1132`** ✅ |
| — | 04:47 | 再次重启 | ✅ **零删除**；启动日志只报告、不再删 |

**各实体自有 KB 条目（业主最关心的"能不能查到"）：**

| 实体 | 条数 | 内容 |
|---|---|---|
| 熊梓铭 | 5 | 3 条巩固记忆 + `梓铭简介：` + `【FG档案范式】熊梓铭` |
| 徐诗雨 | 3 | 1 条巩固记忆 + `徐诗雨 · 人物档案` + `【FG档案范式】徐诗雨` |
| 徐诗韵 | 2 | `【FG档案范式】徐诗韵` + `徐诗韵 · 人物档案` |
| 王全芬 | 2 | `阿芬` + `【FG档案范式】王全芬` |
| 徐诗涵 | 1 | `徐诗涵 · 人物档案` |

---

## 四、那 2 条是怎么丢的（P0-7b 的由来）

启动日志：

```
[SQLiteAdapter] KB人物档案去重（通则）: 删除 2 条重复档案
```

出处 `src/m2/SQLiteAdapter.ts` 的 `_fixKnowledgeBase()` —— **每次启动都跑**，按 `belong_entity_uuid`
给 `classification='人物档案'` 去重、"保留最早一条、其余 DELETE"。它删掉的正是
`徐诗韵 · 人物档案` 与 `【FG档案范式】徐诗雨`。四个问题：

1. **不看 `locked`** —— 已置的保护对它无效
2. **直接违背业主「两份材料都进，分工明确」的决定**
3. 与 `scripts/fix-all-entities-final.cjs` 的 P1-2 是**同一套逻辑**，被"通则"化后在每次启动自动执行
4. 删除无提示、无留痕、无人工确认，且原 `catch {}` 连异常都吞掉

⇒ **P0-7b 已把它降级为「只报告、不删除」**（发现同实体多份人物档案时 `console.warn` 列出 id）。
现启动时输出：

```
[SQLiteAdapter] ⚠️ 2 个实体存在多份人物档案 —— **只报告，不删除**（知识库禁止无确认清理，交人工决定）：
```

> ⚠️ 注意：该告警走 `console.warn` → **stderr**，在 pm2 里是 `logs/pm2-wenstar-err.log`，
> 不在 `-out.log` 里。排查时别只看 out 日志。

---

## 五、已知边界（如实记录）

1. **1 条重复已如实保留**：还原的 68 条里，`【玉瑶本人】玉瑶的档案`（`kn_mqzb65f9_8avd`）与现库
   同名条目（`WK5076500084E0C0EAA3A3E8`）**同题不同 id**。按业主原则**不做"看起来像重复就跳过"**
   的判断，照搬回去；去留由业主定。
2. **1 条正文有编码残留**：`WK1530400084E0C0EAD82782` 的 title/classification 在备份里已是乱码
   （`ϵͳ�ĵ�`）。照搬以保真，未做"顺手修正"。
3. **本批只解决"数据有没有"**；"排序能不能让它进前 3 名额"是另一层（`_own` 优先 + `slice(0,3)`）。
   恢复后各实体自有条目已 ≥2，实测需在会晤中确认（见 P0-7c）。
4. **备份是旧库**（`memories` 2063 条 vs 当前 9721），故**只能按 id 白名单提取 KB 行**，不可整库替换。
