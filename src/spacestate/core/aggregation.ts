/**
 * 多层聚合与权重（S-016 / S-017 / S-018）
 *
 * 把 79 维的单维证据 ℓ_i 聚合为总证据 E。三层结构：
 *
 *   ℓ_i（切片#2 dimEvidence）
 *     → w_i 加权求和得 E_L（S-016 层内）
 *     → 覆盖率 + 掩码 + 阈值三条件准入（S-018）
 *     → Σ m_L·E_L 得总证据 E（S-016 层间）
 *
 * 🔴 **层→维度映射不在此文件**：下标只能经 `layout.ts` 的
 * `layerIndices(layer, purpose)` 取（`'sum'` 求和 / `'admission'` 覆盖率），
 * 本文件的三个函数一律**把层分组作为参数接收**，不硬编码——
 * 映射调整只需改 config/layout，聚合逻辑零改动。
 */

import {
  COVERAGE_MIN,
  DELTA_MAX,
  ICC_B_LOWER,
  ICC_B_SPAN,
  OBSERVE_ONLY_DIMS,
  TAU_MIN,
  resonanceMask,
} from './config.js';
import { posteriorVariance } from './evidence.js';
import type { DimId } from './layout.js';

// ============ S-017 · 维度权重 ============

/** ICC 分级：A 级完全采信、B 级线性过渡、C 级不采信 */
export type IccGrade = 'A' | 'B' | 'C';

/**
 * S-017 ICC 分级系数 r_ICC：
 * - A 级 r = 1
 * - B 级 r = (ICC − 0.5) / 0.25，钳到 [0,1]
 * - C 级 r = 0
 */
export function iccCoefficient(icc: number, grade: IccGrade): number {
  if (grade === 'A') return 1;
  if (grade === 'C') return 0;
  // B 级：ICC 低于下界得负值、高于上界得超 1，都钳回 [0,1]
  const r = (icc - ICC_B_LOWER) / ICC_B_SPAN;
  return Math.min(Math.max(r, 0), 1);
}

/**
 * S-017 维度权重（**未导出**）：w_i = base_i × r_ICC × (1 + δ_i)
 *
 * - `baseI` 基础权重由调用方从配置读入，core 不硬编码
 * - `delta` 本切片固定 0（动态调整留后续），但仍强制 |δ| ≤ 0.3
 *
 * 🔴 **E-14 现行口径（细化，非推翻）**：
 * - **D29 / D30 恒 0**（只观测）：依赖指标不得作为任何优化目标
 *   （S-067 消融不变性），否则系统会主动放大依赖
 * - **D20 由私密模式开关控制是否参与**，默认关（待登记 E-29）；
 *   三者均**不得作为任何优化目标**
 *
 * ⚠️ 本函数**不处理私密模式**，故不导出——见下方 `effectiveWeight`。
 */
function rawDimWeight(
  dim: DimId,
  baseI: number,
  icc: number,
  grade: IccGrade,
  delta = 0,
): number {
  // E-14：只观测维度锁死为 0，先于一切计算
  if (OBSERVE_ONLY_DIMS.has(dim)) return 0;

  // S-017：|δ| ≤ 0.3，越界钳回
  const d = Math.min(Math.max(delta, -DELTA_MAX), DELTA_MAX);
  return baseI * iccCoefficient(icc, grade) * (1 + d);
}

/** 打分所需的上下文（`privateMode` 是会话状态，不是维度属性） */
export interface WeightContext {
  readonly privateMode: boolean;
}

/**
 * 🔴 **维度权重的唯一打分入口**（补包 B 第 1 项）。
 *
 * `rawDimWeight` 只算 base × r_ICC × (1+δ)，**不处理私密模式**；
 * D20 是否参与必须在这里乘上 `resonanceMask`。之所以不把开关拆给调用方：
 * 漏乘即 D20 静默进打分，而这是**放行方向**的风险——拦截会报 0 看得见，
 * 放行看不出任何异常。唯一入口让漏乘在类型层就不可能发生。
 *
 * 🔴 **D20 保守规则**：`ctx.privateMode` 为 `true` 之外的任何值（含
 * `undefined`、`null`、字符串）一律视为**关**。故意写 `=== true` 而非真值判断，
 * 是为了让「传了但传错」和「没传」同样落到安全侧。
 *
 * 📌 **进度表标注**：`privateMode = true` 分支**无生产触发路径**——
 * 私密模式的判定来源白皮书未定义（未决项），当前只能传 `false`，
 * 故 D20 恒 0，行为与旧版一致。**契约已就位，功能未启用。**
 *
 * 🔴 E-29：D20 共鸣权重默认关，非私密模式启用属 L3，不得作为优化目标。
 */
export function effectiveWeight(
  dim: DimId,
  baseI: number,
  icc: number,
  grade: IccGrade,
  ctx: Readonly<WeightContext>,
  delta = 0,
): number {
  return rawDimWeight(dim, baseI, icc, grade, delta) * resonanceMask(dim, ctx.privateMode === true);
}

