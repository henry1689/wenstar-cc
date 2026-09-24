# V30 结构性修复 — FG 档案扇出消除（写路径冗余 → 读时计算）

> 变更类型：**架构级**（持久化扇出模型替换），非表现层/非调参
> 变更日期：2026-09-24
> 影响文件：`src/m4/household/FamilyGraph.ts`、`src/webui/server-household-routes.ts`、
> `src/m4/household/shared/DossierPath.ts`、`src/m4/household/__tests__/fg-fanout-guard.test.ts`
> 依据红线：`personal-assistant/knowledge/debugging/wenstar-fg-roleplay-redlines.md`（V2.0，已全文读取）

---

## 一、根因（隔离实验 + 只读探针实测，非推断）

症状：压力测试下对话「卡死不回复」，聊天气泡停在占位符直至前端 60 秒超时。

### 1.1 第一步：原假设被实验**证伪**

原判定（V29）为「sql.js 全量 `export()` 273.8MB 同步阻塞 20~53 秒是根因」。
隔离实验把两个防抖窗口放大 5 倍（60s→300s）后实测：

| 指标 | 基线 | 实验后 | 判读 |
|---|---|---|---|
| 完成对话 | 238 | 260（+22 轮） | 有流量 |
| 落盘次数 | 1601 | 1626（+25 次） | 窗口确实放大了 |
| `integrateFG` | 14~99 秒 | **仍 14~99 秒** | **假设被证伪** |

补充判据：22 轮仅触发 25 次落盘 ⇒ 真正的落盘闸门是 `_FLUSH_BATCH = 50`（硬上限），
**不是防抖窗口** —— 这条连同上一条，共同否定「导出频率/导出本身是主因」。

### 1.2 第二步：决定性测量 —— 导出根本不是瓶颈

无争用条件下对生产库做**只读**实测（独立进程，不触碰在线服务）：

```
export() 276MB 纯耗时        126 / 145 / 135 ms     ← 三次都是 ~130 毫秒
export() + writeFileSync     2889 ms                ← 慢的是写盘，且线上已是 async
```

**276MB 全量导出只要 130 毫秒。** 原文档所记「20~53 秒」相差 **400 倍**。

**数字是怎么来的（计时口径缺陷）**：`SQLiteAdapter.flushNowAsync` 的 `t0`
打在函数开头，而日志语句位于 `await this._safeWriteDbFileAsync(...)` **之后** ⇒
测得的是 **await 排队时间**。事件循环被 `addEdge` 冻结时，落盘的 await 拿不到
时间片，于是被记成「落盘 52 秒」。

> **因果被写反**：不是落盘拖慢 `integrateFG`，是 `integrateFG` 拖慢了落盘的计数。

### 1.3 第三步：真凶 —— `addEdge` 的写入扇出

日志全量汇总（`[FG·integrate]` 埋点，>300ms 才打）：

| 子阶段 | 合计耗时 | 次数 | 平均 | 最大 |
|---|---|---|---|---|
| **`addEdge`** | **1180.2 秒** | 101 | **11.7 秒** | 16.1 秒 |
| `addNode` | 96.7 秒 | 70 | 1.4 秒 | 3.7 秒 |
| `updatePersonProfile` | 8.7 秒 | 91 | 0.1 秒 | 0.85 秒 |

**`addEdge` 占 FG 总耗时 92%。** 单轮两次建边 ≈ 29 秒，与观测到的
`total=28692ms` / `total=29801ms` 逐条吻合；`total=100420ms` 亦为同一轮叠加。

**扇出的结构成因**（`_addEdgeInner` → `await _syncDossierHousehold` →
`_rebuildSocialGroupDossier`，形如）：

```ts
for (const member of members) {                      // ← 组大小 = 扇出倍数
  const existing = await this._getDossierField(...);  // 查回 + JSON.parse(33KB)
  await this._setDossierFieldSystem(...);             // 查回 + parse + stringify + UPDATE
}
```

只读查询实测规模（**仅计数，不含任何内容**）：

| 项 | 实测值 |
|---|---|
| `person` 节点总数 | 527 |
| `social_group_genes` 最大组 | **509**（≈ 全体人的 96.6%） |
| `family_gene` 最大组 | 46 |
| `properties` 平均 / 最大 / 合计 | 33 KB / 641 KB / 18.7 MB |
| `_changeHistory` 条目 | 顶到上限 200 |

