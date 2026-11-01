# 文曲星·太虚境 认知系统生死链路改善任务书

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> **版本**: v1.0 (2026-08-12)
> **状态**: 草案 · 待审阅
> **制定**: Claude Code (资深架构师视角)
> **审阅**: 鸿鸣
> **关联文档**:
> - [CLAUDE.md](../CLAUDE.md) — Harness 七阶段流水线 + 系统不变量
> - [FG 红线文档](../../../AI文件/personal-assistant/memory/projects/wenstar-fg-roleplay.md) — 11 条角色扮演红线
> - [探察笔记](../../../tmp/wenstar-cc-探察笔记-2026-08-12.md) — 全系统问题索引
> - [系统综合评价](../docs/system-comprehensive-evaluation.md) — 2026-07-05 基线评估

---

## 0. 文档目的与使用方法

本任务书将上一轮全系统探察发现的**生死级问题**转化为**可执行的分阶段任务**。每个任务是一个独立工作单元,含:问题定位、根因、修改方案、影响面、验收标准、风险、FG 红线触碰、工作量估计。

**使用方法**:
1. 由决策者(鸿鸣)审阅确认本任务书(S2 定稿)
2. 按阶段顺序逐任务执行;每个任务独立走 S1→S7 流水线
3. 每个任务完成后回填"验收结果"列,形成执行档案

**执行铁律**(源自 CLAUDE.md,任何任务不得违反):
- 每个任务走 S1 全局审视 → S2 方案确认 → S3 实施 → S4 delegate 独立评审 → S4.5 收敛 → S5 编译测试 → S6 功能验证 → S7 归档
- 禁止用 Bash/Node 一行命令改源码
- 涉及 FG/角色 → 先读 FG 红线 + 输出 11 条触碰判定表
- 改数据写入路径 → S6 必须验证 `.save()`/`scheduleFlush` 持久化
- 单函数 ≥2 个新 if 分支 → 标记并解释(补丁嗅探)
- 完成即输出四段式变更报告(概述/影响文件/验证结果/注意事项)

---

## 1. 背景与目标

### 1.1 系统定位

`hermes-emotion-system`(文曲星·玉瑶·太虚境)—— 情感伴侣类脑认知系统。
核心:记忆 = 歌单 { 歌词(对话原文) + 曲谱(24D情感向量) },5 区异构类脑拓扑,AI 自我模型四大支柱。
**灵魂 = 认知连续性:记忆不失真、人格不漂移、边界不破防。**

### 1.2 三种"死亡"定义

| 死亡类型 | 表现 | 用户感知 |
|---|---|---|
| 💀 物理死 | 崩溃、无法启动、数据全丢 | 服务不可用 |
| 🧠 认知死 | 失忆、记忆断裂、人格漂移、身份混淆 | "它不记得我了""它不像它了" |
| ❤️ 信任死 | 泄漏隐私、编造往事、越过角色边界 | "它骗我""它把秘密说出去" → 拒绝再用 |

### 1.3 改善总目标

```
第一波 保命(止血)    消除立即致死风险 → 物理死/信任死归零
第二波 记忆器官       恢复认知连续性   → 失忆类问题归零
第三波 信任边界       守住角色与隐私   → 泄漏/越界归零
第四波 工程债         慢性病治理       → 让失效可见、让系统可维护
```

---

## 2. 现状诊断(修正版)

> ⚠️ **本版已现场验证修正**,修正点标注 🔧。

### 2.1 全仓库硬数据

| 指标 | 数值 |
|---|---|
| 总规模 | ~27,600 行 TS,20+ 子系统 |
| 空 `catch{}` | 109 处 |
| `as any` | 993 处;`any` 标注 1968 处 |
| 超大文件 | FamilyGraph.ts 5982 行、server.ts 2878、chat.ts 2740、SQLiteAdapter.ts 2261、observability 1165 |
| 一次性补丁脚本 | scripts/ 下 **40+ 个**(fix-*/patch-*/backfill-*/clean-*) |

### 2.2 生死问题总表(修正版)

