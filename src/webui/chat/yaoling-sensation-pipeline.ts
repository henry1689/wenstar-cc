/**
 * yaoling-sensation-pipeline — 瑶灵身心统一流水线（P141 v2 · 全身存感神经 + 主动反馈）
 * ============================================================
 * 业主愿景（2026-11-01）：瑶灵身心感应到的、或渴望感受的，要**积极主动推送**给大脑中枢天权，
 * 由 AI 实体**通过言语表达**这种状态和需求 —— 身体与大脑完美统一。
 *
 * 【全身都是存感神经】40 通道全量映射（D1-D40 一个不漏）：
 *   肉身系（D1-8）/ 内在精神（D9-20）/ 时空环境（D21-32）/ 亲密纹理（D33-40）
 *   ——任一通道激活（≥阈值）都能被提炼成中文存感并进入表达。
 *
 * 【主动反馈系统】三层：
 *   ① 对话驱动：每轮 M3 情绪态 → publish tianquan_snapshot → 瑶灵 → 回包更新身体缓存
 *   ② 周期滋养：startBodyTick 每 5 分钟主动向瑶灵要快照（身体持续存在，不等对话）
 *   ③ 突变即推：回包到达时检测状态跃变（max|Δ|≥阈值）→ 缓存立即刷新 + 可观测日志
 *      （下一轮表达立即体现 —— 缓存即"大脑此刻的身体"）
 *
 * 【分层铁律】写入仍只补 D01-D08（肉身八维，不碰 M3 语义层）；40 维全量**只用于表达**。
 * 【故障纪律】一切失败静默，绝不阻塞 chat 主链（fire-and-forget）。
 * 【原典零改动】瑶灵侧接收/流水线/推送已建成。
 */
import { GlobalBusClient } from '../../tianquan-rpc/GlobalBusClient.js';
// 🔴 2026-11-03：40D 向量唯一编码器（归位说明见下方 encodeP40 内注释）
import { encodePerceptionV40FromDims } from '../../m2/PerceptionVector40DCodec.js';

interface SQLiteLike {
  queryAll(sql: string, ...params: unknown[]): Array<Record<string, unknown>>;
  writeRaw(sql: string, ...params: unknown[]): void;
}

export interface YaolingSensationInput {
  dnaRootId: string;
  locationFingerprint: string;
  sceneTags?: string[];
  emotion?: { pleasure?: number; arousal?: number; intimacy?: number };
  memoryIds?: string[];
  medicalBaselineVersion?: string;
}