// ============ S-016 · 层内聚合 ============

/** 层内求和项：index 是维度下标，用于固定求和顺序（E-06） */
export interface WeightedTerm {
  /** 维度下标（LAYOUT 下标），决定求和顺序 */
  readonly index: number;
  /** 该维权重 w_i */
  readonly w: number;
  /** 该维证据 ℓ_i（已由 dimEvidence 截断到 [-3,3]） */
  readonly ell: number;
}

/**
 * S-016 层内聚合 E_L = Σ_s w_s × Σ_i (w_i × ℓ_i)
 *
 * 本切片单源（w_s = 1），故退化为 Σ_i w_i·ℓ_i。
 *
 * 🔴 **求和顺序固定为维度下标升序**（E-06）：浮点加法不满足结合律，
 * 打乱顺序会得到不同末位，跨平台结果就会漂移。因此先按 `index` 升序
 * 排序再累加——调用方传入顺序无关紧要，结果恒定。
 * 校验：打乱输入顺序后结果差 ≤ 1e-12（属性测试）。
 *
 * 传入的下标集合由调用方选择：求和用 `layerIndices(layer, 'sum')`（w=0 的项本不贡献），
 * 覆盖率/准入用 `layerIndices(layer, 'admission')`（剔除 D27）。
 */
export function layerEvidence(items: readonly WeightedTerm[]): number {
  const ordered = [...items].sort((a, b) => a.index - b.index);
  return ordered.reduce((acc, t) => acc + t.w * t.ell, 0);
}

// ============ S-018 · 覆盖率与层准入 ============

/**
 * 单维覆盖率 cov = 1 − v̂/τ²（G-018）
 *
 * v̂ 复用 `posteriorVariance`，与 dimEvidence 同一公式。
 *
 * G-018 校验（τ=0.3）：πx=100 → v̂=0.009 → cov=0.9；πx=0 → v̂=0.09 → cov=0
 */
export function coverage(piX: number, tau: number): number {
  const tauEff = Math.max(tau, TAU_MIN);
  const vHat = posteriorVariance(piX, tau);
  return 1 - vHat / (tauEff * tauEff);
}

/**
 * 层覆盖率 cov_L = mean(1 − v̂_i/τ_i²)（S-018）
 *
 * 空层返回 0——没有维度就没有覆盖，不能默认为满覆盖。
 *
 * 调用方应传入 `layerIndices(layer, 'admission')` 对应的 π 数组（剔除 D27），
 * 否则两项恒 0 覆盖率会把关系层上限压到 0.875。
 */
export function layerCoverage(piXs: readonly number[], tau: number): number {
  if (piXs.length === 0) return 0;
  const sum = piXs.reduce((acc, p) => acc + coverage(p, tau), 0);
  return sum / piXs.length;
}

/** 层准入所需的全部输入（三个准入条件 + 阈值） */
export interface AdmissionInput {
  /** 用途掩码值，> 0 才算被激活 */
  readonly mask: number;
  /** self 侧覆盖率 */
  readonly coverageSelf: number;
  /** user_est 侧覆盖率 */
  readonly coverageUserEst: number;
  /** 该层证据 E_L */
  readonly evidence: number;
  /** 该层阈值 θ_L */
  readonly threshold: number;
}

/**
 * S-018 层准入：三个条件**全部**满足才计入 minLayers。
 *
 * 1. 掩码激活（mask > 0）
 * 2. **两侧**覆盖率都 ≥ 0.3（self 与 user_est 缺一不可——只有一侧有值
 *    说明是单边臆测，不足以支撑共振）
 * 3. E_L ≥ θ_L
 */
export function layerAdmitted(input: AdmissionInput): boolean {
  return (
    input.mask > 0 &&
    input.coverageSelf >= COVERAGE_MIN &&
    input.coverageUserEst >= COVERAGE_MIN &&
    input.evidence >= input.threshold
  );
}

/**
 * S-018 minLayers 校验：通过准入的层数不足即返回空结果。
 *
 * 🔴 **绝不自动降低阈值或 minLayers 条件**——那会让单一线索就引发误召回，
 * 正是本条规约要防的违规后果。
 */
export function meetsMinLayers(admittedCount: number, minLayers: number): boolean {
  return admittedCount >= minLayers;
}

// ============ S-016 · 层间聚合 ============

/**
 * 总证据 E = Σ_L m_L × E_L（S-016）
 *
 * - `m_L` 层权重本切片固定为 1，故退化为直接求和
 * - **只传已通过准入的层**（S-018 的筛选在此前完成）
 * - 层的求和顺序同样固定：调用方须按 `LAYER_NAMES` 升序传入（E-06）
 */
export function totalEvidence(admittedLayerEs: readonly number[]): number {
  return admittedLayerEs.reduce((acc, e) => acc + e, 0);
}