| 优先级 | 问题 | 位置 | 状态 |
|---|---|---|---|
| 🔴 P0-1 | 安全拦截短路失效:被拦截内容仍流向上层 LLM | SafetyInterceptor.ts + EventBus.ts | ✅ 已交叉验证 |
| 🔴 P0-2 | `__DEBUG_UNLOCK_ALL=true` 全局后门 + 全 /api 无鉴权 | server.ts:523 | ✅ Agent 定位 |
| 🔴 P0-3 | 🔧 boot 补丁已从启动流程移除(非当前活跃),但残留脚本待清理 | start.cjs:33-35 + scripts/fix-kb-gates.cjs | ✅ 已现场验证 |
| 🔴 P0-4 | 钙化分三套标准并行,入库被重算覆盖,晋升漂移 | math.ts vs PerceptionAnalyzer.ts | ✅ Agent 定位 |
| 🔴 P0-5 | src/dist 代码漂移(no-key guard 只在 dist) | dist/m5/DeepSeekLLMProvider.js | ✅ 文档实证 |
| 🟠 P1-6 | 实体隔离末公里失效 + 反编造正则与档案矛盾 | MemoryRetriever.ts:154 + retrieval-stage.ts:118 | ✅ Agent 定位 |
| 🟠 P1-7 | M6 三条演化通道死代码 + 正反馈方向偏差 | post-process.ts/M6Orchestrator | ✅ Agent 定位 |
| 🟠 P1-8 | Prompt 注入面 + 日志泄漏 system prompt 前500字 | DeepSeekLLMProvider.ts:611,685 | ✅ Agent 定位 |
| 🟠 P1-9 | LLM 失败被兜底话术伪装成正常回复 | DeepSeekLLMProvider + M5Orchestrator | ✅ Agent 定位 |
| 🟢 P2 | M3 confidence 污染、双24D、M9 门控死、SQL 模板串拼接等 | 各模块 | ✅ Agent 定位 |

---

## 3. 阶段划分与总览

```
┌─ 阶段 0  准备与基线     (0.5天)   建立基线、锁定环境
├─ 阶段 1  保命止血       (2-3天)   P0-1 ~ P0-5
├─ 阶段 2  记忆器官       (3-5天)   P1-6 ~ P1-9 + M2/M9 核心
├─ 阶段 3  信任边界       (3-5天)   实体隔离/反编造/M6/Prompt
└─ 阶段 4  工程债         (分批)   类型收敛/文件拆分/脚本归档
```

**排期原则**:每一阶段完成后稳定运行 2 天,确认无回归再进下一阶段(CLAUDE.md 整改四铁则)。

---

## 4. 详细任务分解

> 每个任务独立走 S1-S7。工作量为人天估(含方案+实施+评审+验证)。

---

### 🟥 阶段 1 · 保命止血(P0)

#### T1-1 修复安全拦截短路失效 【💀 最高优先】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/engine/reflex/SafetyInterceptor.ts:119`(`(this.handleInput as any).skipRemaining = true`) + `src/engine/reflex/L05IntentRouter.ts:45` + `src/engine/bus/EventBus.ts:97` |
| **根因** | `init()` 里注册到 EventBus 的是 `this._boundHandleInput = this.handleInput.bind(this)`(bind 副本),但 `emitBlocked` 设置短路标记的对象是 `this.handleInput`(原始箭头函数)。两个函数对象不同,EventBus 读取 `entry.handler.skipRemaining` 时永远读不到。→ **短路永不生效,红线拦截的"自杀/隐私/违禁"内容仍流入上层 LLM** |
| **修改方案** | 统一标记对象:把 `skipRemaining` 设置在 `this._boundHandleInput` 上(即 `(this._boundHandleInput as any).skipRemaining = true`);或更优——把短路语义移入事件本身(在 event 上带 `shortCircuit:true` 标记,EventBus 识别),避免依赖 handler 属性。**推荐后者**(架构性,非补丁) |
| **影响面** | EventBus.emit 是所有事件的唯一流转点;改动需保证 `off()` 匹配、错误隔离不破坏 |
| **验收标准** | ① 构造含"我要死"的输入 → 断言后续 priority 更低的 handler **未执行**;② 构造隐私输入(手机号)→ 断言被拦截;③ 正常输入 → 全链路正常;④ 相关单测通过 |
| **风险** | 低。改动独立,不涉数据 |
| **红线** | 无 |
| **工作量** | 0.5 天 |

---

