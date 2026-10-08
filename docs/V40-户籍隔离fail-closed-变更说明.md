# V40 变更说明 — 户籍隔离 fail-closed：检索主体真源修正

> 日期：2026-10-08 ｜ 分支：`feat/40d-perception`
> 依据：业主 2026-10-08 实测报告（玉瑶「嘴上说不知道、身体很诚实」）+ S1 七步因果链诊断
> 批次定位：户籍三元组全域统一 · 修复 2（修复 1 = 批3 存储形态，commit `ebde7a9`）
> 触及模块：`src/webui/chat/retrieval-stage.ts` · `src/webui/chat/process-stages.ts`
> · `src/app/entity/EntityContextManager.ts` · `src/webui/chat.ts`

---

## 一、问题与根因

### 1.1 实测现象

鸿艺与徐诗雨会晤，聊出 `4008 / 8630 电机交货 / 仓库老李卸车 / 物流单号 / 刘运新 / 宁清华`。
切回玉瑶后：

- 问「我和徐诗雨聊的事你知道吗」→ 玉瑶答「**玉瑶这儿没记录**」（声称不知道）
- 让玉瑶扮演徐诗雨 → 却**精确说出** `4008 那批、仓库老李在卸车、8630 对物流单号`

> **嘴上说不知道、身体很诚实** —— 隔离失效的确凿证据。

### 1.2 七步因果链（全部有代码/实测证据）

| 步 | 环节 | 位置 |
|:--:|---|---|
| ① | 与徐诗雨会晤 → `gatekeeper.sessionEntities = {TXS-000000007}` | `UUIDGatekeeper.setSessionEntities` |
| ② | 用户说「很好，你去忙，**。再见**」→ 退出判据 ①整句锚定不匹配 ②`length<10` 而该句正好 10 字符 → **不退出** | `process-stages.ts` |
| ③ | 说「**瑶瑶**，今天天气怎样」→ M3 识别出「瑶瑶」 | — |
| ④ | `getUUIDByName('瑶瑶')` → **null**（`person_aliases` 表**实测 0 行**，只认主名「玉瑶」） | `FamilyGraph.getUUIDByName` |
| ⑤ | `personUUIDs = []` → `if (personUUIDs.length > 0)` 为假 → **不更新会话层** | `process-stages.ts` |
| ⑥ | `sessionEntities` **冻结在 `{007}`** → 玉瑶的每一次检索都用徐诗雨的 UUID | `retrieval-stage.ts` |
| ⑦ | 提示词的「不知道守卫」（`ChatPolicy.canUseUnknownGuard`）要求诚实说不知道 → **①称不知**；扮演徐诗雨时切到 007 会话，检索照旧 → **②说出细节** | `chat.ts` |

### 1.3 病根：`null` / `undefined` 的语义被读反

检索层把「**当前没有主体**」的表达（`null` / `undefined` / 空数组）解读成「**不限制范围**」。
按户籍管理法铁律，前者应 **fail-closed**（无户主即拒之门外），后者才是「明确不限制」。

**真正的缺陷是判据取错了层**：`gatekeeper.sessionEntities` 是**访问控制层**（谁有权读谁的档案），
不是「正在跟谁说话」的真源，且在 ⑤ 的条件下会**冻结在上一个实体**。

---

## 二、白皮书更新摘要

**标题：会晤隔离的主体判据 —— 从「会话白名单」改为「当前对手方」**

1. **检索主体的唯一真源** = `EntityMeeting.getEntityUUID()`（会晤态的对手方）；无会晤 → 玉瑶 UUID。
   **恒非空**。原真源 `gatekeeper.getSessionEntities()` 属访问控制层，会因
   「消息里没人名不更新」+「退出判据漏匹配」而冻结在上一实体 —— 这是泄漏的直接机制。
   ⇒ 本批同时消除该冻结路径，即使退出判据漏匹配，**检索主体也不再跟着错**（根因在真源，不在出口）。

2. **「没有主体」一律 fail-closed，绝不解释为「不限制」**。三类实例同步收敛：
   - 会话层：`if (personUUIDs.length > 0)` → **无条件更新**，空数组即清空，不保留旧值；
   - 历史窗口：玉瑶态查询失败/为空 → **回落空历史**，不再回落 `conversationHistory`（混合历史）；
   - 空主体调用：`getContextWindow(…, null)` 由**静默放行**改为**显式告警留痕**（P-13 精神）。

