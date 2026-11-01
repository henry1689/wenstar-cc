# WenStarOS 当前核心数据流图

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期：2026-08-07 · 性质：只读扫描 · 关联任务：《WenStarOS 天枢架构全局复盘与重设》
> 范围：wenstar-cc 主链路 + wenstar_os 三体链路（文件:函数:行号为当前版本）

---

## 一、目录结构总览

### wenstar-cc（TS 主程序）`D:\tools\wenstar-cc\src`

| 一级目录 | 职责 / 关键文件 |
|---|---|
| `m1` | DNA 双螺旋编码 / 实体提取。DNAEncoder、DualCoreKernel、L0Router~L3、LLMEntityExtractor |
| `m2` | 存储中枢。SQLiteAdapter（sql.js 内存库+落盘）、FusionStorageAdapter、DualHelixWriter、Perception40DStore、PerceptionVector40DCodec、YaoguangNormalizer、ConversationDB、schema.sql |
| `m3` | 感知/决策。M3LogicOrchestrator（decide→24D/40D）、PerceptionAnalyzer、ForesightDetector |
| `m4` | 记忆检索。MemoryRetriever、UnifiedSearchEngine、M4Orchestrator、MemoryInjector、Reranker、QueryDecomposer、SearchIndexBuilder；`retrieval/` 适配器+RRF 路由，`household/` 家族图谱/会晤 |
| `m5` | LLM/表达。M5Orchestrator（**唯一 LLM 调用点**）、DeepSeekLLMProvider、MockLLMProvider、prompts/PromptAssembler |
| `m6` | 自我模型演化（SelfModelManager、M6Orchestrator、TraitEvolver） |
| `m7` | 梦境/巩固。M7Orchestrator、ConsolidationQueue、InductionScheduler、DreamQueue、DreamInternalizer |
| `m8` | 生理锚定（M8Engine、PhysiologicalDeriver） |
| `m9` | 工作记忆 MemoryWriteBuffer（WorkingMemory.ts） |
| `engine` | 新架构。orchestrator、`bus/`EventBus、`chronos/`、`cortex/`(GenerationOrchestrator/PromptComposer)、`heart/`(欲望/情绪/共情)、`reflex/`(L0分类/意图路由)、`storage/`(HybridSearch/Embedding)、`temporal/`(天气/时序)、`tianquan/`(海马体节律/PFC/事件总线) |
| `webui` | HTTP 服务。server.ts、chat.ts(processChat 主链)、server-chat-routes.ts、server-ws.ts、`chat/`(ChatEntry/retrieval-stage/persistence-stage/yaoguang-backfill)、server-*.routes |
| `governance` | audit / auth / police(UUIDPoliceFilter) / scripts |
| `common` | GlobalRegistry、const/llm-config.ts、utils、types |
| `modules` | folder-manager |
| `tianquan-rpc` | TianquanRPCClient、GlobalBusClient、MasterHarris、spec_loader、index |
| `types` / `adapter` / `agent-cnc` | 类型声明；bionic/multimodal 仿生适配器；CNC 工程治理 CLI |
| `app` | 业务域：chat/ChatPolicy、conversation/MemoryGate、knowledge、brain(assembleHippocampus)、memory-vault、entity、fg、role、persona、validation、works、yuyao-memory、alignment、learning(DailyMaintenanceScheduler)、task-agent |

### wenstar_os（Python 三域 OS）`D:\wenstar\wenstar_os`

- `global_bus_main.py` — 三域全局消息总线（TCP :9100，JSON-line）
- `common/` — harris_core(_v2)、base_mcp_harris(GlobalBusTCPClient)、dna_constants、global_uid、proto
- `domain_tianquan/` — 天权中枢。tianquan_rpc_server.py(stdin RPC)、mcp_harris_t.py、tribody_gateway.py、workflows/×11、modules/、validator/、TIANQUAN_DOMAIN_SPEC.md
- `domain_yaoling/` — 瑶灵肉身。mcp_harris_l.py、bus_receiver.py、workflow_executor.py、channels/（d1~d40）、safety/、workflows/、YAOLING_DOMAIN_SPEC.md
- `domain_yaoguang/` — 瑶光感知。mcp_harris_g.py、bus_receiver.py、workflow_executor.py、channels/（obj_d1~d40）、scene_registry、workflows/、YAOGUANG_DOMAIN_SPEC.md

---

## 二、入口清单表