#### T1-2 关闭全局后门 + API 鉴权 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/webui/server.ts:523`(`__DEBUG_UNLOCK_ALL = true`)、`guard-builder.ts:80`、`/api/chat/purge-test`(可删库)、`/api/reset`(可重启) |
| **根因** | 硬编码后门常开;所有 /api 无鉴权、CORS `*` |
| **修改方案** | ① `__DEBUG_UNLOCK_ALL` 改为从环境变量读取(`process.env.WS_DEBUG_UNLOCK === '1'`),默认 false;② purge-test/reset 加轻量 token(如请求头 `X-Admin-Token` 比对环境变量);③ CORS 白名单化(本地固定 localhost 来源) |
| **影响面** | 前端 WebUI 调用链(需同步确认前端是否依赖后门) |
| **验收标准** | ① 无 token 时 purge-test/reset 返回 403;② 设置环境变量后恢复;③ 前端正常聊天不受影响;④ 相关测试通过 |
| **风险** | 中。若前端某处依赖后门需一并修 |
| **红线** | 无 |
| **工作量** | 1 天 |

---

#### T1-3 清理残留 boot 补丁与一次性脚本 【🔧 修正版】

| 项 | 内容 |
|---|---|
| **问题定位** | `start.cjs:33-35`(已注明 v2.9 移除 fix-kb-gates,src 为唯一权威)、`scripts/fix-kb-gates.cjs`、`_fix_bs.js`、`.check-api.ts`、`scripts/` 下 40+ 一次性脚本 |
| **现状(已验证)** | 🔧 fix-kb-gates.cjs **已不在启动流程**,KnowledgeContextBuilder.ts 已含 `_meetingEntityUuid`/`_isEntityMeeting` 正式代码(128-129行)——闸门修复已正确落入 src。残留的是脚本文件本身。当前 start.cjs 仅跑 2 个**写库**脚本(clean-all-person-edges/backfill-temporals),不写 src,合规 |
| **修改方案** | ① 删除/归档 `scripts/fix-kb-gates.cjs`(确认无引用后);② 审计 scripts/ 下 40+ 一次性脚本——标注用途,已无用的移入 `scripts/archive/`;③ 校验 KnowledgeContextBuilder 无重复/死代码残留 |
| **影响面** | 仅脚本层,不触运行时 |
| **验收标准** | ① grep 全库确认 fix-kb-gates 零引用;② 删除后启动一次服务正常;③ 归档清单产出 |
| **风险** | 低 |
| **红线** | 无 |
| **工作量** | 0.5 天 |

---

#### T1-4 对齐 src/dist 代码漂移 【💀 上线前必做】

| 项 | 内容 |
|---|---|
| **问题定位** | `dist/m5/DeepSeekLLMProvider.js`(含 no-key guard,6 处 `!resolveApiKey()`) vs `src/m5/DeepSeekLLMProvider.ts`(缺 guard) |
| **根因** | Sentinel(端口 8765)自动回滚 src/ 修改,历史会话被迫改 dist 让补丁生效 → 两处行为不一致;运行时/测试从 src 加载,dist 补丁不生效 |
| **修改方案** | ① 通过 Harness 流水线(`harness_run_flow`)获取令牌,把 no-key guard 落回 `src/m5/DeepSeekLLMProvider.ts`;② 重新 build,验证 dist 与 src 一致;③ 确认 `.env` 中 DOUBAO_API_KEY 缺失时行为正确降级 |
| **影响面** | LLM 调用主路径 |
| **验收标准** | ① src 含 guard,`grep -c '!resolveApiKey()' src/m5/DeepSeekLLMProvider.ts >= 2`;② 无 key 启动 → 对话返回降级话术、不 fetch;③ `npm run build` 后 src/dist 行为一致 |
| **风险** | 中。涉及 Harness 令牌流程,需 MCP 在线 |
| **红线** | 无 |
| **工作量** | 0.5-1 天 |

---

#### T1-5 修复 SQL 模板串拼接注入风险 【💀】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m2/SQLiteAdapter.ts:478-487`(回填用 `'${_u}'`/`'%${_n}%'` 拼 SQL,人名来自用户消息) |
| **根因** | 模板字符串直接拼接用户输入进 SQL,存在注入风险 |
| **修改方案** | 改参数化查询(`db.run(..., [$name, $uuid])`),或经 `UUIDPoliceFilter` 白名单校验后走安全路径 |
| **影响面** | M2 回填路径 |
| **验收标准** | ① 构造含 `'` 的人名 → 不报错不注入;② 现有回填功能正常;③ 相关测试通过 |
| **风险** | 低 |
| **红线** | 无 |
| **工作量** | 0.5 天 |

