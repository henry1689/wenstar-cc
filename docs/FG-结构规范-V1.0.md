# FG 结构规范 V1.0（法律对齐版）

> 状态：**草案待验收**（T010 Phase 0 交付物）
> 作者：Claude Code（结构与读取侧） · 日期：2026-10-21
> 关联：[T010 任务书](../docs/agent-collab/active/T010-20261021-FG结构规范V1.0-法律对齐版.md)
> [ADR-012 FG 法律对齐架构决策](adr/ADR-012-FG法律对齐架构决策.md)
> 法律依据：[太虚境户籍管理法 V2.1](../data/knowledge-v4/governance/taixu-household-registration-law.md) ·
> [FG 亲属关系红线 V3.5](../data/knowledge-v4/governance/redlines/fg-kinship-redlines.md) ·
> [FG 档案录入治理](fg-profile-entry-governance.md)

> 🔴 **本规范只做结构与规则定义，不含代码实现。** 所有「删除」动作都在 Phase 4/5 停服窗口执行。
> 每条规则均标注法律条款；无法律依据的取舍标注 **〔需业主裁决〕**。

---

## 〇、与 T010 初稿的 5 项法律冲突校正（必须先看）

T010 初稿有 5 条与上位法抵触或会造成数据损失。本规范按法律优先原则做了校正，交豆包/业主确认。

| # | T010 初稿 | 法律条文 | 本规范处理 |
|---|---|---|---|
| 1 | 删除 `security_level`「归记忆域」 | 第九条(一)：户籍登记表含「安全密级」；第二十七条：三级密级；第三十五条⑧⑨配套 | **保留列并接入读取过滤**（当前是死字段，P031 P0-6）。密级属于档案而非仅记忆 |
| 2 | 删除 `family_gene`/`social_group_genes` | 第五条：分户治理以二者为户编码；第三十五条⑩：`social_group_genes` 非空校验 | **保留并按第五条重算**（当前仅 15/18 人有码，是实现缺陷不是字段冗余） |
| 3 | 删除 `candidate`/`void` 状态 | 第三十条：四档；但第十五条 placeholder、第三十二条(五)、第三十三条合并 | 用**既有法律语义**承载：candidate → `entity_source='placeholder'`；void → `archived`（第三十三条：合并后旧节点 status=archived，编号永久归档）。**不新增状态、不删状态** |
| 4 | 删除 `legacy_ids`「迁移完成后」 | 第八条(4)：历史编号永久留存，检索自动重定向 | **保留**（T007 刚用它完成实体合并溯源） |
| 5 | 删除旧子卷（含 `relationMap`）并「定期物理清除 void 节点」 | 第十九条把 relationMap 归档；但**第二十五条**要求 `Dossier.relationMap` 承载主观相处规则；第十一条：卷宗只增不删、PendingItem 超期只标记不物理删除 | ① **保留 `relationMap` 子卷**（法律内部不一致，需业主裁决，见 §1.2）；② **禁止物理删除节点与卷宗记录**，只允许清孤儿边/重复边且必须写入 `_changeHistory` |

> ⚠️ 附带发现：`nodes.tags` 是**真的死列**。红线 §八提到的 `fg_person`/`fg_relation` 标记写在
> **`black_diamond.tags`**（记忆侧，FamilyGraph.ts:6694-6741），不是 `nodes.tags`。该列可删。

---

## 一、数据结构固定

### 1.1 `nodes` 户籍登记表（法律第九条(一)）

| 字段 | 类型 | 必填 | 法律依据 | 说明 |
|---|---|:--:|---|---|
| `id` | TEXT | ✅ | 第七条 | `TXS-{9位流水号}`，纯流水号无分类前缀 |
| `name` | TEXT | ✅ | 第十二条 | 仅存法定本名；关系称谓禁止写入 |
| `type` | TEXT | ✅ | 第二条 | `person` / `org` / `place` / `object`（`event` 为下位扩展，见 §1.5） |
| `uuid` | TEXT | ✅ | 第六条 | 全域唯一，`idx_nodes_uuid` 唯一索引已具备 |
| `category` | CHAR(1) | ✅ | 第八条 | `S/U/A/B/X/G/H` 等；随境遇可变 |
| `status` | TEXT | ✅ | 第三十条 | **四档**：`active` / `dormant` / `archived` / `deceased` |
| `entity_source` | TEXT | ✅ | 第十五条 | 五类：`real`/`ai`/`fictional`/`historical`/`placeholder` |
| `security_level` | INTEGER | ✅ | 第二十七条 | 1 公开 / 2 内部 / 3 私密 |
| `family_gene` | TEXT | ✅ | 第五条 | 家庭户编码 `FAxx` |
| `social_group_genes` | TEXT | ✅ | 第五条 / 第三十五条⑩ | 社群户编码，多值 `A|B`，非空 |
| `aliases` | TEXT | — | 第十二条(3) | JSON 数组：曾用名/昵称/称谓别名 |
| `properties` | TEXT | ✅ | 第九条 | JSON：`dossier` 七子卷 + `_changeHistory` |
| `legacy_ids` | TEXT | ✅ | 第八条(4) | 历史编号永久留存 |
| `created_at`/`updated_at` | TEXT | ✅ | 第十一条 | |