| 入口 | 文件:函数:行号 | 说明 |
|---|---|---|
| HTTP POST `/api/chat` | `src/webui/server-chat-routes.ts:handleChatRoutes:38` → `processChat:52` | 主聊天 HTTP 端点 |
| HTTP GET `/api/chat/stream` | `src/webui/server-chat-routes.ts:133` | SSE 流式聊天 |
| HTTP GET `/events` | `src/webui/server.ts:1649` | SSE 实时推送（事件总线） |
| WebSocket | `src/webui/server-ws.ts:setupWebSocket:6` | `ws://…/api/ws/events` **仅事件推送，不承载聊天** |
| processChat 服务端包装 | `src/webui/server.ts:1457`（handleUserMessage:1511） | 会晤激活检测 → chat.ts |
| 主聊天逻辑 | `src/webui/chat.ts:processChat:303` | 全链路核心（2628 行） |
| 入口守卫管线 | `src/webui/chat/ChatEntry.ts:runChatEntry:26` | M1 编码+时序规则+LLM 实体提取+图谱兜底 |
| 记忆检索（引擎级） | `src/m4/MemoryRetriever.ts:retrieveMemories:69`（`retrieveMemoriesStructured:755`） | 四路召回+海马体索引 |
| 记忆检索（对话级） | `src/webui/chat/retrieval-stage.ts:runRetrieval:43` | 会晤隔离/时间导航/V13/V11/FoundationRoutes |
| 统一搜索 V11 | `src/m4/UnifiedSearchEngine.ts:search:80` | n-gram 初筛+向量精排 |
| 七层搜索 V13 | `src/m4/UnifiedSearchEngine.ts:searchV13:470` | L0-L7 |
| 多路召回前置 | `src/m4/M4Orchestrator.ts:retrieveMultiRankForSearch:429` | V13 候选池 |
| 记忆写入（对话级） | `src/webui/chat/persistence-stage.ts:persistConversation:95` | 三写 |
| 记忆写入（底层） | `src/m2/SQLiteAdapter.ts:writeMemory:706` | memories INSERT |
| 记事记忆写入 | `src/app/yuyao-memory/YuyaoMemoryService.ts:33/52/70` | INSERT INTO memories |
| **LLM 调用（唯一）** | `src/m5/M5Orchestrator.ts:orchestrate:40`（`llm.generate:90`） | 唯一 LLM 调用点 |
| DeepSeek 调用 | `src/m5/DeepSeekLLMProvider.ts:generate:205` → `callDeepSeekApi:111` → `fetch(BASE_URL/chat/completions):124` | V4-flash reasoning_content 处理 |
| Provider 选择 | `src/webui/server.ts:673` | `deepseekAvailable() ? new DeepSeekLLMProvider() : new MockLLMProvider()` |
| 40D 生成 | `src/m3/M3LogicOrchestrator.ts:decide:64` → Phase3.5 `buildPerceptionV40:78`；`src/m3/PerceptionAnalyzer.ts:601` | 24D 投影出 40D |
| 40D 落库 | `src/webui/chat/persistence-stage.ts:writePerceptionV40Dual:66`；`src/m2/Perception40DStore.ts:writePerceptionV40:23` | UPDATE memories.perception_40d |
| 40D 三体同步 | `src/webui/chat/yaoguang-backfill.ts:enqueueYaoguangBackfill:127` → `MasterHarris.collect40DSnapshot:172` | 瑶光客观维异步回填 |
| 天权 RPC | `src/tianquan-rpc/TianquanRPCClient.ts:45`（`_call:117`） | JSON-line over stdio |
| 总线 TCP | `src/tianquan-rpc/GlobalBusClient.ts:50`（`sendCommand:106`） | JSON-line over TCP :9100 |
| 5 层调度器 | `src/tianquan-rpc/MasterHarris.ts:63`（dispatch:143） | 天权RPC + 总线双通道 |
| SPEC 入库 | `src/tianquan-rpc/spec_loader.ts:SpecLoader.loadAll:46` | 三域 SPEC→knowledge_base |
| SQLite 落盘 | `src/m2/SQLiteAdapter.ts:save:1968` / `scheduleFlush:1991` / `flushNow:1996` | 150ms 防抖 export |
| 10s 心跳节律 | `src/engine/tianquan/temporal/HippocampusRhythmCoordinator.ts:start:110`（`setInterval:119`） | THETA/SWR/DELTA 三态 |