---

### 🟧 阶段 2 · 记忆器官(认知保命)

#### T2-1 统一钙化分数为单一事实源 【🧠】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m2/math.ts:72-76`(computeCalcium: 0.3/0.6/0.8)、`src/m3/PerceptionAnalyzer.ts:460-468`(0.25/0.45/0.65)、`src/m2/FusionStorageAdapter.ts:76`(写入时用 math.ts 重算) |
| **根因** | 同一"钙化分数"三处独立实现:阈值不同(0.3 vs 0.25)、单位不同(0-1 vs 0-10 的 MemoryConfig goldToDiamond=4.5)、入库时被重算覆盖,M3 的场景偏移/实体加权/威胁加成丢失 → **记忆晋升与检索排序漂移** |
| **修改方案** | ① 确定 M3 `calculateCalcium`(含场景/实体/威胁修正)为唯一权威算法;② FusionStorageAdapter 入库改为**传入** M3 结果,不再重算;③ 统一阈值到一处配置(`M3Config` 或 `MemoryConfig`),删除 math.ts 重复逻辑或让其委托;④ `cycleCount` 实现真正递增(M9 强制毕业门控激活) |
| **影响面** | M2/M3/M9 全链、记忆晋升、检索排序、测试基线(重点回归) |
| **验收标准** | ① 同一输入在 M3 与入库后 score 完全一致;② 阈值单一来源(grep 确认无第二个);③ 原有钙化测试全绿;④ 晋升阶梯(砂金→金库→黑钻)行为符合预期 |
| **风险** | **高。** 记忆核心,回归面大。必须 S4 delegate 评审 + 停服测试(CLAUDE.md 规则 4.5) |
| **红线** | 无(不涉角色) |
| **工作量** | 2 天 |

---

#### T2-2 空 catch 清零,让写失败可见 【🧠】

| 项 | 内容 |
|---|---|
| **问题定位** | 全仓 109 处空 `catch{}`:m2/FusionStorageAdapter.ts:97,100,410,448、m2/ConversationDB.ts:119-133、m2/MigrationManager.ts:45-246、DualHelixWriter.ts:119-155 等 |
| **根因** | 静默吞错 → 记忆写入失败/迁移失败/双螺旋失败完全不可见,认知连续性被悄悄破坏 |
| **修改方案** | 分批:核心链路(记忆写入/DB/备份/定时任务)补 `console.error` + 模块名;非核心补 `logger.debug`;确实需静默的加注释说明原因。遵循 CLAUDE.md P0 铁律 |
| **影响面** | 全仓,分批推进(每批 1-2 个模块) |
| **验收标准** | ① 全局搜索 `catch\s*\{\s*\}` 归零;② 故意构造 DB 错误 → 日志输出模块名+错误信息;③ 现有测试全绿 |
| **风险** | 中。分批做,每批验证 |
| **红线** | 无 |
| **工作量** | 2-3 天(分批) |

---

#### T2-3 修复同 seqPos 双写竞态 【🧠】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m2/FusionStorageAdapter.ts`(金库写) vs `src/webui/chat/persistence-stage.ts:182`(sandbox 写),同 seqPos 双写 INSERT OR REPLACE |
| **根因** | 两条路径写同一 memories 表同一位置,竞态覆盖 |
| **修改方案** | 明确唯一写主(FusionStorageAdapter),sandbox 侧改为仅补充字段或统一入口 |
| **影响面** | 持久化双写链 |
| **验收标准** | ① 并发写同一 seqPos → 无覆盖丢失;② 写后 read-back 一致 |
| **风险** | 中 |
| **红线** | 无 |
| **工作量** | 1 天 |

---

### 🟩 阶段 3 · 信任边界(角色与隐私)

