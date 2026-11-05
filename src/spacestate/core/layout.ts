/**
 * 79 维布局与值域表（S-001 / S-002 / S-008）
 *
 * 本文件是维度下标的唯一真相源：任何「第几维」的判断都必须由 LAYOUT 推出，
 * 不得在别处硬编码下标，以防维度错位导致证据计算整体失真。
 */

import { DIMS_BY_LAYER, LAYOUT_SIZE, LAYER_NAMES } from './config.js';
import type { LayerName } from './config.js';
import { clampPi } from './coding.js';

/** 印记块 */
export type Block = 'scene' | 'self' | 'user_est' | 'dyad';

/**
 * S-001 79 维布局：下标 → (块, 维度编号)
 *
 * | 下标范围   | 块       | 内容                    |
 * |------------|----------|-------------------------|
 * | [0..8]     | scene    | D32–D40（9 维，全系统共享一份场景层） |
 * | [9..39]    | self     | D01–D31（31 维，瑶灵自己）   |
 * | [40..70]   | user_est | D01–D31（31 维，对用户的估计） |
 * | [71..78]   | dyad     | Y1–Y8（8 个关系指数）        |
 *
 * 采用逐项字面量而非循环生成：规约要求「每个下标对应的（块，维度）逐项一致」，
 * 字面量数组可被黄金表单测逐项审计，循环生成则会把错位风险藏进推导逻辑里。
 *
 * 运行时 Object.freeze：类型级 readonly 挡不住 `(LAYOUT as any).push(...)`，
 * 而 LAYOUT 是维度下标的唯一真相源，被篡改会让全部证据计算错位。
 */
export const LAYOUT = Object.freeze([
  // —— scene：D32–D40（下标 0..8）——
  { block: 'scene', dim: 'D32' },
  { block: 'scene', dim: 'D33' },
  { block: 'scene', dim: 'D34' },
  { block: 'scene', dim: 'D35' },
  { block: 'scene', dim: 'D36' },
  { block: 'scene', dim: 'D37' },
  { block: 'scene', dim: 'D38' },
  { block: 'scene', dim: 'D39' },
  { block: 'scene', dim: 'D40' },

  // —— self：D01–D31（下标 9..39）——
  { block: 'self', dim: 'D01' },
  { block: 'self', dim: 'D02' },
  { block: 'self', dim: 'D03' },
  { block: 'self', dim: 'D04' },
  { block: 'self', dim: 'D05' },
  { block: 'self', dim: 'D06' },
  { block: 'self', dim: 'D07' },
  { block: 'self', dim: 'D08' },
  { block: 'self', dim: 'D09' },
  { block: 'self', dim: 'D10' },
  { block: 'self', dim: 'D11' },
  { block: 'self', dim: 'D12' },
  { block: 'self', dim: 'D13' },
  { block: 'self', dim: 'D14' },
  { block: 'self', dim: 'D15' },
  { block: 'self', dim: 'D16' },
  { block: 'self', dim: 'D17' },
  { block: 'self', dim: 'D18' },
  { block: 'self', dim: 'D19' },
  { block: 'self', dim: 'D20' },
  { block: 'self', dim: 'D21' },
  { block: 'self', dim: 'D22' },
  { block: 'self', dim: 'D23' },
  { block: 'self', dim: 'D24' },
  { block: 'self', dim: 'D25' },
  { block: 'self', dim: 'D26' },
  { block: 'self', dim: 'D27' },
  { block: 'self', dim: 'D28' },
  { block: 'self', dim: 'D29' },
  { block: 'self', dim: 'D30' },
  { block: 'self', dim: 'D31' },

  // —— user_est：D01–D31（下标 40..70）——
  { block: 'user_est', dim: 'D01' },
  { block: 'user_est', dim: 'D02' },
  { block: 'user_est', dim: 'D03' },
  { block: 'user_est', dim: 'D04' },
  { block: 'user_est', dim: 'D05' },
  { block: 'user_est', dim: 'D06' },
  { block: 'user_est', dim: 'D07' },
  { block: 'user_est', dim: 'D08' },
  { block: 'user_est', dim: 'D09' },
  { block: 'user_est', dim: 'D10' },
  { block: 'user_est', dim: 'D11' },
  { block: 'user_est', dim: 'D12' },
  { block: 'user_est', dim: 'D13' },
  { block: 'user_est', dim: 'D14' },
  { block: 'user_est', dim: 'D15' },
  { block: 'user_est', dim: 'D16' },
  { block: 'user_est', dim: 'D17' },
  { block: 'user_est', dim: 'D18' },
  { block: 'user_est', dim: 'D19' },
  { block: 'user_est', dim: 'D20' },
  { block: 'user_est', dim: 'D21' },
  { block: 'user_est', dim: 'D22' },
  { block: 'user_est', dim: 'D23' },
  { block: 'user_est', dim: 'D24' },
  { block: 'user_est', dim: 'D25' },
  { block: 'user_est', dim: 'D26' },
  { block: 'user_est', dim: 'D27' },
  { block: 'user_est', dim: 'D28' },
  { block: 'user_est', dim: 'D29' },
  { block: 'user_est', dim: 'D30' },
  { block: 'user_est', dim: 'D31' },

  // —— dyad：Y1–Y8（下标 71..78）——
  { block: 'dyad', dim: 'Y1' },
  { block: 'dyad', dim: 'Y2' },
  { block: 'dyad', dim: 'Y3' },
  { block: 'dyad', dim: 'Y4' },
  { block: 'dyad', dim: 'Y5' },
  { block: 'dyad', dim: 'Y6' },
  { block: 'dyad', dim: 'Y7' },
  { block: 'dyad', dim: 'Y8' },
] as const);