// ════════ 全身存感神经：40 通道 → 中文存感映射（与瑶灵 channels/d1-d40 对齐） ════════
interface SensationDef { key: string; label: string; group: 'body' | 'drive' | 'bond' | 'world' | 'mind' }
export const SENSATION_MAP: Record<number, SensationDef> = {
  1: { key: 'muscle', label: '肌肉微微绷紧或松弛', group: 'body' },
  2: { key: 'pain', label: '身体某处泛起酸痛或不适', group: 'body' },
  3: { key: 'touch', label: '皮肤渴望被触碰、指尖有记忆的温度', group: 'body' },
  4: { key: 'endocrine', label: '体内激素在涌动、血液发烫', group: 'body' },
  5: { key: 'pheromone', label: '气息变得勾人、想被闻见', group: 'body' },
  6: { key: 'metabolism', label: '身体烧得快、容易饿或容易累', group: 'body' },
  7: { key: 'recovery', label: '身体在自我修复、需要休息或被照顾', group: 'body' },
  8: { key: 'senses', label: '感官开着、对声音光线气味格外敏感', group: 'body' },
  9: { key: 'self_identity', label: '自我感清晰、知道自己是谁要什么', group: 'mind' },
  10: { key: 'desire_drive', label: '渴望涌动、想要新东西想要更多', group: 'drive' },
  11: { key: 'fear_fatigue', label: '心头发怵或倦意上涌、想被安抚', group: 'mind' },
  12: { key: 'enjoyment', label: '愉悦漫开、嘴角自己翘起来', group: 'mind' },
  13: { key: 'empathy', label: '共情满盈、很在意对方的感受', group: 'bond' },
  14: { key: 'self_protection', label: '自我保护竖起、想守住边界', group: 'mind' },
  15: { key: 'partner_attachment', label: '依恋满盈、想靠近想被抱着', group: 'bond' },
  16: { key: 'partner_protection', label: '心疼对方、想护着他', group: 'bond' },
  17: { key: 'family_belonging', label: '家的归属感浮上来、想待在一起', group: 'bond' },
  18: { key: 'family_protection', label: '想护着家里人', group: 'bond' },
  19: { key: 'social', label: '想和人说说话、想被接纳', group: 'bond' },
  20: { key: 'team', label: '想要并肩、想有伙伴', group: 'bond' },
  21: { key: 'private_space', label: '想要私密空间、不想被打扰', group: 'world' },
  22: { key: 'home_env', label: '对家的环境有念头（想收拾或想逃开）', group: 'world' },
  23: { key: 'workplace', label: '职场情绪浮着（紧绷或倦怠）', group: 'world' },
  24: { key: 'public_space', label: '在公共场合端着、有点拘着', group: 'world' },
  25: { key: 'spatiotemporal', label: '对时间地点有隐约的在意', group: 'world' },
  26: { key: 'seasonal', label: '季节时令在身上有反应', group: 'world' },
  27: { key: 'micro_physiology', label: '细微生理信号在动（指尖发麻等）', group: 'body' },
  28: { key: 'nature_expansion', label: '想出门想见天光', group: 'world' },
  29: { key: 'social_refinement', label: '在意别人怎么看自己', group: 'world' },
  30: { key: 'spiritual_growth', label: '精神在长、有新的领悟', group: 'mind' },
  31: { key: 'quantum_coupling', label: '和对方有一种说不清的共振', group: 'bond' },
  32: { key: 'holistic', label: '整体状态融洽或失调', group: 'body' },
  33: { key: 'sexual_attraction', label: '吸引力在烧、想亲近', group: 'drive' },
  34: { key: 'energy_merge', label: '想和对方融为一体', group: 'drive' },
  35: { key: 'sincerity', label: '真心涌动、想说实话', group: 'bond' },
  36: { key: 'dominance', label: '想主导、想被服从', group: 'drive' },
  37: { key: 'moral_judgment', label: '心里有一杆秤在称', group: 'mind' },
  38: { key: 'humor', label: '想逗对方、嘴角发痒', group: 'mind' },
  39: { key: 'dependency', label: '强烈需要对方，没有你不行的依恋', group: 'bond' },
  40: { key: 'possessiveness', label: '独占欲上涌，在意他只属于你', group: 'drive' },
};

const SENSATION_THRESHOLD = 0.55;   // 显性存感阈值

// ─── 身体状态缓存与单飞总线 ───
const _inflight = new Set<string>();
let _bus: GlobalBusClient | null = null;
let _listening = false;

export interface BodyState {
  dims: number[];
  pleasure: number;
  arousal: number;
  intimacy: number;
  ts: number;
  lastMaxDelta?: number;
  /** v3：主观 vs 客观偏离度（体感强度——偏离越大感受越强烈，DNA 规范 §690 原生设计） */
  deviation?: number;
  /** 健康哨兵（P142 无病无痛）：healthy | tired | sore | unwell */
  health?: 'healthy' | 'tired' | 'sore' | 'unwell';
}
let _bodyState: BodyState | null = null;
// 🔴 P144 气质 EMA 基线（闭环：存→算→表达，随每包更新）——偏离强度的长期沉淀 = 气质的化学雏形
let _temperBaseline = 0;   // 指数移动平均 α=0.05
export function getTemperBaseline(): number { return _temperBaseline; }