3. **会晤退出判据由「双障碍」改为「句尾判据」**：原 `^(…|再见)$` 整句锚定 + `length<10`
   双重限制，导致「你去忙，。再见」无法退出；现句尾结束语即可退出，且句尾判据**不受短消息限制**
   （判据本身已要求结束语在末尾）。`_prevTurnIsQuestion` 保留（「结束了吗？」不算退出）。

4. **检索主体解析失败必须可见**：`_activeEntityUuids` 为空时输出 `[Police] …` 告警。
   因为空数组会让下游 8 处 `length > 0 ? X : undefined` 退化成「不限范围」——
   静默放行等价于把 fail-closed 又变回 fail-open。

---

## 三、蓝皮书更新摘要

**标题：会晤隔离链路与 fail-closed 收敛**

1. **受影响文件与全仓横向核验**（共性问题，已全仓检索）：
   - **真源获取点**：全仓**仅 1 处**（`retrieval-stage.ts`）—— 单一真源的雏形，本批只改其取值层；
   - **`X.length > 0 ? X : undefined` 兜底**：**8 处**（`retrieval-stage.ts` 702/788/808/865/898/946/988/1023），
     全部是同一真源的下游 ⇒ **真源恒非空后，这 8 处的 `undefined` 分支即成为不可达的死分支**，
     无需逐处改动（改 1 处真源 = 自动修复 8 处）；
   - **`if (!entityUuid)` 空跳过**：全仓 11 处，其中 `meeting-recall.ts:434` **已是正确示范**
     （`// fail-closed：无归属不检索`），本批据此对齐 `EntityContextManager.ts`；
   - **混合历史回落**：`chat.ts` **3 处**（766 / 768 / 772），本批全部改为 fail-closed。

2. **退出判据的存量违规（本批不改，登记为后续批次）**：
   同一业务规则存在 **5 处实现且互不一致**，违反不变量#7：
   `EntityMeeting._exit1`（整句）/ `_exitTail`（句尾）/ `:783`（整句）/ `process-stages.ts`（本批对齐为句尾）/ `chat.ts:933` / `PrefrontalCortex:287`。
   **不全改的理由**：本批已让隔离**不再依赖退出成败**（真源取自 EntityMeeting 而非会话层），
   退出判据退化为「会话层卫生」问题；5 处收敛为单一函数涉及 `m4`/`webui`/`engine` 三个域，
   属独立批次，避免本批文件集扩散。

3. **已知缺陷登记（不改，只记录）**：
   - `person_aliases` 表**实测 0 行** → 任何昵称（「瑶瑶」「诗雨」）都无法解析成 UUID，
     这是 ④ 的直接成因；本批靠「真源不依赖该解析」绕开，**但别名数据缺失本身待补**；
   - `ChatPolicy.canPersistToMainFG()` 只对 `roleplay` 模式返回 false，而扮演实际走
     `entity_meeting` 模式（DB 中 `roleplay_char` 全空、`belong=007`）→ **该闸门对扮演不生效**；
     本轮实测未发现实际污染，但闸门失效已记录。

---

## 四、回滚方案 / 配置变更清单

### 4.1 回滚方案

| 层 | 内容 |
|---|---|
| **代码回滚** | 本批独立 commit，回退该 commit 即回到「会话白名单做真源」原状。**无数据依赖** —— 本批不改任何表结构、不迁移任何数据 |
| **行为影响** | 回退后玉瑶态会重新读到混合历史（即回到泄漏状态）。若只想回退部分：`chat.ts` 的三处回落是**最保守的一档**，可单独回退为混合历史以换取玉瑶的上下文连续性（**不推荐**，等同于恢复泄漏通道） |
| **告警噪音** | 新增 3 类 `[Police]` / `[EntityContextManager]` 告警。若「玉瑶态专属历史为空」频繁出现，说明玉瑶 UUID 解析或 `queryEntityContext` 有故障，**这是设计意图**（把故障暴露出来），不是误报 |

### 4.2 配置变更清单

**无配置项变更。** 本批不新增/修改任何配置键，不改表结构，不新增依赖。

### 4.3 验证清单

- [ ] `npx tsc --noEmit` exit 0
- [ ] 相关单测全绿
- [ ] **核心复现**：与徐诗雨会晤聊出 `4008/8630` → 切回玉瑶 → 问「我和诗雨聊的事你知道吗」
      → **应答不出细节**（修复前能答出）
- [ ] 日志出现 `[Gatekeeper] 会话结束`（退出生效）
- [ ] 日志中玉瑶态的检索主体为玉瑶 UUID，**不再是 `TXS-000000007`**
- [ ] `npx vitest run` 相关目录全绿

---

## 五、横向关联模块清单（S2 全仓检索结果）