// S-001 完整性断言：布局维数必须为 79，模块加载即失败而非静默错位
if (LAYOUT.length !== LAYOUT_SIZE) {
  throw new Error(`LAYOUT 维数 ${LAYOUT.length} !== 规约 ${LAYOUT_SIZE}（S-001）`);
}

// 整改 6：深冻结。Object.freeze(LAYOUT) 只锁数组本身，
// 内层对象仍可被 `(LAYOUT[0] as any).block = 'x'` 篡改——而 LAYOUT 是下标唯一真相源。
for (const entry of LAYOUT) Object.freeze(entry);

/** LAYOUT 单项的类型（由字面量数组推导，避免第二处定义漂移） */
export type LayoutEntry = (typeof LAYOUT)[number];

/**
 * 合法维度编号的字面量联合（由 LAYOUT 推导）。
 *
 * 把 `dim` 参数的类型从裸 `string` 收紧到此类型，可在**编译期**挡住
 * `'D1'`、`'D01 '`、`'d01'` 这类拼写错误——否则 isBipolar 会静默返回 false，
 * 把拼错的维度当单极 [0,1] 处理并把负值截成 0。
 * 动态来源（数据库读出的 string）应先经 LAYOUT 查找再取 dim。
 */
export type DimId = LayoutEntry['dim'];

/**
 * S-002 双极维清单（值域 [-1,1]），其余为单极维（值域 [0,1]）。
 *
 * 按维度编号判定、与块无关：self.D01 与 user_est.D01 同为双极，
 * scene.D32 双极而 scene.D33 单极。
 */
const BIPOLAR_DIMS: readonly DimId[] = Object.freeze([
  'D01', 'D02', 'D03', 'D05', 'D06', 'D07', 'D09', 'D11', 'D14', 'D15', 'D31',
  'D32', 'D34', 'D36', 'D37', 'D38', 'D39', 'D40',
  'Y2', 'Y4', 'Y7', 'Y8',
]);

/** 该维度是否为双极维（S-002） */
export function isBipolar(dim: DimId): boolean {
  return BIPOLAR_DIMS.includes(dim);
}

/**
 * E-05 / S-018：层 → LAYOUT 下标（由 LAYOUT × config.DIMS_BY_LAYER 推导）。
 *
 * 🔴 **不写死任何下标**：LAYOUT 一旦调整（v3.2 增删维度），本表自动跟随；
 * 下面的加载断言会把「错位」变成启动即失败，而不是运行时静默失真。
 *
 * 为什么只按维度编号过滤、不判块：D01–D31 在 self 与 user_est 各出现一次且同属
 * 一层；D32–D40 只出现在 scene 块；Y1–Y8 只出现在 dyad 块。四块之间维度编号
 * 互不重叠，故按编号过滤即得全部归属下标。
 *
 * 🔴 **E-10 已知交互**：`relation` 层含 D27，而 self / user_est 的 D27 存储精度
 * 恒为 0（证据只在 dyad 块计算）。接入层准入/覆盖率时，须先把
 * `D27_STORAGE_INDICES` 从该层的 piXs 中剔除，否则两项恒定 0 覆盖率会把
 * 关系层覆盖率整体压低。
 */
