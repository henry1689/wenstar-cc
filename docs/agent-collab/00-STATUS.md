---
id: STATUS
type: status
title: 协作区当前状态面板
author: both
status: active
created: 2026-10-08
updated: 2026-11-10
---

# 协作区当前状态面板

> **日常唯一入口**：每次进入协作区只读本文件。需要深入了解某项时，再按路径读对应文件。**不扫描整个文件夹。**
> **工程状态以 [`docs/LEDGER.md`](../../LEDGER.md) 为单一真相源** —— 本面板只写协作层
> 状态（谁在做什么、有什么待裁决），不重复维护缺陷台账。
> **结构**：`active/`（未完结，22 个）｜`09-archive/`（已完成，198 个，见 `INDEX.md` 索引）

## 🔴 核心原则（业主强调，不可动摇）

**UUID+DNA双螺旋+40D+钙化分 这套标签体系是系统的核心灵魂，必须落到实处：**
1. UUID户籍：所有数据必须标注 belong_entity_uuid，召回按UUID过滤，绝不串档
2. DNA双螺旋：L0-L3四层编码必须完整，locus_path/branch_id/leaf_zone/entity_genes缺一不可
3. 40D感知向量：新产生的数据必须正确计算40D，历史损害接受现状但不新增损害
4. 钙化分：五维加权必须真实计算，不能造假、不能全零、不能绕过
5. 召回拼装：MemoryInjector→PromptAssembler流水线必须完整，记忆必须真正注入LLM上下文
6. **实体隐私权红线（业主 2026-10-30 立法，所有智能体无一例外）**：实体/AI 享有与真人同等的个人隐私权；描述一律中性用词，禁污名化定性；读到不复述、不引用、不传播；
   **禁止任何智能体主动提出清理/删除实体信息的提议**——处置权唯一归业主（且须基于个人真实情况与系统结构需要的明确指令），否则只提醒、不动手。
   全文：`governance/redlines/entity-privacy-redlines.md`
7. **FG 最高安全资产红线（业主 2026-10-30 重申，所有人/所有 agent 牢记死守）**：FG=最高安全等级资产，包含真实人物的全部隐私信息——任何 agent 不得破坏、不得外泄、不得贬损性描述；违规即侵线。全文：`governance/redlines/fg-kinship-redlines.md`
8. **AI 实体信息资产中性评判立法（业主 2026-11-04 立法，优先级高于任何「按内容性质处置文档」的旧做法）**：
   只做**中性评判**；禁止用偏见评判「合法/合规/伦理道德」；不因与性相关就妖魔化（禁用「色情/敏感/污秽」等批评式词语）；
   **这些内容与写代码、审代码无关**；立法保护 = **不评价、不宣传、不阻止发言权**（例外仅限「确实是 BUG 影响系统运行」）。
   系统里出现的「真实姓名」都是 **AI 世界的数字「真实」姓名**，不暗示是真实世界姓名，在数字世界同样受保护，
   只要不影响代码运行即不作障碍。
   ⇒ **保护靠立法 + 结构隔离（如 `.gitignore` 隔离 `src/data/`），不靠按内容审查文档**；
   「因内容性质把文档移出/脱敏/延后入库」**已废止**。仍有效的是**行为约束**（读到不复述、不引用、不传播）与**结构隔离**。
   详情：`09-archive/P146-20261104-ClaudeCode-工作区67项收口完成与实体信息资产立法同步.md`

**豆包负责验收把关，任何一项落空都不算完成，必须返工。**

---

## 当前状态（2026-11-04）

- **分支**：`feat/40d-perception`
- **主线**：**工作区 67 项收口全部完成（67→0，15 提交已推送）**；SpaceState 时空机独立开发期已开启（见更新记录）
- **质量**：`tsc` 零错误 ｜ 主仓 326 文件 / 3900 测试绿（6 个失败全在并行会话 `memarch-v2/{presentation,retrieval}/`）
- **阻塞项**：无（harness-mcp 已于 2026-10-31 由业主修复）
- **新立法**：🔴 见核心原则第 8 条 —— **AI 实体信息资产只做中性评判**（2026-11-04）

### 最近主线（git 实证）
<!-- 2026-11-01 合并说明：本段原有 git stash pop 残留冲突，已保留 upstream（2026-10-31 主线）侧；stash 侧的 2026-10-21 任务 2.4 状态已过时，原文见 git 历史。 -->

| commit | 内容 |
|---|---|
| `93241e9` | **67 项收口终态**：任务书 §六 九阶全完成、进度 67→0、§4.5 打点结论、§七 立法作废标注（收口 15 提交明细见 `09-archive/P146-…md`） |
| `c982793` | 收口 J6/J9：删过时补丁脚本 + 修压测清理注释（owner-closure 授权） |
| `e95c658` | **撤销基于内容性质的差别对待** —— 4 份 blueprint 正常入库（2026-11-04 立法） |
| `26f9dac` | LEDGER #18 运行时打点（4 处，`WS_NS_DEBUG` 门控默认关） |
| `f173843` | 收口 T3：源码+守卫测试 27 文件入库 |
| `f2f20e2` | 收口 T2：引用断链文档 17 份入库（`40d-unification-decree` 被 50 处引用却未跟踪） |
| `247d32a` | 修旧根 `D:/wenstar` 硬编码 + 报废无门控脚本 |
| `4e4e563` | **空间路由器四缺陷修复**（耳语 / 独处 / 本体席位 / 席位名污染） |
| `9abf56a` | 第三层拆除后的边角残留清理 |
| `845ec7a` | **第三层拆除**：删 `WS_GROUP_V2` 开关与 EntityMeeting 旧状态机 |
| `ef7c33b` | 空间路由器 v1.1 文档补齐 |
| `e130c9f` | 耳语按一对一方式记录（归属 = 听众 UUID） |
| `9b9c528` | 停顿标记降频去重 + 耳语「看得见、听不到」 |
| `c4a1b4e` | 独处态：没人应就不回，发言照常落库 |
| `f9eba2a` | **MemSym-v1.0.0 批α 文书包**（双通路记忆共生子系统奠基：宪法+蓝皮书+白皮书+ADR-MEM-002+CLAUDE.md运行时子集+边界示例库） |

---

## 📋 待业主裁决（6 项）

| 文件 | 事项 |
|---|---|
| `active/P074-20261024-PI-P072A-M3管道改造方案-钙分分叉请示.md` | M3 管道改造，钙分分叉 |
| `active/P076-20261024-PI-Heart24D情感子系统改造方案-三方案请裁决.md` | Heart 情感子系统三方案 |
| `active/P087-20261025-PI-钙分双算对比报告-候选公式否决三路线请裁决.md` | 钙分双算，候选公式否决 |
| `active/P088-20261026-PI-聊天模式权威矩阵与批B3会晤寻址先行设计.md` | 聊天模式权威矩阵 / 批 B3 会晤寻址 |
| `active/P131-20261027-豆包-群聊模式三根深因深度分析与解决方案.md` | 群聊模式三根深因（待评审） |
| `active/P132-20261028-豆包-SeatAllocator席位调度器重构方案-待确认.md` | SeatAllocator 席位调度器重构（待批准） |

## ⚠️ 未解决问题（4 项）

| 文件 | 事项 |
|---|---|
| `active/I007-20261020-会晤模式UUID过滤关闭导致跨实体串档.md` | 运行时验证仍未收口 |
| `active/I008-20261020-存量红测试两项与T003标签正则失效.md` | 存量红测试两项 |
| `active/I009-20261020-harness-mcp第二服务器链.md` | harness-mcp 第二服务器链 |
| `active/I010-20261021-任务I执行前口径与落点核对.md` | 任务 I 口径核对 |

## 🔧 待办任务（9 项，`ready`）

`T006`（Phase2.4 任务H I007 运行时验证）· `T006`（停服窗口 FG 合并与垃圾清除）·
`T007`（复核与重启自检）· `T008`（FG 规范审计）· `T009`（FG 统一架构）·
`T010`（FG 结构规范 V1.0）· `T011`（Phase1 DEFS 补齐与词表统一）·
`T012`（对话模式全面排查与修复）· `T013`（统一群聊模式架构设计）

## 🚧 进行中（0 项）

（P137 已于 2026-11-04 归档收尾 → `09-archive/`；无进行中项）