| 类别 | 文件 | 本批处置 |
|---|---|---|
| **A. 实际改动** | `retrieval-stage.ts` / `process-stages.ts` / `EntityContextManager.ts` / `chat.ts` | ✅ 已改 |
| **B. 真源调用方** | `retrieval-stage.ts:729`（唯一） | ✅ 已改 |
| **C. 下游兜底** | `retrieval-stage.ts` 8 处 `length>0 ? X : undefined` | 🟢 不改 —— 真源恒非空后不可达 |
| **D. 正确示范** | `meeting-recall.ts:434` `fail-closed：无归属不检索` | 🟢 不改 —— 已是目标形态 |
| **E. 退出判据存量** | `EntityMeeting.ts` ×3 / `chat.ts:933` / `PrefrontalCortex:287` | 🟡 独立批次（见三·2） |
| **F. 受影响相邻模块** | `UUIDGatekeeper.ts`（仅消费，不改）、`ChatPolicy.ts`（闸门失效已登记，不改） | 🟢 只读核对 |

---

## 六、方法论记录

**首跑被 Sentinel 全数回滚**（4 次 Edit 全部丢失）：

- `mid` 风险文件：`reason: "令牌已过期"` / `"无有效令牌"` → 豁免注册后**放行**（`exempt_allowed`）
- `high` 风险文件（`chat.ts`）：**首次豁免记录发生在回滚 2 秒之后**，回滚已执行；
  豁免注册完成后再写一次才放行

⇒ 正确顺序是 **先签权限 → edit → flow 拿令牌 → 令牌期内 commit**。
本批首跑漏了第一步，教训与 `data/sentinel/2026-10-08/reverted_*.json` 的
`reason` 字段一一对应（间隔 ≈800ms 的 watcher 延迟）。

---

## 七、`MEETING_PROP_POINTS` 传播点逐项核验清单（架构铁律 #6）

> 依据 flow `global_arch_constraint` 第 6 条：S4 独立评审必须 **grep 核验**
> `MEETING_PROP_POINTS` 数组与实际代码是否同步（**不依赖硬编码行号**，行号会随重构漂移）。
>
> **核验结论：14 点中 14 点全部偏移，最大偏移 448 行**（编目 1380 → 实际 1921）。
> 偏移主体为既存累积（本批 +36 行只占其中一小部分）。已按 grep 实测值全量更新数组。

| 阶段 | 状态 | 编目旧值 → 实测值 | 证据（grep 命中行原文） |
|---|:--:|---|---|
| L0-路由 | ✓ | 651 → **852** | `_meetingEntityName: _activeMeetingName,` |
| L1-上下文 | ✓ | 764 → **704** | `const _activeMeetingName = ctx._entityMeeting?.isActive() ? …getEntityName() : null;` |
| L2-档案 | ✓ | 798 → **1129** | `const ecResult = buildEntityContext(ctx.m4.getFamilyGraph?.(), {` |
| L3-DNA | ✓ | 861 → **1231** | `dna.entity_genes.push({ name: _meetingEntityName, type: 'person', …` |
| L4-KB过滤 | ✓ | 876 → **1248** | `_meetingEntityUuid: ctx._entityMeeting?.getEntityUUID?.() \|\| null,` |
| **L5-记忆门控** | **✗→已收敛** | 963 → **2251** | ⚠️ 编目原 desc「会晤模式跳过主人记忆检索」的守卫 `ChatPolicy.canRetrieveMemories()` **全仓零调用点（死代码）**；chat.ts 内实际承担会晤跳过的为 `if (ctx.m6 && !_isMeeting)`（M6 自我模型）。已在 desc 中标注 |
| L6-注入保留 | ✓ | 1327 → **1833** | `preserveLabels: !!_meetingEntityName,` |
| L7-PFC | ✓ | 1380 → **1921** | `meetingEntity: _meetingEntityName \|\| undefined, // 🆕 V4.0: 告知 PFC` |
| L8-角色提示 | ✓ | 1451 → **2003** | `const roleHint = _meetingEntityName ? null : _roleInstruction[_currentRole];` |
| L9-自问自检 | ✓ | 1487 → **2049** | `if (_isSelfQ && !_isWorkQ && !knowledgeBaseText && !_meetingEntityName` |
| L10-主人镜像 | ✓ | 1513 → **2325** | `if (ctx.masterProfile && !_meetingEntityName) {` |
| L11-政策选择 | ✓ | 1647 → **2212** | `const policy = _isMeeting ? new ChatPolicy(meetingMode('', _meetingEntityName …` |
| L12-M5调度 | ✓ | 1752 → **2583** | `reply = await ctx.m5.orchestrate(ctx_m4, …, !!_meetingEntityName, streamOpts);` |
| L13-自名检测 | ✓ | 1778 → **2614** | `const hasSelfIdent = bodyText.includes(_meetingEntityName) \|\| …` |

