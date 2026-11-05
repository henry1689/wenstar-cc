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
 * E-05：层组共 7 个，顺序即掩码数组的下标顺序。
 *
 * 该顺序同时是 `DEFAULT_MASKS` 三套掩码、`DIMS_BY_LAYER`、`LAYER_PARAMS` 的
 * 键序与下标序，三者不一致会让掩码/λ/τ 张冠李戴（例如把 body 的 τ 挂到 core 上）。
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
 * 下标不在此处：`layout.ts` 的 `layerIndices(layer, purpose)` 由 LAYOUT × 本表推导，不写死下标。
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

// ============ 层参数（S-046 λ 层级顺序 / 白皮书 τ 回归时间常数） ============

/** 单层参数：λ 为精度衰减系数，τ 为回归时间常数（分钟） */
export interface LayerParam {
  /** 精度衰减系数 λ（S-046）：场景细节掉得最快，情感要点掉得最慢 */
  readonly lambda: number;
  /** 回归时间常数 τ（分钟）；null = 该层不走 OU–Kalman（无 τ 概念） */
  readonly tauMin: number | null;
}

/**
 * 层参数表（白皮书 §2.4 τ 回归时间常数 / §4.2 λ 精度衰减）。
 *
 * ✅ **relation τ = 120 分钟已获业主批准（2026-11-05）**。
 * 白皮书 §2.4 无 Ⅴ 关系层，该值由业主裁定；批准依据与 τ 敏感度实测见下条注释。
 * τ 直接决定无观测期的回归速度，数值变更须重跑
 * `__tests__/tau-sensitivity.test.ts` 并重新走批准流程。
 */
export const LAYER_PARAMS: Readonly<Record<LayerName, LayerParam>> = Object.freeze({
  body: Object.freeze({ lambda: 0.8, tauMin: 60 }),
  core: Object.freeze({ lambda: 0.15, tauMin: 20 }),
  appraisal: Object.freeze({ lambda: 0.4, tauMin: 10 }),
  motive: Object.freeze({ lambda: 0.4, tauMin: 30 }),
  // relation τ = 120 分钟。**业主已批准（2026-11-05）**。
  // 白皮书 §2.4 的 τ 表无 Ⅴ 关系层，此值由业主裁定。
  // 批准依据：① λ 与 dyad 同为 0.15，属同一慢度类别；
  //          ② τ 序列中应慢于 body(60)、不快于 dyad(120)；
  //          ③ τ 敏感度实测（阶跃 0.9 → 90 分钟无观测，基线 0.5）：
  //             τ=60/120/240 → 终态残差 0.066034 / 0.156890 / 0.242668
  relation: Object.freeze({ lambda: 0.15, tauMin: 120 }),
  scene: Object.freeze({ lambda: 1.0, tauMin: null }),
  dyad: Object.freeze({ lambda: 0.15, tauMin: 120 }),
});

/**
 * 层参数加载断言（补包 B 第 5 项：抽成纯函数）。
 *
 * 🔴 **为什么必须是纯函数**：原本这段是模块顶层代码，测试里触发不到——变异测试
 * 只能靠 `vi.resetModules()` + 动态 import 重新加载整个模块，既慢又容易污染其它
 * 用例。抽成可传参的纯函数后，模块加载时用真实参数调一次，变异测试直接用变异后的
 * 参数调，两条路径共用同一份规则，抓得率才可度量。
 *
 * 三条规则（任一不满足即抛错，**不给默认值、不静默降级**）：
 * ① 键序与 `LAYER_NAMES` 一致（掩码 / λ / τ 共用同一序，错位会张冠李戴）
 * ② S-046 λ 层级顺序：scene ≥ body ≥ appraisal = motive ≥ core = relation = dyad
 * ③ 只有 `scene` 不走 Kalman；其余六层必须有正有限的 τ
 *
 * 🔴 属 **R2 区域**（见 `tests/oracle/oracle-change-policy.md`）：
 * 放宽任一断言需业主签字。
 */
