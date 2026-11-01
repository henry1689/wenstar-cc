# 太虚境治理文件总索引（GOVERNANCE）

> 🔴 **本文件是全部治理文件的唯一权威入口。改动任何代码/数据前，先读本表对应的法律/规约。**
> Canonical 主板块：`D:\tools\wenstar-cc`
> 最后更新：2026-11-02（P145 批 D：真值规范 V3.0 + 运维审计规范 V1.0 入表，ADR-015 登记）

---

## 效力层级总表

**上位规范优先于下位规范。下位不得与上位抵触。**

| 层级 | 文件 | 版本 | 职责（一句话） |
|:--:|------|:--|------|
| ① | [太虚境户籍管理法](data/knowledge-v4/governance/taixu-household-registration-law.md) | V2.1 | 实体身份登记（TXS-ID 身份证/户口） |
| ①' | [UUID户籍管理法](data/knowledge-v4/governance/uuid-household-registration-law-v1.0.md) | V1.0 | 数据流动执法（五道闸门/六大铁律） |
| ② | [FG 亲属关系红线](data/knowledge-v4/governance/redlines/fg-kinship-redlines.md) | V3.5 | FG 操作铁律 |
| ② | [知识库红线](data/knowledge-v4/governance/redlines/knowledge-redlines.md) | — | 知识库操作铁律 |
| ② | [实体隐私权红线](data/knowledge-v4/governance/redlines/entity-privacy-redlines.md) | V1.0 | 实体同等隐私权/中性用词/不外传/处置权唯一归业主 |
| ③ | [户籍制落地蓝皮书](data/knowledge-v4/governance/household-registration-blueprint.md) | V4.0 | 户籍制技术落地 |
| ③ | [DNA 遗传编码强制规范](data/knowledge-v4/governance/dna-encoding-mandatory-v1.md) | V1 | DNA 编码框架与执行铁律 |
| ③ | [DNA 双螺旋编码规范](data/knowledge-v4/governance/dna-double-helix-encoding-v2.0.md) | V2.0 | DNA 双螺旋完整编码 |
| ③ | [天权工程蓝皮书](data/knowledge-v4/governance/tianquan-engineering-blueprint-v3.0.md) | V3.0 | 天权工程架构 |
| ③ | [三体全域仿生白皮书](data/knowledge-v4/governance/tianquan-tribody-whitepaper-v3.0.md) | V3.0 | 三体全域仿生认知系统 |
| ③ | [真值、主体与世界域专项规范](data/knowledge-v4/governance/wenstaros-truth-subject-world-domain-v3.0.md) | **V3.0** | 真值判定 / 主体标识 / 世界域 / **记忆体系 A/B 双链路接口规范**（2026-11-02 首个实体化版本） |
| ④ | [PAE 档案采集引擎](data/knowledge-v4/governance/pae-profile-acquisition-engine.md) | V3.3 | 人物档案 LLM 采集 |
| ④ | [实体生命周期治理](data/knowledge-v4/governance/entity-lifecycle-governance.md) | V1.0 | 实体四态流转 |
| ④ | [系统健康守卫](data/knowledge-v4/governance/system-health-guard.md) | V1.0 | 完整性守护 |
| ④ | [记忆系统运维审计规范](data/knowledge-v4/governance/memory-ops-audit-standard-v1.0.md) | **V1.0** | 记忆域留痕义务 / 停服备份 / 法典修订五步流程 / 告警分级 |
| ④ | [编码体系规约](docs/编码体系规约.md) | V1.1 | 编码规范 |
| ④ | [FG 档案录入治理](docs/fg-profile-entry-governance.md) | — | FG 档案录入管控 |
| ④ | [FG 结构规范](docs/FG-结构规范-V1.0.md) | V1.0 草案 | FG nodes/dossier/edges 结构 + 采集/去重/读取规范（2026-10-21 T010，待验收） |
| ⑤ | [FG 亲属白皮书](docs/blueprint/白皮书_fg-kinship-v4.md) | V4 | FG 亲属关系设计 |
| ⑤ | [上下文注入蓝皮书](docs/blueprint/蓝皮书_context-injection-v10.md) | V10 | 上下文注入 |
| ⑤ | [会晤模式蓝皮书](docs/blueprint/蓝皮书_meeting-mode-v5.md) | V5 | 会晤模式 |
| ⑤ | [双版本白皮书](docs/双版本升级/01-太虚境双版本白皮书.md) | — | 双版本升级 |
| ⑤ | [双版本蓝皮书](docs/双版本升级/02-太虚境双版本蓝皮书.md) | — | 双版本升级 |
| ⑤ | [双版本技术规范](docs/双版本升级/04-太虚境双版本技术规范.md) | — | 双版本升级 |
| ④ | [改前必查·系统重建与模块影响面](docs/改前必查-系统重建与模块影响面.md) | — | 场景A：改代码前必读 |
| ④ | [Bug 修复六步闸门](docs/bug修复六步闸门.md) | — | 场景B：修 bug 流程 |
| ④ | [系统不变量与危险信号](docs/系统不变量与危险信号.md) | — | 场景C：评估方案/判补丁 |
| ④ | [变更后核验与强制复审](docs/变更后核验与强制复审.md) | — | 场景D：改完之后必读 |
| ④ | [代码质量铁律与整改](docs/代码质量铁律与整改.md) | — | 场景E：代码审查/质量整改 |
| ④ | [会晤记忆与测试调试根因](docs/会晤记忆与测试调试根因.md) | — | 场景F：记忆/会晤/检索调试 |
| ④ | [研发台账](docs/LEDGER.md) | — | **单一真相源**：做到哪了/问题/计划处理时间 |
| ⑥ | [灵肉伴侣五重铁律](data/knowledge-md/灵肉伴侣·五重铁律协议.md) | — | 亲密关系铁律 |
| ⑥ | 天权域规范（[TIANQUAN] 系列） | — | `data/knowledge-md/[TIANQUAN] *.md` |
| ⑥ | 瑶灵域规范（[YAOLING] 系列） | — | `data/knowledge-md/[YAOLING] *.md` |

