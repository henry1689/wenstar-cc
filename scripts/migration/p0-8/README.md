# P0-8a 知识库只留「文档 + 微信临时」

> 业主指令（2026-10-07）：「知识库里不应该有什么碎片信息，也不能有这些，因为这里只存文档和微信
> 临时信息，再加上微信信息每天晚上还要彻底清除避免污染」
> 逐项拍板：梦境不删、改为隔离；1 字空条目删。
> 日期：2026-10-07 ｜ 脚本：`purge-kb-nondocuments.cjs` / `purge-kb-nondocuments.sql`

---

## 一、为什么要做这一批

业主与熊梓铭会晤时，她"查到"的所谓档案是三条 **22~71 字的「巩固记忆」碎片** ——
事实核查发现两条根因：

| # | 事实 | 证据 |
|---|---|---|
| 1 | **知识库 93.6% 不是文档** | 1132 条里：微信 910 · 梦境 141 · 系统碎片 9 · 真文档约 72 |
| 2 | **短碎片在检索里赢过长文档** | `weightedSearch` 的 `titleBoost` 最高 3 倍 —— 碎片标题带人名 → 0.600；5231 字的档案 → **0.139**，被 `_kept` 的 `matchScore >= 0.3` 门槛**整个滤掉** |

还有两件业主此前不知道的事：

- 🔴 **「每晚清微信」这个机制根本不存在** —— 全仓 grep `wechat_relay`，`src/` 与 `scripts/` 零引用；
  910 条全部来自 2026-09-23/24 的一次性导入。
- 🔴 **系统每天还在往知识库写碎片** —— `SleepTimeConsolidator` 写「巩固记忆」、
  `DailyMaintenanceScheduler` 写「对话主题月报」。

---

## 二、本批四项动作

| # | 动作 | 落点 |
|---|---|---|
| **C1** | 清 9 条非文档非微信非梦境的碎片 | 本脚本（停服窗口） |
| **B1** | 停掉往知识库写「巩固记忆」 | `SleepTimeConsolidator.ts` |
| **B2** | 停掉往知识库写「对话主题月报」 | `DailyMaintenanceScheduler.ts` |
| **C2** | **新建**每晚彻底清微信临时信息 | `DailyMaintenanceScheduler.ts`（每日维护 ⓪-b） |
| **梦境** | 隔离出检索（**不删**） | `SourceTypePolicy.ts`：`dream_behavior` → `GARBAGE_SOURCE_TYPES` |

> 另有守卫同步：`src/app/learning/__tests__/ownership-attribution.test.ts` 的三条断言由
> 「写知识库必须绑对归属」**升级为反向断言**「这两类**不得**再写 knowledge_base」；
> `ProspectiveSimulator`（仍在写）的守卫原样保留。**强度不降反升。**

---

## 三、执行（必须停服）

```bash
pm2 stop wenstar-webui
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue"

# 预览（会打印待删 9 条的 id/来源/长度/归属 + 明确不动的三类计数）
node scripts/migration/p0-8/purge-kb-nondocuments.cjs

# 执行
node scripts/migration/p0-8/purge-kb-nondocuments.cjs --apply \
  --operator owner --reason "P0-8a 清知识库非文档碎片" --ticket P0-8a --confirm <token>

pm2 restart wenstar-webui
```

**安全契约**：`riskLevel=HIGH` · `operationType=delete` · 有界 scope ⇒ 确认/备份/有界性三道规则。
产物：`data/backups/p0-8/p0-8-preapply-*.db` · `p0-8-report-*.json`（含 `deletedRows` **整行快照**，可精确还原）。

---

## 四、删除集的推导规则（可复算，用于核对白名单没漂移）

```
删除 = 非微信 ∧ 非文档 ∧ 非梦境

  非微信：COALESCE(source_name,'') NOT LIKE 'wechat_relay/%'
          🔴 必须 COALESCE —— source_name 为 NULL 时 `NOT LIKE` 结果是 NULL 而非 true，
             会把这行整个滤掉（本次推导时踩过一次，返回了 0 条，是典型的三值逻辑坑）
  非文档：NOT(source_type IN ('md','text','person','research','architecture') AND 正文≥100字)
          AND NOT(source_type='txt' AND 正文≥100字)
  非梦境：COALESCE(source_type,'') <> 'dream_behavior'
```

命中 9 条：`systems_consolidation` 4 · `monthly_topic` 2 · `conversation_induct` 2 · `text` 1（1 字空条目）。

🔴 runner 里写的是**显式 9 个 id 白名单**，不用上面这条按类别扫的 SQL 去删 ——
按类别扫的谓词正是本项目两次数据损失（68→3 条、4 份 FG档案范式）的共同形态。

---

## 五、验收标准

- [ ] `knowledge_base` 1132 → **1123**（−9）
- [ ] 微信 910 条**不变**、梦境 141 条**不变**、真文档约 72 条**不变**
- [ ] 白名单残留 0 条
- [ ] 重启后 `[SleepTime] 系统巩固` 不再产生 `systems_consolidation` 条目
- [ ] 重启后 `[DailyMaintenance] 📊 月度主题(…，不入知识库)`
- [ ] 次日维护出现 `[DailyMaintenance] 🧹 微信临时信息已彻底清除: N 条`
- [ ] **会晤实测**：`[KBw] top=` 打出的标题应是**文档**，不再是「巩固记忆: …」

---

## 六、已知边界（如实记录）

1. **本批不解决"文档能不能被检索到"**（A 项）。清完 + 断源后**先实测**，仍不对才动排序 ——
   不凭推测改评分。见 P0-8c。
2. **梦境仍写入知识库**，只是不进检索。若日后要彻底移出，需先确认梦境功能的消费方。
3. `WK3993000084E0C0EA4CB88E`（标题「非法来源探针」）是探针残留，删掉；若它是某个测试的夹具，
   该测试可能报红 —— 本批未发现引用。
4. **微信清理是"知识库只增不删"原则的明文例外**，规则由业主定义并在代码注释里注明出处；
   判据是结构性的（`source_name LIKE 'wechat_relay/%'`），不是"看起来像垃圾"。