function layerIndices(layer: LayerName): readonly number[] {
  return Object.freeze(
    LAYOUT.reduce<number[]>(
      (acc, entry, index) =>
        DIMS_BY_LAYER[layer].includes(entry.dim) ? [...acc, index] : acc,
      [],
    ),
  );
}

/** 层名 → 该层在 79 维中的下标集合（键序与 LAYER_NAMES 一致） */
export const LAYER_DIMS: Readonly<Record<LayerName, readonly number[]>> = Object.freeze({
  body: layerIndices('body'),
  core: layerIndices('core'),
  appraisal: layerIndices('appraisal'),
  motive: layerIndices('motive'),
  relation: layerIndices('relation'),
  scene: layerIndices('scene'),
  dyad: layerIndices('dyad'),
});

// E-05 加载断言：七层必须恰好铺满 79 维且互不重叠。
// 只在「漏了一维」或「一维被两层同时认领」时才失败——这两种错法都不会报错，
// 只会让聚合结果悄悄偏掉，所以必须在加载期炸出来。
{
  const layered = LAYER_NAMES.flatMap((layer) => LAYER_DIMS[layer]);
  if (layered.length !== LAYOUT.length) {
    throw new Error(
      `LAYER_DIMS 合计 ${layered.length} 项 !== LAYOUT 维数 ${LAYOUT.length}（E-05）`,
    );
  }
  if (new Set(layered).size !== LAYOUT.length) {
    throw new Error('LAYER_DIMS 存在跨层重复下标：同一维度被两层同时认领（E-05）');
  }
}

/**
 * S-008 / 勘误 E-10：主体块 D27 的存储精度恒为 0 的下标集合。
 *
 * 由 LAYOUT 推导而非硬编码，保证下标永远与布局一致（布局一旦调整即自动跟随）。
 * 规约给定的目标值为 [35, 66]，由单测逐项钉死。
 */
export const D27_STORAGE_INDICES: readonly number[] = LAYOUT.reduce<number[]>(
  (acc, entry, index) =>
    entry.dim === 'D27' && (entry.block === 'self' || entry.block === 'user_est')
      ? [...acc, index]
      : acc,
  [],
);

// 整改 3：加载断言。D27 必须恰好命中主体块两处（self + user_est），
// 否则推导已随布局漂移——精确下标 [35, 66] 由单测 `toEqual([35, 66])` 钉死
// （字面量 35/66 不进 core，受工程约束 4 白名单限制）。
if (D27_STORAGE_INDICES.length !== 2) {
  throw new Error(
    `D27_STORAGE_INDICES 命中 ${D27_STORAGE_INDICES.length} 处，应为主体块 2 处（S-008/E-10）`,
  );
}

/**
 * S-008：写入印记时把主体块 D27 的存储精度强制置 0。
 *
 * D27 同频只在逻辑视图由 dyad Y1 回填，证据只在 dyad 块计算，
 * 主体块若保留精度会导致同一证据被计入三次。
 *
 * `prec[]` 里装的正是各维的 π，因此本函数同样受 E-25 约束：
 * 复用 `clampPi` 统一清洗——π=+∞ 饱和 400（而非存 0 当未知）、NaN/负值归 0、
 * 有限超限截到 400。**不得在本函数另写一套清洗逻辑**，否则两处口径必然漂移。
 *
 * 返回新数组（纯函数，不修改入参）。
 *
 * 入参契约：长度必须等于 LAYOUT 维数，否则抛错——传短数组会因下标写入
 * 产生稀疏数组，属调用方 bug，必须显式失败而非静默产出坏数据。
 */
export function stampStoragePrecision(prec: readonly number[]): number[] {
  if (prec.length !== LAYOUT.length) {
    throw new Error(
      `stampStoragePrecision: 长度 ${prec.length} !== LAYOUT 维数 ${LAYOUT.length}`,
    );
  }
  const out = prec.map((p) => clampPi(p));
  for (const index of D27_STORAGE_INDICES) out[index] = 0;
  return out;
}
