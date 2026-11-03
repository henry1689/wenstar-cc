# 40D 感知向量 — 设计文档与 TS 程序（给 Claude Opus 5.5 评估）

> **整理日期**: 2026-11-03
> **用途**: 给 Claude Opus 5.5 评估 40D 感知向量的设计合理性
> **来源**: WenStar OS 现有代码库

---

## 一、40D 设计总览

### 1.1 什么是 40D

40D = 40 维感知向量，是 WenStar OS 用来表示"瑶灵此刻的主观体感状态"的统一坐标系。

**40D = 6 大类（扇区）**：
| 扇区 | 维度范围 | 数量 | 来源 |
|---|---|---|---|
| 大类1 肉身实体基底 | D01-D08 | 8D | 瑶灵（生理/体感） |
| 大类2 个体内在精神 | D09-D14 | 6D | 瑶灵（心理/自我） |
| 大类3 圈层人际 | D15-D20 | 6D | 瑶灵（关系/社交） |
| 大类4 时空环境 | D21-D26 | 6D | 瑶光（客观/环境） |
| 大类5 动态成长 | D27-D32 | 6D | 瑶灵/瑶光（成长/变化） |
| 大类6 伴侣情感纹理 | D33-D40 | 8D | ★ 新增扇区（亲密关系） |

### 1.2 40D 在三域中的角色

| 域 | 角色 | 说明 |
|---|---|---|
| **瑶光（Yaoguang）** | 客观参数源 | 提供医学原始值（血乳酸、催产素、皮质醇等），归一化后填充客观维 |
| **瑶灵（Yaoling）** | 主观体感源 | 提供主观感受值（自我认知、愉悦、亲密依恋等），是语义维的主要来源 |
| **天权（Tianquan）** | 调度中枢 | 接收瑶光/瑶灵的 40D 快照，通过 RPC 透传给 TS 侧 |

**数据流**：
```
瑶光（客观医学值）
  ↓ 天权 RPC
  ↓ 归一化（YaoguangNormalizer）
  ↓
瑶灵（主观感受值）
  ↓ M3 规则引擎
  ↓ 合并
  ↓
40D 感知向量（PerceptionV40）
  ↓ 编码（PerceptionVector40DCodec）
  ↓ 存储（memories.perception_40d）
  ↓
检索时：40D 扇区加权余弦相似度（VectorReranker）
```

---

## 二、核心设计文档

### 2.1 《40D 单轨审查报告》（2026-08-07）

**结论**：
- 存储层 40D 已 100% 单轨：数据实测 `memories.perception_40d` 抽样 834 行全部 len=40
- 契约层存在 Python 侧 32D 残留错配（运行代码已 40D，契约/常量/测试仍锁 32D）
- 检索层非真单轨：`PERCEPTION_40D_ONLY` 默认 false（40D 优先 + 24D 回退双轨）

**40D 维度定义**：
| 项 | 位置 | 内容 |
|---|---|---|
| 类型 | `src/m2/types/perception-40d.ts` | `PerceptionV40`：40 个命名键 |
| 常量 | 同文件 | `PERCEPTION_40D_DIM = 40`；`PERCEPTION_40D_KEYS`（固定键序） |
| 扇区权重 | 同文件 | `PERCEPTION_40D_SECTOR_WEIGHTS`：intimate_texture=0.30 最高 |
| 定义依据 | 同文件 | 40D = spine.proto D1-D32 + 新增 D33-D40（伴侣情感纹理） |
| 编解码 | `src/m2/PerceptionVector40DCodec.ts` | encode → 40 元素 JSON 数组字符串；decode 长度≠40 返回 null |
| 余弦 | 同文件 | `cosineSimilarity40D`：扇区加权余弦 |

**M3 生成链**：
- `src/m3/PerceptionAnalyzer.ts` `buildPerceptionV40`：把注入上下文后的最终 24D 投影为 40D
- D36/D37 双极 [-1,1] 原样，其余钳 [0,1]

**DB 写入/读取**：
- 写入：`persistence-stage.ts` `writePerceptionV40Dual` → 用户消息、助理回复
- 读取：`UnifiedSearchEngine.ts` `SELECT id, perception_40d`；`VectorReranker.ts` decode

### 2.2 《V51 — 40D 字典层级归位与锚点隔离列》（2026-11-02）

**三件事**：
1. 40D 感知向量字典的唯一定义处由 `src/m3/types/perception-40d.ts` 归位到 `src/m2/types/perception-40d.ts`，m3 退为转发桩
2. 锚点重建 `INSERT OR REPLACE` 补 `namespace` 列，从组内 `conversations` 继承
3. `memory-write-columns.test.ts` 新增隔离列守卫

