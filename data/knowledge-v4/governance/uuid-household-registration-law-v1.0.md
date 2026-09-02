# UUID 户籍管理法 WS-HUKOU-LAW-V1.0

> 文曲星·太虚境 — 管线执法法（数据流动的公安执法）
> 版本：V1.0 · 颁布日期：2026-08-07 · 生效日期：系统下一次重启
> 上位法衔接：**太虚境户籍管理法 V2.1**（`taixu-household-registration-law.md`，管实体身份登记）· **本法**（管数据流动的公安执法）
> 对标现实法律：《中华人民共和国居民身份证法》《户口登记条例》《反电信网络诈骗法》（执法条款）
> 效力层级：法律 > 红线 > 本蓝皮书 > PAE > 代码
> 关联：[三体对接联调标准-WS-TRIBODY-LINKUP-V1.0.md](三体对接联调标准-WS-TRIBODY-LINKUP-V1.0.md) · [fg-kinship-redlines.md](../../tools/wenstar-cc/data/knowledge-v4/governance/redlines/fg-kinship-redlines.md)

---

## 第一章 总则

**第一条 立法目的**
将隐私隔离从"关键词过滤"升格为"**UUID 户籍管理**"。每个实体的 UUID 就是其户籍档案保险柜，全系统所有管线、所有链路、只要有输入输出，必挂 UUID 公安过滤器，形成铜墙铁壁。

**第二条 适用范围**
六类存储（`memories` / `conversations` / `knowledge_base` / `black_diamond` / `vault_log` / `search_index`）+ 全部输入输出链路（会晤、检索、知识库、LLM 边界、HTTP 响应）。

**第三条 核心定义**
- **户籍档案夹**：`entities.uuid`（TXS-ID）对应的实体档案
- **公安过滤器**：`UUIDPoliceFilter`（`src/governance/police/`）
- **户籍门阀**：`UUIDGatekeeper`（`src/m4/household/`）
- **最高权限钥匙**：户主钥匙（用户本人 UUID）

**第四条 六大铁律**（与 V2.1 第六条呼应）
1. **户口唯一**：每个实体唯一 TXS-ID，born-with，永不复用
2. **登记义务**：任何写入必须先确定 `belong_entity_uuid`，缺户口者拒绝写入
3. **流动必查**：所有管线所有链路只要有输入输出，必挂公安过滤器
4. **deny-by-default**：不在白名单 = 拒绝；无归属记录仅户主钥匙可见
5. **最高权限钥匙**：档案调取唯一授权 = 用户本人；他人调取必须用户临场授权
6. **全程留痕**：每次放行/拦截生成审计事件（AuditEvent）

---

## 第二章 户籍登记义务（对应写路径）

**第五条 会晤写入强制**
会晤模式 `belong_entity_uuid` 强制 = 会晤实体 UUID。用户会晤时说的每一句话，从产生到落盘都绑定当前实体 UUID，强相关。

**第六条 禁止推断覆盖**
`entity_genes` / 自称检测不得覆盖会晤户口。会晤激活时，归属唯一来源 = `entityMeeting.getEntityUUID()`。

**第七条 无户口写入拒绝**
`resolveOwnership` 返回 null 时，仅户主钥匙场景可写（打 unowned 标记）；会晤场景直接抛 `WriteNotAuthorizedError`。

---

## 第三章 五道闸门（本法的核心）

**第八条 第一道闸门 · 写入闸门**
挂载：`persistence-stage.ts`（resolveOwnership 前置）
会晤强制 belong_entity_uuid = 会晤实体 UUID；禁止 entity_genes 推断覆盖。

**第九条 第二道闸门 · 搜索闸门**
挂载：`SQLiteAdapter._entityUuidClause` + `UnifiedSearchEngine`×4 + `KnowledgeEngine` + `retrieval-stage` + `MeetingContextPipeline`
收编为 `UUIDPoliceFilter.buildSqlClause` 唯一公共子句；空白名单 → `AND 1=0`（fail-closed）。

**第十条 第三道闸门 · 组织 LLM 资料闸门**
挂载：`chat.ts` `finalKnowledgeText` 汇聚点 + PFC 输出
统一执行 `UUIDPoliceFilter.screenContext`，不属于当前白名单的片段剔除。

**第十一条 第四道闸门 · 上下文提取闸门**
挂载：`chat.ts` 会晤上下文恢复 + `EntityContextManager`
名字过滤改 UUID；删 `content LIKE` 兜底。

**第十二条 第五道闸门 · 最后说话闸门**
挂载：`DeepSeekLLMProvider`（LLM 边界）+ `server-chat-routes`（HTTP 响应）
LLM 边界 + 响应前双闸校验。

**第十三条 闸门不得短路**
任一闸门异常必须 fail-closed（宁拒不放）。

---

## 第四章 最高权限钥匙

**第十四条 钥匙唯一性**
用户本人 UUID = 唯一 MasterKey。

**第十五条 档案调取**
跨实体调取一律走 `assertWriteAuthorized`；他人调取需用户显式 intent（`grantTemp` 单次授权）。

**第十六条 授权留痕**
全部授权决策经 `recordAuthorizationDecision` 进审计。

---

## 第五章 监督员

**第十七条 监督员在岗**
`UUIDSupervisor` 周期巡检（纯只读）。

**第十八条 巡检项**
登记率 / 逃生口扫描 / 泄露探针 / 闸门拦截统计 / 白名单一致性。

**第十九条 台账与看板**
监督台账 + `/api/household/dashboard` 渲染。

---

## 第六章 违规责任

**第二十条 违规分级**
寄存器外写入 / 逃生口复现 / 越权调取 → FAIL 阻断。

**第二十一条 追溯**
审计事件全链路可回溯；卷宗只增不删。

---

## 第七章 生效与引用

**第二十二条 生效方式**
所有 AGENT 无条件遵守（写入 CLAUDE.md 铁律 0.4）。新代码必须走 `UUIDPoliceFilter`，禁止手写 UUID SQL。

---

> **实施对照**：五道闸门代码落地见 `D:\tools\wenstar-cc\src\governance\police\UUIDPoliceFilter.ts`；监督员见 `src\governance\police\UUIDSupervisor.ts`。