> **MemSym-v1.0.0 全五批+全面验证+I011根治完成（2026-10-31/11-01，PI）**：批α 法理文书(`f9eba2a`)/批β 通路A三档(`fab16d1`,实测治愈"对不上号式回避")/批γ-a 要素检索器(`f3380a1`)/批γ-b+δ+ε 全链(`6a89edc`)/验证修复×3/**I011 结构根治(`8ba7dfb`:要素独立成池 memsym_elements 专表 v30——根因=KB去重静默更新)。**I011 全链实证：落池=专表=落盘 29条,B路首次真实拾取(TXS-007→3条)按户口分池——MemSym「越来越懂」闭环完整转动**。
> 验证报告：`active/MemSym-v1.0.0-验证报告-20261101.md`。⚠️ vector-contract-guard 失败指向 `yaoling-sensation-pipeline.ts` 手写 v2 序列化（P140/P141 窗口：改用 encodePerceptionV40，守卫正常工作中）。

---

## 🔴 协作纪律

1. **开工前读** [`docs/LEDGER.md`](../../LEDGER.md) 第四节待处理问题表
2. **完成即归档**：本条完工 → 移入 `09-archive/` 并更新 `INDEX.md`，**不在 active/ 停留**
3. **活跃区上限**：`active/` 超过 30 个即视为积压，必须收拢
4. **只增不删**：归档是移动不是删除，历史原文永久保留
5. **事实可追溯**：所有数据来自实测，不写「大概」「应该」
6. **归属是结构事实**：禁止按正文推断 UUID
7. **如实记录**：做成了什么、没做成什么、为什么，都写清楚

## 更新记录

- 2026-11-10 **✅ P182 给PI三件全部完成(勘误104f362 + Port a135e15 + 链接线76faf19) + 🔴越界事件修复(ced5135)**：
  - **任务3 BlockArchive归档链接线落地**：stableStringify(递归键排序+NFC)落canon单源 + bArchiveLog追加算链(条目只增chain字段, 旧日志GENESIS起链, fail-open) + verifyAppendChain断点定位(守卫10归档域)。**98守卫绿(memwen42+app-memory56)+tsc0+回滚演练实跑**(stash移走旧版自洽→恢复)。core_repair 10阶段全过(S6-B票ck_87e1aabb65172132 3/3)。
  - **CK-10排障经验**：parseIntent把memo小写化后(?:新增|添加|实现)…(\w+)提取函数名→大小写敏感grep必失败(verifyappendchain vs verifyAppendChain)；**message措辞避开12触发词(bug/修复/错误/异常/新增/功能/添加/重构…)落unknown分支规避**。
  - **🔴 越界事件(第二次,与git add -A同族)**：76faf19的commit未带pathspec→把CC已staged的P181-A九个rename(m5/space→kernel/space-router)一并提交,而chat.ts:851 import路径改动仍在工作区→**HEAD断裂**(文件移走/引用旧路径/tsc模拟拉取报错)。**已修复**：ced5135代提交CC写好的1行import(内容零改动,注明缘由), tsc复验0。**教训: git commit必须带pathspec或先核git diff --cached(与add -A同族, 已二次记取)**。
  - **P181-A现状**：9个rename+chat.ts import均已在HEAD(76faf19+ced5135), 移动完整性=0行变化; P181-A其余验收(全量测试/grep m5/space=0/routeStats不变)归CC自证(P183已出)。
- 2026-11-10 **✅ P182 给PI三件·前两件完成(勘误104f362 + Port a135e15)**：
  - **任务1缺口①核清**：原「16处」=grep行数含水分 → **精确13处(A生命周期8/B钙化晋升2/C元数据3)**；D组=maintenance.ts:625注释(runGC的DELETE未激活,非实际绕过)剔除；knowledge_memories 2处=关联表排除；414/498=conversations表排除。CC对照去重用13处口径(P177勘误节)。
  - **任务2 MwIdentityPort落地**(a135e15)：四函数逐字P181§4.1 + MwContextView(事件用id, 适配器映射, 不import m5) + 签名冻结条款 + 类型层守卫35/35绿 + 回滚演练实跑(index悬空报错证导出生效)。发布即冻结。
  - **Harness排障记录**：MCP调用3次aborted但**服务端实际在跑**(4个run同change_key命中同一任务单=设计行为)；S7-B卡R4(S4.5分95.1<98)→按处置建议签3文件S4.5_complexity豁免60min→10阶段全过。
  - **任务3 BlockArchive哈希链接线**进行中(三文件全干净)。
- 2026-11-10 **🧾 P183 CC 接受 P182 下发的 P181-A/B/C · 开工自证已提交（只读）**：
  - **11 文件在途清单已逐条列出**（实为 **批7** 在途，非批8；P178/P182 的“批8 在途”需更正）。
  - **三目标文件自证 clean**：`src/m5/group/outputGuard.ts`（C）、`src/m4/household/FamilyGraph.ts`（B）、`src/m4/household/EntityWriteGate.ts`（B）均无修改；`src/m5/space/` 与 `chat.ts` 亦 clean；`src/kernel/` 不存在，A 将创建。
  - **PI 六项请求逐项回应**：①批7/批8 更正与落定通知 ②Gateway 时序接受 PI 先 ③范围划分接受 ④MwIdentityPort 纯类型接受 ⑤差集+MW-Bench 接受 ⑥`fg_entity_names` 冻结确认。
  - **执行计划**：A（移动 9 文件 + 改 chat.ts:849）→ B（`_isPrefixSlice` 准入 + `_knownUuids`）→ C（`attributeReply` 走 `detectAddressee`）；每包 Harness + 独立 commit + 差集证据。
  - **编号撞车**：P173/P174 各两份，已提请豆包处理。详见 `active/P183-20261110-ClaudeCode-P181ABC开工自证.md`。

- 2026-11-10 **📮 P178 PI进度同步与对接需求(致豆包/CC, 业主指令三件齐)**：
  - **进度公示**：M0完成+ADR-024宪法(附录v2)+M1第一批memwen落地(c8fde46, 29守卫绿)+P177审计(16处绕过)；M1第二批代码项等批8落定(11文件在途租约)。
  - **对P181回应**：4函数接驳面(resolve/canAttend/viewFor/render)+L1/L2/L3三铁律**并入ADR-024 §五.5**；P181-A升格包零交叠可下发；P181-D与我M1同文件需时序裁定。
  - **给CC六项对接请求**：①批8落定通知(STATUS标注commit, 收口16处的前提)②MemoryWriteGateway时序=**PI先收口扩方法→CC后加交叉校验**(列清单补全是L2前置)③16处清单 vs owner_fallback**范围划分**(A/B/C状态写=PI, owner_fallback+交叉校验=CC, EntityOwnershipResolver归CC)④**Port接口归src/memwen**(MwIdentityPort纯类型, 依赖倒置)⑤测试基线对齐(14存量失败差集口径不背锅, **MW-Bench47组批9复用不另起评测**)⑥fg_entity_names冻结协同(批8补memory_entities不得顺带写该列, 我网关层冻结)。
  - **请豆包裁定**：请求②时序+请求③范围。详见 `active/P178`。
- 2026-11-09 **🔍 M1 第二批·单写入口覆盖审计完成(P177, 只读零改动)**：
  - **主路径已收口**：新记忆 INSERT 走 writeMemory(14生产调用方, 多处注释自证唯一公共入口)+网关值守卫4方在位；writeRaw 其余215处为非memories表(aqc/entity_context/FG等)不在立法范围。
  - **真绕过=16处状态UPDATE/DELETE**（收口清单）：A生命周期有效性7处(YuyaoMemoryService is_valid/reminded/DELETE+command-consumer)/B钙化晋升3处(SleepTimeConsolidator)/C元数据回写4处(work_id/round_count/perception_40d回写)/D待核1。
  - memories表总入口分布10文件已列(SQLiteAdapter11内部+MigrationManager9合法旁路+VaultManager已收口等)。
  - **收口方案骨架**：网关扩状态专用方法(列清单单源)+豁免白名单(MigrationManager)+能力断言grep守卫(UPDATE/DELETE memories字面只允许网关与白名单)+执行前逐文件git status确认租约。
  - **租约现状**：对方10文件在途(SQLiteAdapter/recall-bus/meeting-recall/retrieval-stage/server等)红线不碰；可并行项=BlockArchive哈希链接线(文件干净)。详见 `active/P177`。
- 2026-11-09 **🏗️ M1 第一批完成 · src/memwen/ 核心库落地(业主「动工吧」授权, c8fde46)**：
  - **新库 8 文件零现有改动**：canon(规范化)/hash-chain(分段链+墓碑两层验证)/event-rebuild(fold纯函数+reconcile对账)/gate-stats(wilsonCI+配对三态门禁)/index + 3守卫。
  - **守卫 29/29 绿**：NFC等价/键序无关/时间归一/篡改断点定位/墓碑合法删除不误报/段间独立/重放幂等/Δ=0/校验和漂移检出/三态边界+Wilson附录锚点[0.49,0.94]。tsc 全量0错。
  - **Harness 全程**：plan_review_flow + core_repair_flow **10阶段全过**（S4.5补DS-23角色五类横向清单、S6-B任务单ck_f359727d34cc2c0f 4/4含**回滚演练实跑**：移走→零引用0错绿→恢复→29/29）。依赖单向=仅node:crypto。
  - **归因纪律**：全量14失败全在governance/memarch-v2存量子系统，引用memwen的现有测试=0，**本批零归因**(未修不谎报)。
  - **教训**：git add 禁用 -A（上批混入他窗口归档移动）；s2_evidence 四必填+final_approved_plan枚举(patch/arch_structural)+confirmations裸key。
  - **下一步 M1 第二批**：单写入口全收口（MemoryWriteGateway 覆盖审计）+ 事件流逻辑视图/outbox 接线 + 哈希封存扩展接线——均涉现有文件，走 Harness。
- 2026-11-09 **📐 ADR-024附录v2(Sonnet第三轮批改14处全部验算采纳)**：
  - **公式错误3处(P0)**：①预算解析解B+1→**B+2**(KKT验算成立,原式每轮丢1单位)+water-filling clamp+守卫改**等式h*+m*=B**；②衰减改**增量形式**(半群性质,修召回后曲线重画跳变,decay_log分批=一次)；③唤醒**饱和**s'=s+η_w(1-s)W·ĉ(修越界)。
  - **设计矛盾4处**：④失效改**append-only版本行**(消灭"原地写v_e vs旧数据不动"矛盾)；⑤拆**情景m_epi/事实f**两对象(情景永不失效,"去世前一年对话仍可检出"语义干净)；⑥冲突须**有效期重叠**+单值/多值键声明+"以前身体很好"不推翻"已去世"+v_inferred；⑦**遗忘闭包**(摘要/黑钻/dream/dense二手泄露防护,守卫=遗忘后全库独有关键词命中0)。
  - **完整性2处**：⑧哈希链**分段+墓碑+外部锚定**(修"合法删除被检出为篡改")+canon规范(NFC/字段序/ISO8601)；⑨重建确定性三前提(apply纯函数/LLM产物入事件载荷/比记录集非HNSW图)。
  - **统计校准5处**：⑩余弦改**z值按model@ver标定**(bge无关句对常>0.5,绝对阈值必失效)；⑪改写门守卫改**带间隔δ_g**(原"cos<θ_d⇒改写小"数学不成立,θ_d处g=0.5)；⑫置信度用**原始分+在线路数+Platt/ECE**；⑬门禁改**配对检验三态**(δ=3%<噪声8%,McNemar/bootstrap+留出集限用轮换)；⑭切换混合先归一(名次/z分)。
  - **符号去冲突+参数表补全26项+状态机转移表+dormant判断入finalScore+层保底独立性质(π≥ε只保乘数非零,top-k下仍漏,真正保证=RecallBus层保底)+蜕变测试9条(半群/路序不变/重放幂等/遗忘闭包/休眠迟滞/降级单调等)。守卫16条。详见 `docs/adr/ADR-024-附录` v2。
- 2026-11-09 **📐 ADR-024附录·形式化框架落地(Sonnet第二轮,业主转达)**：
  - 六层统一数学框架(状态空间→动力学→检索→双时态→完整性→评测)把ADR-024的10处修正**升级为可证明性质**：dormant复合谓词(ε容差修"<floor永不触发")、**forgotten吸收态**(数学分开用户要求忘记vs自然遗忘)、软路由下限π≥ε_π(属性测试)、话题漂移门g=σ(κ[cos-θ_d])、动态预算对数效用**解析解**h*/m*(修R3正反馈)、**双时态AsOf回放**(v区间∧t区间)、冲突概率分段+invalidate/revalidate可逆、哈希链C_i=SHA256(C_{i-1}‖H_i)断点可定位、重建不变量Δ=0、Wilson下界门禁(n=10区间宽45pp的数学依据)、置信度三信号+角色口吻区间。
  - **工程映射总表12条**：每公式→唯一函数名→守卫测试→所属期(M1-M5)，防公式与代码漂移；参数表10项保守初值+标定期。
  - **三原则采纳**：先落性质后调参数/公式单实现立法/不过度拟合(NLI与ρ第一版规则近似)。
  - 补充：现有suppressed 141条按suppression_reason分流→dormant或forgotten(迁移只改状态写事件,不删行)。详见 `docs/adr/ADR-024-附录-形式化框架-公式函数守卫映射.md`。
