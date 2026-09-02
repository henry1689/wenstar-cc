# 太虚境治理文件总索引（GOVERNANCE）

> 🔴 **本文件是全部治理文件的唯一权威入口。改动任何代码/数据前，先读本表对应的法律/规约。**
> Canonical 主板块：`D:\tools\wenstar-cc`
> 最后更新：2026-09-03（治理文件收编后）

---

## 效力层级总表

**上位规范优先于下位规范。下位不得与上位抵触。**

| 层级 | 文件 | 版本 | 职责（一句话） |
|:--:|------|:--|------|
| ① | [太虚境户籍管理法](data/knowledge-v4/governance/taixu-household-registration-law.md) | V2.1 | 实体身份登记（TXS-ID 身份证/户口） |
| ①' | [UUID户籍管理法](data/knowledge-v4/governance/uuid-household-registration-law-v1.0.md) | V1.0 | 数据流动执法（五道闸门/六大铁律） |
| ② | [FG 亲属关系红线](data/knowledge-v4/governance/redlines/fg-kinship-redlines.md) | V3.5 | FG 操作铁律 |
| ② | [知识库红线](data/knowledge-v4/governance/redlines/knowledge-redlines.md) | — | 知识库操作铁律 |
| ③ | [户籍制落地蓝皮书](data/knowledge-v4/governance/household-registration-blueprint.md) | V4.0 | 户籍制技术落地 |
| ③ | [DNA 遗传编码强制规范](data/knowledge-v4/governance/dna-encoding-mandatory-v1.md) | V1 | DNA 编码框架与执行铁律 |
| ③ | [DNA 双螺旋编码规范](data/knowledge-v4/governance/dna-double-helix-encoding-v2.0.md) | V2.0 | DNA 双螺旋完整编码 |
| ③ | [天权工程蓝皮书](data/knowledge-v4/governance/tianquan-engineering-blueprint-v3.0.md) | V3.0 | 天权工程架构 |
| ③ | [三体全域仿生白皮书](data/knowledge-v4/governance/tianquan-tribody-whitepaper-v3.0.md) | V3.0 | 三体全域仿生认知系统 |
| ④ | [PAE 档案采集引擎](data/knowledge-v4/governance/pae-profile-acquisition-engine.md) | V3.3 | 人物档案 LLM 采集 |
| ④ | [实体生命周期治理](data/knowledge-v4/governance/entity-lifecycle-governance.md) | V1.0 | 实体四态流转 |
| ④ | [系统健康守卫](data/knowledge-v4/governance/system-health-guard.md) | V1.0 | 完整性守护 |
| ④ | [编码体系规约](docs/编码体系规约.md) | V1.1 | 编码规范 |
| ④ | [FG 档案录入治理](docs/fg-profile-entry-governance.md) | — | FG 档案录入管控 |
| ⑤ | [FG 亲属白皮书](docs/blueprint/白皮书_fg-kinship-v4.md) | V4 | FG 亲属关系设计 |
| ⑤ | [上下文注入蓝皮书](docs/blueprint/蓝皮书_context-injection-v10.md) | V10 | 上下文注入 |
| ⑤ | [会晤模式蓝皮书](docs/blueprint/蓝皮书_meeting-mode-v5.md) | V5 | 会晤模式 |
| ⑤ | [双版本白皮书](docs/双版本升级/01-太虚境双版本白皮书.md) | — | 双版本升级 |
| ⑤ | [双版本蓝皮书](docs/双版本升级/02-太虚境双版本蓝皮书.md) | — | 双版本升级 |
| ⑤ | [双版本技术规范](docs/双版本升级/04-太虚境双版本技术规范.md) | — | 双版本升级 |
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
docs/adr/  （编号 001-009，已修复编号冲突）
```

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