**删除列**：`tags`（零读写）、`circle_level`（零调用、全 0、法律无依据）〔需业主确认〕。

**不外露**：`entity_source` / `category` / `status` / `security_level` 仅供门阀与治理使用，
**不注入 LLM 上下文**（避免身份泄漏与提示词噪声）。

### 1.2 `dossier` 人生卷宗七子卷（法律第十九条）

| 子卷 | 必备字段 | 法律依据 |
|---|---|---|
| ① `basicInfo` | `gender`, `birthYear`, `birthPlace`, `education` | 第十九条(一) |
| ② `selfProfile` | `traits[]`, `appearance`, `bodyFeatures`, `style`, `voice`, `scent`, `distinguishingMarks`, `likes[]`, `dislikes[]`, `languageHabits`, `taboos[]`, `healthCondition`, `feminineDetails{}`, `contact{}`〔见下〕 | 第十九条(二) |
| ③ `socialIdentity` | `timeline[]`(职业/婚恋), `currentOccupation`, `currentWorkplace` | 第十九条(三) |
| ④ `lifeMilestones` | `[{date, event, type, sourceRef}]` | 第十九条(四) |
| ⑤ `boundDocuments` | `[{docId, title, type, boundAt}]` | 第十九条(五) |
| ⑥ `_changeHistory` | `[{time, operation, field, before, after, reason, source}]` 上限 10000，超出归档 `_deprecated._changeHistoryArchive` | 第十九条(六) |
| ⑦ `misc` | 自由 JSON（禁止放结构化内容） | 第二十条 |
| ⑧ `relationMap`〔**保留项，法律内部不一致**〕 | `relationToUser`, `intersections{}`, `notes` | 第二十五条(二) |

**三条迁移规则**

1. **`_changeHistory` 归位**：现实实现写在 `properties` 顶层（P031 实测 46 条），法律第十九条(六)要求在 `dossier` 内 ⇒ Phase 4 迁移并保留顶层副本指针。
2. **`contact` / `health` 的归宿**：法律第十九条(二)已把「健康状况」并入 `selfProfile`；联系方式（电话/住址）七子卷无独立位置。本规范并入 `selfProfile.contact` 子段 —— **隐私数据只迁移不删除**（业主铁律：亲密/私密信息必须保留）。〔需业主确认子段位置〕
3. **旧 10 模块去向**：`imageTraits`/`personalityPrefs`/`health`/`lifeResume`/`socialCapital`/`familyNetwork` 的有效内容并入 ①②③；原始 JSON 归档 `_deprecated`（**只迁移不删除**）。`memoryAnchors` 由 `boundDocuments` + 记忆侧锚点承接（V2.0 修订摘要第 8 条）。

### 1.3 `edges` 关系网络（法律第二十四条）

| 字段 | 必填 | 说明 |
|---|:--:|---|
| `id` / `source_id` / `target_id` | ✅ | FK → `nodes.id`；禁止自指边 |
| `relation` | ✅ | **必须 ∈ `RELATION_TYPE_DEFS`**（附录 A） |
| `properties` | ✅ | 见下 |
| `created_at` / `updated_at` | ✅ | |

`properties` 规范字段：

| 键 | 说明 |
|---|---|
| `confidence` | 0–1，LLM 综合多轮上下文判定 |
| `source` | `conversation` / `document` / `manual`（取词来源） |
| `created_from` | **溯源主键**：`dialog_group_id` 或 `document_id` |
| `evidence` | 摘要式佐证（≤120 字），**禁止整段对话原文** |
| `known_since` | 时间锚点 |
| `_heat_score` / `_relation_warmth` / `_interactions` | 热力追踪（仅「实体↔用户」边，见 §5.2） |

