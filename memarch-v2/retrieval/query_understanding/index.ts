// =====================================================================
// MemArch-v2.0.0 / M4-Retrieval / query_understanding / index.ts
// 输入：原始 query 字符串
// 输出：QueryContext（40D 向量 + p_A + 实体 + 时间窗 + 意图）
//
// 40D 向量分段（设计文档 §1.3 perception_40d）：
//   [0,10)   语义哈希投影（token 二元组→10 维，L2 归一化）
//   [10,20)  实体共现哈希
//   [20,30)  情绪维度（arousal/valence/dominance 关键词触发）
//   [30,40)  时间/场景特征
//
// 注：真正的语义 embedding 由 M3 Step7_ExtractSemantic 异步写入
//     vec_mem_semantic；本模块在 vec0 未接入前用本地哈希投影占位，
//     保证管线可跑通。TODO(embed): 接入 bge-small-zh 后替换本段。
// =====================================================================

import type { QueryContext, TimeRange } from '../types';

const VEC_DIM = 40;

/** FNV-1a 32bit 哈希（确定性，零依赖） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

/** 简单 token 化：英文按单词，中文按二元 bigram */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  // 英文/数字词
  const en = lower.match(/[a-z0-9_]+/g);
  if (en) out.push(...en);
  // 中文 bigram
  const zh = lower.match(/[\u4e00-\u9fa5]/g);
  if (zh) {
    for (let i = 0; i < zh.length - 1; i++) out.push(zh[i] + zh[i + 1]);
  }
  return out;
}

/** 情绪关键词表（arousal / valence / dominance 三维，各 3 维展开到 10 维） */
const EMOTION_LEX: Array<{ kw: RegExp; arousal: number; valence: number; dominance: number }> = [
  { kw: /(生气|愤怒|讨厌|烦|焦虑|紧张|害怕|担心)/, arousal: 0.8, valence: -0.7, dominance: -0.3 },
  { kw: /(开心|高兴|兴奋|喜欢|爱|愉快|爽|哈哈)/, arousal: 0.6, valence: 0.8, dominance: 0.4 },
  { kw: /(难过|悲伤|失落|委屈|哭|孤独)/, arousal: -0.5, valence: -0.8, dominance: -0.5 },
  { kw: /(平静|放松|无聊|发呆|无所谓)/, arousal: -0.3, valence: 0.0, dominance: 0.1 },
  { kw: /(好奇|疑问|为什么|怎么|如何|究竟)/, arousal: 0.2, valence: 0.1, dominance: 0.2 },
  { kw: /(重要|关键|必须|记得|千万|一定)/, arousal: 0.4, valence: 0.1, dominance: 0.7 },
];

/** 实体抽取：中文括号内容、英文大写专有词、引号内容 */
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const paren = text.match(/[（(]([^（）()]{2,20})[）)]/g);
  if (paren) for (const m of paren) out.add(m.slice(1, -1).trim());
  const quote = text.match(/["「『]([^"」』]{2,20})["」』]/g);
  if (quote) for (const m of quote) out.add(m.slice(1, -1).trim());
  const proper = text.match(/[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]+)*/g);
  if (proper) for (const m of proper) out.add(m.trim());
  return Array.from(out).slice(0, 8);
}

/** 时间词解析：相对时间 → recent_days；绝对时间窗返回 null（调用方按需） */
function parseTimeRange(text: string, now: number): TimeRange {
  const r: TimeRange = { recent_days: null, abs_start: null, abs_end: null };
  const DAY = 24 * 3600 * 1000;
  // 中文数字映射
  const cnNum: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const mN = text.match(/(最近|近|过去)\s*(\d+|[一二两三四五六七八九十])\s*(天|日|周|星期|个月)/);
  if (mN) {
    const rawN = mN[2];
    const n = /^\d+$/.test(rawN) ? parseInt(rawN, 10) : (cnNum[rawN] || 1);
    const unit = mN[3];
    const days = unit.startsWith('周') || unit.startsWith('星期') ? n * 7
      : unit.startsWith('个月') ? n * 30
      : n;
    r.recent_days = days;
    r.abs_start = now - days * DAY;
    r.abs_end = now;
    return r;
  }
  if (/昨天/.test(text)) { r.recent_days = 1; r.abs_start = now - 1 * DAY; r.abs_end = now; return r; }
  if (/前天/.test(text)) { r.recent_days = 2; r.abs_start = now - 2 * DAY; r.abs_end = now; return r; }
  if (/上周/.test(text)) { r.recent_days = 14; r.abs_start = now - 14 * DAY; r.abs_end = now; return r; }
  if (/上个月/.test(text)) { r.recent_days = 60; r.abs_start = now - 60 * DAY; r.abs_end = now; return r; }
  if (/刚才|刚刚|几分钟/.test(text)) { r.recent_days = 0.5; r.abs_start = now - 12 * 3600 * 1000; r.abs_end = now; return r; }
  return r;
}

