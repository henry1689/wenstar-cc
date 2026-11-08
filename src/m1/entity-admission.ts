/**
 * entity-admission — 实体取证准入（批2，ADR-020）
 *
 * 背景：2026-11-07 批1 只做「止源」（物理删除滑窗生成器等 5 类旁路），
 *   合法新实体随之进不来。本批把「取证」并入**主回复调用**：模型在正文前输出
 *   `entity: 名称|类型|证据原文` 头块，代码侧以「证据必须是用户消息的连续子串」
 *   作为唯一反幻觉硬闸门（`verifyAdmission`）。
 *
 * 设计原则（与方案 §4.2 一致）：
 *   · **字段边界而非正则枚举**：逐行认 `entity:` 前缀，只扫正文开始前的头部；
 *   · 解析失败 / 模型不遵守协议 → **零实体，不阻断回复**；
 *   · 正文疑似纯 JSON → 整体跳过（V45 事故：剥离器把 JSON 削成 "[{"）；
 *   · 头部绝不进用户视野：流式用 `EvidenceHeaderGate` 逐块丢弃，非流式返回前剥离。
 *
 * 单一真源：分隔行复用 `outputGuard.HEADER_SEPARATORS`，不在此另造一套。
 */
import { looksLikeRawJson, HEADER_SEPARATORS } from '../common/utils/output-header.js';

/** 头块字段名（单一真源） */
export const ENTITY_EVIDENCE_KEY = 'entity';
/** 只扫描正文开始前的连续行（超出即视为正文，防正文里的 entity: 被误判） */
export const ENTITY_EVIDENCE_MAX_HEADER_LINES = 12;
/** 流式头的字符上限 —— 超限仍未见分隔行则放弃剥离（宁可漏剥头，不可吞正文） */
export const ENTITY_EVIDENCE_MAX_HEADER_CHARS = 800;

/** 追加到系统提示末尾的固定指令（唯一副本） */
export const ENTITY_EVIDENCE_INSTRUCTION = [
  '【实体取证】',
  '在正文之前，先输出本消息中被显式引入的实体，每条一行，格式：',
  'entity: 名称|类型|证据原文',
  '',
  '规则：',
  '1. 证据原文必须逐字复制用户消息中的连续片段，不得改写、不得拼接、不得概括；',
  '2. 只记录被明确介绍或指名的实体（"她叫X""这是我同事X""X老师"）；',
  '3. 未指明具体名称的称谓（"我朋友""一个医生"）不输出；',
  '4. 类型仅限 person / emotion / event / place / org；',
  '5. 无实体则整块省略；',
  '6. 最后输出分隔行 ---，然后开始正常回复。',
].join('\n');

export type EntityType = 'person' | 'emotion' | 'event' | 'place' | 'org';
const ENTITY_TYPES: readonly EntityType[] = ['person', 'emotion', 'event', 'place', 'org'];

export interface RawEntity {
  name: string;
  type: string;
  evidence: string;
}

export type RejectReason = 'empty' | 'length' | 'evidence_not_in_message' | 'name_not_in_evidence';

export interface EntityAdmission extends RawEntity {
  admitted: boolean;
  rejectReason?: RejectReason;
}

export interface ParsedEvidence {
  /** 头块声明的原始实体（未校验） */
  entities: RawEntity[];
  /** 已剥离头块的正文 */
  body: string;
  /** 是否识别到取证头 */
  present: boolean;
  /** 格式不合规的 entity 行数（协议质量指标） */
  malformed: number;
}

/** 该行是否以 `entity:` / `entity：` 开头，并返回其值部分 */
function entityLineValue(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower.startsWith(ENTITY_EVIDENCE_KEY + ':')) return t.slice(ENTITY_EVIDENCE_KEY.length + 1).trim();
  if (lower.startsWith(ENTITY_EVIDENCE_KEY + '：')) return t.slice(ENTITY_EVIDENCE_KEY.length + 1).trim();
  return null;
}

function isSeparator(line: string): boolean {
  return HEADER_SEPARATORS.some(sep => line.trim() === sep);
}

/**
 * 解析回复开头的取证头。
 * 🔴 只在「正文开始前」的连续行内识别；正文里出现 `entity:` 不会被误判。
 */
export function parseEntityEvidence(text: string): ParsedEvidence {
  const raw = text ?? '';
  if (!raw || looksLikeRawJson(raw)) return { entities: [], body: raw, present: false, malformed: 0 };

  const lines = raw.split('\n');
  const entities: RawEntity[] = [];
  let malformed = 0;
  let i = 0;
  // 跳过开头空行（模型常在头前留空行）
  while (i < lines.length && lines[i].trim() === '') i++;
  const start = i;

  // 首行必须是 entity: 才认定为头 —— 否则整份按正文处理（零实体）
  if (i >= lines.length || entityLineValue(lines[i]) === null) {
    return { entities: [], body: raw, present: false, malformed: 0 };
  }

  let bodyStart = -1;
  for (; i < lines.length && i < start + ENTITY_EVIDENCE_MAX_HEADER_LINES; i++) {
    const line = lines[i];
    if (isSeparator(line)) { bodyStart = i + 1; break; }
    const v = entityLineValue(line);
    if (v === null) {
      // 无分隔行但头的下一行已是非 entity 行 ⇒ 视为正文开始（宽容处理，头仍然剥离）
      bodyStart = i;
      break;
    }
    if (!v) { malformed++; continue; }
    const parts = v.split('|').map(s => s.trim());
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) { malformed++; continue; }
    entities.push({ name: parts[0], type: parts[1].toLowerCase(), evidence: parts.slice(2).join('|').trim() });
  }

  if (bodyStart < 0) {
    // 头在 12 行内既没遇到分隔行也没遇到正文 ⇒ 视为没有完整头，按正文处理（不吞内容）
    return { entities: [], body: raw, present: false, malformed: 0 };
  }

  return { entities, body: lines.slice(bodyStart).join('\n'), present: true, malformed };
}