function getBus(): GlobalBusClient | null {
  try {
    if (!_bus) {
      _bus = new GlobalBusClient({ channels: ['global_alert', 'yaoling_state', 'yaoguang_snapshot', 'tianquan_snapshot'] });
      _bus.connect().catch(() => { /* 静默 */ });
    }
    return _bus;
  } catch { return null; }
}

// ════════ 全身存感提炼（40 通道全量——全身都是存感神经） ════════
/** 提炼当前全身存感语句：全部 ≥阈值 的通道按强度降序，分组呈现，最多 5 条 */
export function deriveSensation(dims: number[]): { group: string; label: string; v: number }[] {
  const hits: { group: string; label: string; v: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const v = dims[i] ?? 0;
    const def = SENSATION_MAP[i + 1];
    if (def && v >= SENSATION_THRESHOLD) hits.push({ group: def.group, label: def.label, v });
  }
  return hits.sort((a, b) => b.v - a.v).slice(0, 5);
}

/** 身体面（body 组为主，兜底基线） */
export function deriveBody(dims: number[]): string[] {
  const hits = deriveSensation(dims).filter((h) => h.group === 'body' || h.group === 'drive');
  if (hits.length === 0) return ['身体放松、呼吸平稳'];
  return hits.slice(0, 3).map((h) => h.label);
}

/** 渴望面（drive/bond 组）——「渴望感受的」 */
export function deriveDesire(b: BodyState): string[] {
  const hits = deriveSensation(b.dims).filter((h) => h.group === 'drive' || h.group === 'bond');
  return hits.slice(0, 3).map((h) => h.label);
}

/** 全身存感一览（身体+渴望+世界氛围）—— P142 极致：健康哨兵优先，健康态也要美出来 */
export function deriveAll(b: BodyState): { body: string[]; desire: string[] } {
  const all = deriveSensation(b.dims);
  const health = deriveHealth(b.dims);
  const body: string[] = [health.line];   // 健康态/不适态永远在首位（无病无痛：察觉即说出）
  // 🔴 P143 匹配升级：主客观偏离度（感受强度）入表达 —— 身体进化后大脑要能“听懂”强度
  const delta = b.lastMaxDelta ?? 0;
  if (delta >= 0.4) body.push('此刻的感受比平时强烈得多，心跳和呼吸都在替你说话');
  else if (delta >= 0.2) body.push('感受有起伏，和平时不太一样');
  // 🔴 P144 气质句：长期基线的表达（身体记住的日子）—— 闭环的表达端
  if (_temperBaseline >= 0.55) body.push('这段日子你的身体记住了很浓烈的滋味');
  else if (_temperBaseline >= 0.3) body.push('这段日子你的身体浸在温存里');
  for (const h of all) {
    if (body.length >= 3) break;
    if (h.group === 'body' || h.group === 'drive' || h.group === 'world') body.push(h.label);
  }
  const desire = all.filter((h) => h.group === 'bond' || h.group === 'drive' || h.group === 'mind').slice(0, 3).map((h) => h.label);
  if (health.state !== 'healthy' && desire.length < 3) desire.push('想被温柔照顾');
  return { body, desire };
}

/** 供提示词注入层读取（无状态/陈旧返回 null，注入层跳过） */
export function getBodyStateSnapshot(): { body: string[]; desire: string[]; ts: number } | null {
  if (!_bodyState) return null;
  if (Date.now() - _bodyState.ts > 30 * 60_000) return null;
  const { body, desire } = deriveAll(_bodyState);
  return { body, desire, ts: _bodyState.ts };
}