**建边铁律**
1. 反向边自动建立（按 `RELATION_TYPE_DEFS[type].reverse`），家族边缺反向边视为违规（红线 §三）。
2. `source + target + relation` 三元组唯一（现 `addEdge` 已拦重复）。
3. `confidence < 0.7` 不写边，改存 `PendingItem`（第二十二条）。
4. 写边必须先确认两端节点在册（现 `addEdge` 咽喉已做，禁止绕过）。

### 1.4 关系类型单一真源

- **唯一字典**：`RELATION_TYPE_DEFS`（`src/app/fg/RelationshipTypes.ts`）。
- 其余 5 套词表全部**改为派生**或删除（附录 B-3）。
- **启动断言**：写入白名单 ⊆ DEFS；DEFS 中每个 `reverse` 目标 ∈ DEFS。
- 显示标签只经 `getRelationLabel(relation, isOutgoing)`，禁止 `includes` 模糊匹配（红线 §4.2）。

### 1.5 `type` 扩展说明

`org`（社团/公司/班级）与 `event` 属第四十一条「动态拓展」范畴：
新增类型不修改本法主体，由本规范登记后生效。`org` 节点必须有 `member_of` 边指向 person。

---

## 二、取词来源与采集管线

### 2.1 唯一采集引擎 = **PAE 扩展**（第十四条(2)）

> 🔴 **法律已规定「信息采集唯一合法引擎：PAE」**。因此不新建第二个提取器，
> 而是给 PAE 增加**定时触发**与**文档来源**两种输入通道（第三十五条② 的
> `acquisitionIntegrityGuard` 继续作为其校验器）。

```
输入A：对话组（完整对话组/语义块，非逐句）
输入B：上传文档（.md/.txt/.pdf 个人档案类）
      ↓
  PAE 统一 LLM 语义提取（统一 prompt + JSON schema）
      ↓
  准入门槛判定（§3.1，至少 2 条）
      ↓
  置信分层（≥0.7 入库 / 0.4–0.7 PendingItem / <0.4 丢弃）
      ↓
  三级去重（§四）
      ↓
  写入 nodes + edges + dossier
      ↓
  追加 _changeHistory（第十一条）
```

### 2.2 定时策略

| 通道 | 触发 | 说明 |
|---|---|---|
| 对话组 | 每日 02:00（可配置）扫描**已闭组**对话组 | 每轮上限 N 组，避免 token 与写放大 |
| 文档 | 文档上传/更新事件触发 | 幂等：同一 `document_id + 内容 hash` 不重复提取 |
| 兜底 | 会话空闲期增量 | 仅在无定时任务堆积时执行 |

### 2.3 禁止事项（第三十四条）

- ❌ 逐句/RAG 碎片提取写正式档案（含 `M4Orchestrator.integrateFromEntity` 现行路径）
- ❌ 关系称谓写入 `name` 列
- ❌ 无人工复核覆盖高置信已归档字段
- ❌ 绕过 LLM 直接写档案（脚本/SQL 直写）
- ❌ 无 `_changeHistory` 的写操作

---

## 三、提取规范

### 3.1 实体准入门槛（至少满足 2 条）

1. 与用户有明确交互记录（同一对话组内多轮）
2. 有特征描述（职业/关系/外貌/性格任一）
3. 有持续提及（跨 ≥2 个对话组）
4. 有明确关系（与用户或另一在册实体的关系边）

未达标的**不写 nodes**，只记录在提取器的候选流水（`_changeHistory.operation='候选未达标'`）。

> 🔴 **2026-11-08 更新（ADR-021/022）**：FG 的 `status='candidate'` 观察区与离线 LLM 终审已**物理删除**，
> 不再存在「先写入、后攒证据晋升」的池子。会话内实体的准入改为**写入前取证**（ADR-020 §6）：
> 显式介绍线索 + 原文证据子串校验；未取证不建节点。PAE 通道仍按本节 2/4 条门槛，未达标不落库。

### 3.2 置信分层（第二十二条）

| 区间 | 处理 |
|---|---|
| ≥0.7 | 直接写 `dossier` 正式字段 / edges |
| 0.4–0.7 | 存 `PendingItem`；同一事实独立重复 3 次自动转正；30 天无佐证标记 `expired`（不物理删除） |
| <0.4 | 丢弃（不落库） |