**为什么归位**：
- CK-01（九层管线反向依赖检查）只豁免 `import type`，值导入不豁免
- m2 值依赖 m3 的 `PERCEPTION_40D_KEYS` ⇒ DS-01 恒 60 分
- SQLiteAdapter 是高风险核心存储文件、必然要改 ⇒ S7-B R4 死锁
- 本归位打破该死锁，且与 ADR-007 既定方向一致（M2 → M3 正向依赖）

---

## 三、核心 TS 程序

### 3.1 40D 类型定义（`src/m2/types/perception-40d.ts`）

```typescript
// 40维语义感知坐标系 — 40D 数据契约（V2.1 瑶光对齐）
// 40D = 6 大类（扇区）
//   大类1 肉身实体基底   D01-D08   8D   来源: spine.proto  (瑶灵 D1-D8)
//   大类2 个体内在精神   D09-D14   6D   来源: spine.proto  (瑶灵 D9-D14)
//   大类3 圈层人际       D15-D20   6D   来源: spine.proto  (瑶灵 D15-D20)
//   大类4 时空环境       D21-D26   6D   来源: spine.proto  (瑶灵 D21-D26)
//   大类5 动态成长       D27-D32   6D   来源: spine.proto  (瑶灵 D27-D32)
//   大类6 伴侣情感纹理   D33-D40   8D   ★ 第 6 大类扇区

/** 40D 感知向量：40 个命名键字段，按 D1-D40 编号 */
export interface PerceptionV40 {
  // ── 大类1: 肉身实体基底 D01-D08 ──
  d01_muscle_load: number;      // D01 骨骼肌肉·体能负荷
  d02_pain_level: number;       // D02 躯体疼痛·不适感知
  d03_nerve_arousal: number;    // D03 神经瞬时刺激·触觉
  d04_endocrine_hormones: number; // D04 内分泌·激素波动
  d05_pheromone: number;        // D05 信息素·气息氛围
  d06_metabolic_cycle: number;  // D06 生理周期·代谢生命周期
  d07_self_heal: number;        // D07 躯体自愈·修复维度
  d08_sensory_env: number;      // D08 五感环境·基础体感

  // ── 大类2: 个体内在精神 D09-D14 ──
  d09_self_identity: number;    // D09 自我认知·人格基底
  d10_desire_drive: number;     // D10 原生欲望·成长驱动力
  d11_fear_fatigue: number;     // D11 恐惧·倦怠·制衡心理
  d12_enjoyment: number;         // D12 享受·松弛·幸福感
  d13_empathy: number;           // D13 共情·恻隐联动
  d14_self_protection: number;   // D14 个体自我保护

  // ── 大类3: 圈层人际 D15-D20 ──
  d15_partner_attachment: number; // D15 伴侣亲密依恋
  d16_partner_protection: number; // D16 伴侣专属守护意识
  d17_family_belonging: number;  // D17 家庭归属·陪伴
  d18_family_protection: number; // D18 家庭整体守护
  d19_social_fit: number;         // D19 社会人际·社交适配
  d20_team_protection: number;    // D20 团队集体保护

  // ── 大类4: 时空环境 D21-D26 ──
  d21_private_space: number;      // D21 私人居所·独处氛围
  d22_home_environment: number;   // D22 家庭布局·共处氛围
  d23_workplace: number;           // D23 职场厂区·工作环境
  d24_public_space: number;       // D24 公共场地·人流氛围
  d25_spatiotemporal: number;      // D25 空间距离·时差流逝
  d26_seasonal_climate: number;    // D26 四季气象·昼夜节律

  // ── 大类5: 动态成长 D27-D32 ──
  d27_micro_physiology: number;   // D27 人体微观生理细化
  d28_nature_expansion: number;   // D28 自然世界拓展感知
  d29_social_refinement: number;   // D29 人文社交规则细化
  d30_spiritual_growth: number;    // D30 精神文娱·修养成长
  d31_quantum_coupling: number;    // D31 主观客观量子耦合
  d32_global_overview: number;     // D32 全域统筹总控汇总

  // ── 大类6: 伴侣情感纹理 D33-D40 ★ 新增扇区 ──
  d33_sexual_attraction: number;    // D33 性吸引力
  d34_energy_merge: number;         // D34 能量交融
  d35_sincerity: number;            // D35 真诚度
  d36_dominance: number;            // D36 支配感（双极 [-1,1]）
  d37_moral_judgment: number;       // D37 道德审判（双极 [-1,1]）
  d38_humor: number;                // D38 幽默感
  d39_dependency: number;           // D39 依赖度
  d40_possessiveness: number;       // D40 占有排他
}

/** 扇区定义 */
export const PERCEPTION_40D_SECTORS = [
  { key: 'physical_body',        label: '肉身实体基底', start: 1,  end: 8,  source: 'spine.proto' },
  { key: 'inner_spirit',         label: '个体内在精神', start: 9,  end: 14, source: 'spine.proto' },
  { key: 'social_bonds',         label: '圈层人际',     start: 15, end: 20, source: 'spine.proto' },
  { key: 'spatiotemporal',       label: '时空环境',     start: 21, end: 26, source: 'spine.proto' },
  { key: 'dynamic_growth',       label: '动态成长',     start: 27, end: 32, source: 'spine.proto' },
  { key: 'intimate_texture',     label: '伴侣情感纹理', start: 33, end: 40, source: '新增扇区' },
] as const;

/** 扇区检索权重（P3 前：肉身体验/时空/成长无数据源，权重降 0；伴侣纹理最高） */
export const PERCEPTION_40D_SECTOR_WEIGHTS: Record<string, number> = {
  physical_body:   0.0,   // D01-D08: 当前全 0，P3 瑶灵通道上线后激活
  inner_spirit:    0.15,  // D09-D14: 当前部分由中间层派生
  social_bonds:    0.15,  // D15-D20: 当前部分由中间层派生
  spatiotemporal:  0.0,   // D21-D26: 当前全 0，P3 瑶光通道上线后激活
  dynamic_growth:  0.0,   // D27-D32: 当前全 0，P3 激活
  intimate_texture: 0.30, // D33-D40: ★ 伴侣情感信号，检索权重最高
};

/** 维度总数 */
export const PERCEPTION_40D_DIM = 40;

/** 40D 维度键序（固定，用于编解码对齐） */
export const PERCEPTION_40D_KEYS: (keyof PerceptionV40)[] = [
  'd01_muscle_load', 'd02_pain_level', 'd03_nerve_arousal', 'd04_endocrine_hormones',
  'd05_pheromone', 'd06_metabolic_cycle', 'd07_self_heal', 'd08_sensory_env',
  'd09_self_identity', 'd10_desire_drive', 'd11_fear_fatigue', 'd12_enjoyment',
  'd13_empathy', 'd14_self_protection', 'd15_partner_attachment', 'd16_partner_protection',
  'd17_family_belonging', 'd18_family_protection', 'd19_social_fit', 'd20_team_protection',
  'd21_private_space', 'd22_home_environment', 'd23_workplace', 'd24_public_space',
  'd25_spatiotemporal', 'd26_seasonal_climate', 'd27_micro_physiology', 'd28_nature_expansion',
  'd29_social_refinement', 'd30_spiritual_growth', 'd31_quantum_coupling', 'd32_global_overview',
  'd33_sexual_attraction', 'd34_energy_merge', 'd35_sincerity', 'd36_dominance',
  'd37_moral_judgment', 'd38_humor', 'd39_dependency', 'd40_possessiveness',
];

/** 创建全 0 的 PerceptionV40 */
export function createEmptyPerceptionV40(): PerceptionV40 {
  const p = {} as PerceptionV40;
  for (const k of PERCEPTION_40D_KEYS) p[k] = 0;
  return p;
}
```

