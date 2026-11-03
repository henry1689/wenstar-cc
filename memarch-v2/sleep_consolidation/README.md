# MemArch-v2.0.0 / M3-SleepConsolidation

> 睡眠巩固模块：十步流水线编排器 + 断点续跑 + 生命周期状态机 + LLM 预算控制

## 架构概览

```
sleep_consolidation/
├── config/                 # 配置：预算、配额、总开关
│   ├── flags.ts           # MEMORY_FORGET_ENABLED 等功能标志
│   ├── budget.ts          # LLM token 预算控制
│   ├── quota.ts           # purge 配额、批次大小、超时
│   └── index.ts           # 配置统一出口
├── checkpoint/             # 断点续跑机制
│   └── CheckpointStore.ts # 基于 sleep_runs 表的 checkpoint 持久化
├── lifecycle/             # 生命周期状态机
│   ├── LifecycleStateMachine.ts  # 状态转换规则
│   ├── PromotionEvaluator.ts     # 批量晋升评估
│   └── index.ts
├── prompts/                # LLM Prompt 模板
│   ├── gist.prompt.ts      # Episode gist 生成
│   ├── salience.prompt.ts  # 五维显著性打分
│   ├── extraction.prompt.ts # 语义事实萃取
│   └── index.ts
├── pipeline/               # 十步流水线
│   ├── StepBase.ts         # 步骤抽象基类（计时 + 预算 + 幂等）
│   ├── Step1_ScanPending.ts       # ① 扫描待处理条目
│   ├── Step2_SealEpisodes.ts      # ② 事件封口 + gist 生成
│   ├── Step3_ReevalRawOnly.ts     # ③ RAW_ONLY 复评
│   ├── Step4_ScoreSalienceLLM.ts  # ④ LLM 精确显著性打分
│   ├── Step5_BuildReplaySet.ts    # ⑤ 优先回放集 + STC 标记
│   ├── Step6_MergeDedupe.ts       # ⑥ 合并去重
│   ├── Step7_ExtractSemantic.ts   # ⑦ 语义萃取
│   ├── Step8_ResolveTemporal.ts   # ⑧ 双时态冲突消解
│   ├── Step9_PromoteLifecycle.ts  # ⑨ 晋升评估 + 生命周期推进
│   ├── Step10_PurgeTombstones.ts  # ⑩ 墓碑清理 + 索引维护
│   ├── SleepOrchestrator.ts       # 编排器（断点续跑 + 幂等）
│   └── index.ts
├── tests/                  # 测试
│   ├── test_lifecycle.test.js       # 生命周期状态机单测
│   ├── test_checkpoint.test.js      # 断点续跑单测
│   ├── test_budget_quota.test.js    # 预算配额单测
│   └── test_pipeline_integration.test.js # 端到端集成测试
├── types.ts                # 统一类型定义
└── index.ts                # 对外统一出口
```

## 十步流水线

| 步骤 | 名称 | 耗时目标 | LLM 依赖 | 小睡跳过 |
|------|------|----------|----------|----------|
| ① | scan_pending | <1s | 无 | 否 |
| ② | seal_episodes | ~2min | gist 生成 | 是 |
| ③ | reeval_raw_only | ~30s | 无（规则版） | 否 |
| ④ | score_salience_llm | ~5min | 五维打分 | 是 |
| ⑤ | build_replay_set | ~30s | 无 | 是 |
| ⑥ | merge_dedupe | ~3min | 无 | 是 |
| ⑦ | extract_semantic | ~5min | 事实萃取 | 是 |
| ⑧ | resolve_temporal | ~30s | 无 | 是 |
| ⑨ | promote_lifecycle | ~1min | 无 | 否 |
| ⑩ | purge_tombstones | ~30s | 无 | 否 |

## 快速开始

```typescript
import Database from 'better-sqlite3';
import { SleepOrchestrator, loadSleepConfig } from './sleep_consolidation/index.js';

const db = new Database('./data/memarch-v2.db');
const config = loadSleepConfig({
  MEMARCH_NAMESPACE: 'default',
  MEMORY_FORGET_ENABLED: '1',  // 0 = 只计算不执行（dry-run）
});

const orchestrator = new SleepOrchestrator(db, config);

// 注入 LLM 客户端（可选）
// orchestrator.setLLM(myLLMClient);

// 执行主睡眠（自动断点续跑）
const metrics = await orchestrator.execute('main', true);
console.log('睡眠完成：', metrics);
```

## 验收标准对照

| 验收项 | 实现位置 |
|--------|----------|
| 主睡眠 ≤ 30 分钟 | `config/quota.ts` → `mainSleepTimeoutMin: 30` |
| 小睡 ≤ 5 分钟 | `config/quota.ts` → `napTimeoutMin: 5` |
| 断点续跑（步骤5中断后从步骤5继续） | `checkpoint/CheckpointStore.ts` + `pipeline/SleepOrchestrator.ts` |
| 幂等性（同一步骤执行两次不重复） | `CheckpointStore.isStepCompleted()` + 各步骤 INSERT OR IGNORE |
| MEMORY_FORGET_ENABLED=0 只计算不执行 | `Step10_PurgeTombstones.ts` 中 `forgetEnabled` 分支 |
| 每日 purge 达 500 条自动停止 | `Step10_PurgeTombstones.ts` 中 `dailyPurgeLimit` 检查 |

## Harness 指标看板

运行后返回 `HarnessMetrics` 数据结构，包含：

- **stepResults**: 各步骤耗时、处理条目数、LLM 调用次数
- **llmBudget**: token 消耗、剩余预算、利用率
- **purgeCount / dailyPurgeCount**: 本次/今日 purge 数量
- **checkpoint**: 断点状态、是否恢复运行
- **promotionStats**: 各生命周期转换统计

## 与 M1/M2 的接口契约

- **写入**：复用 M1 `WriteQueue`，小事务 ≤200 行
- **RAW_ONLY 数据源**：读取 M2 `conversations` 表中 `lifecycle_state='raw_only'`
- **巩固度/激活度更新**：直接写入 M1 `memories` 表（`consolidation` / `activation_cache`）
- **事件表**：读写 M1 `episodes` 表（封口、gist 写入）

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_FORGET_ENABLED` | `0` | 遗忘总开关：1=执行 purge，0=dry-run |
| `LLM_SALIENCE_ENABLED` | `1` | 是否启用 LLM 显著性打分 |
| `LLM_GIST_ENABLED` | `1` | 是否启用 gist 生成 |
| `SLEEP_NAP_MODE` | `0` | 小睡模式 |
| `MEMARCH_DB_PATH` | `./data/memarch-v2.db` | 数据库路径 |
| `MEMARCH_NAMESPACE` | `default` | 命名空间隔离 |
