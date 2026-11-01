# 七层检索管线测试失败 · 根因分析与测试方法检讨

> 🔴 **量纲封存声明（2026-10-24《40D 量纲统一法令》）**：本文档成文于旧量纲时代（24D/32D/36D/6D 等表述均为历史），其量纲相关内容**一律以 40D 为准，不得引用旧量纲条款**。当前权威：`data/knowledge-v4/governance/40d-unification-decree-v1.0.md`。


> 日期: 2026-07-28
> 触发: 两次真实 DB 检索暴露 3 个系统级缺陷，126 个单元测试全部未检测到

---

## 一、失败案例

### 案例 1: "熊梓铭 学术研究 纪实小说" → 返回 0 条

**根因**: `search_index` 表在数据库中**从未被创建**。`UnifiedSearchEngine.search()` 的 n-gram 粗筛层从 V11.0 上线第一天起就是空壳——每条查询抛异常 → `catch {}` 静默吞掉 → 候选集为 0 → 返回空结果。

**影响范围**: 所有通过 `search()` 发起的检索请求，n-gram 粗筛层均无效。1585 条 memories + 4537 条 conversations 的文本从未进入倒排索引。

**修复**: Migration v10 创建 search_index 表 + 存量回填 541,564 条 n-gram。

### 案例 2: 同上查询，修复 search_index 后仍无法建 DAG

**根因**: `memories.global_uid` 填充率 0.2%（3/1587），`memories.belong_entity_uuid` 填充率 0.2%。DAG 的 memory_associations 表依赖这两个字段作为边的源/目标锚点——没有它们，四类边全部无法建立。

**影响范围**: V11.0 已定义 DualHelixWriter 写入 `global_uid` 到 `atom_address_timeline` 和 `state_spines`，但 `memories` 表主记录**从未回填**此字段。存量 1585 条记忆全部缺失。

**修复**: 回填脚本为 1585 条记忆生成确定性 SHA256 派生 global_uid，并从 raw_input 中关键词匹配提取 belong_entity_uuid。

### 案例 3: "徐诗雨 浴缸边 亲密" → 找到但满是噪声

**根因**: n-gram 倒排索引是纯词法匹配。"徐诗雨"切为 2-gram: 徐诗、诗雨——搜索时所有含"诗雨"的记忆全部返回，无论内容是"诗雨在浴缸边"还是"诗雨今天天气真好"。纯 n-gram 无法区分语义相关性。

**影响范围**: 所有多义词、高频实体名的检索。同名实体（如"梓铭"出现在 460 篇文档中）的检索结果几乎全部按 n-gram 命中数排序——高频词命中多的排在前面，与语义无关。

**待修复**: RRF 融合层 + 24D 向量语义排序。代码已就绪（searchV13 七层管线），但线上仍走旧 search()。

---

## 二、测试方法系统性缺陷

### 缺陷 1: 零真实 DB 测试

**126 个单元测试全部使用手工 Mock 数据。** 没有一条测试读取了 `data/webui/fusion_memory.db`。

| 测试文件 | 测试数 | 数据来源 |
|:---|:---:|:---|
| RRFusion.test.ts | 11 | 手工构造 RankedItem[] |
| MMRDiversifier.test.ts | 14 | 手工构造字符串 |
| DAGClosureSearch.test.ts | 12 | 内存 MockSQLite |
| Sprint3Modules.test.ts | 14 | 手工构造 MemoryClosureResult |
| ForesightDetector.test.ts | 10 | 手工构造字符串 |
| SurprisalGate.test.ts | 7 | 手工构造字符串 |
| search-v12.test.ts | 9 | 手工构造 MultiRankResult |
| search-v13-full-pipeline.test.ts | 16 | 内存 MockSQLite |
| structure-guard.test.ts | 33 | 接口定义验证 |

**缺失**: 0 个测试读取真实 DB，0 个测试验证 search_index 表存在，0 个测试验证 global_uid/belong_entity_uuid 非空。

### 缺陷 2: 模块隔离测试 → 假信心

每个模块独立测试通过，给了我虚假的完成感。"RRF 正确融合了"、"MMR 正确去重了"、"DAG 闭包正确展开了"——**但没有任何测试验证这些模块在真实数据上真的能串起来跑通。**