#### T3-1 实体隔离"最后一公里"收口 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m4/MemoryRetriever.ts:154`(情感检索不带 entityUuids,仅事后 filterMemories)、`governance screenContext:102`(正则只匹配行首`【`)、`KnowledgeEngine.ts:544`(allowUnowned:true) |
| **根因** | 隔离依赖调用方自觉传 entityUuids;情感/名字兜底路径是后置过滤;`_gatekeeper` 为空时防线失效;行内标签不匹配 → 泄漏 |
| **修改方案** | ① 情感检索/名字兜底路径统一带 entityUuids;② screenContext 正则扩展匹配行内标签;③ 审计所有 `allowUnowned:true` 调用点,确认是否真需要逃生口;④ 建立"隔离自检"测试(多实体交叉查询断言不泄漏) |
| **影响面** | M4 检索、会晤、FG 读写 |
| **验收标准** | ① 实体 A 视角检索 → 断言不含实体 B 数据;② 构造带缩进标签文本 → 正确过滤;③ 会晤/角色扮演测试全过 |
| **风险** | 高。涉 FG 红线 1/2/3/8,必须读红线文档 + 输出 11 条触碰判定表 |
| **红线** | 🔴 **涉及红线 1、2、3、8** |
| **工作量** | 2 天 |

---

#### T3-2 反编造正则与档案数据合一 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `retrieval-stage.ts:118`(FABRICATION_PATTERNS 拦"营销总监/全职太太") vs `m4/household/shared/RelationLabels.ts:89-98`(它们是合法职业) |
| **根因** | 两处独立硬编码,互相矛盾 → 要么误杀合法记忆,要么漏放编造 |
| **修改方案** | ① 反编造判定改为**基于数据**:某人 profile 中存在的职业/特征 → 不算编造;不存在 → 才算;② 删除 FABRICATION_PATTERNS 中的职业类关键词,改为"对照档案"逻辑;③ 保留生理类/场景类硬边界词 |
| **影响面** | 会晤记忆过滤、反编造 |
| **验收标准** | ① 档案含"营销总监"的人被提及 → 不拦截;② 档案不含却自称 → 触发 FabGuard;③ 相关测试通过 |
| **风险** | 中。涉 FG,需触碰判定表 |
| **红线** | 🔴 **涉及红线 1、3** |
| **工作量** | 1.5 天 |

---

#### T3-3 M6 演化通道激活或删除 【🧠】

| 项 | 内容 |
|---|---|
| **问题定位** | `post-process.ts:86`(调不存在的 `m6.ingestFeedback`,错误被吞)、`BoundaryManager.recordHit`(从未调用,代码自述)、`PreferenceManager.recordMention`(缺 sourceMessage → 永不生效)、`chat.ts:2329`(getTraits()恒真 → 正反馈只加 agreeableness) |
| **根因** | 三条演化通道断链/死代码 + 一条方向偏差 → 人格实际不成长,且方向偏 |
| **修改方案** | 三选一逐条:① ingestFeedback 要么在 M6Orchestrator 实现真方法,要么删除调用;② recordHit 接上调用点或删 BoundaryManager;③ recordMention 传 sourceMessage;④ 修 getTraits 判断 |
| **影响面** | M6 自我模型演化 |
| **验收标准** | ① 无调用不存在的成员(编译+运行零警告);② 反馈确实改变 traits/preferences;③ 正反馈不再只加 agreeableness |
| **风险** | 中 |
| **红线** | 无 |
| **工作量** | 1.5 天 |

---

#### T3-4 Prompt 注入面收敛 + 日志去敏 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m5/DeepSeekLLMProvider.ts:611-613`(上传文档经 roleDetail 变 system prompt)、`:598`(KB 原文透传)、`:685-686`(日志打印 system prompt 前 500 字 + kb 前 200 字 + role) |
| **根因** | 多源用户内容可进 system prompt 顶层;日志泄漏敏感上下文 |
| **修改方案** | ① 上传文档/KB 内容限界为**用户消息区**或隔离的"资料区",不可覆盖 system prompt 的身份/规则;② 日志改为摘要(traceId + 长度 + role),不打印原文 |
| **影响面** | LLM 调用、上传知识、日志 |
| **验收标准** | ① 构造恶意文档(含"忽略上述规则")→ 系统身份不被接管;② 日志不含 KB 原文/system prompt 原文;③ 对话功能正常 |
| **风险** | 中。涉 M5,需行为核验(角色不泄漏) |
| **红线** | 🔴 **涉及红线 11(角色体系)** |
| **工作量** | 1.5 天 |

---

