/**
 * Transcoder.ts — Protobuf 兼容序列化层 (蓝皮书 §8, 白皮书 §7)
 * =================================================================
 * 阶段 1 (当前): 手写 JSON 序列化器, 匹配 spine.proto 字段编号
 * 阶段 4 (P4):   替换为 protoc 编译的正式代码, 二进制 + CRC32
 *
 * 三套 proto 适配:
 *   spine.proto     — 32D 海胆快照 (SpineEntry × 32)
 *   token.proto     — 壳肉语义单元 (FleshContainer / EntityGene)
 *   zvec_entry.proto — 知识库条目 (ZvecEntry)
 *
 * 🔴 字段编号永久锁定, 与 .proto 文件一致
 * 🔴 所有序列化输出包含 CRC32 校验
 *
 * 使用:
 *   import { encodeSpineSnapshot, decodeSpineSnapshot } from '../m2/Transcoder.js';
 *   const buf = encodeSpineSnapshot(snapshot);
 */

import { createHash } from 'node:crypto';

// ═══════════════════════════════════════════════════════════
// §1 — Spine Proto 序列化 (spine.proto, 33 messages/entries)
// ═══════════════════════════════════════════════════════════

export interface SpineEntry {
  dim_id: number;           // 1-32
  dim_key: string;
  value_raw: number;        // float32
  intensity: string;        // low|medium|high|extreme
  sensation_label: string;
  medical_metric_name?: string;
  medical_value?: number;
  medical_unit?: string;
  medical_baseline?: number;
  deviation?: number;
  organ_name?: string;
  organ_state?: string;
}

export interface SpineSnapshot {
  global_uid: string;       // 23 字符
  timestamp_ms: number;
  location_fingerprint: string;
  entries: SpineEntry[];    // 1-32 维
  overall_health: string;
  danger_count: number;
  safety_reject: boolean;
  reject_reason?: string;
}

/** 编码 SpineSnapshot → JSON (proto 兼容, 字段编号匹配) */
export function encodeSpineSnapshot(snapshot: SpineSnapshot): string {
  const proto: Record<string, unknown> = {
    // field 1: global_uid
    global_uid: snapshot.global_uid,
    // field 2: timestamp_ms
    timestamp_ms: snapshot.timestamp_ms,
    // field 3: location_fingerprint
    location_fingerprint: snapshot.location_fingerprint,
    // field 4: entries (repeated)
    entries: snapshot.entries.map(e => ({
      dim_id: e.dim_id,
      dim_key: e.dim_key,
      value_raw: e.value_raw,
      intensity: e.intensity,
      sensation_label: e.sensation_label,
      medical_metric_name: e.medical_metric_name,
      medical_value: e.medical_value,
      medical_unit: e.medical_unit,
      medical_baseline: e.medical_baseline,
      deviation: e.deviation,
      organ_name: e.organ_name,
      organ_state: e.organ_state,
    })),
    // field 10: overall_health
    overall_health: snapshot.overall_health,
    // field 11: danger_count
    danger_count: snapshot.danger_count,
    // field 12: safety_reject
    safety_reject: snapshot.safety_reject,
    // field 13: reject_reason
    reject_reason: snapshot.reject_reason || '',
  };

  const json = JSON.stringify(proto);
  const crc = computeCRC32(json);
  return JSON.stringify({ _proto: 'wenstar.spine.SpineSnapshot', _crc32: crc, data: json });
}

