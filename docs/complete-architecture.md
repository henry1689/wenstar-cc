# 🏛️ 太虚境·文曲星 完整系统架构

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 生成日期：2026-07-08
> 源码：296个 .ts 文件，约 52,300 行

---

## 一、模块总览（M1-M9 + 应用层 + 引擎）

| 模块 | 定位 | 文件数 | 行数 | 核心职责 |
|------|------|:------:|:----:|---------|
| **M1** | DNA编码 | 10+5配置 | ~2,200 | 用户输入→DNA结构(L0分类/L1序列/L2语义区/L3实体) |
| **M2** | 融合存储 | 11+3 schema | ~4,300 | 24D情感向量记忆的持久化(SQLite为主) |
| **M3** | 逻辑决策 | 3 | ~1,250 | 24D感知分析+钙化计算+决策路由 |
| **M4** | 知识融合 | 9+1 schema | ~4,100 | 记忆检索+家族图谱+知识库融合 |
| **M5** | 表达生成 | 18 | ~3,700 | 认知组装→策略选择→LLM生成→人文校准 |
| **M6** | 自我演化 | 7 | ~750 | 性格特质演化(大五人格) |
| **M7** | 梦境引擎 | 7 | ~1,100 | 离线记忆巩固+归纳总结 |
| **M8** | 年轮引擎 | 4 | ~750 | 情感里程碑+伤痕愈合时间线 |
| **M9** | 工作记忆 | 1 | ~220 | DNA缓存→逐级毕业→写入M2的唯一入口 |
| **app** | 应用域 | ~42 | ~8,000 | 角色扮演/知识库/金库/人对齐/角色路由 |
| **engine** | 新架构 | ~30 | ~3,500 | EventBus编排器/大脑/边缘系统/皮层 |
| **webui** | 服务端 | 13 | ~10,000 | HTTP服务+chat.ts主管线(2980行) |
| **合计** | — | ~225 | ~58,600 | — |

---

## 二、数据流：用户消息 → 回复

```
用户消息
  │
  ▼
┌── M1: DNA编码 ─────────────────────────────────────────┐
│  L0Router：话题分类 + locus_path 路由                     │
│  L1Sequencer：branch_id + seq_pos 生成                   │
│  L2ContentExtractor：语义区分类(leaf_zone)              │
│  L3EntityAnnotator：实体提取(entity_genes)              │
│  输出：DNA { dna_root_id, branch_id, locus_path, ... }   │
└────────────────────────────────────────────────────────┘
  │
  ▼
┌── M3: 逻辑决策 ─────────────────────────────────────────┐
│  PerceptionAnalyzer：24D感知分析                          │
│  calcCalcium：钙化分计算 + 等级(0-3)                     │
│  决策路由：钙化×愉悦→忽略/记忆/提问/安慰/行动             │
└────────────────────────────────────────────────────────┘
  │
  ▼
┌── M4: 知识融合 ─────────────────────────────────────────┐
│  MemoryRetriever：4路检索(话题/关键词/情感/KB)            │
│  FamilyGraph：家族图谱查询                                 │
│  KnowledgeBase.weightedSearch()：RAG检索                   │
│  FusionEngine：3源融合(知识+记忆+家族)                    │
└────────────────────────────────────────────────────────┘
  │
  ▼
┌── M5: 表达生成 ─────────────────────────────────────────┐
│  CognitionAssembler：组装认知对象                          │
│  StrategySelector：策略选择(语气/长度/实体)               │
│  DeepSeekLLMProvider.generate()：LLM调用                   │
│  HumanisticCalibrator：人文校准                            │
│  输出：回复文本                                            │
└────────────────────────────────────────────────────────┘
  │
  ▼
┌── 持久化 + 副作用 ─────────────────────────────────────┐
│  WorkingMemory.push() → 逐级毕业写入M2                    │
│  ConversationDB：对话存入砂金库                            │
│  M6：自我演化信号处理                                      │
│  M7：高钙化事件入梦境队列                                  │
│  M8：情感里程碑记录                                        │
└────────────────────────────────────────────────────────┘
  │
  ▼
回复 → HTTP SSE
```

---

## 三、chat.ts 主管线（2980行）

### 3.1 模块级状态变量