**改一条边 ⇒ 1000+ 次数百 KB 级的 JSON 解析/序列化 ⇒ 11.7 秒。**

### 1.4 结论：这是**写时冗余**，不是引擎问题

`misc._socialGroups` 把「组内全部成员名单」抄进了**每个成员**自己的档案，
于是任何一次成员变动都让 509 份副本同时失效，只能全量重建。
名单本身可随时从图谱算出 ⇒ **冗余拷贝 + 全量重建**这个组合不成立。

---

## 二、修复：甲 + 乙

### 甲 —— 删除扇出，改读时计算

**删除**（同步路径归零，属结构削减而非改写调用点）：

| 位置 | 内容 |
|---|---|
| `_addEdgeInner` | `await this._syncDossierHousehold(...)` 整行 |
| `_syncDossierHousehold` | 全量 |
| `_rebuildHouseholdDossier` | 全量（46 人组 O(N²) 配对） |
| `_rebuildSocialGroupDossier` | 全量（**509 人组**，主扇出源） |
| `syncHouseholdsToDossier` | 启动期全量回填 —— 读时计算下无意义，且是同一扇出的另一入口 |
| `_setDossierFieldSystem` / `_getDossierField` | 调用方仅上述几处，一并删除 |

> `_addEdgeInner` 删掉该 `await` 后**不再含任何 `await`**，整条建边路径变成纯同步微秒级。

**新增**（读时计算 + 缓存）：

```ts
householdOf(personName)    → { gene, householder, members, lastSync } | null
socialGroupsOf(personName) → [{ gene, type, members, lastSync }]
```

- 计算逻辑从被删函数**原样搬**（户主判定、关系标签、出生年份提取逐条保留）
- `householdOf` 比原实现**更省**：原实现为 X 算「X 的亲属」要让 46 人互相 O(N²) 往返；
  读时计算只需 X 自己一次 O(N)
- `lastSync` → 取组内 `max(nodes.updated_at)`（组上次变动时间，比原写入时刻更有意义）
- 缓存挂在既有 `markDirty()` 失效钩子上（该处本就在清 `_familyCache`/`_socialCache`），
  批量加载 60 份档案时缓存保持温暖

**读取方改造 —— 对外契约逐字段不变**（`server-household-routes.ts`）：

```ts
const household    = fg.householdOf?.(name) ?? null;
const socialGroups = fg.socialGroupsOf?.(name) ?? [];
profile.dossier.misc._household    = household;   // 同时注入，响应形状与改前一致
profile.dossier.misc._socialGroups = socialGroups;
```

> 数据来源由「存储的副本」换成「读时现算」，**字段名、层级、类型一个都不变**。
> 这是红线 §一.5 合规的关键（详见 §五）。

### 乙 —— 让同步路径以后也不可能再被塞满

**乙-1 消除 `_addNodeInner` 的热路径让出点**
原实现在方法体内 `await import('./GarbageEntityGuard.js')`，每轮 addNode 都让出一次
事件循环。**`await` 让出后，排队的其他任务耗时会被算进调用方的 dt** —— 与
§1.2 的计时口径缺陷**同源**，故 `addNode` 的 1.4 秒均值中含相当比例的
「别人的时间记到它头上」。改法：**懒加载单例**（整个进程只 `await` 一次），
保留动态 import 语义以规避循环依赖风险。

**乙-2 图谱富化唯一后台通道**
照搬本仓已验证范式（`extractProfileFromText` 的 fire-and-forget，2026-09-22
用同一手法修过同一类病）：
```ts
enqueueGraphEnrichment(fn)  // 合并去抖 + void ...().then(hook).catch(warn)
```
**约定**：今后任何「档案富化 / 名单同步 / 全量回填」必须走它，
禁止直接 `await` 在 `addNode` / `addEdge` 内。

**乙-3 运行时预算守卫**
`addEdge` + `addNode` 一轮合计 >500ms → Warning + Hook 日志。
原埋点是 `>300ms` 打 Info，太软；回归第一天就该炸出来。

**乙-4 回归测试锁死不变量**
`__tests__/fg-fanout-guard.test.ts`：同步路径无全量重建、读时计算方法存在且带缓存失效、
对外响应字段仍在、垃圾实体守卫判定逻辑逐字保留。

---

## 三、白皮书更新摘要（架构层）

**标题：FG 名单数据由「写时冗余拷贝」改为「读时图谱计算」**

