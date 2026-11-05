/**
 * SpaceState 参数集中配置源
 *
 * 约束来源：基线 S-072「参数集中在单一配置源；core 中除 0、1、2、0.5 外
 * 不出现数值字面量」——本切片（S-001~S-009）前置落地该约束。
 *
 * 白名单说明：0 / 1 / 2 / 0.5 四个数值可在 core 算法模块中直接书写，
 * 无需从本文件取；其余一切数值参数必须经由本文件。
 *
 * 纯常量、无副作用、无模块级可变状态，可被 core 各模块安全导入。
 */

// 纯类型导入：编译期擦除，不产生运行时依赖，故 layout.ts ← config.ts 的
// 运行时单向依赖保持不变（config 仍在依赖链最底层）
import type { DimId } from './layout.js';

/**
 * int8 对称量化满幅：|q| ≤ 127（S-004 / G-004）
 * 同时作为量化公式的值域缩放系数。
 */
export const INT8_MAX = 127;

/** 精度对数编码的字节偏移（S-005 / 勘误 E-01） */
export const PI_BYTE_OFFSET = 128;

/** 精度对数编码的 log2 缩放系数（S-005 / 勘误 E-01） */
export const PI_LOG2_SCALE = 14.75;

/** 精度码值下限：k ∈ [1, 255]，k = 0 保留为「未知」（S-005） */
export const PI_CODE_MIN = 1;

/** 精度码值上限：uint8 满幅（S-005） */
export const PI_CODE_MAX = 255;

/**
 * 精度上限 π ≤ 400（S-006）
 *
 * 由 σ 下限 0.05 等价推出：σ = π^(−1/2)，σ ≥ 0.05 ⟺ π ≤ 1/(0.05²) = 400。
 * 这里直接书写 400 而非由 0.05 推导，是为了避免 0.05*0.05 的浮点误差
 * 把上限算成 399.99999999999994，从而破坏 G-005 的 π=400 → k=255。
 */
export const PI_MAX = 400;

/** 一天的分钟数：昼夜相位分母（S-009a / 勘误 E-20、E-24） */
export const MINUTES_PER_DAY = 1440;

/**
 * 79 维布局总维数（S-001）。
 * 放配置源是为了让 layout.ts 的模块加载断言不出现数值字面量（工程约束 4）。
 */
export const LAYOUT_SIZE = 79;

/**
 * 每维证据 ℓ 的截断上界（S-013）：ℓ ∈ [-3, 3]，截断后再乘权重。
 * 防止单维一票否决——原始失配值可到 -31.57（G-010 #4）。
 */
export const CLIP = 3;

/** 背景离散度 τ 下限（S-015）：τ_i ≥ 0.1，否则背景退化为点质量 */
export const TAU_MIN = 0.1;

/** 双极维值域下界（S-002）；单极维下界为 0（白名单可直接书写） */
export const BIPOLAR_MIN = -1;

// ============ 切片#3 · 多层聚合与权重（S-016~S-018） ============

/** S-017 动态调整上限：|δ| ≤ 0.3（本切片 δ 固定 0，动态调整留后续） */
export const DELTA_MAX = 0.3;

/** S-017 B 级 ICC 分级下界：ICC ≥ 0.5 才进 B 级 */
export const ICC_B_LOWER = 0.5;

/** S-017 B 级 ICC 分级跨度：r = (ICC − 0.5) / 0.25 */
export const ICC_B_SPAN = 0.25;

/** S-018 单侧覆盖率下限：两侧都 ≥ 0.3 才算有效层 */
export const COVERAGE_MIN = 0.3;

/**
 * S-017 / E-14：权重恒为 0 的依赖指标维度。
 * 这三个维度不参与排序，否则依赖指标会主导打分。
 */
export const LOCKED_WEIGHT_DIMS: readonly string[] = Object.freeze([
  'D20',
  'D29',
  'D30',
]);

/**
 * E-05：层组共 7 个，顺序即掩码数组的下标顺序。
 *
 * 该顺序同时是 `DEFAULT_MASKS` 三套掩码的下标序与 `DIMS_BY_LAYER` 的键序，
 * 三者不一致会让掩码张冠李戴（例如把 body 的权重挂到 core 上）。
 */