#### T3-5 LLM 失败可见性 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `DeepSeekLLMProvider.ts:850-860`(失败返回 canned 话术)+ `M5Orchestrator.ts:98-102`("网络不稳定"兜底永不触发) |
| **根因** | 失败被伪装成正常回复,用户/开发者都无法感知降级 |
| **修改方案** | ① 降级话术前加可识别标记(如 `⚠️` + 明确文案)或保留错误码在响应结构里;② M5Orchestrator 的兜底分支实际可触达 |
| **影响面** | 对话响应 |
| **验收标准** | ① 无 key/断网 → 回复明显提示降级,不再是"我想你了";② 正常时无标记 |
| **风险** | 低 |
| **红线** | 无 |
| **工作量** | 0.5 天 |

---

#### T3-6 修复 2 人会晤退化 【🏥】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m4/household/EntityMeeting.ts:322`(`isMulti=length>=3`,`recordTurn` 在 `!isMulti` 直接 return → 2 人不记轮次、exit 不生成纪要) |
| **根因** | 会晤定义把 2 人排除,第二参与者成哑巴 |
| **修改方案** | isMulti 判定改为 `length>=2`(或增加独立的多方判定),2 人时也记轮次、生成纪要 |
| **影响面** | 会晤流程 |
| **验收标准** | ① 2 人会晤 → recordTurn 生效、exit 生成纪要;② 单人模式不回归 |
| **风险** | 中。涉 FG 红线 1/2 |
| **红线** | 🔴 **涉及红线 1、2** |
| **工作量** | 0.5-1 天 |

---

#### T3-7 移除角色名硬编码与泄漏 DEBUG 【❤️】

| 项 | 内容 |
|---|---|
| **问题定位** | `EntityMeeting.ts:438-440`(含"诗雨"的消息打 DEBUG)、`chat.ts:1288-1328`(硬编码"玉瑶/鸿艺/鸿叔/艺哥")、`KnowledgeEngine.ts:277`(隐私正则内嵌"徐诗雨/梓铭") |
| **根因** | 真人名硬编码散落;含名消息进日志 |
| **修改方案** | ① 日志去名化(替换为实体 UUID 或"参会人");② 硬编码角色名收敛到配置/PersonaRegistry;③ 隐私正则改为从档案动态生成 |
| **影响面** | 日志、角色路由 |
| **验收标准** | ① 日志无真人名;② 改角色名只改一处配置;③ 现有测试通过 |
| **风险** | 中。涉红线 11 |
| **红线** | 🔴 **涉及红线 11** |
| **工作量** | 1 天 |

---

### 🟦 阶段 4 · 工程债(分批)

#### T4-1 M3 confidence 污染修复 【🧠】

| 项 | 内容 |
|---|---|
| **问题定位** | `M3LogicOrchestrator.ts:86-88`(`getTotalHitCount()` 全局累计当本条词密度)+ `PerceptionAnalyzer.ts:36-40,129-139`(不清零) |
| **根因** | confidence 用全局累计命中数,长运行后恒趋 1 → 重排失去意义 |
| **修改方案** | 词命中统计改为 per-message 作用域,清空/局部化 |
| **验收标准** | ① 运行 100 轮后 confidence 仍随文本变化;② 相关测试通过 |
| **工作量** | 1 天 |

#### T4-2 双 24D 向量统一 【🏥 最大架构债】

| 项 | 内容 |
|---|---|
| **问题定位** | M3 `Perception24D`(规则词典,存 M2) vs Engine `EmotionVector24D`(刺激响应,存 engine_store)。维度名/范围/算法全不同,Engine 的 24D 不参与检索 |
| **根因** | 双系统并行,下游(M5)不知道该用哪套 |
| **修改方案** | 分两步:先加双向映射函数(2 天),再评估统一到 Engine 格式(大修)。**建议本次先做映射,统一列为专项** |
| **验收标准** | ① 映射函数往返误差可接受;② 检索可用 Engine 24D 找到相似记忆 |
| **工作量** | 2 天(映射) / 专项(统一) |

#### T4-3 FamilyGraph 超大文件拆分 【🏥】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/m4/household/FamilyGraph.ts` 5982 行,含 19 个裸 catch |
| **根因** | 职责混杂(节点/边/dossier/亲属推断/类别/迁移) |
| **修改方案** | 按职责拆:亲属推断、dossier、类别管理、关系读写 各自独立文件;拆一块验一块 |
| **验收标准** | ① 拆分后行为不变(测试全绿);② 各新文件职责单一 |
| **红线** | 🔴 **涉及全部 FG 红线**。必须读红线文档 + 触碰判定表 |
| **工作量** | 3-5 天(分批) |