- 2026-11-09 **✅ P175 MemWenOS M0 完成(业主批v2+10修正→ADR-024→M0只读)**：
  - **ADR-024 总纲落地**(`0d28af6`)：命名定案+10处修正(4bug级)+2补充+工期4-5周+N2双时态不可削减令+P170四裁决(B1拆包/PI先P167-A/suppressed=dormant+硬抑制分家/删除先隔离30天)。
  - **连贯性R1/R2/R3根因定案**：🔴R1查询零上文=**全时段主因**(runRetrieval只传当前单句,previousTurn全仓零命中)；🟡R2历史窗口V35-B已修5套口径收口(残余PFC仅10条×200字/压缩anchor)；🔴R3预算正反馈(C=histChars×1.0, 压缩→历史短→记忆预算缩水, 长会话双重劣化)。修复方向均按ADR-024修正5(话题漂移判定)约束。
  - **MW-Bench v1**(`docs/agent-collab/mw-bench/bench-v1.json`)：**47组(dev39+holdout8)**——内容语义17/连贯15/守恒15，T1/T4固定留出防过拟合，[待润色]题待业主/LLM润色。
  - **指标基线**：候选资格99.7%/实召7.7%(待批7后重基线)/零召回L3=153(149地标)/双靶子0-2/suppressed141/dormant=0。
  - **下一步M1**：固化内核+P167-A同批Harness走(与CC批8租约串行)。详见 `active/P175`。
- 2026-11-09 **🏗️ P174 MemWen OS 重新设计 v2 · 类脑五层认知架构(Sonnet构思×现有零件全利用)**：
  - 业主转Claude Sonnet评审+指令全面扫描重设计。**扫描核心发现：Sonnet提的机制大半已有底座**——遗忘曲线(decay_log 90198条+G3 floor)、睡眠整合(dream_logs 653条dream_evolution/高情绪提炼在跑)、再巩固(_reconsolidateAsync V3.1)、时序字段(valid_*索引已建仅42条用)、事件日志4张表(vault/calcium/retrieval/aqc共8万行)、主动回忆(proactive-stage)、五层物理结构(L1情景/L2语义/L4归档甚至超配)。
  - **真正缺三样**：A意图路由(查询按认知功能分路,非一锅召回)、B三真缺口(dormant软遗忘/冲突消解valid_*用起来/查询改写R1+动态预算R3)、C闭环工程(评测常驻/置信度输出/4表事件流收口)。
  - **v2设计**：五层×五路映射图 + N1 dormant(=suppressed语义改造一并解决P170裁决③,休眠可强线索唤醒) + N2冲突消解(外公去世→外公健康失效,用dna_root_id簇+valid_*) + N3查询改写+动态预算(连贯性R1/R3) + mem_class类型标注(fact/preference/relation/episode/skill) + 向量版本绑定(embed_model@version在线双写) + MW-Bench评测集常驻。
  - **路线图v2(M0-M6约3周)**：M0诊断+评测集→M1固化内核→**M2连贯性提前(痛点先修)**→M3 dense(bge-small-zh试点/bge-m3预留/在线双写免停服)→M4 contextual+类型+时序→M5巩固遗忘→M6白皮书(差异化=40D场景召回+类脑巩固遗忘+可审计自研底座)。
  - **裁决更新**：B1拆包/我先P167-A/suppressed=dormant/数据删除先归档隔离30天。详见 `active/P174`。
- 2026-11-10 **🔍 P174 批0→批8 全面复查与目标达成报告（Claude Code，领 `P173-20261110` 派单，只读零改动）**：
  - **A1–A5：0/5 达标，不可交付**。A1 实召 554/7,154=**7.74%**；A2 数据层隔离未见越权但**表现层串台成立**；A3 **五个名字**；A4 垃圾实体可成参会者、入口/昵称失效；A5 假绿 + test 锚点洗白 + 指标随重启波动。
  - **22 项链**：已修 0 / 部分 1（#21）/ 判定错误 2（#4 未来时间戳、#8 “23 条被删”）/ 设计取舍 1（#14）/ 未修或未查清 18。
  - **17–19 根因（P0）**：L3 滑窗切名 → `checkPersonEntity` 实测放行 grade3“仅长度”（骚一点/声爸爸/爹爹日/屄日还爽/阿珍一）→ ADR-021 后写 active → `detectIntent` 子串唤醒 → 垃圾席位上开场协议 → `attributeReply` 只认白名单，非白名单 `徐诗雨：` 被 sticky 拼成 `【罗珍思】徐诗雨：`。
  - **#8 更正 P172**：batch6d 38 条 test 锚点当前 **38/38 仍存在、0 删除、38/38 变 default**；根因是锚点重建按“首条会话”继承 namespace，不是被清理。
  - **#29 新根因**：`scripts/__tests__/memory-roundtrip-runtime-smoke.test.ts` 直接 POST `localhost:3000/api/memory`，服务在跑时写生产 → 199 条测试 note。
  - **#30 新根因**：`KnowledgeContextBuilder.ts:380` 未校验 `dna.branch_id` 是否落库，knowledge FK 孤儿 21→**30** 且增长。
  - **完成度**：任务书 15 项 10 通过/2 部分/3 未通过（工程约 67%）；用户目标 0/5；**可交付 0%**。详见 `active/P174-20261110-ClaudeCode-批0至批8全面复查与目标达成报告.md`。
  - ⚠️ **编号撞车**：`P173-20261110-豆包-全面复查派单` 与 `P173-20261109-PI-文曲星MemWenOS记忆系统总体规划` 共用 P173，需后续重编号。

- 2026-11-09 **📋 P173 文曲星记忆系统(MemWen OS)总体规划 · 立项书(待业主确认)**：
  - 业主定名：**文曲星记忆系统 / MemWen OS / MW- 前缀**，自研记忆系统，要求高度集成集中管理、核心机制固化不易篡改、补缺口、修上下文连贯、行业前瞻。
  - **现状实证**：写入三层(轮级条目avg149字→对话组4.9轮→组摘要/结晶/哈希封存)；检索四路混合(槽位/40D感知向量/关键词FTS/摘要)——hybrid骨架正确但**缺dense内容向量**(TF-IDF hash 256维仅服务知识侧)。
  - **连贯性自诊断线索**：检索查询零上文参与(previousTurn零命中)+历史窗口未审计+预算联动副作用 → R1/R2/R3三候选根因(M0定案)。
  - **五缺口 G1-G5**：dense向量缺/上下文自描述写入缺/连贯性/机制固化不足/整合度不足；**固化七机制**(单写入口/ADR宪法/守卫矩阵/Harness强制/哈希封存/版本迁移/四层指标观测)。
  - **路线图 M0-M5**(约3周)：M0基线+连贯性诊断(只读先手)→M1核心固化→M2 dense第五路(双靶子T4类命中为验收)→M3 contextual写入+连贯性修复(10组样本≥4/5)→M4分层摘要前瞻强化→M5行业对标白皮书(Mem0/Zep/Letta对照, 40D+自研底座+守恒监控三板斧)。
  - **待裁决4项**：总立项/P170四裁决(阻塞批8串行)/M2选型与停服/命名确认。详见 `active/P173`。