1. **写入模型变更**：成员名单不再拷贝进每个成员的 `dossier.misc`，
   改为读取方从图谱现算。单条边的写入扇出由「组大小 × 2」降为 **0**。
2. **回复路径与富化解耦**：`_addEdgeInner` 不再 `await` 任何 O(组) 工作，
   「能否及时回复」不再取决于社群/家族组的规模 —— 消除一个
   **随组规模恶化的隐性失效模式**（509 人组即为此模式的现存实例）。
3. **存储与响应解耦**：数据来源改变，但对外 API 逐字段一致 ⇒
   `EntityContextBuilder` / `EntityMeeting` / `ProfileAcquisitionEngine`
   及前端零改动（已 grep 实证：这三者均不读 `dossier.misc`）。
4. **不改变架构边界**：不并库、不新增库、不改 schema、不加字段；
   `family_graph.db` 仍为唯一户籍库；FG 户籍单一数据源铁律不变；
   四层标注机制（`belong_entity_uuid` 等）不变。
5. **同步路径有硬约束**：变更方法禁止内联全量重建（运行时预算守卫 +
   回归测试双闸），防止该模式被重新引入。

---

## 四、蓝皮书更新摘要（模块功能）

**标题：m4 FG 层的档案同步与建边路径改造**

1. `FamilyGraph`：删除 `_syncDossierHousehold` / `_rebuildHouseholdDossier` /
   `_rebuildSocialGroupDossier` / `syncHouseholdsToDossier` /
   `_setDossierFieldSystem` / `_getDossierField`；
   新增 `householdOf` / `socialGroupsOf`（带缓存 + `markDirty` 失效）。
2. `_addEdgeInner`：不再 await 任何富化调用，变为纯同步。
3. `_addNodeInner`：`GarbageEntityGuard` 改懒加载单例；**`checkEntity()` 调用、
   grade=3 进观察区、拦截日志、void 排除条件逐字保留**。
4. 新增 `enqueueGraphEnrichment` 后台通道 + 变更方法运行时预算守卫。
5. `server-household-routes`：`GET /api/household/person` 改调读时计算并注入
   `dossier.misc`，**响应结构与改前逐字段一致**。
6. `shared/DossierPath.ts`：仅同步注释中对已删函数的引用。

### 4.1 部署拓扑（无变更）
不新增/拆分/合并任何服务或进程；不新增依赖；数据库拓扑不变（同一 `.db` 文件，零迁移）。

### 4.2 启动流程（**一处变更**）
删除对 `syncHouseholdsToDossier()` 的启动期调用 —— 该全量回填在读时计算模型下
不再有产出对象，且本身是同一扇出的另一入口。启动因此**变快**（省去全组重写）。

### 4.3 配置项清单（无新增）
不引入开关（不给「切回写时拷贝」留后门，避免第二套真源）。

### 4.4 **落盘机制：本次完全不动**（与 V29 的关系见 §七）
`save()` 调用与签名、`scheduleFlush`、`_FLUSH_BATCH`、`flushNowAsync` 全部保持原状。

---

## 五、FG 红线 11 条触碰判定（已全文读取 `wenstar-fg-roleplay-redlines.md` V2.0）