export function assertLayerParams(params: Record<LayerName, LayerParam>): void {
  // ① 键序与 LAYER_NAMES 一致
  const keys = Object.keys(params);
  if (keys.length !== LAYER_NAMES.length || keys.some((k, i) => k !== LAYER_NAMES[i])) {
    throw new Error('LAYER_PARAMS 键序必须与 LAYER_NAMES 一致（掩码/λ/τ 共用同一序）');
  }

  const lambdaOf = (layer: LayerName): number => params[layer].lambda;

  // ② S-046 λ 层级顺序：scene ≥ body ≥ appraisal = motive ≥ core = relation = dyad
  const tiers: readonly (readonly [LayerName, LayerName])[] = [
    ['scene', 'body'],
    ['body', 'appraisal'],
    ['appraisal', 'motive'],
    ['appraisal', 'core'],
    ['appraisal', 'relation'],
    ['appraisal', 'dyad'],
    ['motive', 'core'],
    ['motive', 'relation'],
    ['motive', 'dyad'],
    ['core', 'relation'],
    ['core', 'dyad'],
    ['relation', 'dyad'],
  ];
  for (const [higher, lower] of tiers) {
    if (lambdaOf(higher) < lambdaOf(lower)) {
      throw new Error(
        `S-046 λ 层级顺序颠倒：${higher}(${lambdaOf(higher)}) < ${lower}(${lambdaOf(lower)})`,
      );
    }
  }
  // 同层位必须相等：appraisal = motive，core = relation = dyad
  const sameTier: readonly (readonly [LayerName, LayerName])[] = [
    ['appraisal', 'motive'],
    ['core', 'relation'],
    ['core', 'dyad'],
    ['relation', 'dyad'],
  ];
  for (const [a, b] of sameTier) {
    if (lambdaOf(a) !== lambdaOf(b)) {
      throw new Error(`S-046 λ 同层位不等：${a}(${lambdaOf(a)}) ≠ ${b}(${lambdaOf(b)})`);
    }
  }

  // ③ 只有 scene 不走 Kalman（整层跳变模型）；其余六层必须有正有限的 τ
  const withoutTau = LAYER_NAMES.filter((layer) => params[layer].tauMin === null);
  if (withoutTau.length !== 1 || withoutTau[0] !== 'scene') {
    throw new Error(`τ 为 null 的层应只有 scene，实际：${withoutTau.join(', ') || '（无）'}`);
  }
  for (const layer of LAYER_NAMES) {
    const { lambda, tauMin } = params[layer];
    if (!Number.isFinite(lambda) || lambda < 0) {
      throw new Error(`${layer} 的 λ 必须为非负有限数，实际 ${lambda}`);
    }
    if (tauMin !== null && !(Number.isFinite(tauMin) && tauMin > 0)) {
      throw new Error(`${layer} 的 τ 必须为正有限数，实际 ${tauMin}`);
    }
  }
}

// 模块加载期用真实参数执行一次：层参数配错不会报错，只会让遗忘节奏与层级顺序
// 悄悄跑偏，所以必须在加载期炸出来。
assertLayerParams(LAYER_PARAMS);

// ============ 维度级开关（E-14 细化 / E-10） ============

/**
 * 不走 OU–Kalman 的维度。
 *
 * - `D27`：同频，由 dyad 的 Y1 回填，主体块不独立滤波（E-10）
 * - `D32`–`D40`：场景整层走跳变模型，无 τ 概念
 *
 * 与「层没有 τ」不是一回事：`relation` 层**有** τ（除 D27 外都走 Kalman），
 * `scene` 层是**整层**不走。两者不得混为一谈。
 */
export const NO_KALMAN_DIMS: ReadonlySet<DimId> = Object.freeze(
  new Set<DimId>(['D27', ...DIMS_BY_LAYER.scene]),
);

/**
 * E-14 现行口径：**只观测、共鸣权重恒为 0** 的维度（D29 / D30）。
 *
 * 依赖指标不得作为任何优化目标（S-067 消融不变性），否则系统会主动放大依赖。
 */
export const OBSERVE_ONLY_DIMS: ReadonlySet<DimId> = Object.freeze(
  new Set<DimId>(['D29', 'D30']),
);

/**
 * 仅私密模式参与的维度（D20 欲求）。
 *
 * ⚠️ 旧 40D v2.1 表中 D20 为「团队集体保护」（`d20_team_protection`），
 *    与 v3.1 口径不同义，**禁止混用**（见 `contract/legacy-dim.ts` 的禁令）。
 *    依据：v3.1 D20 = 欲求（Opus v3 维度表）；白皮书正文从不给 D20 语义，
 *    仅在 §3.7 称其为「低发维度」——「低发」支持「欲求」，不支持
 *    「团队集体保护」（后者是持续状态，不会低发）。
 *
 * E-29（已获 Sonnet 同意登记）：D20 曾与 D29/D30 一并被锁死为 0，现改为由
 * 私密模式开关控制是否参与——非私密模式下恒 0，私密模式下按 1 参与。
 * 非私密模式启用 D20 属 L3 事项（需业主审批 + 快照 + 账本）。
 * 判定依据见 `ADR-002-私密模式定义与边界`。
 */
export const PRIVATE_ONLY_DIMS: ReadonlySet<DimId> = Object.freeze(
  new Set<DimId>(['D20']),
);

// ============ 层参数查询（纯函数，无模块级可变状态） ============

