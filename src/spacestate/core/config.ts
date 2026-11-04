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
 * 🔴 **层→维度映射表（LAYER_DIMS）尚缺**：任务书称映射在基线 E-05，
 * 但 E-05 只有层名、S-018 只有掩码值、S-046 只有 λ 顺序，active/ 全部
 * 17 个文件均无映射表。层（body/core/…）与块（scene/self/user_est/dyad）
 * 是**正交划分**，不可自行推导。待映射表到位后在本文件补 LAYER_DIMS，
 * aggregation.ts 的三个函数均以参数接收层分组，无需改动。
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
