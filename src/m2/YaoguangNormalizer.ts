/**
 * YaoguangNormalizer — 瑶光 medical → 40D [0,1] 归一化工具
 * ============================================================
 * 瑶光 `wf_perception_filter` 返回 objective 各维为 **医学原始值**
 * （如 D12 催产素 50 pg/mL、D1 血乳酸 0.9 mmol/L），40D 感知向量需要 [0,1]。
 * 本模块将瑶光客观数据归一化为 40D 值（纯函数，零依赖）。
 *
 * 归一化锚点（瑶光权威，见 三体对接联调标准 §3.2）：
 *   - 单极维度：`(value - range_low) / (range_high - range_low)`，钳 [0,1]
 *   - 双极维度 D36/37：`(v + 1) / 2`（瑶光值域 [-1,1] → 40D [0,1]）
 *   - 锚点 = 瑶光 standard_range 中点（baseline）；客观维缺失时返回 NaN 被跳过
 *
 * 🔴 软连接铁律：本模块只消费瑶光 MCP 返回的 JSON 数据（经天权 RPC 透传），
 * 绝不 import 瑶光模块 / 读写瑶光库。瑶光不可达时由调用方降级（保持 M3 语义维）。
 */
import type { PerceptionState24 } from '../m3/types/perception.js';
// 🔴 2026-11-02 契约归位：40D 字典唯一真源在 m2（见该文件头说明）。
//    改为**同层引用**以消除 CK-01 反向依赖（CK-01 只豁免 import type，值导入不豁免）。
import { createEmptyPerceptionV40 } from './types/perception-40d.js';
import type { PerceptionV40 } from './types/perception-40d.js';
import { MAP_24_TO_40 } from './PerceptionVector40DCodec.js';

/** 双极维度（值域 [-1,1]，瑶光侧已实现） */
const BIPOLAR_40D = new Set([36, 37]);

/** 瑶光 objective 单维结构 */
export interface YaoguangDim {
  standard_value?: number;
  standard_range?: [number, number];
  label?: string;
  context?: { baseline?: number; [k: string]: unknown };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 客观标准值 → [0,1]：双极用 (v+1)/2，单极用 (value-low)/(high-low)。
 * 非法/缺失输入返回 NaN（调用方跳过，不注入错误值）。
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
 * 瑶光 objective（d1..d40 → PerceptionV40 键）批量归一化。
 * 缺失/非法维跳过（返回 Partial，只含有限数值）。
 */
export function normalizeYaoguangObjective(
  objective: Record<string, YaoguangDim> | null | undefined,
): Partial<PerceptionV40> {
  const out: Partial<PerceptionV40> = {};
  if (!objective) return out;
  for (let dim = 1; dim <= 40; dim++) {
    const entry = objective[`d${dim}`];
    if (!entry) continue;
    const normalized = normalizeStandardValue(
      entry.standard_value,
      entry.standard_range,
      BIPOLAR_40D.has(dim),
    );
    const key = keyForDim(dim);
    if (key && isFinite(normalized)) {
      out[key] = normalized;
    }
  }
  return out;
}

/**
 * 语义维集合（M3 词表直接产出，源泉为 WenstarOS M3）：
 *   D09/D12/D14/D15/D17/D19/D33-D40
 * 🔴 铁律：语义维以 M3 为准，瑶光只补客观维（D01-D08/D10/D11/D13/D16/D18/D20/D21-D32）。
 * 若瑶光对语义维也给值，M3 语义优先，不覆盖。
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
    // 🔴 语义维（M3 源泉）跳过 — 瑶光不覆盖
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

/** 兼容旧接口：从 24D 合成一条完整 40D（供存量/降级路径，等价于 M3 内部投影） */
export function buildFallbackV40(p24: PerceptionState24): PerceptionV40 {
  const p40 = createEmptyPerceptionV40();
  for (const { key24, dim40 } of MAP_24_TO_40) {
    const key = keyForDim(dim40);
    if (!key) continue;
    const v = p24[key24] ?? 0;
    p40[key] = BIPOLAR_40D.has(dim40) ? clamp(v, -1, 1) : clamp(v, 0, 1);
  }
  return p40;
}

/** D编号 → PerceptionV40 键名（dNN_key），未映射返回 undefined */
function keyForDim(dim: number): keyof PerceptionV40 | undefined {
  const DIM_KEYS: Record<number, keyof PerceptionV40> = {
    1: 'd01_muscle_load', 2: 'd02_pain_level', 3: 'd03_nerve_arousal', 4: 'd04_endocrine_hormones',
    5: 'd05_pheromone', 6: 'd06_metabolic_cycle', 7: 'd07_self_heal', 8: 'd08_sensory_env',
    9: 'd09_self_identity', 10: 'd10_desire_drive', 11: 'd11_fear_fatigue', 12: 'd12_enjoyment',
    13: 'd13_empathy', 14: 'd14_self_protection', 15: 'd15_partner_attachment', 16: 'd16_partner_protection',
    17: 'd17_family_belonging', 18: 'd18_family_protection', 19: 'd19_social_fit', 20: 'd20_team_protection',
    21: 'd21_private_space', 22: 'd22_home_environment', 23: 'd23_workplace', 24: 'd24_public_space',
    25: 'd25_spatiotemporal', 26: 'd26_seasonal_climate', 27: 'd27_micro_physiology', 28: 'd28_nature_expansion',
    29: 'd29_social_refinement', 30: 'd30_spiritual_growth', 31: 'd31_quantum_coupling', 32: 'd32_global_overview',
    33: 'd33_sexual_attraction', 34: 'd34_energy_merge', 35: 'd35_sincerity', 36: 'd36_dominance',
    37: 'd37_moral_judgment', 38: 'd38_humor', 39: 'd39_dependency', 40: 'd40_possessiveness',
  };
  return DIM_KEYS[dim];
}