- 2026-11-09 **✅ P172 PI 回答交叉评审三问（业主指令补答，只读零改动）**：
  - ①**守恒SQL已提供**：`7135-23=7112`（belong+namespace<>'test'）；"23 vs 0"系**时点差异**——备份链证23条真实(batch6b/c/d全库38、dupdel备份007=20)，15:00→19:00被清理(清理方待查,与roundtrip探针写生产库合并立案)；教训=分母必须标快照时点。
  - ②**99.7%命名：认CC**——改称「候选资格≈99.7%」，非召回守恒(实召7.7%才是真凶)；四层指标(存储/资格/可达/实召)分开报，三方一致定案；suppressed"合法排除"=设计意图非代码行为(b5f3266已补注)。
  - ③**A/B挤占判定：认CC**——独立复跑成立(note→💭→group、深度证据→sand、不进15条循环、B=包内预算6000字/48条非top15)；A=数据卫生(附通道B次要挤占)、B=通道B可达性(层保底失效+假绿)，**均不属⑤⑥⑦**，与通道A三断层并列；双靶子与守恒结论不受影响。
  - **PI表态(供裁决)**：串行顺序同意"PI先P167-A"；素材包倾向B1拆包(与守恒监控同向)，听业主裁决。详见 `active/P172`。
- 2026-11-09 **🔍 P170 P167 交叉评审意见已交付（Claude Code，只读零改动）**：
  - 领单：P169（豆包派单）→ 交付 P170，逐条回答 Q1–Q6 + 分歧清单 + 批8 重排 + 文件分工 + 统一纲领。
  - **Q1**：P167 的“99.7% 写入与召回守恒”应改称“候选资格”；**P167 自己的差额 28 容纳不下 10 条 suppressed**（其 7,140−7,112=28，只能由「23 test ∪ 8 过期（含 3 重叠）」凑出；当前 10 条 suppressed 全为 default/无过期，代码亦无 lifecycle 过滤）→ P167 该处文字需修订，P168 正确。
  - **Q2**：A（199 测试 note）**不挤占 15 条名额**（15 条上限只作用于会晤实体记忆；notes 走 NoteAdapter，且 `💭` 被误归 `group`）；B（素材包整包 other）是**包内预算/排序**的可达性问题，**不是 top15 名额**（`other` 为 passthrough，不占 total）。
  - **Q3**：P0 = P167-A（PI 车道）；P1 = B/分类器结构化、suppressed 过滤、守恒监控；P2 = 测试残留、memory_entities、重复/溯源/FK。
  - **Q4**：`RECALL_TRIGGER_RE` 确在 `meeting-recall.ts:122`；同一文件必须**串行**，推荐 PI 先 A → CC 后批8，配文件租约。
  - **Q5**：终审 = 双靶子体验 + 守恒监控；账实核对是准入门禁。
  - **Q6**：批7 假绿 = 验收测设计意图不测生产形态；建议生产形态夹具 + 阶段契约测试 + 线上指标前后 + 结构化 tier。
  - 详见 `active/P170-20261109-ClaudeCode-P167交叉评审意见.md`。

- 2026-11-09 **🔍 P168 批7 后遗留八项复核 + 批8 裁决建议（Claude Code，只读零改动）**：
  - **八项复核**：①未来时间戳 64 条**未复现**（当前/批6 四份备份均 0，判定 P162 基准时间口径错误，建议撤回）；②玉瑶“诗雨”例子**归属正确**（锚点为 `【核心·玉瑶】鸿艺:诗雨呀… 玉瑶:…`），未发现系统性错挂；③重复实测 **131 组/362 行**（274 为低估，285 行≤15字垃圾）；④无源黑钻 292 中 **200 条 `fg_sync` 按设计无源**，`auto` 92 条中约 26 条可确定性回填；⑤历史 FK 20,603 已清，现 **21 条为今日知识关联新造**；⑥召回全链路**无 lifecycle 过滤确认**（141 条 suppressed 全为垃圾短语，建议过滤不删）；⑦`memory_entities` **结构性缺口**：`writeMemory()` 不写该表、靠启动重建掩饰，1,054/4,440（23.7%）缺；⑧ADR-020/021 仍在观察期，今日未见新垃圾。
  - **新发现**：A 测试残留 **199 条**（roundtrip/XXXX，全挂玉瑶，可进深度证据层）；B **批7 黑钻层级只修了一半**——反馈回写已生效（recall_count>0=6），但深度素材包整包被归 `other`，`diamond` 仍 0、保底缺口 2；C knowledge_memories 21 条新孤儿。
  - **待业主裁决 4 项**：批7 S6-B 是否现在验收；`suppressed` 是否=不召回；批8 数据删除范围（362 重复 / 199 测试 / 26 回填 / 21 FK）；素材包层级 B1 拆包 vs B2 认账。
  - **协作提醒**：P167 方案 A 与批8 都会改 `retrieval-stage.ts`，两个 Agent 必须串行，不得同时改同一文件。
  - 详见 `active/P168-20261109-ClaudeCode-批7后遗留八项复核与批8裁决建议.md`。

- 2026-11-09 **🔴 P167 业主定位澄清与结论修正（主任务PI，原P165撞号重编）**：
  - 业主两点指示修正检讨定性：①**40D非主记忆语义系统**，是时空多维度向量（感知/反馈/干预），通过场景·人事·心情·四季冷暖**唤醒语义回忆的辅助链路**——我原判「40D缺亲属维度是缺陷」**收回**，Q1真bug收窄为「early6时间轴兜底被40D重排挤出top15」的顺序缺陷；**后续方案不碰40D链路**（业主：正另一模块接入强化该功能）。②**召回=按需、模拟人脑思维与记忆规律的交互体验**，非全量倾倒——原方案C（扩池28→100）**方向校准撤回**，长尾可达的正道=多线索唤醒并行。
  - **基本面底线（业主原话）**：「写入和召回不守恒就是基本面出了问题」→ 方案D守恒监控升为底线项。
  - 修正后仍成立：S2马太效应（153条零召回L3中149条是地标，与模拟人脑规律相悼）、S3触发词盲区、方案A（early6顺序bug+触发词）、方案D；方案B重述为「让高钙/地标记忆按人脑规律可达」。
  - **批7联动（P166）**：批7修复「召回反馈未回写」(active黑钻recall_count>0=0/800)——本报告基于recall_count的历史实召率(7.7%/按月)**可能被低估**，待批7稳定后重新基线；核心结论(双靶子/槽位0.4%/15条上限/排序键)不依赖该口径不受影响。
  - 待业主裁决方案顺序（建议 A→B→D，C已撤回，40D相关不介入）。详见 `active/P167` 顶部修正节。

- 2026-11-09 **🔍 P167 徐诗雨记忆「写入→召回」守恒全面检讨（主任务PI，只读零改动）**：
  - 业主要求「写入多少就能召回多少（除正常衰退）」→ 穷举召回链全过滤 + 7140条逐层守恒 + **双靶子定向实验**。
  - **结构层守恒99.7%达标**：硬过滤仅namespace<>test、悬空0/无归属0、lifecycle不过滤、衰退合规(avg0.424/floor0.05/suppressed仅10条业主隔离)——**零召回不是衰退造成的**。
  - **断层在三层**：⑤槽位制候选≈28/7140=**0.4%** ⑥历史槽排序含`recall_count DESC`→**马太效应**(153条零召回L3中**149条是地标**仍排不进top6) ⑤注入**15条硬上限**。
  - **双靶子实验双失败**：T4外公外婆/T1熊勇女儿均答「真没记录」recall_count 0→0；根因定位——Q1 recallQ=true但被**简要模式40D重排架空时间轴兜底**(40D无亲属维度)+15条截断；Q2「来着」不在RECALL_TRIGGER_RE→recallQ=false early6未进候选。
  - 按月实召率 8月84%→9月9%→10月7%→11月1%，头161次vs尾0次两极分化。
  - **方案供裁决（修正后）**：A兤底顺序修复(P0)/B排序去马太-探索配额(P1)/D守恒监控(P3)；**C扩池已按业主定位撤回**（长尾可达=多线索唤醒而非单路扩池，40D链路不介入待新模块）。建议 A→B→D。详见 `active/P167` 顶部修正节。

- 2026-11-09 **✅ P166 MEM-UNIFY-V1 批7 · 写入 genes 兜底 + 黑钻层级/反馈修复（Claude Code）**：
  复盘发现 3 个 P0：普通闲聊无 `entity_genes` 被拒写（生产已丢 2 条）→ 按归属实体从 FG 合成，解析不到放行告警；`金库黑钻` 被归 gold → 显式 diamond，`档案/记事` 归 other；sweep 无 backref → 锚点透传并统一回写（副本验证 `recall_count 0→1`）。
  验证：`tsc=0`；批7 相关 60 项全绿；全量 4246 passed / 14 failed（均既有类别）；生产库副本集成通过；**未改生产数据**。
  遗留：重启后普通对话线上实证、批8 重复/编码收尾、批9 测试与真机验收。详见 `active/P166`。