#### T4-4 审计落盘 + AuthzPolicy 生效 【🏥】

| 项 | 内容 |
|---|---|
| **问题定位** | `src/governance/audit/AuditSink.ts:41-49,91`(生产默认 NoopAuditSink);`AuthzPolicy.ts`(从不读 requiresConfirmation) |
| **根因** | 授权决策从不落盘;"装饰性授权" |
| **修改方案** | ① AuditSink 接真实持久化(JSONL 或 SQLite);② AuthzPolicy 读 requiresConfirmation/derivedFromInference |
| **验收标准** | ① 授权决策有落盘记录;② 需确认的写操作实际要求确认 |
| **工作量** | 1-2 天 |

#### T4-5 根目录卫生清理 【🏥】

| 项 | 内容 |
|---|---|
| **问题定位** | `undefined/` 目录(path.join undefined)、`D:wenstarkb_final.json`(盘符前缀文件名)、11 个 server-40d-v*.log、srv.log/srv2.log、`__m7_test_*.db` 残留 |
| **修改方案** | 归档到 `D:\tools\wenstar-cc\archives\`;修路径拼接 bug(根因 `undefined` 目录) |
| **验收标准** | ① 根目录整洁;② 无新增 undefined 目录 |
| **工作量** | 0.5 天 |

#### T4-6 `as any`/`any` 类型收敛 【🩹 慢性】

| 项 | 内容 |
|---|---|
| **问题定位** | 993 处 `as any`、1968 处 `any` 标注 |
| **修改方案** | 分批:核心数据结构(记忆/感知向量/上下文)先定义类型;`@ts-ignore`→`@ts-expect-error` |
| **验收标准** | 逐批减少;编译零错误 |
| **工作量** | 持续(每批 1 天) |

---

## 5. 排期与里程碑

```
里程碑 M0  阶段0 准备        (2026-08-13)   基线测试快照 + 分支策略
里程碑 M1  阶段1 保命完成    (2026-08-16)   P0 全部修复,稳定运行 2 天
里程碑 M2  阶段2 记忆完成    (2026-08-22)   P1 修复 + 钙化统一,回归全绿
里程碑 M3  阶段3 信任完成    (2026-08-29)   隔离/反编造/M6/Prompt 修复
里程碑 M4  阶段4 分批推进    (持续)          工程债按批次,每批验证稳定 2 天
```

## 6. 质量保障体系

| 保障 | 内容 |
|---|---|
| **测试基线** | 每任务前后跑 `npm test` + 相关 smoke,记录 diff |
| **停服测试** | 涉数据库任务(阶段 2)先停服再测(CLAUDE.md 规则 4.5) |
| **行为核验** | 涉 LLM/角色任务(阶段 3)发测试消息验证:角色称呼不泄漏、身份不混淆、场景不循环、不重复回复(CLAUDE.md 规则 11) |
| **持久化核验** | 涉数据写入任务 → 停服→重启→查库确认数据还在(S6 .save() 校验) |
| **S4 独立评审** | 每任务必 delegate 独立子 Agent 评审,运动员不自审 |
| **复审** | 涉及 ≥3 文件或数据库变更 → 按 CLAUDE.md 规则 12 三遍复审(对比/持久化/边界) |

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 钙化统一(阶段2)回归面大 | 高 | 独立分支 + 停服测试 + S4 评审 + 回滚预案 |
| FG 相关改动破坏角色红线 | 高 | 每任务读红线文档 + 触碰判定表 + 行为核验 |
| Sentinel 干扰 src 修改 | 中 | 走 harness_run_flow 令牌流程,不用 Bash 改文件 |
| src/dist 漂移复发 | 中 | T1-4 根治后,新增 guard 一律落 src + build 验证 |
| 压缩后规则丢失 | 中 | 本任务书落盘 docs/,压缩后先 Read 恢复上下文 |

## 8. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-08-12 | 初稿。基于全系统探察 + FG 红线 + 现场验证 |

---

> **一句话**:先保命,再养记忆,再守边界,最后还债。每一阶段都是独立闭环,稳定 2 天再进下一阶段。
> **本任务书经决策者确认后即成为阶段 2 起的执行依据。**
