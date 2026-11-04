# MemArch-v2.0.0 / M5-Presentation（MemSym 呈现层）

> 基线：MemArch-v2.0.0-Baseline (MD5: C3DCBFC83B96EBE88D06D230F26CF503)
> 本模块：M5 — 概率路由 + 证据标签 + OutputGuard + 强化归因 + 再巩固 + B→A 升级

## 1. 模块定位

M5 是 MemArch-v2.0.0 的呈现层，位于 M4 检索之后、LLM 生成之前。四件事：

1. 概率分发：把 M4 返回的 Evidence[] 分到通路 A（直出）/ 混合 / 通路 B（暗示）。
2. 证据标签：打「记得 / 印象 / 线索 / 不说」四档，避免过度自信。
3. OutputGuard：两级校验——抽断言 + 蕴含验证，把无证据的虚构陈述拦下来。
4. 强化归因 + 再巩固：用户反馈（confirm/engaged/ignored/correct）回写 M3，correct 时触发 M2 再巩固。

核心原则：诚实是底线。全程纯规则，不引入任何 LLM SDK 做标签自评。

## 2. 目录结构

```
presentation/
├── index.ts              # 对外门面（PresentationEngine）
├── router.ts             # 概率分发器
├── labeler.ts            # 证据标签四档判定
├── outputGuard.ts        # 两级校验
├── attributor.ts         # 强化归因器
├── reconsolidate.ts      # 再巩固
├── downgrade.ts          # B→A 升级机制
├── config.ts             # 阈值表外置
├── types.ts              # 类型契约
├── vitest.config.ts
├── tsconfig.json
├── package.json
├── __tests__/
│   ├── helpers.ts
│   ├── router.test.ts
│   ├── labeler.test.ts
│   ├── outputGuard.test.ts
│   ├── attributor.test.ts
│   └── boundary-cases.test.ts
└── README.md
```

## 3. 与 M1-M4 的对接点

M5 不直接 import M1-M4 实现，全部通过依赖倒置接口注入：

```ts
import { PresentationEngine } from '@wenstar/memarch-presentation';
const engine = new PresentationEngine({
  reinforceSink: myM3Adapter,
  writeSink: myM2Adapter,
  pathwayStore: myM1ViewAdapter,
});
```

### M4 → M5 输入

M4 返回的 Evidence[] 直接喂给 engine.present()。M5 用 fromM4Evidence() 适配：

- memory_id → uuid
- text → raw_text
- score/timestamp/recency/strength/source_namespace/recall_sources/entities 直通
- tombstone/suppressed/pathway 由 M4 视图层注入（缺省 false/false/A）

### M5 → M3 回写（ReinforceSink）

reinforce(uuid, signal: 'positive' | 'negative' | 'decay')
- confirm/engaged → positive
- ignored → negative
- correct 旧版本 → decay（进睡眠巩固衰减队列，不删除）

### M5 → M2 再巩固（WriteSink）

write({ message_id: `${old_uuid}::v${ts}`, role: 'user', content: 用户纠正原话, namespace }) → { trace_id, gate }

### M5 → M1 通路回写（PathwayStore）

getPathway(uuid) / promoteToA(uuid, boost) / getReinforcementCount(uuid) / bumpReinforcement(uuid)
M5 不直接查底层表，全部走 M1 视图层。

## 4. 阈值表怎么调

所有魔法数字在 config.ts 的 DEFAULT_CONFIG。实例化时可覆盖：

```ts
new PresentationEngine(deps, {
  router: { p_A_high: 0.75, p_A_low: 0.35 },
  labels: { remembered: { min_score: 0.65, max_recency_days: 60 } },
  upgrade: { promote_after_hits: 3 },
});
```

| 参数 | 默认 | 含义 |
|---|---|---|
| router.p_A_high | 0.7 | p_A ≥ 此值走 A_direct |
| router.p_A_low | 0.3 | p_A < 此值走 B_only |
| labels.remembered.min_score | 0.6 | 记得档最低 score |
| labels.remembered.max_recency_days | 30 | 记得档最大时间窗（天） |
| labels.impression.min_score | 0.35 | 印象档最低 score |
| labels.clue.min_score | 0.15 | 线索档最低 score |
| guard.min_token_overlap | 0.2 | 断言与证据最小 jaccard |
| guard.min_token_hits | 1 | 断言至少命中 token 数 |
| upgrade.promote_after_hits | 2 | B→A 升级所需强化次数 |
| upgrade.boost_per_hit | 0.15 | 单次强化 boost |

## 5. 跑测试

```bash
cd memarch-v2/presentation
npm install
npm test
```

测试用 better-sqlite3 内存库（:memory:），不依赖外部 DB，不依赖 M1-M4 实际实现。

覆盖：
- router.test.ts：分桶 / p_A / 阈值路由 / tombstone / suppressed
- labeler.test.ts：四档校准 / 模糊借氛围降档 / 矛盾降档
- outputGuard.test.ts：断言抽取 / 蕴含验证 / 虚构拦截 / 通路 B 改写 / 零证据兜底
- attributor.test.ts：confirm/correct/engaged/ignored
- boundary-cases.test.ts：端到端厚测试

## 6. 验收标准对照

| 验收项 | 测试位置 |
|---|---|
| 虚构率 < 1% | outputGuard.test.ts 虚构率两节 |
| 记得档准确率 ≥ 95% | labeler.test.ts 记得档准确率 |
| 标签校准 | labeler.test.ts 标签校准 |
| 墓碑不可见 | boundary-cases.test.ts 墓碑记忆 |
| suppressed 不混 A | boundary-cases.test.ts suppressed |
| 通路 B 无事实陈述 | boundary-cases.test.ts 通路 B |

## 7. 严禁事项（代码已落实）

- 不引入 LLM SDK 做标签自评——全部纯规则。
- 不把 tombstone/suppressed 漏到通路 A。
- 通路 B 话术不出现事实陈述句。
- 不直接查 M1 底层表。
- correct 时不直接删旧记忆，走 M3 decay 队列。