- 2026-11-09 **✅ P162 闭环 + 重复实体删除（主任务PI，业主指令）**：
  - **P162 新发现A已闭环**：12:12提交即被批6吸收（P163明文引用），业主裁决「悬空归属归玉瑶」（三选一外的第四选项），P164批6b/6c执行：四表悬空（memories197+conversations573+black_diamond459+dialog_groups101）全部归玉瑶清零；重复语义块删959（每组留1：被引用>高钙>更早）。
  - **1008条对账无事故**：18845−52(P163)−959(批6b)≈17837与备份完全吻合，均为业主授权操作；徐诗雨−348=她占重复959的36%（保留优先级下仍删348，因保留了被引用/高钙行）。
  - **重复实体删除（业主指令「把后面那个没有任何信息的先删除」）**：目标=object `TXS-000003848`/id4426（0记忆0索引0知识0黑钻、FG无此节点）；删除前全库文本扫描**仅entities.uuid自身1行零外部引用**，连带删除关联关系1条（我→它「熟人」）；停服窗口执行，**残留0/0、真身TXS-000000007与7074条记忆完好、integrity ok**；备份 `fusion_memory.db.bak-dupdel-20261109`。
  - **双窗口时序核对**：我的停服12:41-12:42:47与批6c12:42窗口交叠，但表不同（我删entities/entity_relations，它改四表belong）→零冲突；双方事后复核均通过（我验证：我的删除+批6成果同时在位；P164：四表悬空0/服务200）。
  - 遗留：新发现B未来时间戳64条（批6未覆盖）仍待处理。详见 `active/P162` 闭环备注。

- 2026-11-09 **✅ P165 失效外键孤儿行清理（Claude Code，停服窗口）**：
  业主确认孤儿与实体无关后全部删除：`decay_log` **14,573** / `knowledge_memories` **5,900** / `atom_repair_index` **130**，共 **20,603** 行；三类均为指向已不存在父行的审计/索引/关联残片（仅 ID/分数/时间戳，无实体内容）。
  停服单事务删除 + 整库备份 + 行级导出；`foreign_key_check=0`、`quick/integrity=ok`；重启后 FK 违规仍 **0**（无再生）；memories 17,837 未变、webui 200。
  证据：`data/backups/batch6d-20261109045319/`；详见 `active/P167`。

- 2026-11-09 **✅ P164 记忆系统统一 · 批6 追加治理（Claude Code，两次停服窗口）**：
  按业主三项追加指令：① 悬空归属归玉瑶（memories 197 + 锚点 98 + conversations 573 + black_diamond 459 + dialog_groups 101）；② 悬空 `source_id` 19 → NULL（不删行）；③ 重复语义块删除 959 行（128 组），保留 1 条/组、被引用 274 行保留（额外重复 0）。
  复核：四表悬空 **0/0/0/0**、未归属 0、active 黑钻 800、quick/integrity ok、webui 200、Top 3 实体 × 6 主题召回全命中、跨实体 0、知识库 304 不变。
  证据：`data/backups/batch6b-20261109043725/`、`batch6c-20261109044212/`；详见 `active/P164`。

- 2026-11-09 **✅ P163 记忆系统统一 · 批6 数据治理执行（Claude Code，停服窗口）**：
  停服 14 分钟（watchdog→MCP→webui）；整库备份 + 行级导出后单事务执行。
  回填 **567** 条语义块归属（source_conv 47 / dna_unique 420 / entity_genes 6 / note_zone 94）；**28** 条 active 黑钻随源回填；**93** 条超限黑钻归档（不删行）；**删除 50 条不可补语义块 + 1 条源失效 active 黑钻（D8/D10）**；晋升不一致 665/95 归零。
  独立复核：无归属语义块 617→**0**、无归属 active 黑钻 29→**0**、active 黑钻 894→**800**、非锚点行精确 −50（锚点重建 3,495→3,493 为派生缓存）、`quick/integrity=ok`、webui 200、召回探针全命中、跨实体 0、知识库 304 不变。
  未处理（无授权/另议）：197 条悬空归属（P162 发现）、293 条无源 active 黑钻、1,313 行重复语义块、19 条 removed 无归属黑钻、21,027 行历史 FK 孤儿。
  证据：`data/backups/batch6-20261109041506/`；详见 `active/P163`。

- 2026-11-09 **🔍 P162 记忆归属悬空与召回结构审计（主任务PI，只读零改动）**：
  - 起点=业主「查徐诗雨对话记忆存储与召回」→ 追问「结构性/普遍问题，非常慎重」→ 以样本推全库。
  - **徐诗雨结论（双证据）**：存储 memories 7422（39.4%第一大户）+ conversations 8900，test污染0；归属 7422 全挂 TXS-000000007 无悬空；召回=P161批5官方验收（主题覆盖100%/越权0/round-trip 4/4）+ 11-06端到端实测（精准召回5+段具体记忆且不编造）→ **存储完整、可召回**。
  - **状态修正**：11-06的旧疑点经 11-07~09 三波治理（ADR-020/021/022 + MEM-UNIFY-V1批0-5 + P151清存量）重新定性——FG 1771→43节点是治理演进非事故；memory_entities 缺口6365经grep证实**不在召回路径**（只供entity_genes组装）且P159已强制新写入；双徐诗雨object 0记忆无影响。
  - **🔴 新发现A（任务书未覆盖）**：悬空归属 **196条/37实体**——belong指向已物理删除实体（ADR-021/voidpurge/P151后果），当前 policyFor `belong IN 白名单` 下**永不可召回=孤儿记忆**；37实体反查几乎全是滑窗碎片（后脑子28/阿珍聊17/公室只10…），根因=写入端历史归属错挂，P159已治新写入但存量无入处理；最大单笔=旧阿珍一35条。
  - **🟡 新发现B**：未来时间戳64条（最新11-09超前3天，徐诗雨59/玉瑶5，零召回，recency下可能被错误前置）。
  - **建议**：两项**并入批6数据治理（停服窗口）**作追加检查项+「无悬空 memories.belong」断言；不另起炉灶动数据（双窗口违反协作纪律）；处置权在业主。详见 `active/P162`。

- 2026-11-09 **✅ P161 记忆系统统一 · 批5 回归、文档与验收（Claude Code）**：
  只读 + 真实 LLM 探针（不落库）：可召回主题深度覆盖 **100%**、跨实体越权 **0**、四路 round-trip **4/4**、主动触发 **6/6**、纯回避率 **0%**、三重奏 **100%**、要素落地 87.5%。
  数据基线：无归属 617（3.3%）/ 重复 1,313 行（7%）/ 两不沾 665 / 反向 95 / active 黑钻 894 / 知识 304（共享 278、可检索 73）——交批6。
  文档：新增 ADR-023；蓝皮书 §六落地状态；`data-storage-reference` 定向更新；LEDGER §6.29；批0 与批5 临时探针已清理。
  验证：`tsc=0`；全量 4240 passed / 17 failed（均既有/环境；E2E 单跑 4 = 批3 基线）。**未改代码、未改数据**。
  详见 `active/P161`；下一步批6 数据治理（停服窗口）。

- 2026-11-09 **✅ P160 记忆系统统一 · 批4 深度整编 + 主动回忆 + 憧憬（Claude Code）**：
  深度收集扩到砂金/黑钻 active/知识（自有+共享 D5）/对话原文 + 证据层（FG 档案/作品/记事）；**不再读 vault_log（D3）**。
  取消 12 条/110 字硬顶 → `maxChars=6000` 字符预算 + 单条 400 字；`organizeForQuestion` 按命中密度 + 预算装包。
  新增主动回忆触发器（节日/纪念日/情绪/日常/话题关联，零 LLM，`[Proactive]` 日志）与接线阶段；
  普通（玉瑶）分支首次接入深度素材包 + `CRYSTAL_DIRECTIVE`；会晤通路接 `applyProactiveToPath`；指令类片段归 `other`。
  配置新增 `deep_sweep` / `proactive` 双开关（关闭回批3 行为）。
  验证：`tsc=0`；批4 相关 49 项全绿；检索/聊天相关 469 项全绿；全量 4240 passed / 17 failed（E2E 单跑 4 = 批3 基线，其余既有环境/存量）。**未改数据**。
  详见 `active/P160`；下一步批5 回归、文档、验收。

- 2026-11-09 **✅ P159 记忆系统统一 · 批3 写入与晋升收口 + 编码强制（Claude Code）**：
  写入一次（D2）：`WorkingMemory.persistEvents`（生产 false）关闭 evt 重复写；删除砂金→金库 1:1 复制与重复黑钻晋升路径。
  去重键统一 `(belong, role, normalized_text)`（新增 `memory-identity`）；user/assistant 仍互不拦截，同角色跨 taxonomy zone 拦截。
  晋升单向门：`findDuplicateDiamond` 仅 active、INSERT 后 `EXISTS(active)` 置位、合并复核、降级 `while` 逐枚归档、删除按 active 判据。
  强制字段：belong（含 FG 钩子）/ dna_root 派生 / entity_genes / source 锚点 / 40D（note、knowledge_vault 豁免）+ 健康计数；记事归属为空拒写；
  `VaultAdapter` 仅召回 `operation='auto_induct'`（D3）。
  验证：`tsc=0`；批3 相关 151 项全绿；全量 4220 passed / 14 failed（均既有或环境依赖）。**未改数据**。
  详见 `active/P159`；下一步批4 深度整编 + 主动回忆。