| 变量 | 类型 | 用途 |
|------|------|------|
| `_currentRole` | `RoleType` | 角色路由当前角色（默认secretary） |
| `_transitionState` | `TransitionState` | 角色切换状态机 |
| `_currentRoleplay` | `string\|null` | 跨轮次角色扮演锁定 |
| `_currentRPBranch` | `FamilyGraphRoleBranch\|null` | FG角色分支（角色视角隔离） |
| `_rpJustExited` | `boolean` | 角色扮演刚退出标记（强制身份恢复） |
| `_rpTurnCounter` | `number` | 角色扮演轮次计数 |
| `_currentCharacterClass` | `'A'\|'B'\|'C'\|null` | A=FG人物 / B=对话提及 / C=纯即兴 |
| `_emotionSnapshot` | `EmotionSnapshot\|null` | 角色情感隔离快照 |
| `_dg` | `DialogGroupState\|null` | 当前对话组 |
| `_bdVecCache` | `Map` | 黑钻向量逐轮缓存 |

### 3.2 processChat() 完整流程（11阶段）

```
阶段A：入口守卫 (L435-484)
  ├─ 退出残留清除：_rpJustExited 卡住时强制归零
  ├─ 显式扮演检测：/扮演(?:一下)?[了]?([一-龥]{2,8})/
  ├─ 隐式扮演检测：消息以已知角色名开头
  └─ 口语词过滤：Set(['不用了','知道了','好了',...])

阶段B：核心编排 (L486-1199)
  ├─ M1 DNA编码
  ├─ 时空规则引擎（事件校验）
  ├─ LLM辅助实体提取
  ├─ FG兜底实体匹配
  ├─ 人物档案提取（外貌/体态/性格）
  ├─ 答案提取（用户回答→更新FG画像）
  ├─ M3感知决策（24D感知+钙化）
  ├─ 角色分类器 classify() + 状态机 evaluateTransition()
  ├─ 主人镜像提取（用户特征存入master_profile）
  └─ 工作记忆推送

阶段C：记忆检索 (L836-1171)
  ├─ enrichHistory构建（角色扮演时只保留rpChar匹配轮次）
  ├─ 4路记忆检索（话题/关键词/情感/KB）
  ├─ 仿生脑并行检索
  ├─ 体感状态注入
  ├─ 记忆隔离过滤（正常模式过滤角色扮演记忆）
  ├─ 知识库搜索（weightedSearch + ONNX重排序）
  ├─ 亲密知识库检索
  ├─ VAD语调注入
  ├─ 线索助手（clueReply绕过LLM）
  └─ M4编排 → M4Context

阶段D：守卫/约束组装 (L1204-1871)
  ├─ 幻觉守卫（MemoryGate）
  ├─ 融合引擎（3源动态权重）
  ├─ 主动推送（情绪象限驱动）
  ├─ 新人名幻觉守卫
  ├─ 家族/社交约束
  └─ 声明模式守卫（"我上传了文件"防幻觉）

阶段E：角色扮演进入/退出 (L1386-1741)
  ├─ 退出检测：/停止.*扮演/ → 清FG分支+情感存档+重置
  ├─ 扮演进入：创建FG分支→runRoleplayPipeline
  └─ 跨轮次锁定：每轮重新调用runRoleplayPipeline

阶段F：最终组装 + LLM生成 (L1742-2234)
  ├─ factualRecallGuard 预检查
  ├─ 工作模式亲密过滤器
  ├─ 北京/阴历时间注入
  ├─ classificationGuard（未分类KB提醒）
  ├─ enrichedWithGuard构建（对话历史+守卫消息）
  ├─ finalKnowledgeText组装（10+层追加）
  ├─ 角色扮演退出恢复（身份重置指令）
  └─ M5编排 → LLM回复

阶段G：生成后处理 (L2237-2946)
  ├─ 角色扮演健康检查 + Validator校验
  ├─ 幻觉校验（回复中的人名vs FG）
  ├─ FG vs LLM冲突检测（年龄比对）
  ├─ 候选回复生成
  ├─ 对话组管理
  ├─ 持久化（3写：记忆+DB+融合）
  ├─ 梦境队列（钙化≥2）
  ├─ 话题跟踪/网络研究
  ├─ 关系提取+社交图谱同步
  ├─ M6自我演化
  ├─ VAD/仿生异步存储
  └─ 返回ChatResponse
```

---

## 四、角色扮演管线

### 4.1 新旧对比