### 3.2 40D 编解码（`src/m2/PerceptionVector40DCodec.ts`）

```typescript
/**
 * PerceptionVector40DCodec — 40D 感知向量统一编解码标准
 * 40D 编码（《40D 量纲统一法令》：40D 为全系统唯一合法量纲）
 */

export const PERCEPTION_40D_ENCODING_VERSION = 2;

/**
 * 编码：PerceptionV40 → JSON 字符串（带 __v 版本标识）
 * v2 格式：`{"__v":2,"dims":[D1..D40]}`
 */
export function encodePerceptionV40(p: PerceptionV40): string {
  return JSON.stringify({
    __v: PERCEPTION_40D_ENCODING_VERSION,
    dims: PERCEPTION_40D_KEYS.map(k => p[k] ?? 0),
  });
}

/**
 * 解码：JSON 字符串 → PerceptionV40
 * 向后兼容三种格式：
 *   v2: `{"__v":2,"dims":[40 元素]}`（当前标准）
 *   v1: `[40 元素]`（历史纯数组）
 *   v0: `{"d12_enjoyment":0.5,...}`（早期命名对象）
 */
export function decodePerceptionV40(json: string | null | undefined): PerceptionV40 | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (typeof arr === 'object' && arr !== null && !Array.isArray(arr)) {
      const rec = arr as Record<string, unknown>;
      if (Array.isArray(rec.dims)) {
        // v2 格式
        const dims = rec.dims;
        if (dims.length !== PERCEPTION_40D_DIM) return null;
        const p = createEmptyPerceptionV40();
        for (let i = 0; i < PERCEPTION_40D_DIM; i++) p[PERCEPTION_40D_KEYS[i]] = Number(dims[i]);
        return p;
      }
      // v0: 命名对象
      const p = createEmptyPerceptionV40();
      for (const k of PERCEPTION_40D_KEYS) {
        const v = Number((arr as Record<string, unknown>)[k]);
        if (isFinite(v)) p[k] = v;
      }
      return p;
    }
    // v1: 纯数组
    if (Array.isArray(arr)) {
      if (arr.length !== PERCEPTION_40D_DIM) return null;
      const p = createEmptyPerceptionV40();
      for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
        const v = Number(arr[i]);
        if (!isFinite(v)) return null;
        p[PERCEPTION_40D_KEYS[i]] = v;
      }
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

/** 双极性维度（值域含负数）需映射到 [0,1] */
const BIPOLAR_40D = new Set([36, 37]); // D36 dominance, D37 moral_judgment

function normalize40D(v: number, dim: number): number {
  return BIPOLAR_40D.has(dim) ? (v + 1) / 2 : Math.max(0, Math.min(1, v));
}

/**
 * 40D 扇区加权余弦相似度 ∈ [0, 1]
 * 扇区权重来自 PERCEPTION_40D_SECTOR_WEIGHTS
 */
export function cosineSimilarity40D(a: PerceptionV40, b: PerceptionV40): number {
  const va = toNormalizedVector40D(a);
  const vb = toNormalizedVector40D(b);

  const dimWeights = new Float64Array(PERCEPTION_40D_DIM);
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) dimWeights[i] = sectorWeightForDim(i + 1);

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    const wd = dimWeights[i];
    dot += wd * va[i] * vb[i];
    normA += wd * va[i] * va[i];
    normB += wd * vb[i] * vb[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### 3.3 瑶光归一化（`src/m2/YaoguangNormalizer.ts`）

```typescript
/**
 * YaoguangNormalizer — 瑶光 medical → 40D [0,1] 归一化工具
 * 瑶光返回 objective 各维为医学原始值（如 D12 催产素 50 pg/mL），40D 需要 [0,1]。
 */