/**
 * 代码侧准入校验 —— **唯一硬闸门**：证据必须是用户消息的连续子串。
 * LLM 可以编名字，但编不出原文里不存在的片段。
 */
export function verifyAdmission(raw: RawEntity, message: string): EntityAdmission {
  const name = String(raw.name ?? '').trim();
  const evidence = String(raw.evidence ?? '').trim();
  const type = String(raw.type ?? '').trim().toLowerCase();
  const base: RawEntity = { name, type, evidence };
  if (!name) return { ...base, admitted: false, rejectReason: 'empty' };
  if (name.length < 2 || name.length > 12) return { ...base, admitted: false, rejectReason: 'length' };
  if (!(message || '').includes(evidence)) return { ...base, admitted: false, rejectReason: 'evidence_not_in_message' };
  if (!evidence.includes(name)) return { ...base, admitted: false, rejectReason: 'name_not_in_evidence' };
  return { ...base, admitted: true };
}

/** 批量校验 + 类型收敛（未知类型保留但标记，交给上层决定是否入库） */
export function verifyAdmissions(entities: RawEntity[], message: string): EntityAdmission[] {
  return entities.map(e => {
    const v = verifyAdmission(e, message);
    if (v.admitted && !ENTITY_TYPES.includes(v.type as EntityType)) {
      // 类型不在协议枚举内 ⇒ 不入 person 通道（防未知类型混入 FG）
      return { ...v, admitted: false, rejectReason: 'empty' as RejectReason, type: v.type };
    }
    return v;
  });
}

/** 协议质量计数（零依赖、进程内累计；供日志/运维观察协议缺失率） */
export const admissionStats = {
  turns: 0,
  headerPresent: 0,
  protocolMiss: 0,
  malformedLines: 0,
  admitted: 0,
  rejected: 0,
};
export function recordAdmissionTurn(present: boolean, malformed: number, admitted: number, rejected: number): void {
  admissionStats.turns++;
  if (present) admissionStats.headerPresent++; else admissionStats.protocolMiss++;
  admissionStats.malformedLines += malformed;
  admissionStats.admitted += admitted;
  admissionStats.rejected += rejected;
}

/**
 * 流式取证头闸门 —— 保证头块不进 SSE / TTS。
 *
 * 状态机：
 *   undecided：缓冲中，直到能判定「首行是不是 entity:」
 *   body     ：已判定无头，逐块放行
 *   header   ：丢弃头行，遇到分隔行后切换到 body
 *
 * 失败安全：缓冲超过字符上限 / 头模式下行内容异常 ⇒ 放弃剥离，原样放行（宁可露出头，不吞正文）。
 */
export class EvidenceHeaderGate {
  private buf = '';
  private mode: 'undecided' | 'body' | 'header' = 'undecided';

  /** 喂入增量，返回**可安全展示**的文本（可能为空串） */
  push(delta: string): string {
    if (!delta) return '';
    if (this.mode === 'body') return delta;

    this.buf += delta;

    if (this.mode === 'undecided') {
      const t = this.buf.replace(/^\s+/, '');
      if (!t) return '';
      // 纯 JSON ⇒ 不剥头（V45）
      if (looksLikeRawJson(t)) { this.mode = 'body'; const out = this.buf; this.buf = ''; return out; }
      // 需要首行完整才能判定
      const nl = t.indexOf('\n');
      if (nl < 0) {
        if (t.length > 64) { this.mode = 'body'; const out = this.buf; this.buf = ''; return out; }
        return '';
      }
      const first = t.slice(0, nl);
      if (entityLineValue(first) === null) { this.mode = 'body'; const out = this.buf; this.buf = ''; return out; }
      this.mode = 'header';
      // 继续走 header 处理（不 return，fallthrough 到下方逻辑）
    }

    // header 模式：逐行检查
    let out = '';
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) {
        if (this.buf.length > ENTITY_EVIDENCE_MAX_HEADER_CHARS) {
          // 放弃剥离：头没写完却超限 —— 原样放行，避免吞正文
          out += this.buf; this.buf = ''; this.mode = 'body';
        }
        break;
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (isSeparator(line)) { this.mode = 'body'; break; }
      if (entityLineValue(line) === null) {
        // 头区出现非 entity 行且无分隔行 ⇒ 认定正文从此开始（该行属于正文）
        out += line + '\n' + this.buf; this.buf = ''; this.mode = 'body';
        break;
      }
      // entity 行：丢弃
    }
    if (this.mode === 'body' && this.buf) { out += this.buf; this.buf = ''; }
    return out;
  }

  /** 流结束时冲刷（未判定的缓冲原样放行） */
  flush(): string {
    const out = this.buf;
    this.buf = '';
    if (this.mode !== 'body') this.mode = 'body';
    return out;
  }
}