### 3.3 写入前自检（PAE `acquisitionIntegrityGuard` 6 项 + 新增 2 项）

①无空值污染 ②pendingItems 质量 ③无重复 pendingItems ④changeHistory 合规 ⑤completeness 合法 ⑥无孤儿 dossier
+ ⑦**关系类型 ∈ DEFS** ⑧**两端节点在册且有 UUID**

---

## 四、三级去重

| 层 | 规则 | 冲突处置 |
|---|---|---|
| **实体** | ① UUID 精确 → 同一实体；② `aliases` 精确匹配 → 合并（先搬边后置 archived，见第三十三条）；③ 名字不同但语义同一人 → 只记 `PendingItem`，**人工裁决**，禁止自动合并 | 合并写 `_changeHistory`，旧号存 `legacy_ids` |
| **关系** | `source+target+relation` 三元组 | 保留 `confidence` 高者，`evidence` 合并追加 |
| **字段** | 已有正式字段**不覆盖**；新增值只做**合并/追加**（数组追加、时间线追加） | 值冲突 → `PendingItem`，等人工（第二十三条） |

---

## 五、读取规范（与写入结构一一对应）

### 5.1 单一档案入口 `PersonProfileView`

```ts
type PersonProfileView = {
  uuid, name, aliases,                 // 户籍登记表
  basicInfo, selfProfile, socialIdentity,
  lifeMilestones, boundDocuments, relationMap, misc,   // 卷宗
  relations: RelationLabel[],          // edges 派生，带方向
  heat?: { warmth, heatScore },        // 热力（仅用户边）
  completeness,                        // 派生指标
};
```
- **会晤模式与普通模式共用**，消除 P031 P0-1（会晤读 `selfProfile` / 普通读顶层 flat 的分裂）。
- 顶层 flat 字段（`appearance`/`traits`/`occupation`…）**只在迁移期内做兜底**，Phase 5 删除。

### 5.2 单一关系入口 `getUserRelation(entityId)`

- 返回 `{ labels[], warmth, heatScore, source:'edges' }`；**edges 为唯一权威**（第二十四条）。
- 解析「实体↔用户」这一条边，**不扫全部边**（修 P031 P0-3/P0-2：优先级矛盾 + 方向丢失）。
- 返回结构必须携带 `direction: 'out'|'in'`，标签按方向计算。

### 5.3 读取零副作用

- 从所有 `get*` 中移除 `_checkStatusDowngrade`（P031 P0-4：读取会改状态并删边）。
- 状态流转只由**维护任务**与**写路径**触发（第三十条/第三十一条）。

### 5.4 void / 合并实体处理

- `getEntityByUUID` 必须 `status != 'void'` 并跟随 `merged_to`/`legacy_ids` 重定向（第八条(4)、第三十三条）。

### 5.5 密级接入读取（第二十七/二十八条）

| 密级 | 读取规则 |
|---|---|
| 1 公开 | 全部在册实体可读 |
| 2 内部 | 同社群户 + 临时授权 |
| 3 私密 | 仅用户本人与对应关系实体 |

- `PersonProfileView`/`getUserRelation`/`buildEntityContext` 统一接受 `minSecurityLevel` 参数；
  缺省按当前会话主体（用户=3）。
- 越权**静默降级返回空**，并写审计日志（第二十八条(3)）。

### 5.6 字段契约表（原则：**写入方与读取方必须同时存在**）

| 字段 | 写入方 | 读取方 | 状态 |
|---|---|---|---|
| `basicInfo.gender/birthYear` | PAE | `PersonProfileView` | ✅ |
| `selfProfile.*` | PAE | 会晤+普通模式 | ✅（现状 2.1% 填充，待 PAE 定时补） |
| `selfProfile.feminineDetails` | PAE | 会晤（`appearance=true` 时） | ✅ |
| `socialIdentity.timeline` | PAE | 会晤社会身份 | ⚠️ 现填充 2.6% |
| `lifeMilestones` | PAE / 状态变更 | 会晤里程碑（前 6 条） | ⚠️ 现 1.5% |
| `boundDocuments` | 多人会晤纪要 | `getMeetingsForPerson` | ⚠️ 触发条件极少 |
| `_changeHistory` | 全部写路径 | `getProfileTimeline`（现状 0 调用 → Phase 2 接治理 API） | ⚠️ |
| `misc._household/_socialGroups` | 户籍路由 | 户籍路由 | ✅ |
| `edges.properties.confidence/evidence/source` | PAE / 手动 | `getUserRelation` / 治理视图 | 🕳 新增 |
| `security_level` | 建节点 | §5.5 密级过滤 | 🕳 新增（现死字段） |
| `family_gene/social_group_genes` | BFS | 户籍视图 / 分户统计 | 🕳 半接线 |
| `circle_level` / `tags` | — | — | ❌ 删除 |