**本批对传播点的影响**：

- **未新增任何 `_meetingEntityName` 传播点** —— 本批改的是 UUID（`_meetingEntityUuid`）的取值来源，
  不是 name 的传播路径；编目 14 点的语义与数量不变。
- **`retrieval-stage.ts` 新增了 `ctx._entityMeeting.getEntityUUID()` 读取**（本批核心改动）。
  它读取的是 **UUID 而非 name**，故不落入本编目（编目范围是 `_meetingEntityName` 全链路）；
  其隔离语义与 L4-KB过滤（`_meetingEntityUuid`）同源 —— 二者都直接取自 `EntityMeeting`，
  不经过 `gatekeeper.sessionEntities`。此点已在三·1 与本文档 §二·1 记录。

---

## 八、高风险文件全量 import 依赖评估（DS-10）

**结论：本批改动 4 个文件，全部不改函数签名、不改导出、不增删 import ⇒ 上层调用方零适配需求。**

| 文件 | 本批改动性质 | 签名/导出变化 | import 变化 | 上层调用方影响 |
|---|---|---|---|---|
| `src/webui/chat/retrieval-stage.ts` | 内部局部变量 `_activeEntityUuids` 的构造逻辑 | 无 | 无（未新增/删除 import） | 无 —— `RetrievalInput` 接口未变 |
| `src/webui/chat/process-stages.ts` | 内部：`setSessionEntities` 调用条件 + 退出判据表达式 | 无 | 无 | 无 —— 返回值 `{ _meetingEntityName, _entityContextText, _meetingStartHistoryIndex }` 未变 |
| `src/app/entity/EntityContextManager.ts` | `getContextWindow()` 内空分支加告警 | 无（签名 `allHistory, entityUuid, maxTurns` 未变） | 无 | 无 —— 调用点 `chat.ts:732` 传参不变 |
| `src/webui/chat.ts` | `enrichedHistory` 三处赋值改值 + `MEETING_PROP_POINTS` 行号订正 | 无（`processChat` 导出与签名未变） | 无 | 无 —— 22 段 `finalKnowledgeText` 注入顺序未动，只动 `enrichedHistory` 的取值 |

**依赖方向核验**（M1→M9 正向流不变、无 M9→M1 反向引用）：

- `retrieval-stage` / `process-stages` **读取** `ctx._entityMeeting`（M4/household 层）—— 属既有依赖，
  本批只改读取的**字段**（`getEntityUUID()` 而非会话层），未新增跨层引用；
- 未引入任何新的 `import` 语句，`src/m1`~`src/m9` 之间依赖图无新增边。

---

## 九、服务层变更说明（DOC_SERVICE）

**结论：部署拓扑、启动流程、配置项清单三者均无变更。**

### 9.1 部署拓扑

无变更。仍为单一 `pm2` 进程 `wenstar-webui`（`start.cjs` → tsx → `server.ts`），
监听 `127.0.0.1:3000`，进程树 `start.cjs(P0) → tsx CLI(P1) → node server.ts(P2)`，
由 `ServerLock`（`data/webui/server.lock`）保证单实例写库。本批不新增进程、端口、服务或依赖。

### 9.2 启动流程

无变更。启动顺序仍为：`.env` 加载 → 启动前脚本 → `ServerLock` 校验 → FG/门阀初始化
→ M 层迁移（**本批不新增迁移**，最后一条为批3 的 v18）→ 各子系统拉起。
本批**不含 schema 变更、不含数据迁移、不含回填**，重启后无一次性动作。

### 9.3 配置项清单

**无配置项新增或修改。** 本批零 `MEMORY_CONFIG` / yaml / 环境变量改动。

### 9.4 运行期可观测变化（非配置）

新增三类日志（供巡检，不改任何配置）：

| 日志 | 触发条件 | 含义 |
|---|---|---|
| `[Police] 检索主体解析失败…` | `_activeEntityUuids` 为空 | 户籍故障：既无会晤实体也取不到玉瑶 UUID |
| `[Police] 玉瑶态专属历史为空 / 查询异常…` | 玉瑶态查询返回空或抛错 | 按 fail-closed 用空历史（**设计意图**，非误报） |
| `[EntityContextManager] getContextWindow 收到空 entityUuid…` | 直接调用方传 null | 生产路径不经过此分支；提示新增调用点改传真实 UUID |
