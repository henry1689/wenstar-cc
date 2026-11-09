# MemArch Module 3 — 睡眠巩固（Sleep Consolidation）任务书

> **模块编号**: M3-SleepConsolidation
> **版本**: v1.0 任务书
> **日期**: 2026-11-03
> **基线溯源**: 基于 **MemArch-v2.0.0-Baseline** (MD5: `C3DCBFC83B96EBE88D06D230F26CF503`) 拆分
>
> ---
> **📊 任务书三级要素**
>
> | 要素 | 内容 |
> |---|---|
> | **P 优先级** | 🟠 **P1** — 高优先级，记忆系统的"离线大脑" |
> | **交付物清单** | ① 十步睡眠流水线编排器（断点续跑 + 幂等）<br>② 事件封口（gist 生成）<br>③ RAW_ONLY 复评（带上下文再编码）<br>④ 精确显著性打分（LLM 版）<br>⑤ 优先回放集 + STC 行为标记<br>⑥ 合并去重 + 语义萃取 + 双时态冲突消解<br>⑦ 晋升评估 + 生命周期推进<br>⑧ 墓碑清理 + 索引维护<br>⑨ 单元测试 + 集成测试 |
> | **依赖关系** | 前置：M1 存储层、M2 在线写入（有 RAW_ONLY 数据）<br>并行：无<br>下游：M4 检索（巩固度激活度作为先验） |
> | **执行权限** | 🤖 **Claude Code 主导**<br>（十步流水线编排、晋升算法、生命周期状态机属于内核重构）<br>👥 **Pi 辅助**（LLM prompt 模板、测试用例、Harness 指标看板） |
> ---

---

## 一、模块概述与边界

### 1.1 模块定位

睡眠巩固模块是记忆系统的"离线大脑"，负责把白天零散、粗糙的编码，在夜间（或用户空闲时）整理、加固、提炼、遗忘。它是**重活离线做**（P5 原则）的核心载体，所有 LLM 调用、合并、萃取、遗忘决策都在这里完成，不阻塞在线交互。

### 1.2 模块边界

**本模块负责**：
- 十步睡眠流水线的编排与执行
- 事件封口（episode gist 生成）
- RAW_ONLY 复评（带上下文再编码）
- 精确显著性打分（LLM 版）
- 优先回放集计算与执行
- STC 行为标记
- 合并去重
- 语义萃取 + 双时态冲突消解
- 晋升评估（consolidated / 黑钻候选）
- 生命周期状态推进（fresh → weakening → expiring → consolidated）
- 墓碑清理与索引维护

**本模块不负责**：
- 在线写入（→ M2）
- 检索与排序（→ M4）
- 记忆呈现与守卫（→ M5）
- 用户主权操作（→ M6，本模块只做自动遗忘，不做用户主动遗忘）

---

## 二、核心功能清单

### 2.1 睡眠流水线十步

| 步骤 | 名称 | 输入 | 输出 | 认知对应 |
|---|---|---|---|---|
| 1 | 事件封口 | open 状态的 episode | gist、参与者、情绪曲线、episode 显著性 | 事件分割 |
| 2 | 复评 RAW_ONLY | 带 episode 上下文的原始消息 | 补写 L3 痕迹，或确认不写 | 带上下文的再编码 |
| 3 | 精确打分 | 当日新痕迹 | LLM 重要度、精确新颖度、自我相关度 | — |
| 4 | 优先回放 | 回放集（P_i 排序前 100） | 巩固度 +η_sleep，更新实体边权重 | 海马回放 |
| 5 | STC 行为标记 | 高唤醒 episode 前后 ±6h 的弱痕迹 | 巩固度小幅上调 | 突触标记与捕获 |
| 6 | 合并去重 | 余弦 ≥ 0.92 且实体重合的痕迹对 | 合并成一条，n_refs 相加，溯源链保留 | 记忆整合 |
| 7 | 语义萃取 + 冲突消解 | 已巩固痕迹、gist | L4 事实；旧事实设置 valid_to | 系统巩固 |
| 8 | 晋升评估 | 全部 L3 / L2 | 进入巩固态、黑钻候选 | 固化 |
| 9 | 生命周期推进 | 刷新 activation_cache 后的 B 层 | 状态迁移，expiring 先尝试萃取 | 主动遗忘 |
| 10 | 墓碑清理 + 索引维护 | 到期墓碑 | 物理清除、FTS 优化、Harness 指标 | 类淋巴清洗 |

### 2.2 触发与调度

| 触发类型 | 条件 | 执行步骤 |
|---|---|---|
| 主睡眠 | 本地时间 03:00 + 用户空闲 ≥ 30 分钟 | 全部 10 步 |
| 小睡 | 用户空闲 ≥ 2 小时 | 步骤 1-3（轻量） |
| 手动 | 业主命令 | 可指定步骤范围，支持 dry-run |

### 2.3 工程保障机制