/** 瑶光 objective 单维结构 */
export interface YaoguangDim {
  standard_value?: number;
  standard_range?: [number, number];
  label?: string;
}

/**
 * 客观标准值 → [0,1]
 * 单极：(value - range_low) / (range_high - range_low)
 * 双极：(v + 1) / 2
 */
export function normalizeStandardValue(
  value: number | undefined,
  range: [number, number] | undefined,
  bipolar = false,
): number {
  if (bipolar) {
    if (typeof value !== 'number' || !isFinite(value)) return NaN;
    return clamp((value + 1) / 2, 0, 1);
  }
  if (typeof value !== 'number' || !isFinite(value)) return NaN;
  if (!Array.isArray(range) || range.length !== 2) return NaN;
  const [lo, hi] = range;
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return NaN;
  return clamp((value - lo) / (hi - lo), 0, 1);
}

/**
 * 语义维集合（M3 词表直接产出）：
 *   D09/D12/D14/D15/D17/D19/D33-D40
 * 铁律：语义维以 M3 为准，瑶光只补客观维
 */
const SEMANTIC_DIMS = new Set([
  9, 12, 14, 15, 17, 19, 33, 34, 35, 36, 37, 38, 39, 40,
]);

/** 语义维基底 + 瑶光客观维合并：只覆盖瑶光客观维（语义维以 M3 为准） */
export function fillObjectiveDims(
  base: PerceptionV40,
  objective: Record<string, YaoguangDim> | null | undefined,
): PerceptionV40 {
  const merged: PerceptionV40 = { ...base };
  if (!objective) return merged;
  for (let dim = 1; dim <= 40; dim++) {
    // 语义维（M3 源泉）跳过 — 瑶光不覆盖
    if (SEMANTIC_DIMS.has(dim)) continue;
    const entry = objective[`d${dim}`];
    if (!entry) continue;
    const normalized = normalizeStandardValue(
      entry.standard_value,
      entry.standard_range,
      BIPOLAR_40D.has(dim),
    );
    if (isFinite(normalized)) {
      const key = keyForDim(dim);
      if (key) merged[key] = normalized;
    }
  }
  return merged;
}
```

### 3.4 40D 检索重排（`src/m4/VectorReranker.ts`）

```typescript
/**
 * VectorReranker — 自有40D向量精排引擎（V11.0；P072批2起 40D-only）
 * 对 n-gram 初筛后的候选记忆集合，用自有40D仿生心智向量做精细化重排。
 */