> **LLMCenter 概念：不存在**（全库 grep `LLMCenter` = 0）。Provider 配置源 `src/common/const/llm-config.ts:getProviderConfig()`；API Key 支持 DEEPSEEK_API_KEY / LLM_API_KEY / DOUBAO_API_KEY 多源（DeepSeekLLMProvider.ts:59-63）。

---

## 三、主聊天链路（数据流 ①：用户输入 → 回复 → 记忆 → 三体）

```
1. HTTP 入口         server-chat-routes.ts:42 → server.ts:1457 processChat（会晤激活）
2. 节律入网          chat.ts:307 __hippocampusCoordinator.onUserMessage()（THETA+离线锁）
3. 入口守卫          ChatEntry.ts:26 runChatEntry
                        ├─ M1 编码 encoder.encodeSingle:31
                        ├─ 时序规则引擎
                        ├─ LLM 实体提取 extractEntitiesLLM:130
                        ├─ FamilyGraph 兜底:151
                        └─ TXS-ID UUID 解析:167
4. 意图/情感/40D     chat.ts:528 ctx.m3.decide(dna, ctx) → 40D buildPerceptionV40:78
                        ├─ 角色路由 RoleClassifier.classify:539
                        ├─ 工作记忆 workingMemory.push:577
                        └─ consolidationQueue.recordActivity:579
5. 上下文窗口        chat.ts:592-666 会晤上下文（EntityContextManager/压缩摘要）
6. 检索召回          chat.ts:671 runRetrieval → retrieval-stage.ts:43
                        ├─ 作品指称 resolveReferent:71
                        ├─ 会晤隔离墙 :106（query memories by belong_entity_uuid）
                        ├─ 时间导航 :246 / 话题切换 :306
                        ├─ 情感检索 findByEmotionalSimilarity + rerank:324 / 多跳 :357
                        ├─ V13 七层 :459-517 → retrieveMultiRankForSearch:470 → searchV13:479（透传 p40:496）
                        ├─ V11 降级 :521-538 → UnifiedSearchEngine.search:523
                        └─ FoundationRoutes :672 → m4/retrieval/orchestrate.ts
7. 知识库检索        chat.ts:941 buildPreM4Context → ctx.m4.orchestrate:975 → retrieveMemories（m4/MemoryRetriever.ts:69）
8. Prompt 组装       chat.ts:711 门阀白名单 → :1014 MemoryGate → :1096 FamilyGraph 铁律
                        ├─ :1424 MemoryInjector.injectMemories（maxChars=8000）
                        ├─ :1505 PFC processEnhanced（PrefrontalCortex 统一门控）
                        └─ :1747 PromptAssembler（hardRule/safety/identity/memory/persona 分块）
9. LLM 生成          chat.ts:1856 ctx.m5.orchestrate → m5/M5Orchestrator.ts:40 → llm.generate:90
                        └─ DeepSeekLLMProvider.ts:205 → callDeepSeekApi:111 → fetch …/chat/completions:124
10. 校验             chat.ts:1861 HallucinationValidator → :1874 FabGuard → :1882 会晤自称检测
11. 候选/应答组装    chat.ts:1897 generateCandidates → 评分 :2347 → 返回 :2538
12. 记忆写入         chat.ts:1991 persistConversation（异步）→ persistence-stage.ts:95
                        ├─ ConversationDB 双条 + writeMemory memories 双条（:178/:234）
                        ├─ 40D 双轨写 writePerceptionV40Dual:199/252
                        ├─ 瑶光回填入队 enqueueYaoguangBackfill:258
                        ├─ DualHelix 三底座 :283 → Transcoder 校验 :305 → 写后读验证 :321
                        ├─ n-gram 增量索引 :385
                        └─ vault_log 对话归纳 :365
13. 附属             M7 梦境队列 :2027 / TopicTracker 研究 :2061 / 社交图谱 :2153
                        M6 演化 :2239 / M8 锚定 :2251 / VAD 谱曲 :2280 / 对话组 flush :1954
14. 节律释放         chat.ts:2536 __hippocampusCoordinator.afterResponse()
```

---

## 四、记忆检索 / 写入链路（数据流 ②）

**检索（并行三入口）**
```
对话级 retrieval-stage.ts:43（V13/V11/FoundationRoutes，见主链路步骤6）
引擎级 m4/MemoryRetriever.ts:69：海马体稀疏索引 :87-103 → 话题 findByLocus:106
       → 关键词 :122 → 情感 findByEmotionalSimilarity:152 → 四路合并 merge
M4 编排 m4/M4Orchestrator.ts:79 orchestrate → retrieveMemories:104
```