---

## 归档区（历史版本，不具现行效力）

```
data/knowledge-v4/governance/_archive/
├── 天权工程蓝皮书V2.0.md   （已被 V3.0 取代）
├── 三体白皮书V1.0.md        （已被 V3.0 取代）
└── 三体白皮书V2.0.md        （已被 V3.0 取代）
```

---

## 决策记录（ADR）

```
docs/adr/  （编号 001-015 + ADR-MEM-*，序号唯一：新 ADR = 当前最大 +1 = 016）
├── ADR-001 ~ 009                （L0 纯规则 / 分类生长 / 最小语义单元 / m1-m2 边界 / 冷启动
│                                  / 分离原则 / 模块边界 / 钙化统一 / chat 拆分）
├── ADR-010-dialog-group-memory-unit.md        （记忆单元由单消息迁移至对话块，2026-10-06）
├── ADR-011-memory-retrieval-orchestration.md  （记忆「取」的架构：分层候选 + 统一编排，2026-10-06）
├── ADR-012-FG法律对齐架构决策.md              （FG：单一字典 + 单一采集引擎 + 单一读取入口，2026-10-21 草案）
├── ADR-014-20261026-...                        （⚠️ 已归档废弃，内容并入 ADR-MEM-002）
├── ADR-015-20261102-AB双链路记忆架构与B链路卷宗化.md  （★ A/B 双链路定稿 + B 链路卷宗化，2026-11-02）
├── ADR-MEM-002-...                             （MemSym 双通路记忆共生协议，法条本文）
└── ADR-MEM-003-20261102-...                    （记忆生命周期与受控遗忘，M 层基础法案）
```

> ⚠️ **编号沿革（两处历史误记，已核实）**：
> ① `ADR-011` 在《P0 记忆体系止血任务书》V1–V3 中被记为「ADR-0012」；
> ② T002 任务书 §Phase 5 要求的「ADR-0012（双链路架构）」—— 该号早已被 FG 法律对齐占用。
> 双链路 ADR 实际编号为 **ADR-015**（2026-11-02 落地，见其 §〇 编号更正）。
> **ADR-013 在 `docs/adr/` 中无实体文件**（仅被 ADR-014 引用过一次），编号不复用。

---

## 治理纪律（本次收编确立）

1. **唯一入口**：治理文件一律以本表为准；新增治理文件必须登记到本表。
2. **单一 canonical**：规范只存一份于 `D:\tools\wenstar-cc`，外部目录（D:\wenstar）仅留指针。
3. **版本唯一**：同一主题只保留最新版，旧版归档 `_archive/`，不并存。
4. **动手前必读**：改动代码/数据前，先定位本表对应层级文件并读完。

---

## 📁 文档归档分类规则（后续新增文档必守·铁律）

> 🔴 **后续新增任何文档，必须按以下分类存入 canonical 权威路径，禁止散落他处、禁止重复、禁止多版本并存。**

| 文档类别 | 权威路径 | 命名规范 |
|---------|---------|---------|
| 法律（户籍/UUID/宪法） | `data/knowledge-v4/governance/` | 英文小写 kebab-case，如 `xxx-law-v1.0.md` |
| 红线 | `data/knowledge-v4/governance/redlines/` | 英文小写 kebab-case |
| 核心规约/蓝皮书 | `data/knowledge-v4/governance/` | 英文小写 kebab-case |
| 设计蓝皮书/白皮书 | `docs/blueprint/` | `白皮书_主题-vN.md` / `蓝皮书_主题-vN.md` |
| 编码/录入规约 | `docs/` | 中文主题名，如 `编码体系规约.md` |
| 域规范（天权/瑶灵） | `data/knowledge-md/` | `[TIANQUAN]` / `[YAOLING]` 前缀 |
| 决策记录 ADR | `docs/adr/` | `ADR-{3位序号}-{主题}.md`（序号连续不冲突） |
| 变更台账 | `docs/blueprint/` | `变更台账_{日期}_{主题}.md` |
| 历史版本归档 | `data/knowledge-v4/governance/_archive/` | 保留原文件名 |

**五条铁律：**

1. **先登记后落盘**：新增治理文档必须先登记到本文档「效力层级总表」，再写入文件。
2. **单一 canonical**：只存一份于 `D:\tools\wenstar-cc`；禁止在 `D:\wenstar` 等外部目录新增治理文档。
3. **版本唯一**：同主题只保留最新版，旧版移入 `_archive/`，不并存、不覆盖。
4. **单一格式**：一律 `.md`，禁止 `.md`/`.txt` 双格式镜像。
5. **ADR 序号唯一**：新 ADR 取当前最大序号 +1，禁止重号。
