# 🏛️ 太虚境·文曲星 架构优化完整方案

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 综合双方意见：你的"拆大文件+统一路由+分步走" + 嫂子的"分层解耦+逻辑收敛+标准化+经验沉淀"

---

## 核心原则

1. **不推翻现有业务链路** — 每改一步，现有功能不变
2. **分层解耦，逻辑收敛** — 巨型文件拆小，重复逻辑合一
3. **每步可验证、可回滚** — 改完就测，出事切 tag
4. **改 Demo = 铺垫新系统底座** — 踩坑记录全部留给 WenStarOS

---

## 阶段一：致命问题修复 + 单源状态改造（1次对话）

### 1.1 修复 10 项已知缺陷

| # | 问题 | 修复方式 |
|---|------|---------|
| 1 | 角色路由三重重复调用 | 以 chat.ts 为唯一权威，M5/DeepSeek 删掉独立分类 |
| 2 | retrieveFullClue 无时间窗 | 默认只读近30天，加 sinceTimestamp 参数 |
| 3 | 两份 family_graph.db | 已统一 + 归档 |
| 4 | 亲密文本正则三处不一致 | 统一 `isIntimate()` 工具函数，全局复用 |
| 5 | 角色切换频繁锁死 | 阈值做成可配置，亲密场景放宽 |
| 6 | LLM reasoning_content 污染 | 加强剥离逻辑（已做） |
| 7 | 学术守卫误拦截 | 增加场景标签区分 |
| 8 | 人物年龄/关系幻觉 | M4 前置 FG 校验 |
| 9 | 同步持久化阻塞接口 | 梦境/年轮/演化异步化 |
| 10 | chat.ts 2980 行 | 拆分为 4 条独立管线 |

### 1.2 拆分 chat.ts → 4 个独立文件

```
原 chat.ts（2980行）
  │
  ├─ ChatEntryGuard.ts       入口守卫/消息预处理/扮演识别/口语过滤
  ├─ ChatRetrievalPipeline.ts 记忆/知识库/FG 检索链路（原阶段C）
  ├─ ChatGeneratePipeline.ts  认知组装/LLM调用/回复后校验（阶段D-F）
  ├─ ChatPersistencePipeline.ts 对话落库/梦境/年轮/演化副作用（阶段G）
  │
  └─ chat.ts（保留~300行）  仅4个管线的串行调度入口
```

### 1.3 统一全局上下文 `ChatContext`

```typescript
interface ChatContext {
  sessionId: string
  dgId: string
  userRawMsg: string
  
  // 唯一角色状态（全链路只读）
  currentRole: RoleType
  rpState: TransitionState
  rpChar: FamilyGraphRoleBranch | null
  rpTurn: number
  rpJustExit: boolean
  
  // 全链路中间产物
  dna: DNA
  wenVec: number[]   // 36维向量（兼容旧24D）
  calciumScore: number
  m4Ctx: M4Context
  
  // 全局标记
  isRolePlayMode: boolean
  isIntimateScene: boolean
}
```

**铁律**：所有模块禁止自行创建角色状态，classify() 全局只暴露一处统一工具函数。

---

## 阶段二：核心模块标准化封装（2-3次对话）

### 2.1 公共基础层 `src/common/`

```
src/common/
  ├── const/         所有固定权重、阈值、路径、枚举
  │   ├── paths.ts      数据库路径、模板路径
  │   ├── thresholds.ts 钙化阈值、晋升条件、相似度阈值
  │   ├── enums.ts      圈层等级、关系类型、WenVec36维度定义
  │   └── intimacy.ts   亲密关键词统一正则
  ├── types/         全局统一 TS 类型
  │   ├── dna.ts        DNA 结构体（含 vec_ref 预留字段）
  │   ├── vault.ts      三金库统一结构
  │   ├── fg.ts         FG 关系/节点/圈层类型
  │   └── context.ts    ChatContext 定义
  └── utils/         全局工具函数
      ├── id-gen.ts     dna_root_id/branch_id/seq_pos 唯一生成入口
      ├── is-intimate.ts 统一亲密检测函数（替代三处分散正则）
      ├── wen-vec.ts     24D→36D 向量兼容转换
      └── time.ts       公历/农历/四季/时段标签
```

### 2.2 M2/M4 存储统一封装

```
VaultStorage 工具类（统一三金库读写）
  ├── writeSand(conversation) → conversations 表
  ├── writeGold(dna, perception) → memories 表
  ├── upgradeToBlackDiamond(memoryId) → black_diamond 表
  ├── queryByTimeWindow(type, start, end, roleplay?) → 强制时间窗
  └── queryByEntity(name, type) → 实体关联查询

FGAdapter 工具类（统一家族图谱查询）
  ├── getPerson(name) → PersonProfile
  ├── getRelatives(name, maxHop) → Relative[]
  ├── getEdge(a, b) → RelationType
  ├── validatePerson(name) → { age, occupation, exists }
  └── validateConsistency() → 冲突报告
```

### 2.3 M5 提示词模板化 + 参数配置中心

```
prompts/              全部提示词抽离为独立 XML 模板
  ├── core-rules.xml     核心规则
  ├── identity-fixed.xml 固定身份
  ├── fact-database.xml  事实库
  ├── memory-block.xml   历史记忆
  ├── output-format.xml  输出格式
  └── intimate-mode.xml  亲密模式

llm-config.ts         参数统一配置中心
  ├── daily    { temp: 0.9, timeout: 10s, reasoning: undefined }
  ├── intimate { temp: 1.0, timeout: 20s, reasoning: undefined }
  └── roleplay { temp: 0.4, timeout: 15s, reasoning: 'max' }
```

---

## 阶段三：异步化 + 经验沉淀（持续）

### 3.1 M6/M7/M8 全异步化

```
高钙化事件 → EventBus → DreamQueue    (M7)
高价值记忆 → EventBus → M8Engine      (M8)
关系变更   → EventBus → M6Orchestrator (M6)
```

### 3.2 自动化巡检脚本

```
scripts/
  ├── db-check.ts      脏数据巡检（孤立节点、缺失反向边、冲突人物）
  ├── vec-test.ts      向量提取效果测试（记录各场景标准值域）
  └── pipeline-debug.ts 全链路日志（DNA→向量→检索→钙化分→回复）
```

### 3.3 四层日志体系

```
INFO  → 正常对话流转、记忆晋升、关系更新
DEBUG → DNA字段、向量数值、检索命中列表
WARN  → 人物冲突、权重自动修正、角色切换熔断
ERROR → 数据库写入失败、LLM超时、图谱节点缺失
```

### 3.4 经验沉淀文档

```
docs/
  ├── architecture-trap.md    架构踩坑记录
  ├── parameter-tuning.md     参数调优记录（钙化/向量/温度最优值）
  ├── fg-practice.md          图谱实践经验（圈层分配/权重/锁）
  └── demo-summary.md         全链路踩坑总结 → 直接平移到新系统
```

---

## 执行节奏总表

| 阶段 | 内容 | 时长 | 风险 |
|:----:|------|:----:|:----:|
| 一 | chat.ts 拆分 + 10 bug 修复 + ChatContext 统一 | 1次对话 | ⚠️ 中（拆文件可能隐藏依赖） |
| 二 | common 基础层 + 存储封装 + 提示词模板化 | 2-3次对话 | 🟢 低（新增不修改） |
| 三 | 异步化 + 巡检脚本 + 经验文档 | 持续 | 🟢 低（不影响现有功能） |

**回滚保障**：每阶段完成打 tag（`opt-phase1-20260709`），出事 `git reset --hard`。
