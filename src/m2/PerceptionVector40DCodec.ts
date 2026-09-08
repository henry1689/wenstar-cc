/**
 * PerceptionVector40DCodec — 40D 感知向量统一编解码标准
 * ============================================================
 * 40D 编码完全参照 32D 通用规则细则（双规范结合）:
 *   - WS-ARCH-32D-MEM 工程蓝皮书 spine.proto D1-D32（5 大类，field 10-55）
 *   - DNA 双螺旋完整编码规范 V2.0 §1.1（海胆 32 根语义刺）
 * 40D = spine.proto D1-D32 + 新增 D33-D40（伴侣情感纹理，第 6 大类）
 *
 * 🔴 双轨制铁律：
 *   24D（Perception24D/EmotionVectorCodec）完全保留不动；
 *   40D 侧每个维度 D1-D40 一一对应独立定义，不做折中合并。
 *   map24DTo40D 仅用于「存量迁移初始填充 + 当前无 P3 数据源时派生」，
 *   不改变 24D 侧任何行为。
 *
 * 铁律遵循（来自双规范）:
 *   1. 每根刺 = float32，只记录主观感受强度，不记录实体对象
 *   2. 全部 40D 由规则计算产出，禁 LLM 直接算（MH-4）
 *   3. 12 节点编码管道全部规则驱动
 */
import type { Perception24D } from '../m3/types/perception.js';
import {
  PerceptionV40,
  PERCEPTION_40D_KEYS,
  PERCEPTION_40D_DIM,
  PERCEPTION_40D_SECTOR_WEIGHTS,
  createEmptyPerceptionV40,
} from '../m3/types/perception-40d.js';

// V12.4 阶段B 根除24D: 默认 40D v2 JSON（全零语义向量）— 金库/记事/锚点等无感知输入时的统一落库默认值。
// 与旧 perception_json='{}'（全零 24D）语义等价：知识类条目不参与情感相似召回（余弦 0）。
export function encodeEmptyPerceptionV40(): string {
  return encodePerceptionV40(createEmptyPerceptionV40());
}

// ──────────────────────────────────────────────
// 1. 编码：PerceptionV40 → JSON 字符串（带 __v 版本标识）
// ──────────────────────────────────────────────

/**
 * 当前 40D 编码版本标识。
 * v1 = 纯数组格式（40 元素，历史存量）
 * v2 = `{"__v":2,"dims":[40 元素]}` 对象格式（当前标准，含版本可识别）
 * 解码向后兼容 v1/v2/命名对象三种格式。
 */
export const PERCEPTION_40D_ENCODING_VERSION = 2;

/**
 * 将 PerceptionV40 编码为 JSON 字符串（带 __v 版本标识）。
 * 统一入口：所有 40D 感知向量写入 perception_40d 列必须走此方法。
 * v2 格式：`{"__v":2,"dims":[D1..D40]}` — 版本可识别、可校验。
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
 *   v0: `{"d12_enjoyment":0.5,...}`（早期命名对象，无 __v）
 * 长度不对或解析失败返回 null（不抛出）。
 */
/**
 * 格式闸:v2 形状判定(供 decode 分支选择与 detect 同源)。
 * v2 格式 = 对象携带 dims 数组。detect 只判格式、不做完整性校验,故此处不查长度/数值。
 */
function hasV2Shape(rec: Record<string, unknown>): boolean {
  return Array.isArray(rec.dims);
}

/**
 * 完整性闸:从对象解析 v2 dims(长 40 + 全有限数)。
 * 非法 → null。仅在格式闸通过后调用;decode 内部校验,保证"非法 v2 → null(需修复)"语义。
 */