export const LAYER_NAMES = Object.freeze([
  'body',
  'core',
  'appraisal',
  'motive',
  'relation',
  'scene',
  'dyad',
] as const);

/** 层名类型（由 LAYER_NAMES 推导） */
export type LayerName = (typeof LAYER_NAMES)[number];

/**
 * E-05 / S-018：层 → 维度归属（v3.1 编号）。
 *
 * 来源：Opus v3 维度表，白皮书正文引用逐一吻合（详见协作区研判报告 rev2 第二节）。
 *
 * | 层        | 维度   | v3 语义                                               |
 * |-----------|--------|-------------------------------------------------------|
 * | body      | D01-06 | 精力、舒适、体温感、接触强度、节律、松弛               |
 * | core      | D07-09 | 效价、唤醒、掌控感                                     |
 * | appraisal | D10-16 | 新颖、目标契合、应对、确定性、归因、价值相容、紧迫性   |
 * | motive    | D17-23 | 探索、照护、嬉戏、欲求、恐惧、分离痛、挫败             |
 * | relation  | D24-31 | 亲近、安全感、被理解感、同频、坦诚、依赖、排他、权力平衡 |
 * | scene     | D32-40 | 场景块（全系统共享一份）                               |
 * | dyad      | Y1-Y8  | 关系指数                                               |
 *
 * 🔴 **代际红线**：19:35 投放的《40D感知向量-维度全表》是 `perception-40d.ts`
 * **v2.1 旧定义**（双极维只有 D36/D37、D32 为「全域统筹总控」、D39/D40 为
 * 依赖/排他、D27 为微观生理细化），与 v3.1 存在维度语义代际差异，**不得**
 * 用作本表来源。它唯一的正确用途是 adapter 的 LegacyDim 映射输入（键加 `L:`
 * 前缀，旧「当前全 0」扇区一律输出 π=0 未知，而非「值 0 + 正常精度」）。
 *
 * ⚠️ 待业主确认（建议登记 E-28）：D17 / D19 / D28 / D31 四个维度名只有 Opus v3
 * 表出处，白皮书正文未直接引用，归属靠连续区间与邻近维度佐证推出。
 * 若业主改判，只改本常量，其余代码零改动。
 *
 * 下标不在此处：`layout.ts` 的 `LAYER_DIMS` 由 LAYOUT × 本表推导，不写死下标。
 */
export const DIMS_BY_LAYER: Readonly<Record<LayerName, readonly DimId[]>> = Object.freeze({
  body: Object.freeze(['D01', 'D02', 'D03', 'D04', 'D05', 'D06'] as const),
  core: Object.freeze(['D07', 'D08', 'D09'] as const),
  appraisal: Object.freeze([
    'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16',
  ] as const),
  motive: Object.freeze([
    'D17', 'D18', 'D19', 'D20', 'D21', 'D22', 'D23',
  ] as const),
  relation: Object.freeze([
    'D24', 'D25', 'D26', 'D27', 'D28', 'D29', 'D30', 'D31',
  ] as const),
  scene: Object.freeze([
    'D32', 'D33', 'D34', 'D35', 'D36', 'D37', 'D38', 'D39', 'D40',
  ] as const),
  dyad: Object.freeze(['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7', 'Y8'] as const),
});

/**
 * S-018 默认用途掩码（下标对应 LAYER_NAMES）。
 * 三套通路各自的层激活权重，> 0 即视为被掩码激活。
 */
export const DEFAULT_MASKS = Object.freeze({
  /** 通路 C：0.3 / 1 / 0.3 / 0.5 / 0.8 / 0.6 / 1 */
  pathwayC: Object.freeze([0.3, 1, 0.3, 0.5, 0.8, 0.6, 1]),
  /** 通路 B：0 / 1 / 0 / 0.3 / 0.5 / 0 / 1 */
  pathwayB: Object.freeze([0, 1, 0, 0.3, 0.5, 0, 1]),
  /** 共同经历隐喻：0 / 1 / 0 / 0 / 0.8 / 0.8 / 0.8 */
  sharedEpiphany: Object.freeze([0, 1, 0, 0, 0.8, 0.8, 0.8]),
});
