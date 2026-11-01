---
id: STATUS
type: status
title: 协作区当前状态面板
author: both
status: active
created: 2026-10-08
updated: 2026-10-31
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

**豆包负责验收把关，任何一项落空都不算完成，必须返工。**

---

## 当前状态（2026-10-31）

- **分支**：`feat/40d-perception`
- **主线**：**空间路由器三层拆除全部完成** —— 开关与旧状态机已彻底删除，GroupSession 成为会晤/群聊状态的唯一真源；四类实机缺陷（耳语 / 独处 / 本体席位 / 席位名污染）已修复
  并实机验证。
- **质量**：`tsc` 零错误 ｜ 260 个用例全通过（14 文件）
- **阻塞项**：无（harness-mcp 已于 2026-10-31 由业主修复）

### 最近主线（git 实证）

| commit | 内容 |
|---|---|
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

## 🚧 进行中（1 项）

`active/P137-20261030-PI-隐私守卫同类盘点与徐诗雨身高解除.md`

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