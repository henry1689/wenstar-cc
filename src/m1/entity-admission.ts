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

// ════════════════════════════════════════════════════════════════════
// 确定性取证（2026-11-08 批2b / ADR-020 修订）
// ════════════════════════════════════════════════════════════════════
// 背景：模型对取证头协议的实测合规率 0/4（assembler 任务块 / 独立 system 消息 /
//   用户轮前缀三种注入方式全部无效）。合法新实体的准入不能依赖模型的格式服从性，
//   因此把「显式介绍」这一确定性信号作为**主准入来源**：
//   · 发现：extractIntroducedPersons —— 规则命中处就是证据，证据恒为原文连续子串；
//   · 校验：仍走 verifyAdmissions 同一道硬闸门（单一闸门，不新增第二套判据）；
//   · 给定名字找证据：findIntroEvidence —— FG 写入判据与发现侧共用它。

/** 介绍线索（单一真源）：介绍动词 + 社会角色 + 亲属称谓 */
export const INTRO_CUES: readonly string[] = [
  '叫', '名叫', '叫做', '自称', '介绍', '这是',
  '朋友', '同事', '同学', '老师', '医生', '先生', '女士',
  '老板', '领导', '客户', '下属', '部下', '合伙人', '邻居', '室友', '顾问', '秘书', '助理',
  '妈妈', '母亲', '爸爸', '父亲', '爷爷', '奶奶', '外公', '外婆',
  '哥哥', '弟弟', '姐姐', '妹妹', '阿姨', '叔叔', '舅舅', '姑姑',
  '老公', '老婆', '丈夫', '妻子', '儿子', '女儿',
];

/** 证据窗口半径：线索必须落在名字 ±10 字内（与批1 FG 闸门口径一致） */
const INTRO_WINDOW = 10;

/**
 * 给定名字，返回其「显式介绍」证据窗口原文；无证据返回 null。
 *
 * 遍历全部出现位置（原实现只查首次出现，首次无线索而后续有线索时会漏判）。
 * 返回的窗口是消息的连续子串，可直接作为 verifyAdmission 的证据。
 */
export function findIntroEvidence(text: string, name: string): string | null {
  const t = text ?? '';
  const n = (name ?? '').trim();
  if (!t || !n) return null;
  let from = 0;
  for (;;) {
    const idx = t.indexOf(n, from);
    if (idx < 0) return null;
    const win = t.slice(Math.max(0, idx - INTRO_WINDOW), Math.min(t.length, idx + n.length + INTRO_WINDOW));
    if (INTRO_CUES.some(c => win.includes(c))) return win;
    from = idx + n.length;
  }
}

/** 非人名/泛指词（结构判据：代词、指代、纯关系词不可能是一个人的名字） */
const NON_PERSON_WORDS = new Set([
  '我', '你', '您', '他', '她', '它', '我们', '你们', '他们', '她们', '大家', '有人', '某人', '自己',
  '什么', '这个', '那个', '这里', '那里', '现在', '今天', '明天', '昨天', '刚才', '那边', '这边',
  '朋友', '同事', '同学', '老师', '医生', '先生', '女士', '老板', '领导', '客户', '下属', '部下',
  '合伙人', '邻居', '室友', '顾问', '秘书', '助理',
  '妈妈', '爸爸', '父亲', '母亲', '儿子', '女儿', '孩子', '老婆', '老公', '丈夫', '妻子',
  '哥哥', '弟弟', '姐姐', '妹妹', '阿姨', '叔叔', '舅舅', '姑姑', '爷爷', '奶奶', '外公', '外婆',
]);

/** 名字的基本合法性（结构判据，不是词表枚举） */
function isLikelyPersonName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 4) return false;
  if (!/^[一-龥]+$/.test(name)) return false;
  if (NON_PERSON_WORDS.has(name)) return false;
  if ('他她它你您我'.includes(name[0])) return false;
  if (name.endsWith('们')) return false;
  return true;
}

/**
 * 发现侧规则：每条正则的 group 是被介绍的人名，整体匹配 m[0] 就是证据。
 * 顺序无依赖；同一名字只取首次命中。
 */
const INTRO_PATTERNS: ReadonlyArray<{ re: RegExp; group: number; whole?: boolean }> = [
  // 她叫林小雅 / 有个女孩叫诗雨（排除「我叫X」——那是说话人自述，不是新实体）
  { re: /(?<!我)(?:叫|名叫|叫做)([一-龥]{2,4})/g, group: 1 },
  // 林小雅是我的同事 / 老王是我朋友（关系词必须是已知称谓，防「今天是我的生日」）
  { re: /([一-龥]{2,3})是我的?([一-龥]{2,4})/g, group: 1 },
  // 这是我同事罗珍思
  { re: /这是(?:我的?)?(?:朋友|同事|同学|老师|老板|领导|客户|下属|部下|合伙人|邻居|医生|先生|女士|室友)([一-龥]{2,4})/g, group: 1 },
  // 张老师 / 李医生 / 王阿姨（姓氏+称谓，整段即名字）
  { re: /([一-龥])(?:老师|医生|先生|女士|阿姨|叔叔|师傅)/g, group: 0, whole: true },
];

/** 关系词（用于校验「X 是我的 Y」中的 Y 确实是称谓） */
const RELATION_CUES = new Set(INTRO_CUES.filter(c => c.length >= 2 || c === '叫'));

/**
 * 从用户消息中提取**被显式介绍的人**（确定性，零 LLM）。
 * evidence 一律取正则整体匹配 m[0] —— 由构造保证是消息的连续子串。
 */
export function extractIntroducedPersons(text: string): RawEntity[] {
  const t = text ?? '';
  if (!t) return [];
  const out: RawEntity[] = [];
  const seen = new Set<string>();
  for (const p of INTRO_PATTERNS) {
    // 第三条规则要额外确认第二组是称谓词
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(t)) !== null) {
      let name: string;
      if (p.whole) {
        name = m[0];
      } else {
        name = m[p.group] ?? '';
        // 「X 是我的 Y」：Y 必须是称谓，否则是普通句子（今天是我的生日）
        if (p.re.source.includes('是我的') && !RELATION_CUES.has(m[2] ?? '')) continue;
      }
      name = name.trim();
      if (!name || seen.has(name) || !isLikelyPersonName(name)) continue;
      seen.add(name);
      out.push({ name, type: 'person', evidence: m[0].trim() });
    }
  }
  return out;
}

/** 确定性准入：发现 → 同一道硬闸门校验 */
export function admitDeterministic(text: string): EntityAdmission[] {
  return verifyAdmissions(extractIntroducedPersons(text), text ?? '');
}

/** 主回复取证头的准入结果（正文 + 准入/拒绝统计） */
export interface ReplyAdmission {
  body: string;
  present: boolean;
  malformed: number;
  admitted: EntityAdmission[];
  rejected: number;
}

/**
 * 解析并校验主回复头块 —— chat.ts 的唯一调用口。
 * 无头 / 解析失败 ⇒ present=false、正文原样返回（绝不阻断回复）。
 */
export function admitModelFromReply(reply: string, message: string): ReplyAdmission {
  const parsed = parseEntityEvidence(reply ?? '');
  if (!parsed.present) return { body: reply ?? '', present: false, malformed: 0, admitted: [], rejected: 0 };
  const all = verifyAdmissions(parsed.entities, message ?? '');
  const admitted = all.filter(a => a.admitted);
  return { body: parsed.body, present: true, malformed: parsed.malformed, admitted, rejected: all.length - admitted.length };
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
