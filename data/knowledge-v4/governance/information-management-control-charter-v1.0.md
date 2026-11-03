# WenStar OS 信息管理系统管控总纲 V1.0

> **文档编号**：WS-GOV-INFO-CHARTER-V1.0
> **颁布**：2026-10-26 · 业主指令「统一纳入信息管理系统，先写方案确认后实施，正式文件作为维修依据」
> **效力**：二级治理文件（仅次于户籍法/量纲法令等一级刚性法）——**本总纲是写入、检索、生成三链全部管控节点的唯一权威地图与维修依据**
> **上位法**：《40D 量纲统一法令》《UUID 户籍管理法》《太虚境户籍管理法》《DNA 双螺旋编码规范》《天权工程蓝皮书》

---

## 一、三链管控拓扑（全节点地图）

### 1.1 写入链（信息进入系统的闸门序列，按序必经）

| 序 | 管控节点 | 位置 | 职责 | 法源 |
|---|---|---|---|---|
| W1 | **M1 DNA 编码管道** | `m1/DNAEncoder` 12 节点 | 文本→L0-L3 编码 + GlobalUID + scene_tags，全规则驱动禁 LLM | DNA 编码规范 |
| W2 | **SurprisalGate 惊讶度写入门** | `m3/SurprisalGate.ts` | 写入前判信息量，低新奇+低钙化冗余不入金库 | 惊讶驱动巩固 |
| W3 | **ForesightDetector 前瞻识别** | `m3/ForesightDetector.ts` | 事实记忆 vs 前瞻计划/承诺分离 | V13 规则 |
| W4 | **M3 感知与钙分** | `m3/PerceptionAnalyzer` + `M3LogicOrchestrator` | 40D 感知产出（原生）+ 钙化评分 + 情绪标签 + 场景基线 | 40D 法令 |
| W5 | **UUID 写入闸门** | `persistence-stage` resolveOwnership | 无户口拒写；会晤强制=会晤实体 UUID；禁止推断覆盖 | 户籍法第八条 |
| W6 | **writeMemory 唯一公共写入口** | `m2/SQLiteAdapter.writeMemory` | 列清单收口（防 REPLACE 静默清列，D8 根治先例）；40D 恒写 | 收口不变量 |
| W7 | **DualHelixWriter 寻址链写入** | `m2/DualHelixWriter` | ATL 藤蔓组(vine)+归属(TXS-ID)+路由戳 | DNA 双螺旋 |
| W8 | **隔离与分类标记** | persistence-stage | namespace='test' 测试隔离(#D)、roleplay 会晤标记(P038)、belong_entity_uuid | #D/P038 裁决 |
| W9 | **去重防抖** | `_isDuplicateNewWrite` + flush 防抖链 | 同原文去重、150ms 合并写、50 次硬上限 | 数据健康 |
| W10 | **AQC 质检侧车** | AQC 引擎 | 只读质检，永不修改/阻塞管道 | 白皮书 |

### 1.2 检索链（信息取出的中枢分配——**检索端确为中枢统一分配**）

```
retrieval-stage（runRetrieval 总入口）
 ├── 会晤隔离墙（提前 return，I007 命中实体数=1 防线）
 │    ├── MeetingOrchestrator 统一中枢 → SearchOrchestrator 适配器注册表
 │    │     （dialog_group / high_calcium / meeting 三路 + 知识库/黑钻/砂金域）
 │    ├── EntityMem 通道 + 联想V1（全历史40D，原生 p40）
 │    └── 会晤40D重排（S2-R5，原生 p40）
 └── 主链（非会晤）
      ├── M4Orchestrator.retrieveMultiRankForSearch → MemoryRetriever 六路并行
      │     emotion(情感)/keyword(n-gram)/spine(40D语义联想+DUAL_CHAIN寻址先行)/locus(话题)/entity(UUID)/work(作品)
      │     —— 每路查询向量唯一来源=M3 原生 p40（情感路待整改见§四）
      ├── UnifiedSearchEngine searchV13 七层管线（RRF 融合 + DAG闭包 + 40D L6.5精排 + MMR）
      └── V11 兜底（n-gram→40D 精排，p40 透传）
```

**序检闸门（横切所有检索路）**：
- **UUIDPoliceFilter**（搜索闸门，第九条）：`buildSqlClause` 唯一公共子句，deny-by-default，空白名单 `AND 1=0`
- **FiveStageGate 五级闸门**：G1 语义初筛（spine 路 floor=0.3 路内执行）→ G2 时空 → G3 衰减 → G4 意图（isActiveRecallIntent 同源正则）→ G5 话题壁垒——挂载于 retrieveMultiRank 出口与 retrieveMemories
- **UUIDGatekeeper**（`m4/household`）：三层白名单（base/session/tempGrants）+ 知识库 visible_entity_uuids
- **会晤隔离墙 + 命中实体数=1**：跨实体串档最后防线（P075 实测零串档）

### 1.3 生成/输出链（信息抵达 LLM 前的闸门序列）

| 序 | 管控节点 | 职责 |
|---|---|---|
| G1 | **PFC 前额叶统一门控** | `engine/tianquan/prefrontal/PrefrontalCortex.processEnhanced` —— 上下文组装唯一闭环（chat.ts 仅轻量兜底）；三分支互斥注入（assembledSystemPrompt > directive > violations） |
| G2 | **KnowledgeTextAssembler 22 段装配** | 守卫优先→身份优先→知识优先的固定顺序 |
| G3 | **反幻觉/反编造防护** | 幻觉守卫、编造特征过滤（S2-J1b）、日常感受防护 |
| G4 | **MemoryGate 注入管控** | 记忆碎片注入预算与截断 |
| G5 | **LLM 边界双闸** | DeepSeekLLMProvider + HTTP 响应前双重校验（第五道闸门） |
| G6 | **prompt-sanitizer** | 输出净化 |

### 1.4 后台小中枢（离线管控，~80% 算力侧）

| 中枢 | 职责 |
|---|---|
| **BIOS/Mind 双核**（`m1/DualCore*`） | BIOS 永不调 LLM（DNA/校验/闸门）；Mind 永不直接操作存储 |
| **ChatPolicy 状态机** | 会话模式唯一真相源，canXxx() 白名单制（替代散落判断） |
| **EmotionRegulator** | 海马体↔杏仁核抑制回路：记忆驱动情绪微调 |
| **MemoryAssessor** | 三库晋升评估（双尺度钙分兼容，P072-A4 归一后统一真值） |
| **SleepTimeConsolidator + M7 梦境** | 24h 流式巩固、情景→语义归纳 |
| **Heart 心跳引擎** | 情绪状态分量（EmotionState24）衰减/涌现/刺激响应 |
| **EntityMeeting.detectUserIntent** | 会晤唤醒意图门（精准句式，防点名误触） |

---

## 二、写入-检索一致性契约（维修对照矩阵）

| 标记/量纲 | 写入点（生产者） | 检索过滤点（消费者） | 一致性状态 |
|---|---|---|---|
| `belong_entity_uuid` | W5 resolveOwnership（强制） | UUIDPoliceFilter 全链 + spine uuidClause | ✅ |
| **40D 向量** | W6 恒写（codec 唯一编码器） | decodePerceptionV40 硬校验（len≠40 拒收） | ✅（3 处手写序列化待收回，见§四） |
| `dna_root_id`/vine_group_id | W1/W7 | spine 藤一簇一票 + DUAL_CHAIN 预筛 | ✅（v28 已回填） |
| `namespace='test'` | W8 标记 | storage 层硬排除 + **spine 路 SQL 待补**（见§四 P0） | ⚠️ 破口中 |
| `memory_kind='roleplay'` | W8 标记 | 各路 isBackgroundTask 分支（口径待统一） | ⚠️ 口径不一 |
| `promoted_to_diamond` | 三库晋升 | spine 排除；其他路依赖存储层 | ⚠️ 待核 |
| 查询向量 | M3 原生 p40（W4） | spine/V13/V11/会晤=原生 ✅；**情感路=投影 ❌**（见§四） | ⚠️ 一路掉队 |

## 三、维修依据（改任何管控点的法定流程）

1. **先对表本总纲**：改动点在§一哪一格、触碰§二哪一行
2. **Harness 七阶段全流程**（S1-S7）：S2 凭据五字段 + DS-23 全仓同类修复原则
3. **测试基线差集归因**：全量 vitest 修前/修后失败集对照，0 归因才可宣布完成
4. **守护断言同步**（§四落地后）：任何编码器/闸门改动必须同步更新 structure-guard 断言，否则 CI 拦截
5. **协作区回传**：STATUS + 任务文档，防多窗口覆盖

## 四、审计发现的整改批终版规格（2026-10-26 业主确认：写做一致 + 全系统无 40D 外任何 D）

> 🔴 **永久执法口径（业主 2026-10-26）**：后续不再存在 40D 以外的其它 D；即使发现遗留，一律按全 40D 法律整改调整，确保与系统法规一致。
> 本节即实施蓝图（吸收外部审查三点修正），方案与实施严格一一对应。

### 执行顺序：P0 → 制度断言 → P1 → P2

**P0（隔离红线）**
- spine 语义联想路（含 DUAL_CHAIN 历史扩展）SQL 补 `AND COALESCE(namespace,'default')<>'test'`——与 #D 测试隔离硬门同口径

**制度断言（CI 硬拦，与 P0 同批落地）**
- 新增 `vector-contract-guard.test.ts` 三断言，**排除 `*.test.ts/__tests__` 夹具面**（实测 7 个测试文件有手写 v2 夹具）：
  1. 编码器唯一入口：非测试代码不得出现手写 `{__v…dims` 序列化（仅允许 codec 内）
  2. 查询同源：**查询路径白名单**（findByEmotionalSimilarity40D / rankByVector / searchV13 / search / spine 路）内不得出现 `projectState24ToV40`；**合法用途白名单保留**：SQLiteAdapter L1004（write 兑底）/L1818（合并派生）、dialog-group-stage:179（源为 24D 快照，投影为唯一编码途径——显式豁免记录）、MigrationManager 历史迁移
  3. 隔离全过滤：直写 SQL 检索 memories 的路径必须含 namespace 排除与 belong_entity_uuid 子句

**P1（查询向量全链原生）**
- 情感路三层联动：RetrievalQuery 增 `p40?` → runEmotion（retrieveMultiRank 侧）透传 options.p40 → findByEmotionalSimilarity40D 用 `query.p40 ?? projectState24ToV40(回退，标注“内部分析非检索查询”）` → **cacheKey 加入 p40 指纹**（原绑 current_perception，换向量不失效的坑）
- 手写序列化收回：codec 新增 `encodePerceptionV40FromDims(arr:number[])`（KEYS 映射+硬校验 len=40），MigrationManager/SQLiteAdapter 共 3 处手写改调它（直接替换会编译不过——手写处是 number[] 非命名对象）

**P2（结构合一）**
- `m2/types/perception-40d.ts` 独立副本删除（仅 SQLiteAdapter 引用，改为引 m3 单源——“避免反向依赖”已不成立，m2 已多处引 m3 类型）

## 五、制度化防复发（守护断言，随整改批落地）

`structure-guard` 新增三断言（CI 硬拦）：
1. **编码器唯一入口**：src 内不得出现手写 v2 序列化（`JSON.stringify({__v` 仅允许 codec 内）
2. **查询向量同源**：查询路径不得出现 `projectState24ToV40`/任何24D→40D 投影（仅迁移/回填允许）
3. **隔离标记全过滤**：任何直写 SQL 检索 memories 的路径必须含 `namespace` 排除与 `belong_entity_uuid` 子句

---

**状态**：方案待业主确认 → 确认后按§四清单走 Harness 整改批（P0 项可先行）+ 守护断言落地 + 本总纲入治理索引。