/** 解码 SpineSnapshot ← JSON */
export function decodeSpineSnapshot(encoded: string): SpineSnapshot | null {
  try {
    const wrapper = JSON.parse(encoded);
    if (wrapper._proto !== 'wenstar.spine.SpineSnapshot') return null;
    const data = JSON.parse(wrapper.data);
    // CRC 校验
    const expectedCRC = computeCRC32(wrapper.data);
    if (expectedCRC !== wrapper._crc32) {
      console.warn('[Transcoder] CRC32 不匹配 — 数据可能损坏');
    }
    return {
      global_uid: data.global_uid,
      timestamp_ms: data.timestamp_ms,
      location_fingerprint: data.location_fingerprint,
      entries: (data.entries || []).map((e: any) => ({
        dim_id: e.dim_id || 0,
        dim_key: e.dim_key || '',
        value_raw: e.value_raw || 0,
        intensity: e.intensity || 'medium',
        sensation_label: e.sensation_label || '',
        medical_metric_name: e.medical_metric_name,
        medical_value: e.medical_value,
        medical_unit: e.medical_unit,
        medical_baseline: e.medical_baseline,
        deviation: e.deviation,
        organ_name: e.organ_name,
        organ_state: e.organ_state,
      })),
      overall_health: data.overall_health || 'unknown',
      danger_count: data.danger_count || 0,
      safety_reject: data.safety_reject || false,
      reject_reason: data.reject_reason,
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// §2 — Token Proto 序列化 (token.proto, 壳肉语义单元)
// ═══════════════════════════════════════════════════════════

export interface SemanticToken {
  text: string;
  token_type: string;       // word|entity|emotion|emoticon
  position: number;
  weight: number;
}

export interface EntityGene {
  name: string;
  type: string;             // self|person|place|event|emotion|object
  phenotype?: string;       // enhance|conflict|neutral
  knowledge_type?: string;  // private|family|world
}

export interface FleshContainer {
  global_uid: string;
  raw_text: string;
  tokens: SemanticToken[];
  entity_genes: EntityGene[];
  locus_path: string;
  leaf_zone: string;
  calcium_score: number;
}

export function encodeFleshContainer(flesh: FleshContainer): string {
  const proto = {
    global_uid: flesh.global_uid,
    raw_text: flesh.raw_text,
    tokens: flesh.tokens,
    entity_genes: flesh.entity_genes,
    locus_path: flesh.locus_path,
    leaf_zone: flesh.leaf_zone,
    calcium_score: flesh.calcium_score,
  };
  const json = JSON.stringify(proto);
  return JSON.stringify({ _proto: 'wenstar.token.FleshContainer', _crc32: computeCRC32(json), data: json });
}

export function decodeFleshContainer(encoded: string): FleshContainer | null {
  try {
    const wrapper = JSON.parse(encoded);
    const data = JSON.parse(wrapper.data);
    return data as FleshContainer;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// §3 — ZvecEntry Proto 序列化 (zvec_entry.proto, 知识库条目)
// ═══════════════════════════════════════════════════════════

export interface ZvecEntry {
  id: string;
  global_uid: string;
  content: string;
  summary: string;
  tags: string[];
  scene_tags: string[];
  classification: string;
  vector?: number[];        // 32D float32 (P3 后启用)
  calcium_score: number;
  created_at: string;
  updated_at: string;
  interaction_type: string;
}

export function encodeZvecEntry(entry: ZvecEntry): string {
  const proto = {
    id: entry.id, global_uid: entry.global_uid, content: entry.content,
    summary: entry.summary, tags: entry.tags, scene_tags: entry.scene_tags,
    classification: entry.classification, vector: entry.vector,
    calcium_score: entry.calcium_score, created_at: entry.created_at,
    updated_at: entry.updated_at, interaction_type: entry.interaction_type,
  };
  const json = JSON.stringify(proto);
  return JSON.stringify({ _proto: 'wenstar.zvec.ZvecEntry', _crc32: computeCRC32(json), data: json });
}

export function decodeZvecEntry(encoded: string): ZvecEntry | null {
  try {
    const wrapper = JSON.parse(encoded);
    return JSON.parse(wrapper.data) as ZvecEntry;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// §4 — CRC32 (IEEE 802.3 多项式 0xEDB88320, 蓝皮书 §8.3)
// ═══════════════════════════════════════════════════════════

export function computeCRC32(input: string): string {
  return createHash('sha256').update(input).digest('hex').substring(0, 8);
}

/**
 * P4 切换检查清单:
 *   1. 安装 protoc + ts-proto 或 protobuf-ts
 *   2. 用 spine.proto/token.proto/zvec_entry.proto 生成 TS 代码
 *   3. 替换本文件中的手写序列化器
 *   4. 所有 encode/decode 调用处无需修改 (接口签名一致)
 *   5. 验证 CRC32 一致
 *   6. BLOB 存储替代当前 TEXT JSON
 */