**写入（单点三写）** `persistence-stage.ts:95` → `SQLiteAdapter.writeMemory:706`；写后验证 :321；搜索索引 `m4/SearchIndexBuilder.ts indexDocument:385`；金库 `autoPromoteCandidatesV2:2325`

---

## 五、40D 链路（数据流 ③：生成 → 检索 → 落库 → 同步）

| 环节 | 文件:函数:行号 |
|---|---|
| 生成 | `m3/M3LogicOrchestrator.ts:78` `enhanced.perceptionV40 = analyzer.buildPerceptionV40(...)`（24D 投影） |
| 检索使用 | `chat.ts:674` 透传 `p40` → `retrieval-stage.ts:496` → `UnifiedSearchEngine.ts:479` perceptionV40 参数（40D 查询向量） |
| 落库 | `persistence-stage.ts:199/252` `writePerceptionV40Dual` → `UPDATE memories SET perception_40d=?`；备选 `m2/Perception40DStore.ts:23` |
| 客观维同步 | `persistence-stage.ts:258` → `yaoguang-backfill.ts:127 enqueueYaoguangBackfill` → `_processNext:68` → `MasterHarris.collect40DSnapshot:83`（include_yaoling=false, 30s）→ 天权 RPC 中继 |
| 融合写回 | `yaoguang-backfill.ts:104` `fillObjectiveDims(p40Semantic, objective)`（YaoguangNormalizer）→ `_writeP40:106` |

---

## 六、三体链路（数据流 ④：RPC / TCP / 文件读取）

### 天权（t）— stdio JSON-line RPC
- 入口：`tianquan-rpc/TianquanRPCClient.ts:45`；服务端 `D:\wenstar\wenstar_os\domain_tianquan\tianquan_rpc_server.py:88-96`（method 注册表）
- RPC 方法：`health`、`run_workflow`、`lint_check`、`arch_parse`、`sql_audit`、`generate_snapshot`、`get_spec`、`list_workflows`、`collect_40d_snapshot`（60s 超时 :109）
- 工作流 11 个（wf_code_review/wf_arch_refactor/wf_sql_governance…）

### 瑶灵（l）/ 瑶光（g）— TCP :9100 GlobalBus
- 客户端：`tianquan-rpc/GlobalBusClient.ts:50`，`sendCommand:106` → publish `global_alert`
- 服务端：`global_bus_main.py`（BusTCPServer :9100；auth/subscribe/publish）
- MasterHarris 路由表 `MasterHarris.ts:15-38`：瑶灵 `wf_sensation_pipeline`/`wf_safety_gate`；瑶光 `wf_objective_env_sample`/`wf_location_fingerprint`/`wf_perception_filter`
- 瑶灵执行器：`domain_yaoling/workflow_executor.py:84 run_full_pipeline`（40 通道 D1-D40，D32 compute_holistic）；`health_report.py`（40D 月度报告 dim 1-40）
- 瑶光执行器：`domain_yaoguang/workflow_executor.py:114 run_env_sample / :157 run_location_fingerprint / :267 run_full_snapshot`
- 频道：天权 subscribe `global_alert/yaoling_state/yaoguang_snapshot`；publish `tianquan_snapshot/yaoguang_snapshot`；GlobalBusClient 默认订阅 `['global_alert','yaoling_state','yaoguang_snapshot']`（GlobalBusClient.ts:45）

### 维度字段
- 瑶灵 `channels/`：d1~d40（40 维；D1-D32 生理五大类 + D33-D40 伴侣纹理），`domain_yaoling/channels/__init__.py:77 create_all_channels`
- 瑶光 `channels/`：obj_d1~d40（客观维）
- 上报均为 **40D**（health_report.py:52 `dim_vals={d:[] for d in range(1,41)}`）；`m3/types/perception-40d.ts:11` 注明 40D = spine.proto D1-D32 + D33-D40
- 归一化桥：`src/m2/YaoguangNormalizer.ts`（fillObjectiveDims/buildFallbackV40）、`src/m2/PerceptionVector40DCodec.ts`

### SPEC 文件（TS 侧加载）
- `tianquan-rpc/spec_loader.ts:12-16`：`TIANQUAN_DOMAIN_SPEC.md`(TIANQUAN-SPEC-20260711)、`YAOLING_DOMAIN_SPEC.md`、`YAOGUANG_DOMAIN_SPEC.md`
- 加载：`spec_loader.ts:46 loadAll` → `kb.add`（locked=true）；`server.ts:498 initMasterHarris → loadDomainSpecs`