function parseV2Dims(rec: Record<string, unknown>): number[] | null {
  const dims = rec.dims as unknown[];
  if (dims.length !== PERCEPTION_40D_DIM) return null;
  const out = new Array<number>(PERCEPTION_40D_DIM);
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    const v = Number(dims[i]);
    if (!isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

export function decodePerceptionV40(json: string | null | undefined): PerceptionV40 | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (typeof arr === 'object' && arr !== null && !Array.isArray(arr)) {
      const rec = arr as Record<string, unknown>;
      // 声明为 v2(__v===2)却无 dims → 畸形 v2,返回 null(不落 v0 命名分支)
      if (rec.__v === PERCEPTION_40D_ENCODING_VERSION && !hasV2Shape(rec)) {
        return null;
      }
      // 带 dims 数组 → 按 v2 解析(与 detect 判定同源):
      // 旧 decode 仅 __v===2 才解析,使 {__v:3,dims:[40]}/{dims:[40]} 落 v0 分支静默产出全零,
      // 而 detect 判 2 —— 版本判定分裂导致脏数据"审计通过但内容清零"。
      // 未知 __v + 合法 dims:数据保全优先,按 v2 解析(不返 null,以免迁移侧破坏性覆写)。
      if (hasV2Shape(rec)) {
        const dims = parseV2Dims(rec);
        if (dims === null) return null;
        const p = createEmptyPerceptionV40();
        for (let i = 0; i < PERCEPTION_40D_DIM; i++) p[PERCEPTION_40D_KEYS[i]] = dims[i];
        return p;
      }
      // v0: 命名对象(无 dims 字段 / 无 __v)→ 直接读命名键
      const p = createEmptyPerceptionV40();
      for (const k of PERCEPTION_40D_KEYS) {
        const v = Number((arr as Record<string, unknown>)[k]);
        if (isFinite(v)) p[k] = v;
      }
      return p;
    }
    // v1: 纯数组(40 元素)
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

/**
 * 检测 40D 编码格式版本。
 * 返回：2（v2 带 __v 对象）/ 1（v1 纯数组）/ 0（v0 命名对象）/ -1（无法解析）。
 * 用于迁移校验与数据审计。
 */
export function detectPerceptionV40Version(json: string | null | undefined): number {
  if (!json) return -1;
  try {
    const v = JSON.parse(json);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // 与 decode 同源:格式闸 = 带 dims 数组即 v2(完整性由 decode 内部校验)
      if (hasV2Shape(v as Record<string, unknown>)) return 2;
      return 0;
    }
    if (Array.isArray(v)) return 1;
    return -1;
  } catch {
    return -1;
  }
}

// ──────────────────────────────────────────────
// 2. 24D → 40D 映射（仅迁移/派生用，不碰 24D 侧）
// ──────────────────────────────────────────────

/**
 * 24D → 40D 语义映射表。
 * 🟢 = 当前由 24D 规则引擎派生（24D 有现成语义）
 * 🔵 = 留接口，依赖 P3 瑶灵/瑶光数据源（当前填 0）
 */
export const MAP_24_TO_40: ReadonlyArray<{ key24: keyof Perception24D; dim40: number; sector: string }> = [
  // ── 大类2 精神内核（🟢 部分派生）──
  { key24: 'self_ref',      dim40: 9,  sector: 'inner_spirit' },     // D09 自我认知
  { key24: 'pleasure',      dim40: 12, sector: 'inner_spirit' },     // D12 愉悦
  { key24: 'safety',        dim40: 14, sector: 'inner_spirit' },     // D14 个体自保
  // ── 大类3 圈层人际（🟢 部分派生）──
  { key24: 'intimacy',      dim40: 15, sector: 'social_bonds' },     // D15 伴侣依恋
  { key24: 'belonging',     dim40: 17, sector: 'social_bonds' },     // D17 家庭归属
  { key24: 'etiquette',     dim40: 19, sector: 'social_bonds' },     // D19 社交适配
  // ── 大类6 伴侣情感纹理（🟢 24D 直搬）──
  { key24: 'sexual_attraction', dim40: 33, sector: 'intimate_texture' },
  { key24: 'energy_merge',      dim40: 34, sector: 'intimate_texture' },
  { key24: 'sincerity',         dim40: 35, sector: 'intimate_texture' },
  { key24: 'dominance',         dim40: 36, sector: 'intimate_texture' },
  { key24: 'moral_judgment',    dim40: 37, sector: 'intimate_texture' },
  { key24: 'humor',             dim40: 38, sector: 'intimate_texture' },
  { key24: 'dependency',        dim40: 39, sector: 'intimate_texture' },
  { key24: 'possessiveness',    dim40: 40, sector: 'intimate_texture' },
];

/**
 * 将 Perception24D 映射为 PerceptionV40。
 * 🟢 维度从 24D 派生，🔵 维度（无 P3 数据源）填 0。
 * 用于：存量迁移初始填充 + 当前运行时派生（P3 前）。
 * 不修改 24D 输入对象。
 */
export function map24DTo40D(p24: Perception24D): PerceptionV40 {
  const p = createEmptyPerceptionV40();
  for (const { key24, dim40 } of MAP_24_TO_40) {
    p[PERCEPTION_40D_KEYS[dim40 - 1]] = p24[key24] ?? 0;
  }
  return p;
}

// ──────────────────────────────────────────────
// 3. 40D 向量计算（L2 范数 / 扇区加权余弦）
// ──────────────────────────────────────────────

/** 双极性维度（值域含负数）需映射到 [0,1] */
const BIPOLAR_40D = new Set([36, 37]); // D36 dominance, D37 moral_judgment

function normalize40D(v: number, dim: number): number {
  return BIPOLAR_40D.has(dim) ? (v + 1) / 2 : Math.max(0, Math.min(1, v));
}

/**
 * 将 40 元素数组转换为 PerceptionV40 对象（检索 queryVec40D 用）。
 * 长度不对或含非数字时返回 null。
 */
export function arrayToPerceptionV40(arr: number[]): PerceptionV40 | null {
  if (!Array.isArray(arr) || arr.length !== PERCEPTION_40D_DIM) return null;
  const p = createEmptyPerceptionV40();
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    const v = Number(arr[i]);
    if (!isFinite(v)) return null;
    p[PERCEPTION_40D_KEYS[i]] = v;
  }
  return p;
}