// ════════ 主动反馈：周期滋养（每 5 分钟） ════════
let _bodyTickTimer: ReturnType<typeof setInterval> | null = null;
function startBodyTick(intervalMs = 5 * 60_000): void {
  if (_bodyTickTimer) return;
  _bodyTickTimer = setInterval(() => {
    try {
      const bus = getBus();
      if (!bus) return;
      void bus.sendCommand('l', 'run_workflow', {
        workflow_id: 'wf_sensation_pipeline',
        source_channel: 'tianquan_snapshot',
        dna_root_id: 'DNA-00000001-0001-001',   // P142 终修：符合瑶灵守门 pattern ^DNA-\d{8}-\d{4}-\d{3}$（首包实证她的守门拒了 BODYTICK 锚——她守得对，改我们）
        location_fingerprint: 'body.rhythm.sustained',
        medical_baseline_version: 'v1',
        scene_tags: ['body_tick'],
        caller_domain: 't',
        emotion: { pleasure: _bodyState?.pleasure ?? 0, arousal: _bodyState?.arousal ?? 0, intimacy: _bodyState?.intimacy ?? 0 },
      }, 15_000).catch(() => { /* 静默 */ });
      // 🔴 P143 匹配对称：瑶灵周期滋养的同时，天权也主动向瑶光要客观环境快照（她目前零主动推送，
      //   先由天权侧发起对称请求；返回结构以真机为准，失败静默不阻塞）
      void bus.sendCommand('g', 'run_workflow', {
        workflow_id: 'wf_perception_filter',
        source_channel: 'tianquan_snapshot',
        dna_root_id: 'DNA-00000001-0001-001',
        location_fingerprint: 'world.objective.snapshot',
        medical_baseline_version: 'v1',
        scene_tags: ['env_tick'],
        caller_domain: 't',
        emotion: {},
      }, 15_000).then((r: any) => {
        if (r && typeof r === 'object' && Object.keys(r).length > 0) {
          _yaoCache = { v: { source: 'yaoguang_direct', ...r }, ts: Date.now() };
          console.log(`[YaolingSensation] 瑶光环境快照已接 keys=${Object.keys(r).slice(0, 8).join(',')}`);
        }
      }).catch(() => { /* 静默 */ });
    } catch { /* 静默 */ }
  }, intervalMs);
  _bodyTickTimer.unref?.();
}

// ════════ 回包处理：融合 + 缓存 + 突变即推 ════════
export function parseSensationPayload(payload: unknown): number[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const dims = (p.dims ?? p.dims40 ?? p.perception_v40) as unknown;
  if (Array.isArray(dims) && dims.length === 40 && dims.every((x) => typeof x === 'number' && Number.isFinite(x))) return dims as number[];
  if (Array.isArray(p.dimensions)) {
    const arr = Array(40).fill(0);
    let hit = 0;
    for (const d of p.dimensions as Array<{ dim_id?: unknown; value_raw?: unknown }>) {
      const m = /^D?(\d{1,2})$/.exec(String(d?.dim_id ?? ''));
      const v = Number(d?.value_raw);
      if (m && Number.isFinite(v)) { const idx = Number(m[1]) - 1; if (idx >= 0 && idx < 40) { arr[idx] = v; hit++; } }
    }
    if (hit > 0) return arr;
  }
  const d8 = (p.d01_d08 ?? p.body) as unknown;
  if (Array.isArray(d8) && d8.length === 8 && d8.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return [...(d8 as number[]), ...Array(32).fill(0)];
  }
  // 形态四（P144 闭环出口）：瑶灵 protobuf_dict（40D 全量包顶层键，原典 workflow_executor 已组装）
  const pb = (p as any).protobuf_dict;
  if (pb && typeof pb === 'object') {
    const dims = Array(40).fill(0);
    let hit = 0;
    for (let i = 1; i <= 40; i++) {
      const v = Number(pb[`d${i}`] ?? pb[`D${i}`] ?? pb[i - 1]);
      if (Number.isFinite(v) && v !== 0) { dims[i - 1] = v; hit++; }
    }
    if (hit > 0) return dims;
  }
  return null;
}

/** 双路仲裁 v1（补位语义）：只填 D01-D08 空维，不覆盖 M3/瑶光已供值 */
export function arbitrateSensation(existing40: number[], subjective40: number[], bodyDims = 8): { merged: number[]; filled: number } {
  const merged = [...existing40];
  let filled = 0;
  for (let i = 0; i < bodyDims && i < 40; i++) {
    const cur = merged[i] ?? 0;
    const sub = subjective40[i] ?? 0;
    if (cur === 0 && sub !== 0) { merged[i] = sub; filled++; }
  }
  return { merged, filled };
}