---

## 七、定时器清单（数据流 ⑤：后台/任务）

| 位置:行号 | 周期 | 职责 / 是否烧 token |
|---|---|---|
| `engine/tianquan/temporal/HippocampusRhythmCoordinator.ts:119` | 10s | **核心节律协调器**。THETA/SWR/DELTA 调度全部离线任务；chat 发消息加锁暂停（:197-204） |
| `engine/tianquan/temporal/assembleHippocampus.ts:245` | — | 注册 7 组件：M7 梦境(SWR 60s/DELTA 5min)、ConsolidationQueue(SWR 30s)、Induction(DELTA 1h)、SleepTimeConsolidator(DELTA 6h)、CoreMemory(6h)、DailyMaintenance(24h)、HippocampalIndex(周/日) |
| `webui/server.ts:946` | 15min | M6 自我模型 `m6.maintenance()`（演化/偏好） |
| `webui/server.ts:951` | 首 5min | 记忆仓 `memoryVault.backup()` |
| `webui/server.ts:1091` | 30min | 统一备份引擎（fusion_memory+family_graph+vault） |
| `webui/server.ts:1097` | 5min | DualHelix 失败重试回放 `retryHelixQueue` |
| `webui/server.ts:1261` | 5min | **做梦研究** `researchTopic`（TopicTracker→WebSearch→KB，烧 LLM/token，调试跳过） |
| `webui/server.ts:1303/1310` | 1h | **AQC 质检** SandQC/GoldQC + 黑钻自动提炼（烧 LLM/token，LAZY 模式可跳过） |
| `webui/server.ts:1399` | 30min | 景幻仙姑金库巡检 `autoPromoteCandidatesV2` |
| `webui/server.ts:1148` | 24h | 音频文件清理 |
| `webui/server.ts:1625` | 60s | 速率限制 map 清理 |
| `webui/server.ts:2677` | 30s | Hook 探针超时标红 |
| `webui/maintenance.ts:167/174/182/199` | 数分钟 | 记忆仓 compact/GC/知识GC/衰减 |
| `m7/InductionScheduler.ts:60` | 1h | 情感归纳（并入海马体 DELTA） |
| `m9/WorkingMemory.ts:49` | — | MemoryWriteBuffer 定时 flush |
| `m2/SQLiteAdapter.ts:99/1980` | 150ms | **落盘防抖** |
| `engine/temporal/EventTimerScheduler.ts:28` | intervalMs | 时序事件 tick |
| `engine/tianquan/knowledge/MDFileWatcher.ts:44` | 轮询 | MD 文件监视 |
| `engine/orchestrator.ts:267` | 30min | 时序上下文刷新 |

token 消耗敏感定时器：**做梦研究(5min)、AQC 质检(1h)、SleepTimeConsolidator(6h)、M7 梦境内化(SWR)、M6 维护(15min)**。`WS_LAZY_TIMERS`/`isDebugMode()` 为整体省 token 开关（server.ts:1092/1321）。

---

## 八、关键结论

1. **聊天走纯 HTTP POST + SSE，无 WS 聊天通道**（WS 仅事件推送）——并发压力在 HTTP handler 进程内。
2. **LLM 只有 DeepSeek/Mock 两 Provider、无 LLMCenter 抽象**——Provider 统一入口在 `common/const/llm-config.ts`，`m5/M5Orchestrator.ts:90` 是唯一 `llm.generate` 调用点（LLMCenter 天然挂载点）。
3. **40D 由 M3 一次性产出并双轨落库**：语义维同步（persistence-stage）+ 瑶光客观维经 MasterHarris→天权 RPC `collect_40d_snapshot` 异步回填。
4. **10s 海马体心跳（`HippocampusRhythmCoordinator`）是全部离线/后台 token 任务的统一调度中枢**——天枢 TaskCenter 的现有锚点。
5. **`webui/server.ts` 组合根仍承担装配 + 定时器注册 + 路由挂载**（2849 行）——SystemCenter 拆解候选。

---

## 九、执行证据

`setInterval(` → 31 处/17 文件（server.ts 11、maintenance.ts 5 最多）；`setTimeout(` → 56 处/35 文件（server.ts 3、AsyncTaskQueue 4、TianquanRPCClient 4、DeepSeekLLMProvider 4 最多）；`LLMCenter|LLMCentre` → **0**；`retrieveMultiRankForSearch` → M4Orchestrator:429 / MemoryAdapter:4,39 / retrieval-stage:448,459,470。