```
旧管线 (app/roleplay-legacy/)              新管线 (app/roleplay/)
────────────────────────                    ────────────────────────
ROLEPLAY_STRUCTURED_ENABLED=false           ROLEPLAY_STRUCTURED_ENABLED=true
7路并行采集                                  5层串行截断采集
DataCollector → 7路同时fire                  MemoryRetriever.retrieveFullClue()
FG直查                                      FamilyGraphAdapter 双源适配器
扁平规则提示词                                4层XML结构化提示词
无就绪门                                     ReadinessGate 就绪判定
独立SessionCache                            统一SessionCache
updateTempProfile生长                        静态（无生长模块）
```

### 4.2 4层装配结构

```
【角色扮演】你是{角色名}，用{角色名}的口吻回复。

---

<core_rules priority="MAX">
1. 事实强制准则：下方事实库有记录就不能回避
2. 双向禁止红线：①禁止抛开人名写抒情 ②禁止冷漠回避事实  
3. 身份隔离铁律：我为{角色}，与其他人独立
4. 场景连续性铁律：场景由上下文决定，不每轮重写
5. 时间锚点铁律：过去的事不能当现在场景
</core_rules>

<fixed_identity>当前唯一身份：{角色}</fixed_identity>
【我认识的人】· 列表

---

<fact_database>
【自身档案】我叫{名}，今年{年龄}岁...
【亲属关系】我的妈妈：{名}...
</fact_database>
【回答格式】用户问亲属→第一行直接答...

---

【过往记忆（以下都是过去的事）】
• [过去] {记忆内容}

---

【知识背景】{知识库内容}
```

### 4.3 家族图谱关系类型（全部方向限定）

| 关系类型 | 方向 | 说明 |
|---------|------|------|
| `mother_of` / `daughter` | 双向 | 母亲→女儿 |
| `father_of` / `son` | 双向 | 父亲→儿子 |
| `elder_sister_of` / `younger_sister_of` | 双向 | **姐姐→妹妹**（方向明确） |
| `spouse_of` | 双向 | 配偶 |
| `aunt_of` / `niece_of` | 双向 | 姑姑→侄女 |
| `cousin_of` | 双向 | 表亲（同辈） |
| `sister_in_law_of` | 双向 | 妯娌 |

---

## 五、三库记忆体系

### 5.1 砂金库（Sand Vault）

| 表 | 写入时机 | 关键字段 |
|----|---------|---------|
| `conversations` | 每轮对话即时写入 | role, content, timestamp, roleplay_char, dialog_group_id |
| `memories` (calcium≤1) | WorkingMemory毕业 | calcium_score, effective_strength, lifecycle_state='candidate' |

**读取路径：**
```
chat.ts → retrieveFullClue → 
  SQL: SELECT content FROM conversations WHERE roleplay_char=? ORDER BY timestamp DESC LIMIT 10
  SQL: SELECT raw_input FROM memories WHERE raw_input LIKE ? ORDER BY calcium_score DESC LIMIT 8
```

### 5.2 金库（Gold Vault）

| 表 | 写入时机 | 关键字段 |
|----|---------|---------|
| `memories` (calcium≥1) | WorkingMemory毕业→active | 24D perception_json, dna_root_id, dialog_group_id |

**读取路径：**
```
chat.ts → MemoryRetriever.retrieveMemories() →
  findByLocus：SQL SELECT * FROM memories WHERE locus_path LIKE ? ORDER BY seq_pos DESC
  findBySeqPosRange：SQL SELECT * FROM memories WHERE seq_pos>=0 ORDER BY seq_pos DESC LIMIT 200
  findByEmotionalSimilarity：两阶段扫描（地标→最近200条）→ 复合评分
```

### 5.3 黑钻库（Black Diamond）

| 表 | 写入时机 | 关键字段 |
|----|---------|---------|
| `black_diamond` | MemoryAssessor晋升 | summary, emotion_tag, tags, emotion_vector |

**晋升条件：** calcium_level≥2 AND effective_strength>0.6 AND recall_count≥1

**读取路径：**
```
retrieveFullClue → 
  SQL: SELECT summary FROM black_diamond WHERE tags LIKE ? ORDER BY created_at DESC LIMIT 5
```

---

## 六、RAG 实现

### 6.1 KnowledgeEngine.weightedSearch()