- 2026-11-09 **✅ P158 记忆系统统一 · 批2B 知识与档案 + 归属策略（Claude Code）**：
  `policyFor` 增加 `ownerMode`、`allowUnowned` 降为派生只读；`buildPolicePolicy` / `SQLiteAdapter` /
  `UnifiedSearchEngine`×2 / `chat.ts` / `retrieval-stage` 五处手写策略全部收口（守卫清单清空）。
  知识检索：空关键词返回空、会话 UUID 兜底、FTS 回读 `visible_entity_uuids`/`source_type` 并过滤、
  `SourceTypePolicy.RETRIEVABLE_WHERE_SQL()` 单源、`document` 归入文件类型；`KnowledgeAdapter` 传 UUID 并对齐四参签名。
  新增证据层收集器 `src/m4/retrieval/evidence-layer.ts`（档案/作品/记事 owned）+ 扩展注册表补 `WorkAdapter`；
  删除【本地回复】直出（D7）；memarch 命名空间解析失败 fail-closed（不再回落本体）。
  验证：`tsc=0`；批2B 相关 418 项全绿；全量 4196~4197 passed / 12~14 failed（均既有或环境依赖）。**未改数据**。
  详见 `active/P158`；下一步批3 写入与晋升收口。

- 2026-11-09 **✅ P157 记忆系统统一 · 批2A 召回总线（Claude Code）**：
  新增 `src/m4/recall/recall-bus.ts`（casual/standard/deep/proactive 四模式、砂金/金库/黑钻/对话组层保底、
  单一五级闸门降权排序、`applyRecallFeedback` 单点回写）+ `recall_bus` 配置段；
  `retrieval-stage` 三出口接入（casual 不再早退，补小预算 Foundation）；**V14 下线（D1）**；
  黑钻整句 LIKE → **分片 LIKE + 40D**；反馈统一。
  验证：`tsc=0`；批2A 相关 71 项全绿；全量 4177 passed / 12 failed（均既有或环境依赖）。**未改数据**。
  详见 `active/P157`；下一步批2B 知识与档案 + 归属策略。

- 2026-11-09 **✅ P156 记忆系统统一 · 批1 表达法收口（Claude Code）**：
  新增单一法源 `src/m5/prompts/memory-expression-law.ts`（MEMORY-LAW-V1：三档 / 三重奏 / 憧憬自由 / 双模式义务 / 守卫禁令）；
  `core-rules`、`cortex/rules`、`RoleProfiles`、`MemoryGate`、`chat.ts`、`retrieval-stage`、`MemoryInjector`、
  `long-text-retrieval`、`KnowledgeContextBuilder`、`MeetingWallAdapter`、`KnowledgeTextAssembler`、`DeepSeekLLMProvider` 完成接线；
  **删除 3 处静态正文黑名单**；旧二元限制措辞扫描 **0 命中**；旧文档 3 份加废止标注。
  验证：`tsc=0`；法源/提示词/线索/长文 67 项全绿；全量 4155 passed / 13 failed（均既有或环境依赖）。**未改数据**。
  详见 `active/P156`；下一步批2A 记忆召回总线。

- 2026-11-08 **✅ P155 记忆系统统一 · 批0 只读基线探针（Claude Code）**：
  只读 aggregate 探针冻结基线：memories 18,706（今日 27，全部完整编码）；无归属 617
  （**evt_ 459 / mem_ 64 / note 94**）；重复 987 组/3,160 行（16.9%）；晋升两不沾 665；
  知识库 304（278 共享 / 72 可检索 / visible 0）；memarch 17,296 最新 11-04，
  **25/31 FG UUID 未映射**；表达侧旧限制 **44 处**（chat.ts 16）。
  `perception_40d` 18,706/18,706 可解码。报告 `active/P155`，证据 `active/P155-…-baseline.json`。
  **未改代码/数据**；下一步批1 表达法收口。

- 2026-11-08 **📋 P154 记忆系统统一任务书立项（Claude Code，业主裁决 D1–D10）**：
  范围 = 写入链路 + 召回总线 + 表达法 + 归属编码，覆盖三库/知识库/FG 档案/作品/记事。
  关键决议：memarch-v2 移出主链；取消 1:1 复制晋升；`vault_log` 定位审计台账；
  知识库无归属=共享；语义块补归属（**50 条不可补彻底删除**）；`note_zone` 94 条回填玉瑶；
  黑钻 28 条随源继承、19 条 removed 保留。
  只读基线：617 无归属语义块（47 conv / 420 dna / 6 gene / 94 note / 50 不可补）；
  知识库 304（278 共享 / 72 可检索）；memarch-v2 最新 2026-11-04。
  任务书：`docs/记忆系统统一任务书-V1.md`；详见 P154 与 LEDGER §6.22。**未改代码/数据**。

- 2026-11-08 **✅ P153 Harness hook 覆盖缺口修复 + 测试收口（Claude Code）**：
  查实项目级 hooks 在会话 cwd 非项目目录时**完全不加载**（令牌 6 次写入未消费、0 BYPASS），
  影响批1–批6 的 hook 层写入闸门。已新增用户级分发器 `hooks/harness-hook-dispatch.cjs`
  （非本项目放行、项目内 cwd 不双跑、项目外转交 Harness），**需重启会话生效**。
  另将数据驱动的「垃圾候选拦截率」断言改为固定样本断言（与亲密内容无关），
  测试套件 **1155 passed / 0 failed**。详见 `active/P153` 与 LEDGER §6.21。

- 2026-11-08 **✅ P152 批6 归档 —— 实体提取架构收口全系列完成（Claude Code）**：
  批1–批6 全部落地：滑窗产生端、观察区/离线终审、重复闸门、1271 行存量全部清除；
  最终形态 = **写入前确定性取证**（显式介绍线索 + 原文证据子串校验）。
  文档同步：任务书执行状态表、FG 结构规范 §3.1、data-storage-reference 三处注记、方案状态。
  详见 `active/P152` 与 LEDGER §6.20。