- **断点续跑**：每步写 checkpoint 到 sleep_runs，崩溃后从断点继续
- **幂等设计**：每步用 sleep_run_id + target_id 作为幂等键，重复执行不产生副作用
- **预算控制**：每步有 LLM 调用预算和时间预算，超出就留到下一个周期
- **存活计数**：主睡眠成功完成后，所有存活痕迹的 sleep_cycles_survived + 1

### 2.4 优先回放集

**优先级公式**：
```
P_i = S_i · (1 - c_i) · (0.5 + 0.5 · nov_i)
```
- S_i：显著性
- c_i：当前巩固度
- nov_i：新颖度

**取前 N = 100 条**，已经巩固（c ≥ 0.85）的不再回放（无边际收益）。

### 2.5 冲突消解（步骤 7 细节）

```
新事实 F_new(subject, predicate, object)
  ├─ 查询同 subject + predicate 且 valid_to IS NULL 的旧事实 F_old
  ├─ 谓词为单值型（lives_in / works_at / relationship_status）：
  │     object 不同 → F_old.valid_to = F_new.valid_from；F_old.superseded_by = F_new.id
  ├─ 谓词为多值型（likes / has_pet）：并存，不冲突
  ├─ 无法判定 → 两条都保留，置信度各 -0.1，标记 conflict
  └─ 全程写账本（只记 id 和谓词）
```

---

## 三、技术实现要点

### 3.1 编排骨架

```typescript
const STEPS: SleepStep[] = [
  sealEpisodes, reevaluateRawOnly, preciseScoring, prioritizedReplay,
  stcTagging, mergeDuplicates, extractSemantics, evaluatePromotions,
  advanceLifecycle, purgeAndMaintain,
];

export async function runSleep(mode: 'main' | 'nap'): Promise<void> {
  const run = SleepRuns.resumeOrCreate(mode);
  const steps = mode === 'nap' ? STEPS.slice(0, 3) : STEPS;

  for (const step of steps.slice(run.stepIndex)) {
    const budget = CFG.sleep.budgets[step.name];
    const res = await step.exec({ runId: run.id, budget, cycleNo: run.cycleNo });
    SleepRuns.checkpoint(run.id, step.name, res.stats);
    if (res.deferred) break;                      // 超预算，剩余留给下个周期
  }

  if (mode === 'main' && SleepRuns.allDone(run.id)) {
    incrementSurvivedCycles(run.cycleNo);
  }
  Harness.report(run.id);
}
```

### 3.2 豁免检查（生命周期推进前）

按顺序执行，任一命中即跳过遗忘：
1. A 层锚点豁免：所属 episode 含 A 层条目或黑钻引用，整组豁免
2. DNA 根保护：本条是 ≥1 条 A 层记忆的 dna_root_id
3. 黑钻引用：被 black_diamond_v2 引用
4. 前瞻记忆引用：被 pending 状态的承诺引用
5. L4 唯一来源：是某条有效 L4 事实的唯一来源 → 只删原文，保留溯源存根

### 3.3 删除五道闸

| 闸 | 实现 |
|---|---|
| 先忘后删 | tombstone 时同步删除 FTS 行和向量行，主表保留墓碑元数据 |
| 墓碑期 30 天 | purge_after = deleted_at + 30d |
| 硬配额 | 每日 purge 计数达 500 条即停 |
| 完整性 + 快照 + 事务 | PRAGMA integrity_check，VACUUM INTO 备份，小事务 |
| 总开关 | MEMORY_FORGET_ENABLED=0 时只计算不执行（影子模式） |

### 3.4 晋升判定（步骤 8）

```typescript
export function evaluatePromotion(m: TraceRow, ctx: PromoCtx): PromoDecision {
  if (m.lifecycle_state === 'tombstone' || m.namespace !== 'default') return { to: null };

  // consolidated 条件：c ≥ 0.85 且 睡眠周期 ≥ 3 且 不同日期召回 ≥ 3
  const consolidated =
    m.consolidation >= 0.85 &&
    m.sleep_cycles_survived >= 3 &&
    m.distinct_recall_days >= 3;

  if (!consolidated) return { to: null };
  if (m.lifecycle_state !== 'consolidated') return { to: 'consolidated', reason: 'c+cycles+spacing' };

  // 黑钻候选：SD ≥ 0.7 且 (地标 或 用户确认)
  const sd = selfDefiningScore(m, ctx);
  const diamondEligible = sd >= 0.7 && (m.is_landmark === 1 || ctx.userConfirmed);

  if (!diamondEligible) return { to: null };
  if (m.sensitivity >= 1 && !ctx.userConfirmed) return { to: 'diamond_pending_confirm', sd };
  if (ctx.autoDiamondThisWeek >= 5) return { to: null, reason: 'weekly_cap' };

  return { to: 'diamond', sd, reason: 'self-defining' };
}
```

**取消旧通道**：
- 取消：地标 + 钙 ≥ 3.5 单独通道
- 取消：原生钙 ≥ 4.5 单独通道
- 取消：召回 ≥ 5 单独通道
- 取消：亲密关键词情感通道

