# V27 结构修复 — 会晤路径铁律接入 PAS assembler

> 变更日期: 2026-09-20
> 变更类型: 架构级（arch_structural）
> 影响文件: `src/m4/household/EntityContextBuilder.ts` / `src/webui/chat.ts`
> 关联: 批20（补丁尝试，已回退，Harness 自动登记债务 debt_mu8xgcez_uztpd7）

---

## 一、根因（为什么必须做，而不是逐个去重）

会晤模式的原链路中，铁律是**以纯文本形式拼进 `EntityContextBuilder.systemText`** 的，
而 `chat.ts` 的通用守卫（如 `memoryGuard`）走 `allGuardMsgs`（history 通道）——
**两条通道各注入一次，同一规则出现两遍**。

更深层的问题：`EntityContextBuilder` 是**会晤专用路径**，它**绕过 PAS assembler**，
使批2 立法 P-01「单一真源」无法覆盖它 —— 会晤路径形成**与主链路平行的第二套铁律**。

**批20 的教训**：对已存在的重复「逐个去重」是补丁（Harness S4.5 正确判定为 patch）；
真正的解是**把铁律归位到唯一承载层**，让重复在机制上不可能发生。

## 二、修复方案

| 步骤 | 内容 |
|---|---|
| ① | `EntityContextResult` 增加 `rules?: Array<{id, content}>` |
| ② | 5 条铁律从 `parts`（systemText）移出 → `rules`（**原文一字不改，仅换承载通道**）|
| ③ | `chat.ts` 保存 `ecResult.rules`，注册为 assembler 的 `hardRule` |
| ④ | `memoryGuard`（权威版，含 S2-R4）从 `allGuardMsgs` 移出 → 注册为同 id `entity_past_boundary` |
| ⑤ | 修正注册顺序（override = 后注册者胜，memoryGuard 最后）|
| ⑥ | 铁律注册**不设** `WS_NO_CONTENT_FILTER` 开关（安全底线不受调试开关影响）|
| ⑦ | 新增 `[铁律·去重校验]` / `[Assembler·块]` 观测埋点 |

**去重机制**：`PromptAssembler.add()` 同 id + `conflictPolicy:'override'` → 后注册者覆盖，
**同一条规则无论被多少路径注入，最终只留一份**。

## 三、白皮书更新摘要（架构层）

**标题：九层管线 — 会晤上下文装配与 PAS 的统一**

1. **架构图变更**：会晤路径的「铁律注入」不再属于 M4（EntityContextBuilder）的
   systemText 输出，而是经 `rules` 契约上浮至 chat.ts 编排层，统一由 PromptAssembler 承载。
   M4 只负责「产出规则内容」，chat.ts 负责「注册到唯一承载层」。
2. **接口契约变更**：`EntityContextResult` 新增 `rules` 字段（向后兼容，optional）。
   `systemText` 的职责收窄为档案/记忆内容，不再含铁律。
3. **单一真源（PAS P-01）覆盖范围扩展**：原覆盖 `core-rules.ts` / `rules.ts` / `personality.ts`，
   现覆盖会晤路径的全部安全铁律 —— 会晤路径不再是 P-01 的盲区。
4. **数据流变更**：`EntityContextBuilder.rules → chat.ts → PromptAssembler(hardRule) →
   render() → finalKnowledgeText`。最终注入顺序：实体档案在前、assembler 块在后（S2-R2 不变）。

## 四、蓝皮书更新摘要（模块功能）

**标题：m4/household 与 webui 的职责边界收窄**

1. **`EntityContextBuilder`（M4）功能说明更新**：新增「铁律结构化输出」职责 ——
   返回 `rules` 数组供上层注册；不再负责把铁律拼进 `systemText`。
2. **`chat.ts` 编排职责更新**：新增「铁律归位」职责 —— 把 M4 的 `rules` 与本地
   `memoryGuard` 注册到 PromptAssembler，依赖其 override 机制去重。
   新增观测日志 `[铁律·去重校验]`（各铁律出现次数）与 `[Assembler·块]`（块清单）。