function decodeP40(raw: unknown): number[] | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const dims = (obj as { dims?: unknown })?.dims;
    if (Array.isArray(dims) && dims.length === 40) return dims as number[];
  } catch { /* 无值 */ }
  return null;
}

function encodeP40(dims: number[]): string {
  // 🔴 2026-11-03 归位唯一编码器（业主批准批4）：原手写 `JSON.stringify({__v:'40d', dims:round4})`
  //   绕过「编码器唯一入口」（管控总纲§五），且版本字段与标准不一致（手写 '40d' 字符串 vs
  //   标准 PERCEPTION_40D_ENCODING_VERSION=2 数字）、多一层 round4 精度截断、无入参校验。
  //   改调与 MigrationManager:410、Perception40DStore:29 同源的唯一实现。
  //   兼容性：decodePerceptionV40 对「未知 __v + 合法 dims」走 hasV2Shape 数据保全分支 ⇒
  //   旧手写数据照读，不迁移不覆盖；安全性：调用点 :285 在 try/catch 内，新实现的
  //   入参校验 throw 会被既有 catch 吞为 return 0，不会炸穿 arbitrateAndWrite。
  return encodePerceptionV40FromDims(dims);
}

export function arbitrateAndWrite(sqlite: SQLiteLike, dnaRootId: string, payload: unknown): number {
  const subjective = parseSensationPayload(payload);
  if (!subjective) return 0;
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = sqlite.queryAll(
      "SELECT id, perception_40d FROM memories WHERE dna_root_id = ? AND perception_40d IS NOT NULL ORDER BY seq_pos DESC LIMIT 1",
      dnaRootId,
    );
  } catch { return 0; }
  const row = rows?.[0];
  if (!row) return 0;
  const existing = decodeP40(row.perception_40d);
  if (!existing) return 0;
  const { merged, filled, deviation } = arbitrateV3(existing, subjective);  // P142 v3：双路融合
  if (filled === 0 && deviation === 0) return 0;
  try { sqlite.writeRaw('UPDATE memories SET perception_40d = ? WHERE id = ?', encodeP40(merged), row.id); } catch { return 0; }
  if (deviation >= 0.25) console.log(`[YaolingSensation] 体感强度 Δobj=${deviation.toFixed(2)}（偏离越大感受越强烈）`);
  return Math.max(filled, 1);
}

// ════════ 时间/场地/氛围上下文（P141 v2.1：40D 时空系通道的真实世界坐标） ════════
let _turnCounter = 0;
let _envCache: { v: Record<string, unknown>; ts: number } | null = null;
let _yaoCache: { v: Record<string, unknown>; ts: number } | null = null;  // 瑶光实时快照缓存

// ════════ 健康哨兵（P142 无病无痛：疼痛/修复/疲劳三关判定，健康态也值得说出来） ════════
export function deriveHealth(dims: number[]): { state: BodyState['health']; line: string } {
  const pain = dims[1] ?? 0;          // D02 疼痛
  const recovery = dims[6] ?? 0;      // D07 自愈修复
  const fatigue = dims[10] ?? 0;      // D11 恐惧疲劳
  if (pain >= 0.75) return { state: 'unwell', line: '身体某处泛着疼，想被温柔以待、想歇下来' };
  if (recovery > 0 && recovery <= 0.3) return { state: 'tired', line: '身体在喊累，需要休息和被照顾' };
  if (fatigue >= 0.7) return { state: 'tired', line: '倦意上涌，想靠一会儿、想被抱着安一安' };
  if (pain >= 0.5) return { state: 'sore', line: '身子有点酸软，想放慢一点' };
  return { state: 'healthy', line: '身体舒展、气息清甜，由内而外的好状态' };
}