---

## 四、验收标准

### 4.1 功能验收

| 验收项 | 通过标准 |
|---|---|
| 断点续跑 | 步骤 5 中断后重启，从步骤 5 继续，不重复执行前 4 步 |
| 幂等性 | 同一步骤执行两次，数据不产生重复或冲突 |
| 事件封口 | 测试 20 个 open episode，gist 生成质量人工评分 ≥ 3/5 |
| RAW_ONLY 复评 | 复评后 30-50% 的 RAW_ONLY 消息补写痕迹 |
| 优先回放 | 回放集确实是 S·(1-c)·(0.5+0.5·nov) 排序前 100 |
| STC 标记 | 高唤醒 episode 前后 ±6h 的弱痕迹巩固度有小幅上调 |
| 合并去重 | 余弦 ≥ 0.92 且实体重合的痕迹对被正确合并 |
| 冲突消解 | "我住杭州" → "我住上海" 后，旧事实 valid_to 正确设置 |
| 晋升评估 | 满足条件的痕迹正确进入 consolidated 状态 |
| 生命周期推进 | activation 低于阈值的痕迹正确进入 weakening/expiring |
| 墓碑清理 | 到期墓碑被正确物理删除，审计账本记录完整 |

### 4.2 性能验收

| 验收项 | 通过标准 |
|---|---|
| 主睡眠总耗时 | ≤ 30 分钟（万级条目） |
| 小睡总耗时 | ≤ 5 分钟 |
| 单步预算 | 每步 LLM 调用不超预算，超出自动 defer |
| 在线写入不阻塞 | 睡眠期间在线写入 p95 延迟增加 ≤ 10ms |

### 4.3 安全验收

| 验收项 | 通过标准 |
|---|---|
| 总开关生效 | MEMORY_FORGET_ENABLED=0 时，步骤 9-10 只计算不执行 |
| 配额生效 | 每日 purge 达 500 条后自动停止 |
| 豁免检查生效 | A 层锚点/DNA根/黑钻引用的痕迹不被遗忘 |
| 审计完整 | 所有 promote/tombstone/purge 操作都有审计记录 |

---

## 五、⚠️ 加固防篡改要求（验收合格后强制执行）

### 5.1 加固时机

**本模块全部验收通过后**，由模块负责人执行加固，加固完成前不得交付给 M4/M6 调用。

### 5.2 加固内容

#### 5.2.1 编排冻结

- 对外只暴露 `SleepOrchestrator.run(mode)` 单一入口
- 十步流水线的顺序、每步的输入输出契约**冻结**
- 新增步骤必须走 ADR 评审 + 业主授权
- 不允许跳过步骤执行（除非业主手动指定）

#### 5.2.2 内部代码保护

- 模块核心文件（SleepOrchestrator.ts / 各 Step 实现 / PromotionEvaluator.ts / LifecycleAdvancer.ts）标记为只读
- 提交时强制要求：commit message 中必须包含 `[M3-SleepConsolidation-改动说明]`
- 所有阈值（theta_permanent / min_sleep_cycles / merge_cosine 等）只能通过配置文件改，不能硬编码
- LLM prompt 模板存放在独立目录，修改需走评审

#### 5.2.3 外接部分预留

- 保留以下必要外接点：
  - `onStepComplete` 钩子：每步完成后的回调（供监控/审计扩展）
  - `onPromotion` 钩子：晋升事件回调（供通知/统计扩展）
  - `onTombstone` 钩子：墓碑事件回调（供审计扩展）
  - 自定义步骤注册接口：允许其他模块添加自定义睡眠步骤
- 除上述预留外接点外，**模块内部逻辑不允许外部直接修改**

#### 5.2.4 Harness 监管接入

- 模块状态上报到 Harness：睡眠运行次数、每步耗时、晋升数量、遗忘数量
- 每次睡眠运行写 sleep_runs 表，可追溯
- Harness 定期校验：睡眠是否按时执行、晋升率是否异常、遗忘率是否异常
- 发现篡改或异常 → 自动告警 + 暂停睡眠流水线

### 5.3 修改权限

| 操作 | 权限要求 |
|---|---|
| 正常运行睡眠流水线 | 系统自动调度 |
| 手动触发睡眠 | 业主/模块负责人 |
| 阈值参数调整 | 模块负责人 + Harness 备案 |
| 晋升规则修改 | 必须业主授权 + ADR 评审 |
| 流水线步骤增删改 | 必须业主授权 + ADR 评审 |
| 内部代码修改 | 必须业主授权，否则视为篡改 |

---

## 六、依赖与协作

- **前置**：M1 存储层就绪、M2 在线写入就绪（有 RAW_ONLY 数据）
- **并行**：M1 验收后即可启动开发，M2 验收后可联调
- **下游**：M4 检索依赖 consolidation/activation 作为先验；M6 治理依赖审计数据