| # | 触发 | 判定 | 依据 |
|---|---|---|---|
| 1 | ✅ 含 FamilyGraph | **不触碰** | 只删 `dossier.misc` 的同步拷贝写入，**不触碰 `entity_relations` / `entity_topology` 任何写入路径**；不并库、不新增库，`family_graph.db` 仍为唯一户籍库 |
| 2 | ✅ 含 EntityContextBuilder | **不触碰** | 本次不改该文件；已 grep 实证它只读 `selfProfile`/`basicInfo`/`socialIdentity`/`lifeMilestones`/`roleplayProfile`，**不读 `.misc`** ⇒ prompt 与角色扮演零影响 |
| 3 | ✅ 含 FamilyGraph → `roleplay_forbidden` | **不触碰** | 不改 `relation_to_user`、不改 `roleplay_forbidden` 计算、不改 `getPersonProfile` 主体（红线 §一.3 明令禁删） |
| 4 | ✅ 含 EntityMeeting | **不触碰** | 本次不改该文件；其只以 `getPersonProfile` 为输入 |
| 5 | ✅ **dossier 结构 — 实质触碰** | ⚠️ **业主已明示确认**（S2，2026-09-24） | `misc._household` / `misc._socialGroups` **停止写入存储**、改读时计算。`misc` 类型仍 `Record<string, any>`，字段未删；**对外响应逐字段一致**（路由注入）；prompt/角色扮演零影响（见 #2 实证）。属**存储位置变更**，非字段增删。全仓再无第二处读 `dossier.misc` |
| 6 | — | 不适用 | 全仓不存在 `MeetingContextPipeline`（`find` 无结果） |
| 7 | ❌ | 不适用 | 不改 `chat.ts` / `CoreMemoryManager` / `RoleplayDomain` / persona 注入 |
| 8 | ✅ 含 SQLiteAdapter 涉及 | **不触碰** | **不新增任何字段、不改 schema** ⇒ 四层标注机制无需变更；本次亦不修改 `SQLiteAdapter.ts` |
| 9 | ❌ | 不适用 | 不含角色扮演管线文件 |
| 10 | ✅ 含实体匹配（`GarbageEntityGuard`） | **不触碰** | 乙-1 只改**加载时机**（每轮动态 import → 懒加载单例）；`checkEntity()` 调用、grade=3 进观察区、拦截日志、void 排除条件**逐字保留**（回归测试锁死） |
| 11 | ✅ 含 SQLiteAdapter | **不触碰** | **不修改 `SQLiteAdapter.ts`**；不改 schema、不加字段 |

**另确认（红线 §一 反毒数据）**：不写入「我↔任何人=姐妹」类毒数据 ——
本变更**零改动** `entity_relations` / `entity_topology` 的任何写入路径，
亦不触碰 `RelationshipExtractor.ts` 的 5 条写入路径与 `isName()` 检查。

---

## 六、明确偏离声明