/** 40D 向量 L2 范数（值域 [0, sqrt(40)]） */
export function computeL2Norm40D(p: PerceptionV40): number {
  let sumSq = 0;
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    const v = p[PERCEPTION_40D_KEYS[i]];
    if (typeof v === 'number' && isFinite(v)) sumSq += v * v;
  }
  return Math.round(Math.sqrt(sumSq) * 100) / 100;
}

/** 将 PerceptionV40 转为 40 维 [0,1] 归一化数组 */
export function toNormalizedVector40D(p: PerceptionV40): Float64Array {
  const v = new Float64Array(PERCEPTION_40D_DIM);
  for (let i = 0; i < PERCEPTION_40D_DIM; i++) {
    v[i] = normalize40D(p[PERCEPTION_40D_KEYS[i]] ?? 0, i + 1);
  }
  return v;
}

/** 获取某维度所属扇区权重 */
function sectorWeightForDim(dim: number): number {
  if (dim >= 1 && dim <= 8) return PERCEPTION_40D_SECTOR_WEIGHTS.physical_body;
  if (dim >= 9 && dim <= 14) return PERCEPTION_40D_SECTOR_WEIGHTS.inner_spirit;
  if (dim >= 15 && dim <= 20) return PERCEPTION_40D_SECTOR_WEIGHTS.social_bonds;
  if (dim >= 21 && dim <= 26) return PERCEPTION_40D_SECTOR_WEIGHTS.spatiotemporal;
  if (dim >= 27 && dim <= 32) return PERCEPTION_40D_SECTOR_WEIGHTS.dynamic_growth;
  return PERCEPTION_40D_SECTOR_WEIGHTS.intimate_texture; // D33-D40
}

/**
 * 40D 扇区加权余弦相似度 ∈ [0, 1]。
 * 扇区权重来自 PERCEPTION_40D_SECTOR_WEIGHTS（P3 前肉身体验/时空/成长权重 0）。
 */
export function cosineSimilarity40D(a: PerceptionV40, b: PerceptionV40): number {
  const va = toNormalizedVector40D(a);
  const vb = toNormalizedVector40D(b);

  // 加权点积 + 范数（扇区权重）
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

/**
 * 情绪共振切片：只取伴侣纹理（D33-D40）+ 精神/人际可用维（D09-D20）
 * 用于情绪共振检索（40D 文档 §九：情绪共振只取 14D）。
 */
export function resonanceVector40D(p: PerceptionV40): Float64Array {
  const v = toNormalizedVector40D(p);
  // 切片：D09-D20（12D 精神+人际）+ D33-D40（8D 伴侣纹理）= 20D
  // 实际共振核心：伴侣纹理 8D + 愉悦/依恋 等
  const idx = [8, 11, 13, 14, 16, 18, 32, 33, 34, 35, 36, 37, 38, 39]; // D09,D12,D14,D15,D17,D19,D33-D40 = 14D
  const out = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = v[idx[i]];
  return out;
}