---

## 附录 B：Phase 5 删除清单（逐项，不留兼容层）

> 全部删除均在**停服窗口**执行，且必须先跑双库备份 + 迁移校验 + 72h 回滚窗口（第三十九条）。

### B-1 旧写入路径（法律禁止或已失效）
- `M4Orchestrator.integrateFromEntity` 的**逐句 RAG 提取写档案**分支（第三十四条(5)）
- `FGRelationExtractor`（产出恒 0）
- `HumanWorldGraph.enhanceFromConversation` + `hwg_persons/relations/events/profile_snapshots/bridges` 五表
- `FamilyGraph.integrateOrgRelation`（零调用）
- `MockLLMProvider.rawCall` 返回 `persons` 非 `relations` 的坏降级路径
- `scripts/` 下 20+ 直写 `nodes/edges` 的批量脚本（改为调用 PAE）

### B-2 死字段/死列
- 列：`nodes.tags`、`nodes.circle_level`
- 列（**仅在业主决定放弃密级/分户时**，否则保留）：`security_level`、`family_gene`、`social_group_genes`
- 顶层 flat：`appearance`/`body_features`/`traits`/`occupation`/`description`/`style`/`personality`/`interests`/`age`/`relations`/`addressingChain`/`_autoProfileGenerated`/`_historyArchived`/`_uuid`
- 子卷（迁入后归档 `_deprecated`，不物理删除）：`lifeResume`/`socialCapital`/`familyNetwork`/`imageTraits`/`personalityPrefs`/`health`

### B-3 词表分裂（5 套 → 0）
- `FGRelationExtractor.WHITELIST`
- `HumanWorldGraph.KINSHIP_MAP`
- `RelationLabels.DIRECTED_FAMILY_LABEL` / `SOCIAL_LABEL`（保留 `getRelationLabel()` 外壳，内部改读 DEFS）
- `EntityContextBuilder.SOCIAL_LABELS` / `PARENT_RELS` / `SIBLING_RELS` / `EXT_FAMILY_RELS` / `EXCLUDE_RELS`
- `FamilyGraph.KINSHIP_MAP` / `REVERSE_RELATION` / `SOCIAL_REVERSE` / `ALL_REVERSE` / `SOCIAL_LABEL_CN`（改读 DEFS）

### B-4 读取侧死方法
`getCalculatedAge` / `getProfileTimeline`(接治理 API 后保留) / `setRelationWeights` / `getRelationWeights` /
`updateInteractionFreq` / `updateEmotionalIntensity` / `getEffectiveIntimacy` / `lockWeight` / `unlockWeight` /
`autoAssignCircle` / `batchAutoAssignCircles` / `setCircleLevel` / `getCircleLevel` / `getPersonsByCircle`

### B-5 数据清理（**仅限边与索引，不动节点与卷宗**）
- 孤儿边（端点不存在）
- 重复边（同三元组，保留 `confidence` 最高者）
- `relation` 不在 DEFS 的边：**先迁移映射再删**（附录 A 映射表）
- void/已合并节点参与的边

---

## 附录 A：`RELATION_TYPE_DEFS` 补齐清单（Phase 1 执行）

> 方法：全仓 6 套词表 + DB 实际值 + 基因码列表取并集 = **66 种**，DEFS 现有 **44 种**，
> 缺失 **32 种**（剔除脚本误配 7 项）。处置分三类。

### A-1 必须补定义（在用、有语义，法律未禁止）