export function rankByVector(
  candidates: MemoryCandidate[],
  mode: SearchMode = 'balanced',
  queryVec40D?: number[] | null,
): RankedMemory[] {
  if (candidates.length === 0) return [];

  const results: RankedMemory[] = [];
  for (const item of candidates) {
    // 1. 钙化门槛过滤
    if ((item.calciumLevel ?? 1) < cfg.minCalciumLevel) continue;

    // 2. 40D 扇区加权余弦相似度
    const p40 = isPerception40DEnabled() ? decodePerceptionV40(item.perception40d) : null;
    const q40 = p40 && queryVec40D && queryVec40D.length === 40 ? arrayToPerceptionV40(queryVec40D) : null;

    let score = 0;
    if (p40 && q40) {
      const sim40 = cosineSimilarity40D(q40, p40);
      const decay = item.createdAt
        ? Math.exp(-cfg.decayLambda * ((Date.now() - new Date(item.createdAt).getTime()) / 86_400_000))
        : 1;
      score = sim40 * cfg.vectorWeight * decay + (item.calciumScore ?? 0.5) / 10 * cfg.calciumWeight;
    } else {
      // 无 40D 向量 → 钙化基础分（P072批2: 24D回退已删）
      score = (item.calciumScore ?? 0.5) / 10 * cfg.calciumWeight;
    }

    results.push({ item, score: Math.min(score, 1) });
  }

  return results.sort((a, b) => b.score - a.score);
}
```

---

## 四、当前存在的问题

### 4.1 已知问题

1. **Python 侧 32D 残留**：
   - `spine.proto` 头部仍写 "32D 海胆语义快照"
   - `dna_constants.DIM_COUNT = 32` 锁死在测试里
   - 实际 Python 代码已发射 40D，但契约层没更新

2. **检索层非真单轨**：
   - `PERCEPTION_40D_ONLY` 默认 false
   - 40D 优先 + 24D 回退双轨仍存在

3. **扇区权重问题**：
   - physical_body / spatiotemporal / dynamic_growth 权重都是 0
   - 这三个扇区当前全是 0，等于这 20 维完全不参与检索
   - 只有 inner_spirit (0.15) / social_bonds (0.15) / intimate_texture (0.30) 三个扇区有贡献

4. **24D 中间层待废**：
   - MAP_24_TO_40 映射表还在
   - projectState24ToV40 还在用作派生
   - 目标是 M3 直产 40D，24D 中间层退役

### 4.2 设计上的疑问（请 Claude Opus 5.5 评估）

1. **40D 维度设计是否合理**？
   - 6 大类 40 维，有没有冗余或缺失？
   - 双极维度（D36/D37）的设计是否必要？
   - 扇区加权余弦的权重分配是否合理？

2. **40D 在记忆系统中的角色**：
   - 40D 是情感向量，不是语义向量
   - 当前用 40D 做检索重排，是否合适？
   - 语义检索应该用语义向量（如 bge-small-zh），40D 应该只做情绪匹配？

3. **40D 与 MemSym v1.1 的整合**：
   - MemSym v1.1 设计里，通路 B 的 fitScore 用的是 40D 相似度
   - 这个设计是否合理？

4. **瑶光/瑶灵/天权三域分工**：
   - 瑶光提供客观医学值，瑶灵提供主观感受值
   - 这个分工是否清晰？
   - 语义维由 M3 规则引擎派生，而不是瑶灵直接产出，这个设计是否合理？

---

## 五、给 Claude Opus 5.5 的评估请求

请从以下角度评估这份 40D 感知向量设计：

1. **理论合理性**：40D 维度划分是否有心理学/神经科学依据？
2. **工程可行性**：当前实现是否有架构上的缺陷？
3. **检索效果**：用 40D 情感向量做检索重排，效果会不会好？
4. **与新架构的兼容性**：MemArch v2 设计里，40D 应该扮演什么角色？
5. **改进建议**：有什么可以优化的地方？