/** 意图识别（前瞻召回用） */
function detectIntent(text: string): string {
  if (/\?|？/.test(text)) return 'question';
  if (/记得|回忆|上次|之前|刚才|昨天/.test(text)) return 'recall';
  if (/提醒|明天|待办|计划|要记得/.test(text)) return 'prospective';
  if (/为什么|原因|怎么搞|怎么回事/.test(text)) return 'causal';
  if (/总结|概括|综述/.test(text)) return 'summary';
  return 'chitchat';
}

/** p_A 重要性概率：高=用户在追问高价值记忆，低=日常闲聊 */
function estimateImportance(text: string): number {
  let p = 0.3;
  if (/记得|上次|之前|为什么|如何|怎么|关键|重要|必须|千万|一定/.test(text)) p += 0.25;
  if (/\?|？/.test(text)) p += 0.15;
  if (/哈哈|呵呵|嗯|哦|好的|行|可以/.test(text)) p -= 0.2;
  if (text.length >= 30) p += 0.1; // 长查询更可能是严肃检索
  if (text.length < 8) p -= 0.1;
  return Math.max(0, Math.min(1, p));
}

/**
 * 主入口：把原始 query 解析为 QueryContext。
 * 纯同步函数（better-sqlite3 同步语义一致），延迟预算 ≤ 50ms。
 */
export function understandQuery(raw: string, namespace: string, now: number = Date.now()): QueryContext {
  // 🔴 namespace 为必填、无默认值：隔离边界不允许"忘了传就落默认"的隐式约定。
  //   此前默认全部落在 views 的 'default' 分支，导致按角色分 ns 写入的数据一条都召回不到。
  if (!namespace) throw new Error('[understandQuery] namespace 必填（隔离边界不可为空）');
  const vec = new Array<number>(VEC_DIM).fill(0);

  // [0,10) 语义哈希投影
  const toks = tokenize(raw);
  for (const t of toks) {
    const h = fnv1a(t) % 10;
    vec[h] += 1;
  }
  // [10,20) 实体哈希
  const entities = extractEntities(raw);
  for (const e of entities) {
    const h = fnv1a(e) % 10;
    vec[10 + h] += 1.5;
  }
  // [20,30) 情绪维度：命中的 lex 累加
  const emoSlice = new Array<number>(10).fill(0);
  for (const { kw, arousal, valence, dominance } of EMOTION_LEX) {
    if (kw.test(raw)) {
      emoSlice[0] += arousal;
      emoSlice[1] += valence;
      emoSlice[2] += dominance;
      // 扩展到 10 维（arousal×valence 组合）
      emoSlice[3] += arousal * valence;
      emoSlice[4] += arousal * dominance;
      emoSlice[5] += valence * dominance;
      emoSlice[6] += Math.abs(arousal);
      emoSlice[7] += Math.abs(valence);
      emoSlice[8] += Math.abs(dominance);
      emoSlice[9] += 1;
    }
  }
  for (let i = 0; i < 10; i++) vec[20 + i] = emoSlice[i];

  // [30,40) 时间/场景特征
  const tr = parseTimeRange(raw, now);
  if (tr.recent_days != null) {
    vec[30] = tr.recent_days;
    vec[31] = tr.recent_days <= 2 ? 1 : 0; // 近期
    vec[32] = tr.recent_days >= 14 ? 1 : 0; // 远期
  }
  if (/记得|回忆|上次/.test(raw)) vec[33] = 1;
  if (/计划|明天|提醒/.test(raw)) vec[34] = 1;

  // L2 归一化整个 40D（向量召回路使用）
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VEC_DIM; i++) vec[i] /= norm;

  const p_A = estimateImportance(raw);
  const intent = detectIntent(raw);

  return {
    namespace,
    raw_query: raw,
    vec40: vec,
    p_A,
    entities,
    emotion_vec: vec.slice(20, 30),
    time_range: tr,
    intent,
  };
}