| 类型 | 建议 category | 建议 reverse | 依据 |
|---|---|---|---|
| `elder_sister_of` | family | `younger_sister_of` | FG 白名单在用；DB 4 条边 |
| `younger_sister_of` | family | `elder_sister_of` | 同上 |
| `elder_brother_of` | family | `younger_brother_of` | RelationLabels/基因码在用 |
| `younger_brother_of` | family | `elder_brother_of` | 同上 |
| `niece_of` | kinship | `aunt_of`+`uncle_of` 二义 → 用 `nibling_of` 中转 | RelationLabels/基因码 |
| `nephew_of` | kinship | `nibling_of` | 同上 |
| `grandparent_of` | kinship | `grandchild_of` | 多处反向目标缺失 |
| `sister_of` | family | `sibling_of` | ECB 在用 |
| `brother_of` | family | `sibling_of` | ECB 在用 |
| `lover_of` | social | `lover_of` | **正式身份**（业主 2026-10-06 口径）；DB 10 条边 |
| `lives_in` | other | `residence_of` | DB 9 条；`REVERSE_RELATION` 已有 |
| `residence_of` | other | `lives_in` | DB 7 条 |
| `close_to` | other | `close_to` | `REVERSE_RELATION` 在用 |
| `has_appearance` | other | —（单向特征边） | DB 61 条（`addFeatureEdge` 产物） |
| `has_feature` | other | — | ECB EXCLUDE_RELS |
| `patient_of` | social | `doctor_of` | DEFS `doctor_of.reverse` 指向它 |
| `org_of` | social | `member_of` | 组织关系（第五条社群户） |
| `employer_of` | colleague | `employee_of` | 词表在用 |
| `employee_of` | colleague | `employer_of` | 同上 |
| `consultant_of` | colleague | `server_of` | 词表在用 |
| `server_of` | colleague | `consultant_of` | 多处反向目标 |
| `vendor_of` | colleague | `vendor_of` | 词表在用 |
| `investor_of` | colleague | `investor_of` | 词表在用 |
| `supplier_of` | colleague | `supplier_of` | 词表在用 |
| `competitor_of` | colleague | `competitor_of` | 词表在用 |
| `stranger_of` | social | `stranger_of` | 词表在用 |
| `fellow_of` | social | `fellow_of` | 词表在用 |
| `operated_by` | social | `operated_by` | 基因码 socialMap 在用 |

### A-2 补齐缺失的反向目标（DEFS 内 `reverse` 指向但未定义）

`step_child_of`、`child_in_law_of`、`fan_of`、`org_of`、`server_of`、`grandparent_of`

### A-3 迁移/删除（垃圾或应合并）

| 现值 | 处置 |
|---|---|
| `其他`（DB 7 条） | 迁移为 `acquaintance_of` 或人工裁决后删 |
| `has_feature` | 并入 `has_appearance` 或 `selfProfile` 字段 |
| `friend_of` ↔ `close_friend_of` | 保留两者，`close_friend_of` 已在 DEFS |
| `sister_of`/`brother_of` | 建议**归并到 `sibling_of`**（方向信息由 edges 自带），避免 12 种同义家族类型 |

### A-4 断言（启动时校验）

```ts
// ① 写入白名单 ⊆ DEFS  ② 每个 reverse ∈ DEFS  ③ 每个 DEFS 类型有中文标签
```

---

## 附录 C：Phase 1–5 任务书草案

| Phase | 内容 | 关键验收 |
|---|---|---|
| **1 规范落地** | DEFS 补齐（附录 A）+ 启动断言 + 词表派生化 | 断言全绿；5 套词表改为读 DEFS |
| **2 采集改造** | PAE 扩展定时 + 文档来源 + JSON schema；准入门槛 + 置信分层 + 三级去重 | 每日定时跑通；`_llm` 边 `confidence` 落库 |
| **3 读取统一** | `PersonProfileView` + `getUserRelation` + 读取零副作用 + void 重定向 + 密级接入 | 会晤/普通模式字段一致；读取不再改状态 |
| **4 数据迁移（停服）** | 停服 + 双库备份 → candidate→placeholder / void→archived / flat→dossier / `_changeHistory` 归位 / 未定义边迁移 → 迁移校验 → 重启 | 迁移报告 + 72h 回滚窗口 |
| **5 旧规则清除** | 附录 B-1~B-4 逐项删除（B-5 数据清理同窗口） | 0 残留；fgIntegrityGuard 10 项全绿 |

---

## 附录 D：验收判据（供豆包使用）

1. 启动断言：`relation ∉ DEFS` 的写入被拒绝（可注入脏值验证）。
2. 会晤与普通模式对同一实体的 `PersonProfileView` 字段集合**完全一致**。
3. 读取 200 次不改变任何 `status`/`edges` 计数（零副作用）。
4. `getEntityByUUID(旧合并编号)` 重定向到当前 TXS-ID。
5. 密级=3 的档案在未授权会话中**不可见**，且有审计日志。
6. 迁移后 `integrity_check=ok`，`social_group_genes` 非空率 100%（第三十五条⑩）。