```
输入：keywords + sceneTags + 24D perception

1. N-gram提取：中文2-3字组合 + 英文2+字母单词
2. 全表扫描：
   SQL: SELECT * FROM knowledge_base ORDER BY impression_score DESC LIMIT 50
3. 每行三路评分：
   - 文本分：ngram命中率 × 0.50
   - 场景分：scene_tags Jaccard相似度 × 0.15  
   - 情感分：emotion_vector余弦相似度 × 0.15
   + impression_score × 0.20
   × 未分类惩罚(0.7)
```

### 6.2 Hybrid Search（RAGPipeline）

```
输入：query
  → 关键词路径：KnowledgeEngine.search() LIKE 搜索
  → 向量路径：EmbeddingProvider → TF-IDF 256维 → VectorStore.similaritySearch()
  → 合并：向量结果优先，关键词回填，按分去重

可选 ONNX 重排序（bge-small-zh 512维）：
  语义分 × 0.30 + 关键词分 × 0.60 + 匹配分 × 0.10
```

---

## 七、Hermes 调用链路（chat.ts → DeepSeek API）

```
chat.ts L2234:
  reply = await ctx.m5.orchestrate(
    ctx_m4,                  // M4Context（感知+记忆摘要+家族）
    enrichedWithGuard,       // 对话历史+守卫消息
    finalKnowledgeText,      // 所有知识/上下文/守卫块
    userMessage              // 知识库文本 + '\n\n' + 原始消息
  )

  ↓

M5Orchestrator.orchestrate():
  ① cognition = CognitionAssembler.assemble(m4ctx)    — 组装认知对象
  ② strategy = StrategySelector.select(cognition)     — 选择生成策略
  ③ combinedKnowledge = wrapKnowledge(finalKnowledgeText) — 锚定约束+场景上下文+知识
  ④ llm.generate({strategy, cognition, history, combinedKnowledge, userMessage, role})

  ↓

DeepSeekLLMProvider.generate():
  ① role = classify(cognition.perception, rawInput)   — 角色路由（第三次重复分类！）
  ② level = calcLevel(24D感知, rawInput)              — 情绪等级计算
  ③ systemPrompt = 时间 + buildRoleSystemPrompt(role, level, kb) + replyInstruction
  
  ④ contextBlock = [感知] + [风格] + [实体] + [要求] + [亲密示例]
  
  ⑤ 如果是角色扮演路径：
      处理【角色设定详细说明】区块 → 简化system prompt
      温度0.95，无reasoning_effort
      历史仅保留最近4轮（排除记忆标记）
  
  ⑥ 正常路径：
     消息数组 = [
       {role:'system', content: systemPrompt},
       {role:'system', content: 身份边界提醒},
       ...recentTurns（最近N轮，工作话题10轮/其他200轮）,
       {role:'system', content: 反编造铁律},
       {role:'system', content: 人物档案},
       {role:'system', content: 玉瑶本人档案（自介查询时）},
       {role:'user', content: contextBlock + '\n鸿艺: ' + rawInput}
     ]
     温度：0.9（日常）/ 1.0（亲密/回忆）
     roleplay时：0.4 + reasoning_effort='max'
     
  ⑦ POST https://api.deepseek.com/v1/chat/completions
     model: deepseek-v4-flash
     timeout: 10-20秒（按level分级）
     重试：2次（仅429/503）
```

### 角色路由的三重重复调用

| 位置 | 调用点 | 状态变量 | 风险 |
|------|--------|---------|------|
| chat.ts L777-787 | classify() + evaluateTransition() | 模块级 _currentRole | 入口正确 |
| M5Orchestrator.ts L71-81 | classify() + evaluateTransition() | 实例级 this._currentRole | 覆盖chat.ts结果 |
| DeepSeekLLMProvider.ts L205-227 | classify() + evaluateTransition() | 静态级 DeepSeekLLMProvider._currentRole | 再覆盖一次 |

三个地方的感知维度、状态变量都不同，结果可能不一致。

---

## 八、ID机制

| ID | 格式 | 生成位置 | 作用域 | 存储位置 |
|----|------|---------|--------|---------|
| **dna_root_id** | `{6位seq}{14位时间}M01{4位L0编码}` | DNAEncoder | 全局（跨日重置） | memories/dna_root_id |
| **branch_id** | `evt_{YYYYMMDD}_{3位seq}` | L1Sequencer | 会话级 | DNA.branch_id |
| **seq_pos** | 递增整数 | L1Sequencer / FusionStorageAdapter | 存储级 | memories.seq_pos |
| **dialog_group_id** | `{dna_root_id}_DG_{seqPos}` | chat.ts 对话组管理 | 组级 | conversations/memories |