一个真实的七层管线测试应该是：

```
真实 DB → 真实 n-gram 粗筛 → 真实 24D 向量 → 真实 RRF 融合
→ 真实 DAG 边 → 真实闭包展开 → 真实叙事输出 → 人工检查结果
```

### 缺陷 3: 没有"DB 健康检查"作为前置步骤

在开始任何功能测试之前，应该先跑：

```sql
-- 这些查询应该在测试套件的第一行
SELECT count(*) FROM search_index;           -- ≥ 100,000
SELECT count(*) FROM memories WHERE global_uid IS NOT NULL;  -- = mem count
SELECT count(*) FROM memories WHERE belong_entity_uuid IS NOT NULL; -- ≥ 30%
```

如果任何一条不满足，**应该直接 fail 整个测试套件**，而不是让后续测试在假数据上跑出假结果。

### 缺陷 4: 没有"金标查询"回归集

缺少一组 3-5 条**必须返回特定结果**的标准查询：

| # | 金标查询 | 必须命中 |
|:---:|:---|:---|
| 1 | "熊梓铭 学术研究" | ≥ 3 条含"实验/研究/文献/认知"的记忆 |
| 2 | "徐诗雨 浴缸 亲密" | ≥ 1 条含"浴缸"的记忆 |
| 3 | "妈妈 身体" | ≥ 2 条含"妈妈"的记忆 |

每次代码变更后自动跑这组金标查询，如果任何一条不满足 → 直接 block 合并。

---

## 三、修正方案

### 新增: DB 健康检查（测试前置）

```typescript
// src/__tests__/db-health-check.test.ts — 所有测试的前置门禁
describe('DB 健康检查（前置）', () => {
  it('search_index 表存在且有数据', () => {
    const cnt = db.exec('SELECT count(*) FROM search_index');
    expect(cnt[0].values[0][0]).toBeGreaterThan(100000);
  });
  it('memories.global_uid 全部非空', () => {
    const nulls = db.exec('SELECT count(*) FROM memories WHERE global_uid IS NULL');
    expect(nulls[0].values[0][0]).toBe(0);
  });
  it('memories.belong_entity_uuid 填充率 ≥ 20%', () => {
    const total = db.exec('SELECT count(*) FROM memories');
    const filled = db.exec("SELECT count(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''");
    const pct = filled[0].values[0][0] / total[0].values[0][0];
    expect(pct).toBeGreaterThanOrEqual(0.2);
  });
});
```

### 新增: 金标查询回归测试

```typescript
// src/__tests__/golden-queries.test.ts
const GOLDEN_QUERIES = [
  { query: '熊梓铭 学术 研究', minResults: 3, mustContain: ['研究', '实验', '文献', '认知'] },
  { query: '徐诗雨 浴缸 亲密', minResults: 1, mustContain: ['浴缸'] },
  { query: '妈妈 身体 担心', minResults: 2, mustContain: ['妈妈'] },
];
```

### 新增: 端到端真实 DB 检索测试

```typescript
// 用真实 fusion_memory.db 跑完整 search() 和 searchV13()
// 验证: 候选数 > 0, 返回结果数 > 0, 结果与查询语义相关
```

---

## 四、经验教训

1. **单元测试 ≠ 系统可用。** 126 个测试全绿不代表数据库里有 search_index 表。
2. **Mock 数据不会告诉你真数据炸了。** 我构造的 MemoryClosureResult 有 global_uid、有 belong_entity_uuid——但真实 DB 里这两个字段全是 NULL。Mock 完美地隐藏了这个问题。
3. **"写完 + 编译 + 测试通过" ≠ "完成了"。** 真正的完成是：在真实 DB 上跑真实查询，输出与人工判断一致。我写了 126 个测试却一次都没做过这件事。
4. **代码审查需要在真实数据上验证。** 如果我写完 MigrationManager v8、v9 之后立即查了 search_index 表是否存在，问题会在 5 分钟内暴露而不是拖到两天后的真实检索测试。
5. **每个模块接入管线之前，必须先验证它的输入数据源。** searchV13 接入 DAG 闭包之前，应该先验证 memory_associations 表有多少条边、种子节点有多少个——而不是假设"边建好了就能展开"。