/**
 * 该维度所属的层。
 *
 * 故意**不用 `Map` 缓存反查表**：core 禁止模块级可变状态（工程约束 2），
 * 而 `Map` 虽是 const，其内容仍可被 `.set()` 就地改写。改用 `find` 线性查找，
 * 48 个维度在配置粒度调用下成本可忽略，换来「查表本身不可能被篡改」。
 *
 * @throws 未知维度直接抛错，不静默归入任何一层
 */
export function layerOf(dim: DimId): LayerName {
  const hit = LAYER_NAMES.find((layer) => DIMS_BY_LAYER[layer].includes(dim));
  if (!hit) throw new Error(`layerOf: 未知维度 ${dim}`);
  return hit;
}

/** 该维度所属层的 λ（S-046 精度衰减系数） */
export function layerLambda(dim: DimId): number {
  return LAYER_PARAMS[layerOf(dim)].lambda;
}

/**
 * 该维度的回归时间常数 τ（分钟）。
 *
 * - `NO_KALMAN_DIMS`（D27 + D32–D40，共 10 个维度编号）→ `null`
 * - 其余维度 → 所属层的 τ
 *
 * 🔴 **层应有 τ 却为 null 时抛错，不给默认值**。抛错是刻意的：基线补全前
 * 差分测试必须明确失败，而不是悄悄用一个编造的 τ 把结果算歪。
 */
export function layerTau(dim: DimId): number | null {
  if (NO_KALMAN_DIMS.has(dim)) return null;
  const layer = layerOf(dim);
  const tau = LAYER_PARAMS[layer].tauMin;
  if (tau === null) throw new Error(`${dim}: 层 ${layer} 未配置 τ`);
  return tau;
}

/**
 * 共鸣打分的维度权重乘子（0 或 1）。调用方**必须**乘上它，
 * 用途掩码 `layerMask` 不能覆盖这个结果。
 *
 * - `OBSERVE_ONLY_DIMS` → 恒 0
 * - `PRIVATE_ONLY_DIMS` → **仅当 `privateMode === true`** 才为 1
 * - 其余 → 1
 *
 * 🔴 **保守规则（ADR-002 §4）**：`privateMode` 为 `true` 之外的任何值
 * （`undefined` / `null` / `1` / `'true'` / `{}`）一律视为**关**。
 * 上游 `effectiveWeight` 已传入 `ctx.privateMode === true`，但本函数是
 * **导出函数、可被单独调用**，故在此再收紧一次——双保险不增加成本。
 *
 * 🔴 **来源限制（ADR-002 §3.1）**：
 * ```
 * privateMode 只允许来自显式来源（用户显式指令 / 事先授权的会话标定）。
 * 禁止从内容检测、话题敏感度、语义推断、语调、关键词推断。
 * 判定行为本身即侵犯（ADR-002 §3.1）。
 * ```
 *
 * 与 `effectiveWeight()` 的分工：`rawDimWeight` 只算 base × r_ICC × (1+δ)，
 * 私密模式这种**上下文相关**的开关在唯一入口内生效，以保持 core 纯函数与职责单一。
 */
export function resonanceMask(dim: DimId, privateMode: boolean): 0 | 1 {
  if (OBSERVE_ONLY_DIMS.has(dim)) return 0;
  if (PRIVATE_ONLY_DIMS.has(dim)) return privateMode === true ? 1 : 0;
  return 1;
}

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

/**
 * 测试专用：导出需与 oracle 逐项对拍的常量快照（补包 B 第 5 项）。
 *
 * 产出 `tests/oracle/layer-constants-ts.json`，由 oracle 侧读取后与
 * `oracle_spacestate.py` 的同名常量**逐项比对**——10⁵ 差分跑不到层参数，
 * 对常量零保护力，这层对拍是常量的唯一交叉验证。
 *
 * 全部返回**拷贝**，不暴露内部引用（`DIMS_BY_LAYER` / `LAYER_PARAMS` 是冻结常量，
 * 直接返回会让调用方拿到可被 `Object.freeze` 之外方式误用的引用）。
 */
export function exportLayerConstants(): {
  readonly dimsByLayer: Record<string, readonly string[]>;
  readonly layerParams: Record<string, { readonly lambda: number; readonly tauMin: number | null }>;
  readonly noKalman: readonly string[];
  readonly observeOnly: readonly string[];
  readonly privateOnly: readonly string[];
} {
  return {
    dimsByLayer: Object.fromEntries(LAYER_NAMES.map((l) => [l, [...DIMS_BY_LAYER[l]]])),
    layerParams: Object.fromEntries(
      LAYER_NAMES.map((l) => [l, { lambda: LAYER_PARAMS[l].lambda, tauMin: LAYER_PARAMS[l].tauMin }]),
    ),
    noKalman: [...NO_KALMAN_DIMS].sort(),
    observeOnly: [...OBSERVE_ONLY_DIMS].sort(),
    privateOnly: [...PRIVATE_ONLY_DIMS].sort(),
  };
}