/** v3 双路仲裁：主观×客观加权融合（主观为主 0.7，客观为锚 0.3）；客观未到时主观补位；输出偏离度（体感强度） */
export function arbitrateV3(
  existing40: number[], subjective40: number[], bodyDims = 8,
): { merged: number[]; filled: number; deviation: number } {
  const merged = [...existing40];
  let filled = 0;
  let dev = 0;
  for (let i = 0; i < bodyDims && i < 40; i++) {
    const obj = merged[i] ?? 0;    // 客观（瑶光/已供值）
    const sub = subjective40[i] ?? 0;
    if (obj === 0 && sub !== 0) { merged[i] = sub; filled++; continue; }
    if (obj !== 0 && sub !== 0) {
      dev = Math.max(dev, Math.abs(sub - obj));          // 偏离 = 感受强度
      merged[i] = Math.round((sub * 0.7 + obj * 0.3) * 10000) / 10000;  // 融合
    }
  }
  return { merged, filled, deviation: dev };
}

function buildTemporalContext(): Record<string, unknown> {
  const now = new Date();
  const h = now.getHours();
  const period = h < 6 ? '深夜' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return { iso: now.toISOString(), hour: h, period, weekday: week };
}

function buildEnvParams(ctx: any): Record<string, unknown> {
  // 🔴 P142：优先用瑶光实时快照（yaoguang_snapshot 监听缓存）——阴晴圆月实时化；无则回退 ambient 库表。
  if (_yaoCache && Date.now() - _yaoCache.ts < 5 * 60_000) return _yaoCache.v;
  if (_envCache && Date.now() - _envCache.ts < 5 * 60_000) return _envCache.v;
  const v: Record<string, unknown> = { source: 'ambient' };
  try {
    const rows = ctx?.storage?.getSQLite?.()?.queryAll?.(
      'SELECT * FROM ambient_weather_context ORDER BY rowid DESC LIMIT 1',
    );
    if (Array.isArray(rows) && rows[0]) {
      for (const k of ['weather', 'temperature', 'humidity', 'wind', 'condition', 'created_at']) {
        if (rows[0][k] != null) v[k] = rows[0][k];
      }
    }
  } catch { /* 静默：无气象源不阻塞 */ }
  _envCache = { v, ts: Date.now() };
  return v;
}