| # | 事项 | 处置 |
|---|---|---|
| 1 | `lastSync` 语义微调 | 由「上次同步写入时刻」变为「组内 `max(updated_at)」。**字段名、类型、层级不变** |
| 2 | 启动期全量回填被移除 | `syncHouseholdsToDossier()` 删除。读时计算下无产出对象；保留即保留扇出入口 |
| 3 | 存量副本成为死数据 | 停止写入后，527 人 `properties` 中已存的两份名单不再更新。**读取方已注入计算值覆盖**，服务端返回值正确；残留仅为体积。**按业主 S2 决定记录搁置，主线完成后统一清理**（先取备份） |

---

## 七、与 V29 的关系（V29 根因被证伪，**方案撤回**）

V29 主张「换 `better-sqlite3` 消除全量导出阻塞」。本变更集的隔离实验与只读实测证明：

- `export()` 276MB 无争用实测 **130ms**，非「20~53 秒」（计时口径缺陷，见 §1.2）
- 线上写盘已是 async（2~4 秒，不阻塞主线程）
- 真实热点是 `addEdge` 扇出，**换底座完全不触及它**

因此 V29 **按业主 S2 决定撤回**（2026-09-24），本文档与 `docs/V29` 中均保留审计痕迹，
不删除。V29 §八 记录的 4 个 sql.js 全文件覆写脚本缺 `ServerLock` 守卫，
作为**遗留项**继续跟踪（本次不动落盘机制，故不因此恶化）。

**两套方案的取舍记录**：

| | 形态一：换存储底座（V29） | 形态二：消除写扇出（本文 V30） |
|---|---|---|
| 消除 `integrateFG` 尖峰 | ❌ 不触及 `addEdge` | ✅ 根因所在 |
| 改动面 | 4 源文件 + 回滚风险 | 3 源文件，且**净删除** |
| 收益 | 仅 2~4 秒写盘排队（本已 async） | 101 次 × 11.7 秒 ≈ **1180 秒** |
| 数据迁移 | 零 | 零 |
| 引入新风险 | 新引擎语义、事务边界、FTS5 依赖 | 存储位置变更（已逐字段保契约） |

**业主审批：采用形态二；形态一记录为不采纳并撤回。**

---

## 八、验证方案与判据

| 验证项 | 判据 | 结果 |
|---|---|---|
| `tsc --noEmit` | 退出码 0 | 待验 |
| 新增回归测试 | `fg-fanout-guard.test.ts` 全绿 | 待验 |
| 既有 FG 测试 | `FamilyGraph.test.ts` 等不回归 | 待验 |
| `[FG·integrate] addEdge` | 101 次合计 1180 秒 → **单次 < 100ms** | 待验（需真实流量） |
| `integrateFG` | 14~99 秒 → **亚秒级** | 待验（需真实流量） |
| 60 秒超时 | 业主实测 2 次 → **0** | 待验（需真实流量） |
| `/api/household/person` 响应结构 | 与改前基线**逐字段一致** | 待验（先抓形状基线） |
| FG 红线 SQL 自查（§五 三条） | 零毒数据 | 待验 |
| `.save()` 持久化校验（S6） | `save()` 调用点与签名零削减 | 待验 |

### 8.1 回滚方案

| 项 | 内容 |
|---|---|
| 回滚粒度 | revert 本变更集文件（3 源文件 + 测试 + 2 文档） |
| 数据兼容 | 无 schema 变更、无回填、无迁移 ⇒ 回滚即回到写时拷贝，存量副本仍在 |
| 风险 | 回滚后恢复 11.7 秒/次 的建边开销，但不丢数据 |
| 配置开关 | 无（回滚只能靠 git revert） |

---

## 九、已知风险与遗留项（不在本次范围）

1. **`social_group_genes` 有一个组覆盖 527 人中的 509 人** —— 组规模本身不合常理。
   属数据卫生，**按业主原则记录搁置**，主线完成后统一交业主处理；本次不擅改数据。
2. **存量 `properties.dossier.misc` 两份名单成为死数据** —— 见 §六.3。
3. **4 个 sql.js 全文件覆写脚本缺 `ServerLock` 守卫**（V29 §八遗留）：
   `BackfillGlobalUID.ts`、`BackfillDualHelix.ts`、`migrate-entity-relations.ts`、
   `scan-knowledge-intimate.ts`。均不在 `package.json.scripts`，服务不自动调用。
4. **`wenstar-webui` 的 pm2 `kill_timeout` 未设置**（默认 1600ms），而 276MB 落盘需 ~2.9 秒
   ⇒ 关停时 SIGINT 后的 `shutdownFlush()` 可能没跑完就被 SIGKILL。

   **更正（2026-09-24 落地后核实）**：此处**原写为「留下截断的生产库」，该说法错误**。
   经读源确认，`_safeWriteDbFile` 是 **`tmp → fsync → rename` 原子写**
   （`SQLiteAdapter.ts:2706`，NTFS 同盘 rename 为原子替换，任一步失败只影响 tmp、
   原文件完好）。故 SIGKILL 中途**不会损坏库**，实际后果是
   **「本次落盘未完成 ⇒ 丢最近一批未落盘写入」**，原库保持完好。

   结论不变（建议单独处置 `kill_timeout`），但**风险等级由「数据损坏」下调为「末批写入丢失」**。
   重启前仍建议先让至少一次周期落盘完成。
5. **`addNode` 1.4 秒的真实构成**：乙-1 消除让出点后须重新测量再定论，
   **本次不盲目改动其判定逻辑**。
6. 实验期注入的环境变量 `TIANQUAN_FLUSH_INTERVAL_MS` / `FG_FLUSH_MIN_INTERVAL_MS`
   仍为 300000，须**先落盘再优雅重启**恢复为默认 60 秒（不可直接 `pm2 restart`）。

---

## 十、审计卷宗（PROPOSAL_AUDIT_TRAIL）

| 项 | 内容 |
|---|---|
| 起因 | 压力测试下对话卡死不回复（前端 60 秒超时） |
| S1 全局审视 | 汇总日志计数、`[M4·timing]` 分解、`[FG·integrate]` 子阶段分布、`dossier.misc` 消费面穷举、FG 红线 11 条 |
| S2 业主审批 | 2026-09-24，业主明确批复「1-4 都同意」，四项分别为：红线 §一.5 触碰确认、存量死数据记录搁置、V29 标注撤回保留审计痕迹、即刻开工 |
| 形态一 | 换存储底座（sql.js → better-sqlite3） —— 隔离实验证伪后**记录为不采纳** |
| 形态二 | 消除写扇出、改读时计算 + 非阻塞闸门 —— **采纳并落地** |
| 差异矩阵 | 见 §七 表格 |
| 被否决的局部路线 | ① 仅把防抖窗口调大（实测无效，22 轮仍 14~99 秒）② 仅把整组重建改成后台（治标，重建本身仍是 11.7 秒）③ 只做增量更新不做去冗余（保留扇出面，组变大仍会劣化） |
| 承认的偏离 | §六 三条 + V29 撤回（§七），均如实记录，未作含糊处理 |
| 遗留登记 | §九 六条 |