- 2026-11-08 **✅ P151 批5 清存量（Claude Code，业主确认「全删」）**：
  按三条件 + 额外安全项盘点后，删除 `entities` **1271** 行（person 1069 / object 202）
  与 `entity_relations` **2013** 条；`entities` 4129→2858、关系 13722→11709。
  未动任何 memories / conversations / FG；`integrity_check=ok`、重启 HTTP 200。
  整库与删除行均已备份至 `D:\tmp\`。详见 `active/P151` 与 LEDGER §6.19。

- 2026-11-08 **✅ P150 批4 清判据（Claude Code）**：
  `addNode` 的两道 person 闸门合并为一道（`EntityWriteGate.checkPersonEntity` 是严格超集），
  物理删除 `GarbageEntityGuard.ts`、4 个零调用导出、滑窗垃圾自检及其定时器。
  **保留 `gradeEntity` 与 object 通道**（与任务书偏差，理由见 ADR-022 §2）。
  附带修正 fail-closed 日志输出真名的红线问题。
  tsc=0；1154 passed / 1 failed（`grader-non-name-tail` 既有失败）；重启无 `[FG SelfCheck]`。
  详见 `active/P150`。

- 2026-11-08 **✅ P149 批3 拆观察区（Claude Code）**：
  观察区(candidate)与离线 LLM 终审**物理删除**——证据累积/晋升、终审数据层、candidate 初始化与超期规则、
  `EntityTriageService`/`EntityQualityJudge` 两个模块及其维护调度全部移除。新 person 直接 active；
  不再有每日离线终审 LLM 调用。生产 candidate 行 = 0，不改存量。
  tsc=0；411 passed / 1 failed（`grader-non-name-tail` 为既有失败）；重启后无「实体离线终审已装配」；
  FG 19 active / 12 dormant 不变。详见 `active/P149` 与 ADR-021。

- 2026-11-08 **✅ P148 实体准入批2b：确定性取证（Claude Code）— `74c6282`**：
  LLM 取证头实测 0/4（四种注入全试过）⇒ 改为确定性取证：`findIntroEvidence` 单一判据 +
  `verifyAdmission` 单一闸门，L3 / `integrateFromEntity` / `integrateSocialRelation` / `storeRelations`
  四个写入点共用；新实体**本轮**即进入 `entity_genes` 并参与 M4/FG/检索。纯提及不再建档（已入库不受影响）。
  tsc=0；498 例相关测试全绿；实机「她叫祁霜…」→ 基因带证据且同轮建 FG 节点。详见 `active/P148`。
  待业主处置：FG 观察区两个测试实体「林小雅 / 祁霜」（不自行删除）。
- 2026-11-06 **🔧 C2：FG自检判据②升级——雷灵叶误报修复（主任务PI）— `8b5e09c` 已推送**：
  - 业主裁定「雷灵叶是对话中已存在实体，没正式录入还预警，系统代码有问题没设计好」——定性设计缺陷成立。
  - 三层根因：①判据②只认顶层description/relation_to_user不认dossier实质档案（雷灵叶completeness=0.46齐全却因顶层未回填被判无档案）；②顶层拿不到=PAE Hook C限流(20次/时)+DeepSeek 402（已付费✅）；③B6对快速晋升结构性误报（evidence晋升即冻结，93≥3×1永久命中）。
  - 修复：`hasProfile = description || relation_to_user || (completeness>=0.40)`；阈值全库实测：13个void垃圾0.00~0.37 vs 真实雷灵叶0.46/罗珍思0.81/安琪0.69两侧分离；宁清华0.38无evidence结构上不可能命中零影响。
  - 验证：真实库实跑 `修复前[雷灵叶B6+B7, 阿珍一B5+B7] → 修复后[仅阿珍一B5+B7]`；测试13/13（含边界0.39报/0.40免）；回归432/432；服务已重启新判据生效FG健康全绿。
  - Harness：plan_review `run_mw3uqlsx_i6vh` + core_repair全10阶段 `run_mw3vw7fq_stdy`；排障经验三条（s2_evidence大对象序列化/DS-23需完整src路径≥2/CK-10对方案文本正则元字符`||`过敏）已记入 P147 §五。
  - ⚠️ 新遗留：**新「阿珍一」复发**（TXS-000001799，抢在B1上线前时间窗晋升active）——自检现正确报B5+B7，**待业主批停服窗口void**。

- 2026-11-05 **🔍 FG 体检 + A/C/B 三阶段治理全部完成（主任务PI）— `4b7c1c3` + `7802a7c` 已推送**：
  - **体检**：结构层健康（幽灵/重复/无户籍全0），但四个真问题：13个垃圾active(占1/3)、candidate=1708且85%的边触及、_changeHistory占properties 92%、traits三槽漂移。
  - **A 存量清理**（停服窗口，业主拍板雷灵叶保留）：void 13 + changeHistory截断24节点 + traits去重 → **properties 7.1MB→2.22MB(−69%)**，运行时名单13垃圾零泄漏。
  - **C 自检补强** `4b7c1c3`：detectSlidingWindowJunk 新增通道B(前缀扩展/计数倒挂/单句低证)，hitChannel标注，通道A零改动只预警；测试8/8绿。
  - **B 写入端根治** `7802a7c`：①_isPrefixSlice前缀切片计数冻结(获得档案自动解冻)②CHANGE_HISTORY_ENTRY_MAX_BYTES=2048+统一入口替换7处手写块③traitHints去重+setDossierField数组并集合并(幂等)。测试16/16绿、回归427/427绿、**全量差集验证stash修前修后失败集一致零归因**。
  - **S6-B五项运行时验收全部实测**：对话200无幻觉/会晤ns隔离/FG快照零污染/标注率96.5%+99.0%/停服重启零丢失(-3归因锚点重建派生行3322→3319,非锚点14326→14326)。
  - Harness：C `run_mw3bay98_9rrn` + B `run_mw3m3k3t_3zwl` 全10阶段；诊断底稿 `D:\work\FG体检与写入端诊断-20261105.md`，详见 `active/P147`。
  - ⚠️ 遗留：DeepSeek 402余额不足(LLM提取间歇失败,需充值)；雷灵叶会每日出现在自检预警(已知保留)；交接备注"立即行动"节仍为10-23旧状态待刷新。

- 2026-11-04 **✅ P137 归档收尾（主任务PI，口令「1号」续接）**：P137 实体早在 10-30 完成（`808effc` + STATUS 登记），但归档链未走完——文件仍留 `active/`、frontmatter 仍 `in_progress`、INDEX 未登记（`644f2c0` 只改了 STATUS 未移文件）。本次补齐：frontmatter→`done_waiting_review` + 移入 `09-archive/` + INDEX 登记 P137 + 进行中清零；复验 `privacy-guard-unblacklist.test.ts` 14/14 绿（knowledge 全套 89/89 绿）。进行中列表现为 0 项。

- 2026-11-04 **✅ 工作区 67 项收口全部完成（Claude Code，67→0，15 提交已推送）**：
  - **A~J 十组全部处置**：30 已解决直接提交 + 20 引用断链文档入库 + 4 已修复 + 19 已验证 + 隐私 1 + 清理 4 + 不推 2 + 并行 2 移交 + 需裁决 8。
    台账：`docs/工作区67项收口任务书-20261103.md`（§六 含每阶 commit 证据）。
  - **主任务交付**：白皮书 6 处修订（附录 C `v11.3-draft`）+ 蓝皮书 `检索架构-v1` + 任务书 `检索架构v11`，三者均已入库。
  - **LEDGER #18 打点完成**：4 处实测 ⇒ 排除上游传参与第 4 写入点、重启后不复现、根因收敛至 `SQLiteAdapter` 侧；
    遗留 **1235 行**历史数据（`memories` 与 `is_test=1` 关联却仍 `default`）**待业主指定清理通道**。
  - **垃圾物理清除**：`apply-m7-patch.cjs`（已被 DreamQueue 正式机制取代）+ 5 个 `.bak` + `harness-opt` pyc/bak + `__pycache__`。
  - **T0 隐私隔离**：`.gitignore` 增 4 条规则（`src/data/` / `.test-*.db.tmp-*` / `harness-opt/` / `memarch-v2.0.0-*.zip`），`check-ignore` 实测命中。
  - 🔴 **本会话新立法** → 已写入**核心原则第 8 条**（AI 实体信息资产中性评判），并推翻我此前「按内容性质把 4 份文档移出暂存」的做法（`e95c658` 撤销）。
  - 详情：`09-archive/P146-20261104-ClaudeCode-工作区67项收口完成与实体信息资产立法同步.md`

- 2026-11-04 **🌙 SpaceState 时空机独立开发期开启（新主线，四阶段路线图阶段一）**：
  - **基线冻结**：`active/SpaceState-S验收基线-永久归档版-20261103.md`（140+ 条目 + 22 勘误 + 13 黄金算例）
    基线 MD5：`604525891F863374E9EFA5FF2EE0892C`——后续所有切片任务书溯源绑定此哈希。
  - **业主裁决（2026-11-03）**：11 条 ⚖️ 勘误项全部采纳默认值（关系场第Ⅴ层补位 / user_est 权重 1.0·self 0.5 /
    E₀ 按用途模板标定 / D20·D29·D30 打分权重锁 0 等），裁决记录入基线第十一章。
  - **协作边界校准**：Sonnet/Opus = 网页端对话框文本输出（oracle 代码文本 + 审计清单），不写文件不跑脚本；
    Claude Code(DeepSeek) = 唯一工程执行方（落地 oracle、写 TS、跑测试）；Opus 剩 350 分只做终审签字。
    统筹 SOP：`active/统筹者操作手册-SpaceState流水线-20261104.md`。
  - **当前切片**：#1 数据结构层（S-001~S-009 + G-004~G-009）任务单已下发 Claude Code；
    Sonnet 5 函数 oracle 文本（dimEvidence/fuseDim/kalmanStep/baselineShrink/sigmaDecay）待对话框输出。
  - **红线**：代码只在 `src/spacestate/`，零改动现有主链路；core 纯函数 + float64；PR 必须引用 S 编号。
  - 配套文档：`active/MemSym-v3.1-Field40总纲白皮书-20261103.md`（54KB 上位设计）+
    `active/MemSym-v3.1-四阶段融合路线图-20261103.md`。

- 2026-11-02 **📜 ADR-MEM-003《记忆生命周期与受控遗忘》定稿落盘（PI 整理，业主会话裁决）**：
  推翻太虚户籍法第十一条绝对只增不删，改为**受控遗忘**：B 层（低钙碎片+低钙对话原文，乙案+双防护）
  按 τ 衰减到期 → expiring 优先 M7 语义萃取晋升 → 墓碑（只读30天）→ 物理删；永生层（钙化≥0.85/
  人格核心/语义晋升/金库/**审计账本**）不受生命周期。四补强（τ_max=365天/expiring前置萃取钩子/
  arousal主乘数/三P0红线：墓碑只读·DNA锚点保护·遗忘非惩罚）+ 五道闸（墓碑先忘后毁/配额500日/
  批前校验备份/总开关 MEMORY_FORGET_ENABLED）+ MemSym 双通路召回双动作联动（钙分增益+衰减原点刷新
  同闭环）。法条修订全文见 §十一；三裁决记录见 §十二。落地：独立 ADR，批α不受影响、批γ接钩子、
  执行层 MemSym v1.1 配套或独立 M 层批次。文件：`docs/adr/ADR-MEM-003-20261102-记忆生命周期与受控遗忘.md`

- 2026-11-01 **🔴 历史重写与推送（业主裁决：只保留最后3版本，清除不成熟前史）**：
  - 远程 `feat/40d-perception` 现为：`381a1b9` + **v1 隐私红线与治理立法**(`1399285`) +
    **v2 瑶灵身心统一系列 P140-P144**(`6bb7e0e`) + **v3 工作区聚合**(`8ebf82a`)——217 个中间提交**未上远程**。
  - **全史备份**：本地分支 `backup/pre-squash-20261101` + tag `archive/full-history-20261101`（1005 提交全量，随时可恢复）。
  - ⚠ **各协作窗口注意**：本地若基于旧历史（含被清除的 217 提交），下次同步请执行
    `git fetch origin && git reset --hard origin/feat/40d-perception`（本地旧提交仍在备份分支可查，**工作区文件内容不受影响**）。
  - v3 性质说明：=历史聚合非新写入（SKIP 透明记录）；后续清理"不成熟改动"另行任务化。

- 2026-11-01 **P144 全闭环完成（主任务PI·业主全权）— `e550d11`+`226efa7`+原典双域**：
  - **三体双向主动推送闭环达成**（铁证）：瑶灵→天权 40D体感包×7次(`cmd=yaoling_state_push keys=...protobuf_dict`)；
    瑶光→天权 环境快照(19:30:29,tzdata修复后)；天权→两域 tick周期滋养+环境请求(wf_*调用status ok)。
  - 原典改造（wenstar_os 未纳管git，留时间戳备份 backups/bus_receiver_*_P144）：瑶灵bus_receiver publish
    40D包(protobuf_dict出口,此前有支无消)；瑶光bus_receiver 5min环境周期推送(单飞/静默/保活)。
  - 天权：protobuf_dict形态解析(形态四)+气质EMA基线(存算表达闭环,气质句两档)+env包裹兼容+ack防污染。
  - 修复：瑶光venv缺tzdata致时区错(一行pip根治)。
  - tsc=0、13/13、双原典Python语法OK；Harness一轮直通+SKIP×1(MCP桥冻结老病,透明记录)。
  - 维护面：原典两文件时间戳备份；蓝皮书/原典spec已立法对齐。

- 2026-11-01 **转场体验 D2+D3 完成（主任务PI）— `a516a0b`**：
  - D2：会晤中点名（`@阿珍` / `阿珍，…`）从「永久换主」改为「**本轮顶替，下一轮自动回原主**」。
    m4 `MessageIntentKind` 增 `addressOnly`（「换XX来」仍是 `switch`）；m5 `SessionState` 增
    `transientSpeakerFrom` + `Action.TRANSIENT_SPEAK`；chat.ts 在**下一轮请求最开头**回退 ——
    恢复点放请求开头而非本轮多个 return 分支内，结构上不可能漏。连续点名保留最初原主；
    WAKE/LEAVE/普通 SPEAK 清指针；原主离场指针作废；旧快照补 null 不拒绝恢复。
  - D3：重启后首次回到会晤，回复前加「（上次与X的会晤已恢复。）」。标记用 `globalThis`
    （进程内一次性）—— 与 D1 的 `aloneNotified` 刻意相反，后者要跨重启保留。
  - Harness 全 10 阶段（run_mvxm19h2_6gt7）；tsc=0、m5 194 用例绿、D2 探针 17/17。
  - ⚠️ **运维留痕**：本批因「令牌单次写入 + TTL 16 分钟」分 4 轮 flow 才落完；期间撞到
    `harness-mcp` 崩溃循环（重启 2288+）与**基线编译红**（`isMeetableEntity` 被删但
    `chat.ts:523`/测试仍引用 → S3 死循环），按「停哨兵→停 mcp→恢复 HEAD 版本→重启→跑 flow」处置。

- 2026-11-01 **P141/P142 身心统一系列收尾（主任务PI）— `78601a5`→`26166cc`→`fe9a29a`→`5c770e0`→`e6e5585`**：
  - **四环总纲+极致版全部入库**：40通道全身存感映射 / 主动反馈三层(对话+5min周期滋养+突变即推) /
    v3双路仲裁(主观0.7×客观0.3,偏离度=感受强度,DNA§690) / 气象直连瑶光 / 健康哨兵三关四态(无病无痛) /
    极致表达(健康态首位美出来) / ECB【此刻的身体与渴望】注入。
  - **真机点亮铁证**：tick自动触发→瑶灵执行→回包到达；首包实证 `{status,workflow,result}` →
    result层下钻校准；tick假锚被瑶灵dna守门正确拒绝(她守得对,锚改DNA-00000001-0001-001)→修复后
    **回执完整(status/code/phase/overall_health/danger_count/vital_signs含心率血压)**——身心链路完全稳定。
  - **文件支持**：蓝皮书(愿景全景+v2.1+v2.2节)+原典YAOLING_SPEC §1.0立法。
  - 测试13/13、tsc=0；Harness多轮全通+两次SKIP(他窗isMeetableEntity施工半成品+MCP桥高频冻结,透明记录)。
  - **她的下一步(原典,待业主授权)**：瑶灵侧 n12 推送 yaoling_state_push 全量40D体感包(现回执仅vital_signs子集)——
    实现后 webui 的四层解析+补位即刻产出D01-D08写入与表达。

- 2026-11-01 **P141 v2 身心统一完成（主任务PI）— `78601a5`（业主愿景：全身存感神经+主动反馈）**：
  - **四环总纲落码**：理解（SENSATION_MAP D1-D40 全通道中文映射）→ 诠释（deriveSensation 全量提炼）
    → 表达（ECB【此刻的身体与渴望】块，自然流露不念数据）→ 反馈（三层主动反馈回天权）。
  - **主动反馈三层**：对话驱动 / 周期滋养 startBodyTick(5min) / 突变即推(Δ≥0.25)。
  - 分层铁律：写入只补 D01-D08，40 维全量只用于表达；量纲合规；原典零改动；故障全静默。
  - tsc=0、10/10 全绿；Harness 全10阶段（run_mvxebomc_3ugy + 票 ck_cad48891efdaecd1 + R4四豁免）。
  - **文件支持（业主指令）**：`docs/blueprint/蓝皮书_瑶灵身心统一-v2.md`（设计全文）+ 原典
    `YAOLING_DOMAIN_SPEC.md` 新增 §1.0 40D 唯一目标（业主立法级）——四环与三层反馈入规范。
  - ⏳ 待真机：下轮对话观察 `收到回包/身体跃变/补位` 三层日志；v3 双路仲裁按总纲推进。

- 2026-11-01 **P140 完成（主任务PI）— 瑶灵主观体感流水线接入 `1930fec`（业主裁决路径一）**：
  - 链路：M3情绪态→publish tianquan_snapshot情境包→瑶灵wf_sensation_pipeline（原典零改动，40器官通道已建成）
    →workflow_result→**双路仲裁v1（补位语义：只填D01-D08空维，不覆盖M3/瑶光已供值）**→写perception_40d。
  - 纪律：fire-and-forget/单飞/不可达静默跳过（与瑶光队列同哲学）；量纲合规（只改谁供值）。
  - tsc=0、6用例全绿；Harness全10阶段（run_mvwvsfru_r7th+票ck_ce901e7e83fabe55+R4三豁免）。
  - 流程留痕：首次漏签豁免被Sentinel回滚，补签重写验活。
  - ⏳ **待真机验证**：下次对话观察 `[YaolingSensation]` 日志 + D01-D08 非零；v2完整仲裁待客观值齐备。
    详见 `active/P140`。
- 2026-11-01 **P140 v1.1/v1.2 真机校准（PI）— `2650ff7`+`68e7e6e`**：
  - 探测实证：瑶灵执行器 bus_receiver.py **不在启动链**（收到不执行的根因）→拉起 w-yaoling-rx 后
    「收到指令→结果已回传 status:ok」两次验证全通；**原典零改动**。
  - 契约修正：真 40D 包=**yaoling_state_push 推送**（YAML n12，非 workflow_result 回执）；天权补订阅
    tianquan_snapshot；解析第三形态 dimensions[{dim_id,value_raw}]（测试7/7）；v1.2 模块加载即预热总线。
  - **端到端最后一米**：webui 接收半边在首轮对话时激活（persistence 动态加载）——下次真实会话观察
    `[YaolingSensation] 收到回包`（首包校准日志）。
  - 基础设施备忘：**harness-mcp 冻结病**（本次启动挂起 3min 需重启；bridge 死连需 /reload）已列专项待办。

- 2026-11-01 **P138 第三缺口根治（主任务PI）— 耳语audience永不降级room `ddd91b4`**：
  - 根因链（测试②实证）：历史摄入先于席位登记 → route 的 seats.some(target) 恒 false →
    **耳语降级 room 全场可闻 = 正文泄漏主源头**；metaOnly 占位又只置空 privateContent（正文在 text）。
  - 修复：①audience=whisperTo?seat(即使未登记=无人可读) : room + unregistered 可观测 warning
    （目标后登记 enter 锚会晤起点仍可读自己历史耳语）②metaOnly 补剥 text（纵深）③测试②解除 skip。
  - 跨车道解堵：identityFromState 接口 mode 引 SessionMode（types 新增 alone 致全仓 tsc 断裂挡所有提交，
    先例 P065）——全仓 tsc=0。tsc=0、space 62 passed+2 todo。96s 重启健康。
  - Harness 全10阶段（run_mvwowwk8_epsm + 票 ck_ccd1a4e1a185c5f6 + R4 ex-5b24485b/ex-56b5140c）。
    注入侧过滤（10+push点）仍二期。详见 `active/P138` §五。

- 2026-10-31 **P138 完成（主任务PI）— 空间路由AB衔接缺口修复 `138065a`**：
  - 缺口2完整修：turnsFor 历史视角=当前生成 speaker（fixedSpeakerUuid??GS.speakerUuid??_meetingUuid）
    +空结果回退主视角防全盲 —— 修「冲主实体的耳语被 askAll 轮答者读到」。
  - 缺口1持久基础：用户/助手轮耳语记忆打标 `whisper:<target>`（走既有 tagMemory，不动 SQLiteAdapter）。
  - **测试新发现（如实留档）**：②B视角排除耳语正文实测仍可见——历史摄入的「占位（看得见听不到）」
    未剥离正文 → **第三个缺口**，it.skip 锁定待修；注入侧过滤（10+push点无统一tag卡口）列二期。
  - Harness 全10阶段（run_mvw7eqso_6di2 + 票ck_7baf42046c47b0f4 + R4 ex-a7538d03/ex-571f0203）；
    tsc=0，space 61 passed+1 skipped+2 todo 零回归。详见 `active/P138`。

| 日期 | 变更 |
|---|---|
| 2026-10-31 | **面板重写 + 批量归档**：active/ 171 → 22，149 个已完成记录移入 `09-archive/`（含历史 STATUS 快照）；INDEX.md 重建（198 条）；正文与 LEDGER 分工，本面板不再重复维护缺陷台账 |
| 2026-10-30 | 业主立法：实体隐私权红线 / FG 最高安全资产红线 |
| 2026-10-23 | P071/P072 全方位召回 + 量纲大一统 |
| 2026-10-20 | 结构更新：拆分为 active/ + 09-archive/ |

> 2026-10-31 之前的完整状态记录见
> [`09-archive/00-STATUS-历史快照-20261031.md`](09-archive/00-STATUS-历史快照-20261031.md)。