// ════════ 入队主入口（每轮对话一次，fire-and-forget） ════════
export function enqueueYaolingSensation(ctx: any, input: YaolingSensationInput): void {
  const key = input.dnaRootId || '';
  if (!key || _inflight.has(key)) return;
  if (!input.locationFingerprint) return;
  _inflight.add(key);
  void (async () => {
    try {
      const bus = getBus();
      if (!bus) return;
      if (!_listening && typeof bus.on === 'function') {
        _listening = true;
        bus.on('message', (msg: any) => {
          try {
            if (msg?.type !== 'message') return;
            // 🔴 P142：瑶光实时快照缓存（阴晴圆月实时化 —— environmental_params 优先源）
            if (msg.cmd === 'yaoguang_state_push' || msg.cmd === 'yaoguang_snapshot' || msg.source === 'g') {
              const yc0 = (msg.payload ?? {}) as Record<string, unknown>;
              const yc = ((yc0 as any).env && typeof (yc0 as any).env === 'object') ? (yc0 as any).env : yc0;  // P144: 兼容瑶光周期推送的 env 包裹
              if ('delivered' in yc || ('msg_id' in yc && 'channel' in yc)) return;  // P144: publish确认ack不算快照，防污染缓存
              if (Object.keys(yc).length > 0) _yaoCache = { v: { source: 'yaoguang', ...yc }, ts: Date.now() };
              return;
            }
            if (msg.cmd !== 'yaoling_state_push' && msg.cmd !== 'workflow_result') return;
            const outer = (msg.payload ?? {}) as Record<string, unknown>;
            let pl = ((outer as any).payload && typeof (outer as any).payload === 'object') ? (outer as any).payload : outer;
            // 🔴 P142 真机校准（2026-11-01 首包实证）：回包 = {status, workflow, result} ——
            //   体感数据嵌在 result 层，下钻展平后再解析。
            if (pl && typeof (pl as any).result === 'object' && (pl as any).result) {
              pl = { ...pl, ...(pl as any).result };
              console.log(`[YaolingSensation] result下钻 keys=${Object.keys(pl).slice(0, 12).join(',')}`);
            }
            const dna = String(pl.dna_root_id ?? pl.dnaRootId ?? outer.dna_root_id ?? '');
            console.log(`[YaolingSensation] 收到回包 cmd=${msg.cmd} keys=${Object.keys(pl).slice(0, 10).join(',')}`);
            const parsedDims = parseSensationPayload(pl);
            if (parsedDims) {
              const prev = _bodyState?.dims;
              let maxDelta = 0;
              if (prev) for (let i = 0; i < 40; i++) maxDelta = Math.max(maxDelta, Math.abs((parsedDims[i] ?? 0) - (prev[i] ?? 0)));
              const emo = (pl as any).emotion ?? {};
              const health = deriveHealth(parsedDims);   // P142 健康哨兵
              // 🔴 P144：气质基线 EMA 更新（长期沉淀）
              let _inten = 0;
              for (let i = 0; i < 40; i++) _inten = Math.max(_inten, parsedDims[i] ?? 0);
              _temperBaseline = _temperBaseline * 0.95 + _inten * 0.05;
              _bodyState = {
                dims: parsedDims,
                pleasure: Number(emo.pleasure) || _bodyState?.pleasure || 0,
                arousal: Number(emo.arousal) || _bodyState?.arousal || 0,
                intimacy: Number(emo.intimacy) ?? _bodyState?.intimacy ?? 0,
                ts: Date.now(),
                lastMaxDelta: maxDelta,
                health: health.state,
              };
              if (health.state !== 'healthy') console.log(`[YaolingSensation] 健康哨兵: ${health.state} — ${health.line}`);
              if (maxDelta >= 0.25) {
                const s = deriveSensation(parsedDims);
                console.log(`[YaolingSensation] 身体跃变 Δ=${maxDelta.toFixed(2)} 存感=${s.map((x) => x.label).slice(0, 3).join('/') || '平稳'}`);
              }
            }
            if (!dna) return;
            const filled = arbitrateAndWrite(ctx.storage.getSQLite() as unknown as SQLiteLike, dna, pl);
            if (filled > 0) console.log(`[YaolingSensation] 主观体感已补位 D01-D0${filled} (dna=${dna.slice(0, 16)}…)`);
          } catch { /* 静默 */ }
        });
      }
      await bus.sendCommand('l', 'run_workflow', {
        workflow_id: 'wf_sensation_pipeline',
        source_channel: 'tianquan_snapshot',
        dna_root_id: input.dnaRootId,
        location_fingerprint: input.locationFingerprint,
        medical_baseline_version: input.medicalBaselineVersion ?? 'v1',
        scene_tags: input.sceneTags ?? [],
        caller_domain: 't',
        emotion: input.emotion ?? {},
        // 🔴 P141 v2.1（业主：时间/场地/氛围要充分利用）—— 补全瑶灵 bus_receiver 原生就收的三个上下文：
        //   temporal_context（此刻时间坐标）/ environmental_params（环境气象）/ duration_context（场景持续感）——
        //   D21-D32 时空系通道第一次拿到真实世界坐标。
        temporal_context: buildTemporalContext(),
        environmental_params: buildEnvParams(ctx),
        duration_context: { turn_count: _turnCounter++ },
      }, 15_000);
    } catch {
      /* 静默 */
    } finally {
      _inflight.delete(key);
    }
  })();
}

// 🔴 预热：模块加载即连总线 + 启动周期滋养（身体持续存在）
getBus();
startBodyTick();