### 8.1 dna_root_id 全链路传递

```
DNAEncoder.generateRootId(l0_code)
  → DNA.dna_root_id
  → WorkingMemory.push()
  → FusionStorageAdapter.write()
  → SQLiteAdapter.write()
  → INSERT INTO memories (dna_root_id, ...)

同时传递到：
  → conversations 表（insertConversation时）
  → black_diamond 表（VaultManager晋升时）
  → M4 timeline（compressMemories时透传）
```

---

## 九、数据库文件

| 文件 | 路径 | 大小 | 用途 |
|------|------|:----:|------|
| `fusion_memory.db` | `data/webui/` | ~30MB | **主库**：memories/conversations/knowledge_base/black_diamond等25表 |
| `family_graph.db` | `data/webui/knowledge/` | ~420KB | **家族图谱**：nodes+edges |
| `vault.db` | `data/memory-vault/` | 不定 | **隔离金库**：独立存储，SHA256完整性校验 |

### fusion_memory.db 核心表

| 表 | 行数 | 用途 |
|----|:----:|------|
| conversations | ~6,500 | 原始对话（砂金） |
| memories | ~1,200 | 24D记忆（金库） |
| knowledge_base | ~67 | 知识库条目 |
| black_diamond | ~150 | 珍藏记忆（黑钻） |
| entity_topology | ~260 | 实体关系拓扑 |
| master_profile | ~250 | 主人画像镜像 |
| aqc_records | ~4,700 | 质量检查记录 |
| decay_log | ~177,000 | 衰减日志 |
| vault_log | ~3,600 | 金库操作日志 |

---

## 十、环境变量与配置

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API密钥（缺则Mock降级） |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 模型选择 |
| `ENABLE_NEW_ARCH` | `false` | 启用hybrid架构（EventBus） |
| `ROLEPLAY_STRUCTURED_ENABLED` | `false` | 启用4层结构化角色扮演 |
| `ENABLE_SEMANTIC_FUSION` | `false` | 启用感知驱动3源融合 |
| `VECTOR_SIM_THRESHOLD` | `0.5` | 黑钻向量相似度阈值 |
| `PORT` | `3000` | HTTP端口 |
| `TTS_URL` | `http://localhost:8765` | 语音合成服务 |

### 外部服务端口

| 服务 | 端口 | 用途 |
|------|:----:|------|
| 情感谱曲引擎 | 8100 | VAD情感分析 |
| 仿生智脑 | 7200 | 仿生记忆金库 |
| TTS语音 | 8765 | 文字转语音 |
| DeepSeek API | 443(远程) | LLM主模型 |

---

## 十一、架构中的问题清单（待检讨）

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| 1 | **角色路由三重重复调用** | 三处独立状态，结果可能不一致 | chat.ts / M5Orchestrator / DeepSeekLLMProvider |
| 2 | **chat.ts 2980行** | 单文件过大，逻辑耦合严重 | `src/webui/chat.ts` |
| 3 | **FG"我"节点非标处理** | 被误删过，重建逻辑脆弱 | FG 操作脚本 |
| 4 | **retrieveFullClue 无时间窗过滤** | 旧场景污染新对话 | `MemoryRetriever.retrieveFullClue()` |
| 5 | **isIntimateText 正则三处不一致** | 亲密检测结果不同 | RoleClassifier / DeepSeekLLMProvider / M5Orchestrator |
| 6 | **family_graph.db 两份** | `data/webui/knowledge/` vs `data/knowledge/` 内容不同 | 初始化路径配置 |
| 7 | **deepseek-v4-flash 思维链污染** | reasoning_content 被当回复 | `callDeepSeekApi()` 后处理 |
| 8 | **学科守卫太宽** | `研究/学习` 误拦截亲密模式 | `DeepSeekLLMProvider._academicGuard` |
| 9 | **用户消息翻倍风险** | contextBlock + 消息体拼接到 userMessage | `DeepSeekLLMProvider` generate() |
| 10 | **角色切换熔断机制** | 切3次就锁5轮，不适合亲密切换频繁场景 | `TransitionManager.ts` |