3. **配置项**：无新增/变更配置项（铁律不受 `WS_NO_CONTENT_FILTER` 控制，与原行为一致）。

## 五、回滚方案

**代码回滚**：`git revert <commit>` 或 `git checkout HEAD~1 -- src/m4/household/EntityContextBuilder.ts src/webui/chat.ts`
（本次改动集中在 2 个文件，无数据迁移、无库结构变更，回滚安全）

**回滚后的行为**：铁律回到 `systemText`（会晤路径），memoryGuard 回到 `allGuardMsgs`；
重复问题重新出现，但不影响功能正确性。

**备份**：`D:/tmp/ECB-before-b21.ts`（EntityContextBuilder 改前）、`D:/tmp/chat-before-b21.ts`（chat.ts 改前）

## 六、验证证据

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| 单元测试 | 758 passed / 3 skipped |
| `[铁律·去重校验]` | 自称铁律=1 记忆优先于标签=1 回忆≠编造=1 过去的法定分界线=1 记忆即事实=1 ✅ |
| `[Assembler·块]` | entity_self_title:122 entity_memory_priority:112 entity_recall_not_fabrication:114 entity_past_boundary:559 entity_memory_fact:142 memory_context:2580 |
| 顺带修复 | `WS_NO_CONTENT_FILTER=true` 时「共同过去」原只得简版(487)，现无条件注入权威版(559，含 S2-R4) ✅ |

## 七、S4.5 十四项确认

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 1 | ARCH_M_LAYER_NO_REVERSE_DEP | ✓ | EntityContextBuilder 仅 import `./FamilyGraph.js` / `./shared/RelationLabels.js` / `./EntityGreetingProtocol.js`（均同层），无 M5+ 反向依赖 |
| 2 | ARCH_CHAT_TS_THIN | ✓ | chat.ts 改动 54+/1-，全部为「保存 rules」「注册到 assembler」「注释」「埋点」，无新增业务逻辑 |
| 3 | FG_REDLINE_2 | ✓ | 未新增任何 familyGraph 取数调用；仅改规则承载通道，分支数据隔离逻辑未触及 |
| 4 | COUPLING_CHAT_TS_22SEG | ✓ | `finalKnowledgeText` 拼接顺序未变（实体档案在前 + assembler 块在后，S2-R2 保持）|
| 5 | COUPLING_MEETING_NAME_POINTS | ✓ | 14 点 L0-L13 全部核验；本次仅影响 L2（档案），已同步更新其 desc/via（`buildEntityContext() → ecResult.rules → PromptAssembler`）；L0/L1/L3-L13 未触及 |
| 6 | RISK_IMPORT_DEP_ASSESS | ✓ | 无 import 变更；`hardRule`/`PromptAssembler` 原已 import（chat.ts:2119）|
| 7 | RISK_NO_HARDCODED | ✓ | 新增行无人名、无时间常量（已 grep 6 个人名 + ISO/时间模式）|
| 8 | 文档同步 | ✓ | 本文档含白皮书摘要（4 条）+ 蓝皮书摘要（3 条）+ 回滚方案 |
| 9 | DOC_M_LAYER | ✓ | 见 §三.1、§三.2、§四.1 |
| 10 | DOC_CHAT_TS | ✓ | 见 §三.4、§四.2 |
| 11 | DOC_SERVICE | ✓ | 无服务层变更（配置项无增删）|
| 12 | DOC_MIN_SUMMARY | ✓ | 白皮书 4 条 / 蓝皮书 3 条 / 回滚方案 详见本文件 |

---

**注**：本文档同时作为 Harness S2 重审要求的「架构优化方案 + 未达标根因说明」。
**连续轮次未达标根因**：前两轮（批20 patch、S2 首轮）提交的是**代码方案**，
未附 S4 要求的「逐项确认证据」与「配套文档」——S4.5 的评分维度包含文档与确认项，
缺失即判不通过（85.7% = 12/14 项通过，缺 2 项文档类）。
