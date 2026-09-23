/**
 * server-chat-routes.ts — Chat/重置/状态 API 端点 (从 server.ts 拆出)
 * /api/chat | recall | purge-test | prefer-candidate | stream | clear |
 * /api/reset | status | conversation
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import type { FamilyGraph } from '../m4/household/FamilyGraph.js';
import type { EntityMeeting } from '../m4/household/EntityMeeting.js';
import type { ChatResponse, ChatContext } from './chat.js';
import { randomUUID } from 'node:crypto';
// 🔴 P1-5 S4-M3: streaming.enabled/job_ttl_ms 接线（enabled:false 一键回退同步路径）
import { getRetrievalFusionConfig } from '../config/retrieval-fusion-config.js';

/** TTS 异步 job 存储（S4 P1-2 修复：长文音频后台生成，不阻塞 /api/chat 响应） */
const TTS_JOBS = new Map<string, { urls: string[]; done: boolean; createdAt: number }>();
const TTS_JOB_TTL_MS = 120_000; // 2 分钟自动过期（防内存泄漏）
/** 短/中回复（≤2 段）同步生成无感；长文（>2 段）走异步 job */
export const TTS_SYNC_MAX_SEGMENTS = 2;

/** 语音播报单段最大字符数（edge-tts 输入安全上限） */
export const TTS_MAX_TEXT = 400;
/** 语音播报单段目标句数（2~4 句，控制播报节奏：不多不少不碎） */
export const TTS_SEGMENT_TARGET_SENTENCES = 3;
/** 语音播报单段硬上限（句数达标但字数溢出时的强制截断） */
export const TTS_SEGMENT_MAX_CHARS = 250;
/** V15 边写边播: 增量 TTS 触发字量门槛（V22 升至 120 字，对齐段粒度 2~3 句，
 *   消除 V17 降 40 字导致的超短单句段 → edge-tts 高频 NoAudioReceived 无声） */
export const TTS_INCR_MAX_CHARS = 120;
/** V24 边写边播: 首段快速触发字数（首段 1~2 句即播，消除"文字写完等几秒"的滞后） */
export const TTS_FIRST_SEG_CHARS = 60;
/** V15 边写边播: 增量段在途上限（串行队列防 edge-tts 并发打满） */
export const TTS_MAX_INFLIGHT = 3;

/**
 * _truncateForTTS — 语音播报文本断句截断。
 * 长回复（可达数千字）只播报前段：在 max 窗口内找断点。
 * 断点两级优先级（对齐 SSE 路由的 [。！？\n] 句级约定）：
 *   1. 句级（。！？…\n）最右断点 > 40%*max → 采用（完整句优先）
 *   2. 逗号级（；，、;）最右断点 > 40%*max → 采用（短语兜底）
 *   3. 回退最近句级断点（不要求越过 40% 阈值）→ 保句子完整
 *   4. 完全无断点 → 硬截断在 max
 * 纯函数，可单测。
 */
export function _truncateForTTS(text: string, max = TTS_MAX_TEXT): string {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  const cutoff = t.slice(0, max);
  const SENT = new Set(['。', '！', '？', '…', '\n']);
  const PHRASE = new Set(['；', '，', '、', ';']);
  const threshold = Math.floor(max * 0.4);

  // 找最右断点
  let sentIdx = -1;
  let phraseIdx = -1;
  for (let i = cutoff.length - 1; i >= 0; i--) {
    if (sentIdx === -1 && SENT.has(cutoff[i])) sentIdx = i;
    if (phraseIdx === -1 && PHRASE.has(cutoff[i])) phraseIdx = i;
    if (sentIdx !== -1 && phraseIdx !== -1) break;
  }
  // 1. 句级优先（完整句）
  if (sentIdx > threshold) return cutoff.slice(0, sentIdx + 1);
  // 2. 逗号级兜底
  if (phraseIdx > threshold) return cutoff.slice(0, phraseIdx + 1);
  // 3. 回退最近句级断点（保句子完整）
  if (sentIdx >= 0) return cutoff.slice(0, sentIdx + 1);
  // 4. 无断点 → 硬截断
  return cutoff;
}

/**
 * segmentForTTS — 长文分段（滚动播报核心，纯函数可单测）。
 * 按"几句话一个断点"切段，让前端一段段连续播完整个超长文本（数千字）。
 * 规则（双上限保安全 + 节奏）：
 *   1. 以句子结尾（。！？…\n）为断点累计句子
 *   2. 目标句数 TTS_SEGMENT_TARGET_SENTENCES 达到 → 切段
 *   3. 单段字数硬上限 TTS_SEGMENT_MAX_CHARS：句数未达但字数溢出 → 立即切段
 *   4. 无句级断点（超长单句）→ 在 TTS_SEGMENT_MAX_CHARS 处硬切
 *   5. 短文本（≤ TTS_SEGMENT_MAX_CHARS）→ 单段原样返回
 *   6. 空/纯空白 → 返回空数组
 * 与 _truncateForTTS 并存：_truncateForTTS 保留给调用方兼容；多段播报走本函数。
 */
export function segmentForTTS(text: string, targetSentences = TTS_SEGMENT_TARGET_SENTENCES, maxChars = TTS_SEGMENT_MAX_CHARS): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  if (t.length <= maxChars) return [t];

  const SENT_END = new Set(['。', '！', '？', '…', '\n']);
  const segments: string[] = [];
  let buf = '';
  let sentCount = 0;

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (SENT_END.has(ch)) sentCount++;
    const segFull = (sentCount >= targetSentences || buf.length >= maxChars);
    if (segFull) {
      segments.push(buf.trim());
      buf = '';
      sentCount = 0;
    }
  }
  if (buf.trim()) segments.push(buf.trim());

  // 异常兜底：因超长单句产生 >maxChars 的段（无任何断点）→ 硬切
  const out: string[] = [];
  for (const s of segments) {
    if (s.length <= maxChars) { out.push(s); continue; }
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  }
  return out;
}

/** 🔴 V25 预热优化: edge-tts 常驻 worker 进程。
 * 原 generateTTSAudio 每次 execFile('edge-tts') 都 fork 新 Python 进程（冷启动 ~3.5s，其中 import edge_tts ~1.4s）。
 * 改为常驻 worker：模块级 import edge_tts 只发生一次，后续合成走 stdin/stdout JSON 行协议，asyncio 并发。
 * 注意：edge-tts 装在 Python 3.13；PATH 里的 `python` 是 hermes venv 3.11，必须用绝对路径。 */
const TTS_PYTHON = 'C:\\Users\\henry\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
/** 禁用代理环境变量（edge-tts 需直连微软服务；worker 由 spawn 继承） */
const TTS_NO_PROXY_ENV = { NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };

class TTSWorker {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private stdoutBuf = '';

  constructor(private scriptPath: string) {}

  /** 懒启动（幂等）。spawn 即返回，import edge_tts 在子进程后台进行，不阻塞调用方。 */
  ensureStarted(): void {
    if (this.proc && !this.proc.killed) return;
    const p = spawn(TTS_PYTHON, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...TTS_NO_PROXY_ENV },
    });
    this.proc = p;
    p.stdout!.setEncoding('utf8');
    p.stdout!.on('data', (chunk: string) => this._onStdout(chunk));
    p.stderr!.on('data', () => { /* worker 错误经响应回传，stderr 仅诊断 */ });
    p.on('exit', () => { this._failAll(new Error('tts worker exited')); this.proc = null; });
    p.on('error', (e) => { this._failAll(e); this.proc = null; });
  }

  /** 合成单段 → 写 outPath。resolve=成功；reject=失败（由 genOne 外层重试，空文件检测不变）。 */
  synthesize(text: string, outPath: string): Promise<void> {
    this.ensureStarted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.proc!.stdin!.write(JSON.stringify({ id, text, path: outPath }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private _onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (;;) {
      const nl = this.stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line);
        const p = this.pending.get(resp.id);
        if (p) { this.pending.delete(resp.id); resp.ok ? p.resolve() : p.reject(new Error(resp.error || 'tts synth failed')); }
      } catch (_) { /* 解析失败忽略，等待后续行 */ }
    }
  }

  private _failAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }
}

/** worker 单例（懒初始化；路径从 dataDir 推导 PROJECT_ROOT/scripts/tts_worker.py） */
let _ttsWorker: TTSWorker | null = null;
function _getWorker(dataDir: string): TTSWorker {
  if (!_ttsWorker) {
    _ttsWorker = new TTSWorker(path.resolve(dataDir, '..', '..', 'scripts', 'tts_worker.py'));
  }
  return _ttsWorker;
}

/**
 * generateTTSAudio — 分段文本 → mp3 音频 URL 列表（同步/异步共用）。
 * 并发限流 3（edge-tts 负载保护）；某段失败跳过不阻塞整体。
 * S4 P2-6 修复：文件名用 randomUUID 彻底杜绝同毫秒碰撞。
 */
export async function generateTTSAudio(segments: string[], dataDir: string, onSegment?: (url: string, idx: number) => void): Promise<string[]> {
  const worker = _getWorker(dataDir);
  const genOne = async (txt: string, idx: number): Promise<string | null> => {
    if (!txt.trim()) return null; // 空段不生成（S4 P2-4）
    const _fn = 'tts_' + Date.now().toString(36) + '_' + randomUUID().slice(0, 8) + '.mp3';
    const _fp = path.join(dataDir, 'audio', _fn);
    // V14: edge-tts 服务端临时故障重试（NoAudioReceived 生成 0 字节文件）——重试 2 次，间隔 1.5s/3s
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * attempt)); // 1.5s/3s 退避
        await worker.synthesize(txt, _fp); // V25: 走常驻 worker（复用 import，省 ~1.4s/段）
        if (fs.existsSync(_fp) && fs.statSync(_fp).size > 0) {
          const url = '/audio/' + _fn;
          // 🔴 S2-F2: 每段生成完立即回调（边生成边播，不等全量）— 消除长文"文字写完干等几秒"。
          // idx 保持分段顺序，前端按序播放（缺段等待）。
          try { onSegment?.(url, idx); } catch (_oc) { /* 回调失败不阻塞 */ }
          return url;
        }
        // 0 字节文件（NoAudioReceived）→ 删除重试
        try { fs.unlinkSync(_fp); } catch (_de) { /* 忽略 */ }
        if (attempt < maxAttempts) { console.warn('[TTS] 第 ' + attempt + ' 次生成空文件，重试...'); continue; }
      } catch (_e) {
        if (attempt < maxAttempts) { console.warn('[TTS] 第 ' + attempt + ' 次失败，重试:', (_e as Error)?.message || _e); continue; }
        console.warn('[TTS] 段生成失败(重试' + maxAttempts + '次后):', (_e as Error)?.message || _e);
      }
    }
    return null;
  };
  const CHUNK = 3;
  const files: (string | null)[] = new Array(segments.length);
  for (let i = 0; i < segments.length; i += CHUNK) {
    const batch = segments.slice(i, i + CHUNK);
    const batchFiles = await Promise.all(batch.map((s, j) => genOne(s, i + j)));
    batchFiles.forEach((f, j) => { files[i + j] = f; });
  }
  return files.filter((f): f is string => !!f);
}

/** TTS job 状态查询（S4 P1-2 异步方案：前端轮询补齐长文段） */
export function getTTSJob(jobId: string): { urls: string[]; done: boolean } | null {
  sweepTTSJobs();
  const job = TTS_JOBS.get(jobId);
  return job ? { urls: job.urls, done: job.done } : null;
}

/** TTS job 兜底清理（复审 P2-1：独立定时器防长驻内存；也被 getTTSJob 惰性触发） */
export function sweepTTSJobs(): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of TTS_JOBS) {
    if (now - v.createdAt > TTS_JOB_TTL_MS) { TTS_JOBS.delete(k); removed++; }
  }
  return removed;
}

// ── 🔴 P1-5 流式聊天 job 存储（路径 B: POST /api/chat {stream:true} → jobId → 轮询/SSE） ──

// ══════════════════════════════════════════════════════════════════════
// 🔴 终态契约（阶段 A，2026-09-24）
//
// 事故背景：压测下前端气泡反复只显示 `…`，三种完全不同的结局坍缩成同一占位符，
//   且其中两种还会让 UI 卡在 busy（输入框禁用）→ 表现为「卡死不回复」：
//     ① LLM 报错   → status='error'，但前端只 clearInterval，不 clearBusy、不渲染原因
//     ② job 被 TTL sweep 掉 → 端点返回 {ok:false}（无原因），前端所有 dd.ok&& 分支
//        都不进 → 空转到 60s 硬超时
//     ③ 任务一直 running（无 deadline）→ 空转到 60s 硬超时
//
// 结构性修复：给 job 一个**明确的终态语义**——每个终态必带结构化 error_code +
//   人类可读 reason；sweep 由「直接删除」改为「先置终态、再延迟回收」，
//   使轮询永远拿到明确状态而非 ok:false 的歧义空值。
//   前端相应禁止裸 `…` 占位：拿不到内容必须说明**为什么**。
// ══════════════════════════════════════════════════════════════════════

/** 终态结构化错误码（枚举而非自由文本，供前端与日志分别归因） */
export type JobErrorCode =
  | 'llm_rate_limited'      // 模型服务限流（429）
  | 'llm_timeout'           // 模型响应超时/被中止
  | 'llm_failed'            // 重试耗尽仍未成功
  | 'deadline_exceeded'     // 任务超过 TTL 仍未完成
  | 'job_failed';           // 其他会话处理失败

/**
 * 从异常里归类出结构化错误码 + 人类可读原因（纯函数，可单测）。
 * 判定顺序有意义：429 必须最先——`API call failed after 3 attempts: 429 (...)`
 * 同时含 429 与 attempts，根因是限流而非「重试耗尽」本身。
 */
export function classifyJobError(err: unknown): { error_code: JobErrorCode; reason: string } {
  const msg = String((err as Error)?.message ?? err ?? '');
  if (/429|rate.?limit|too many requests|限流/i.test(msg)) {
    return { error_code: 'llm_rate_limited', reason: '模型服务限流，请稍后重试' };
  }
  if (/timeout|timed out|abort/i.test(msg)) {
    return { error_code: 'llm_timeout', reason: '模型响应超时' };
  }
  if (/attempts|API call failed/i.test(msg)) {
    return { error_code: 'llm_failed', reason: '模型调用失败（已重试仍不成功）' };
  }
  return { error_code: 'job_failed', reason: msg.slice(0, 200) || '会话处理失败' };
}

/** sweep 对单个 job 的处置（纯函数，可单测；sweepChatJobs 只负责套用结果） */
export type SweepAction =
  | { action: 'keep' }
  | { action: 'mark'; patch: Partial<ChatJob> }   // 置终态但**不删**，给前端留读取窗口
  | { action: 'delete' };

export function nextJobStateForSweep(job: ChatJob, now: number, ttl: number): SweepAction {
  const age = now - job.createdAt;
  // ① 未终态且超龄 → 置 deadline_exceeded 而非直接删除
  //    （直接删除会让轮询拿到 {ok:false}，前端无法区分「过期」「任务 id 错误」「从未存在」）
  if (job.status === 'running' && age > ttl) {
    return {
      action: 'mark',
      patch: {
        status: 'deadline_exceeded',
        error_code: 'deadline_exceeded',
        reason: `任务超过 ${Math.round(ttl / 1000)} 秒未完成，已终止`,
        terminalAt: now,
      },
    };
  }
  // ② 已终态 → 自进入终态起再保留 ttl，让前端有机会读到终态
  const doneAt = job.terminalAt ?? job.createdAt;
  if (now - doneAt > ttl) return { action: 'delete' };
  return { action: 'keep' };
}

/** 流式聊天 job */
export interface ChatJob {
  /** running → done | error | deadline_exceeded（四个状态，终态必带 error_code + reason） */
  status: 'running' | 'done' | 'error' | 'deadline_exceeded';
  /** 已推送的 token 增量（前端轮询时一次性取回补齐） */
  tokens: string[];
  /** 最终 reply（done 后，M5 校准 + 幻觉校验的完整结果，覆盖气泡） */
  reply: string;
  /** 完整 ChatResponse（done 后） */
  result: any | null;
  audio: { audio_url: string | null; audio_urls: string[]; tts_job: string | null };
  /** V24: 增量 TTS finalize 完成后置 true（前端轮询据此判断音频已定稿，不再等空 audio_urls 超时丢尾） */
  audio_done?: boolean;
  createdAt: number;
  error?: string;
  /** 终态结构化错误码（终态必填） */
  error_code?: JobErrorCode | null;
  /** 终态人类可读原因（终态必填；前端据此显示，禁止退回裸占位符） */
  reason?: string | null;
  /** 进入终态的时刻；sweep 据此做延迟回收 */
  terminalAt?: number;
}
const CHAT_JOBS = new Map<string, ChatJob>();
/** 3 分钟自动过期（防内存泄漏；与 p1_speed.streaming.job_ttl_ms 对齐） */
const CHAT_JOB_TTL_MS = 180_000;

/** 流式 job 状态查询（惰性 sweep） */
export function getChatJob(jobId: string): ChatJob | null {
  sweepChatJobs();
  return CHAT_JOBS.get(jobId) || null;
}

/** 流式 job 兜底清理（惰性触发 + server.ts 60s 定时器；防长驻内存）
 * S4-M3: job_ttl_ms 从配置读取（默认 180s）
 * 🔴 阶段 A：改为「先置终态、后回收」，见 nextJobStateForSweep。 */
export function sweepChatJobs(): number {
  const now = Date.now();
  const ttl = getRetrievalFusionConfig()?.p1_speed?.streaming?.job_ttl_ms ?? CHAT_JOB_TTL_MS;
  let removed = 0;
  for (const [k, v] of CHAT_JOBS) {
    const act = nextJobStateForSweep(v, now, ttl);
    if (act.action === 'delete') { CHAT_JOBS.delete(k); removed++; }
    else if (act.action === 'mark') { Object.assign(v, act.patch); }
  }
  return removed;
}

/**
 * 🔴 P1-5: TTS 结果构建（同步路径与流式 job 路径共用）。
 * 长文分段滚动播报（V12.5）：≤2 段同步生成无感；>2 段异步 job 轮询补齐。
 */
/**
 * V15 边写边播: 流式增量 TTS——文字生成过程中逐句生成音频并推送，根治语音滞后脱节。
 * feed() 收到 onToken 碎片（可能半字/半标点/多句），字符级累积按句末标点切段；
 * 累积 >=TTS_INCR_MAX_CHARS 且对齐句子边界触发一次生成；_dispatch 用 promise 串行链一次一段。
 * finalize() 在 done 后用 segmentForTTS 全量重算对齐最终 reply（增量段可能被 M5 校准覆盖）。
 */
export class IncrementalTTS {
    private _buf = '';
    private _pending: Array<{ text: string; idx: number }> = [];
    private _inFlight = 0;
    private _aborted = false;
    private _gen = 0;
    private _chain: Promise<unknown> = Promise.resolve();
    private _done: Array<{ idx: number; url: string }> = []; // V22: 记录已生成段，finalize 保序返回
    private _segGen = 0; // V23: 段计数器（连续 0,1,2,3..），段 idx 必须连续否则前端 urls 稀疏卡空位
    private _forceTail = false; // V23: flush 后强制消费尾部残句（即使 <2 句）
    constructor(private _dataDir: string, private _onSegment: (idx: number, url: string) => void) {}

    feed(tok: string): void {
        if (this._aborted || !tok) return;
        this._buf += tok;
        // ① 按句末标点切完整句入 _pending
        for (;;) {
            const m = this._buf.match(/^.*?[。！？…\n]/s);
            if (!m) break;
            const s = m[0].trim();
            this._buf = this._buf.slice(m[0].length);
            if (s && /[一-龥]/.test(s)) this._pending.push({ text: s, idx: this._gen++ });
        }
        // ② 触发门槛: 首段(_segGen===0) 60 字即触发，后续段 120 字；或 >=2 完整句
        const cc = this._pending.reduce((n, p) => n + p.text.length, 0);
        const _threshold = (this._segGen === 0) ? TTS_FIRST_SEG_CHARS : TTS_INCR_MAX_CHARS;
        if (cc + this._buf.length >= _threshold && (this._pending.length >= 1 || this._buf.length >= _threshold)) this._dispatch();
        else if (this._pending.length >= 2) this._dispatch();
    }

    /** 文字 done 前调用: 提交残留部分句 */
    flush(): void {
        if (this._aborted) return;
        const t = this._buf.trim();
        this._buf = '';
        if (t && /[一-龥]/.test(t)) this._pending.push({ text: t, idx: this._gen++ });
        this._forceTail = true; // V23: flush 后即使剩 1 句也强制消费，防尾部残句丢失
        if (this._pending.length) this._dispatch();
    }

    /** 串行队列: 一次只跑一段，在途<=TTS_MAX_INFLIGHT，生成完 onSegment 推 chat-tts。
     * V22: 合并 2~3 句 / ≤120 字为一段（不再单句）——单句段太短（20~50字）edge-tts 高频 NoAudioReceived，
     * 导致"时有时无 + 只播一句"。段粒度对齐 edge-tts 稳定区间（80~120 字）。 */
    private _dispatch(): void {
        if (this._aborted) return;
        // 合并前 N 句到 ~120 字（至少 2 句，最多 3 句），杜绝短单句段；
        // flush 后(_forceTail) 或 单句本身 >=120 字 → 单句也单独生成。
        // V24: 首段(_segGen===0)阈值降到 TTS_FIRST_SEG_CHARS(60字)快速触发；后续段 120 字。
        // 🔴 V25 修复响应慢: 原 _chain = _chain.then(...) 是严格串行链——_inFlight 虽能数到 3，
        //   但每个 generateTTSAudio 都串在前一个 .then 后，实际一次只跑 1 段（9 段串行 32.9s）。
        //   改为真并发：while 填满 _inFlight 槽位（最多 TTS_MAX_INFLIGHT=3 段同时生成），
        //   _chain 只做「所有已派发 task 完成」的聚合追踪（task 已并发启动，非串行执行）。
        while (this._inFlight < TTS_MAX_INFLIGHT && this._pending.length) {
            const _threshold = (this._segGen === 0 && !this._forceTail) ? TTS_FIRST_SEG_CHARS : TTS_INCR_MAX_CHARS;
            if (!this._forceTail && this._pending.length < 2 && this._pending[0]!.text.length < _threshold) break;
            let text = '';
            let n = 0;
            while (this._pending.length && n < 3 && text.length < TTS_INCR_MAX_CHARS) {
                text += this._pending.shift()!.text;
                n++;
            }
            if (!text) break;
            const idx = this._segGen++; // 段 idx 连续（0,1,2,3..），前端 urls 按 idx 保序
            this._inFlight++;
            // 立即并发启动（不再 .then 串行），_inFlight 控制并发上限
            const task = generateTTSAudio([text], this._dataDir, (url) => {
                if (!this._aborted) { this._done.push({ idx, url }); this._onSegment(idx, url); }
            })
                .catch((e) => console.warn('[TTS] 增量段失败:', (e as Error)?.message || e))
                .finally(() => { this._inFlight--; this._dispatch(); });
            // _chain 仅聚合完成（task 已启动，此处不串行执行）
            this._chain = this._chain.then(() => task);
        }
    }

    /** done 后: 等链清空 → 返回已生成的增量段 url（含失败空位，按原始 idx 保序）。
     * V22: 不再 segmentForTTS 全量重切——增量段(2~3句/段)与全量段(3句/250字)切分粒度不同，
     * 双轨 idx 冲突导致全量段填不进前端已被增量段占位的 urls 数组 → 兜底失效。
     * 单一分段策略：增量段就是最终段，finalize 只补 flush 尾部残句。 */
    finalize(fullReply: string): Promise<{ audio_url: string | null; audio_urls: string[]; tts_job: string | null }> {
        this.flush();
        // V24 drain: _inFlight 上限(3)会让"在途段之外的剩余句"滞留 _pending，
        // 此前 _chain.then 只覆盖已排队段 → finalize 提前返回 → 长文只播前 3 段。
        // 这里轮询等待 _pending 清空 + _inFlight 归零（finally 递归会持续消费），
        // 保证所有段都排队并生成完，finalize 才返回完整 audio_urls。
        const drain = async (): Promise<void> => {
            let guard = 0;
            while (!this._aborted && (this._pending.length > 0 || this._inFlight > 0)) {
                this._dispatch();
                if (++guard > 4000) break; // 5ms*4000=20s 兜底，防死循环
                await new Promise(r => setTimeout(r, 5));
            }
            await this._chain;
        };
        return drain().then(() => {
            if (this._aborted || !fullReply || fullReply.length <= 1)
                return { audio_url: null, audio_urls: [], tts_job: null };
            // 已生成段按 idx 保序（含空位），供前端兜底补缺
            const urls: (string | null)[] = [];
            for (const r of this._done) urls[r.idx] = r.url;
            const compact = urls.filter((u): u is string => !!u);
            return { audio_url: compact[0] || null, audio_urls: urls as string[], tts_job: null };
        });
    }

    abort(): void { this._aborted = true; }
}

async function buildTTSResult(
  reply: string,
  ttsEnabled: boolean,
  dataDir: string,
  pushFn?: (event: string, data: any) => void,  // 🔴 S2-F2: 增量段 SSE 推送（仅流式路径传）
): Promise<{ audio_url: string | null; audio_urls: string[]; tts_job: string | null }> {
  let audio_url: string | null = null;
  let audio_urls: string[] = [];
  let tts_job: string | null = null;
  if (ttsEnabled && reply && reply.length > 1) {
    const segments = segmentForTTS(reply);
    if (segments.length <= TTS_SYNC_MAX_SEGMENTS) {
      try {
        audio_urls = await generateTTSAudio(segments, dataDir);
        if (audio_urls.length > 0) audio_url = audio_urls[0];
      } catch (_err) { console.warn('[TTS] 生成失败:', (_err as Error)?.message || _err); }
    } else {
      tts_job = 'ttsjob_' + randomUUID();
      TTS_JOBS.set(tts_job, { urls: [], done: false, createdAt: Date.now() });
      // 🔴 S2-F2: onSegment 回调 — 每段生成完立即追加到 job.urls + 推 SSE `chat-tts`，
      // 前端增量按序播放，不等全量段（消除长文语音"干等几秒"）。
      void generateTTSAudio(segments, dataDir, (url, idx) => {
        const job = TTS_JOBS.get(tts_job!);
        if (!job) return;
        // 保序追加：job.urls 按 idx 填充，缺位用 null 占位（前端轮询按序等待）
        while (job.urls.length <= idx) job.urls.push(null as any);
        job.urls[idx] = url;
        try { pushFn?.('chat-tts', { job_id: tts_job, index: idx, url }); } catch (_se) { /* SSE 失败不阻塞 */ }
      }).then(urls => {
        const job = TTS_JOBS.get(tts_job!);
        if (job) { job.urls = urls; job.done = true; }
      }).catch(e => {
        console.warn('[TTS] 异步 job 生成失败:', (e as Error)?.message || e);
        const job = TTS_JOBS.get(tts_job!);
        if (job) job.done = true;
      });
    }
  }
  return { audio_url, audio_urls, tts_job };
}

export interface ChatRouteDeps {
  processChat: (message: string, clientMsgId?: string | null, testMode?: boolean, onToken?: (delta: { text?: string }) => void) => Promise<ChatResponse>;
  /** 🔴 P1-5 流式: 直写 SSE 客户端池（绕过 broadcastEvent 1.5s 限速） */
  pushToSSEClients?: (event: string, data: any) => void;
  resetPipeline: () => Promise<void>;
  conversationHistory: any[];
  conversationDB: any;
  storage: FusionStorageAdapter;
  familyGraph: FamilyGraph;
  m6: any;
  maintenance: any;
  DATA_DIR: string;
  PROJECT_ROOT: string;
  PROJECT_DIR: string;
  saveConversationHistory: () => void;
  listApiKeys: () => any[];
  setApiKey: (name: string, value: string) => void;
  deleteApiKey: (name: string) => void;
  getApiKey: (name: string) => string | undefined;
  entityMeeting?: EntityMeeting;  // V10.1: byte-level meeting trigger
}

/** P2-2: 派生当前聊天对象状态（UI 显示单一事实来源，聊天核心链路零改动）。
 *  mode: yuyao=玉瑶默认态(_meeting=null) / private=私聊-XX / meeting=会晤(2人+)
 *  targetName=当前聊天对象昵称；participants=会晤参会人；
 *  speakerName=本条回复发言者 —— 仅会晤(meeting)返回当前主发言实体，私聊/玉瑶为 null
 *  （前端据此仅在会晤时前置【发言者】前缀，且退出会晤后历史消息前缀保留）
 */
function buildChatState(entityMeeting?: EntityMeeting): { mode: 'yuyao' | 'private' | 'meeting'; targetName: string; participants: string[]; speakerName: string | null } | null {
  if (!entityMeeting) return null;
  const active = entityMeeting.isActive();
  const isMulti = entityMeeting.isMultiParty();
  const entityName = active ? (entityMeeting.getEntityName() || '玉瑶') : '玉瑶';
  return {
    mode: (!active ? 'yuyao' : (isMulti ? 'meeting' : 'private')) as 'yuyao' | 'private' | 'meeting',
    targetName: entityName,
    participants: isMulti ? entityMeeting.getParticipants().map(p => p.name) : [],
    speakerName: isMulti ? entityName : null,
  };
}

export async function handleChatRoutes(deps: ChatRouteDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { processChat, resetPipeline, conversationHistory, conversationDB, storage, familyGraph, m6, maintenance, DATA_DIR, PROJECT_ROOT, PROJECT_DIR } = deps;

  // ── 聊天 ──
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
    const { rawBody, text: bodyText } = await readBodyWithBytes(req);
    // 🔴 P0-4.1: 移除字节级会晤触发（V10.5）——消息含人名即 enter 导致跨实体污染。
    // 会晤切换统一由 chat.ts 的 EntityMeeting.detectUserIntent（精准句式：找X聊聊/叫X来）处理。
    const body = JSON.parse(bodyText);
    if (!body.message || typeof body.message !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return true; }
    // 🛡️ V4.0: 角色扮演已彻底废除，实体会晤替代。不再注入【角色扮演】标记。

    // 🔴 P1-5 流式分支（路径 B）: body.stream===true 才进 job 分支，默认同步路径向后兼容。
    //   S4-M3: streaming.enabled===false → 回退同步路径（一键回滚旧行为）。
    //   job 后台跑完整 processChat（幻觉校验/持久化/TTS 全部落地逻辑不破坏），
    //   onToken 旁路推 chat-token/chat-done 到 SSE；前端轮询 /api/chat/job/status 兜底。
    if (body.stream === true && getRetrievalFusionConfig()?.p1_speed?.streaming?.enabled !== false) {
      const jobId = 'chatjob_' + randomUUID();
      const job: ChatJob = { status: 'running', tokens: [], reply: '', result: null, audio: { audio_url: null, audio_urls: [], tts_job: null }, createdAt: Date.now() };
      CHAT_JOBS.set(jobId, job);
      // 🔴 V25 预热: 流式请求一开始就 spawn worker（import edge_tts ~1.4s 在 LLM 思考期并行完成），
      // 首段语音不用再等 import，消除「文字写完后首段额外等 1.4s」。
      if (body.tts !== false) _getWorker(DATA_DIR).ensureStarted();
      // V15 边写边播: 增量 TTS（tts:false 时为 null，纯文字不变）
      const incrTTS = (body.tts !== false && getRetrievalFusionConfig()?.p1_speed?.streaming?.enabled !== false)
        ? new IncrementalTTS(DATA_DIR, (idx, url) => {
            // V24: 渐进更新 job.audio.audio_urls——SSE 掉线/第一次 done 后轮询 /job/status
            // 也能拿到已生成段（finalize drain 返回完整前，这里先逐段落库兜底）。
            while (job.audio.audio_urls.length <= idx) job.audio.audio_urls.push(null as any);
            job.audio.audio_urls[idx] = url;
            deps.pushToSSEClients?.('chat-tts', { job_id: jobId, index: idx, url });
          })
        : null;
      void (async () => {
        try {
          const result = await processChat(body.message.trim(), body.client_msg_id, body.test_mode === true, (delta) => {
            if (delta?.text) {
              job.tokens.push(delta.text);
              deps.pushToSSEClients?.('chat-token', { job_id: jobId, token: delta.text });
              incrTTS?.feed(delta.text);   // V15: 喂给增量 TTS（文字生成中即触发语音）
            }
          });
          job.result = result;
          job.reply = result.reply || '';
          // 🔴 发送卡死修复: TTS 不阻塞 done——reply 就绪立即完成（文本可展示），TTS 后台异步生成后更新 audio。
          job.status = 'done';
          job.terminalAt = Date.now();
          deps.pushToSSEClients?.('chat-done', { job_id: jobId, reply: job.reply, audio_url: null, audio_urls: [], tts_job: null });
          console.log('[ChatStream] done: ' + jobId + ' tokens=' + job.tokens.length + ' len=' + job.reply.length);
          // V15: 增量 TTS 尾补（不阻塞 done；增量段已在流式期间推送）
          if (incrTTS) {
            incrTTS.finalize(job.reply).then((audio) => {
              job.audio = audio;
              job.audio_done = true; // V24: 音频定稿信号（前端轮询据此退出，不再等空 audio_urls）
              deps.pushToSSEClients?.('chat-done', { job_id: jobId, reply: job.reply, audio_url: audio.audio_url, audio_urls: audio.audio_urls, tts_job: audio.tts_job });
            }).catch((e) => { console.warn('[ChatStream] 增量 TTS 尾补失败:', (e as Error)?.message || e); });
          } else {
            void buildTTSResult(job.reply, body.tts !== false, DATA_DIR, deps.pushToSSEClients?.bind(null)).then((audio) => {
              job.audio = audio;
              job.audio_done = true;
              deps.pushToSSEClients?.('chat-done', { job_id: jobId, reply: job.reply, audio_url: audio.audio_url, audio_urls: audio.audio_urls, tts_job: audio.tts_job });
            }).catch((e) => { console.warn('[ChatStream] TTS 后台生成失败:', (e as Error)?.message || e); });
          }
        } catch (e) {
          incrTTS?.abort();
          // 🔴 阶段 A: 终态必带结构化错误码 + 可读原因；SSE 同步透出，前端据此渲染
          const classified = classifyJobError(e);
          job.status = 'error';
          job.error = (e as Error)?.message || String(e);
          job.error_code = classified.error_code;
          job.reason = classified.reason;
          job.terminalAt = Date.now();
          deps.pushToSSEClients?.('chat-error', {
            job_id: jobId,
            error: job.error,
            error_code: job.error_code,
            reason: job.reason,
          });
          console.warn('[ChatStream] error: ' + jobId, job.error, 'code=' + job.error_code);
        }
      })();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ stream: true, job_id: jobId, poll_hint_ms: getRetrievalFusionConfig()?.p1_speed?.streaming?.poll_hint_ms ?? 150 }));
      return true;
    }

    const result = await processChat(body.message.trim(), body.client_msg_id, body.test_mode === true);

    // TTS 生成 — 长文分段滚动播报（V12.5，P1-5 抽 helper 与流式路径共用）
    const { audio_url, audio_urls, tts_job } = await buildTTSResult(result.reply || '', body.tts !== false, DATA_DIR);
    // 安全序列化：防止循环引用导致 JSON.stringify 抛异常
    const safeResult = _sanitizeForJSON(result);
    const safeObject = (safeResult && typeof safeResult === 'object' && !Array.isArray(safeResult)) ? safeResult : {};
    // P2-2: UI 显示 — 附带当前聊天对象状态（chat_state 不进 ChatResponse 核心结构，仅路由层附加）
    const chat_state = buildChatState(deps.entityMeeting);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...(safeObject as Record<string, unknown>), chat_state, audio_url, audio_urls, tts_job }));
    } catch (err) {
      console.error('[ChatRoute] /api/chat 异常:', (err as Error)?.message || err);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply: '抱歉，出了一点小问题，请再说一次好吗？', turn_count: 0, error: 'chat_route_error' }));
    }
    return true;
  }

  // ── TTS job 状态轮询（S4 P1-2 异步长文音频） ──
  if (req.method === 'GET' && url.pathname === '/api/tts/status') {
    const jobId = (url.searchParams.get('job') || '').trim();
    const job = jobId ? getTTSJob(jobId) : null;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: !!job, done: job?.done ?? false, audio_urls: job?.urls ?? [] }));
    return true;
  }

  // ── 🔴 P1-5 流式聊天 job 状态轮询（路径 B 兜底：SSE 断开时轮询补齐） ──
  if (req.method === 'GET' && url.pathname === '/api/chat/job/status') {
    const jobId = (url.searchParams.get('job') || '').trim();
    const job = jobId ? getChatJob(jobId) : null;
    if (!job) {
      // 🔴 阶段 A: 原先只回 {ok:false} —— 前端所有 dd.ok&& 分支都不进，空转到 60s 硬超时，
      //   且无法区分「任务过期被回收」与「任务 id 从来不存在」。必须给出可归因的原因。
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        status: 'expired',
        error_code: 'deadline_exceeded' as JobErrorCode,
        reason: '任务已过期或不存在，无法继续接收回复',
      }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      status: job.status,
      reply: job.reply,
      tokens: job.tokens,   // S4-m11: SSE 断开时轮询一次性取回补齐中间 token
      result: job.result,
      audio_url: job.audio?.audio_url ?? null,
      audio_urls: job.audio?.audio_urls ?? [],
      tts_job: job.audio?.tts_job ?? null,
      audio_done: !!job.audio_done,
      error: job.error || null,
      // 🔴 阶段 A: 终态必带结构化码 + 可读原因（前端据此渲染，禁止退回裸 `…`）
      error_code: job.error_code ?? null,
      reason: job.reason ?? null,
      age_ms: Date.now() - job.createdAt,
    }));
    return true;
  }

  // ── 撤回消息 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/recall') {
    try {
      const body = JSON.parse(await readBody(req));
      const messageId = body.message_id;
      if (!messageId) { res.writeHead(400); res.end(JSON.stringify({ error: 'message_id required', ok: false })); return true; }
      const idx = (conversationHistory as any[]).findIndex((t: any) => t.id === messageId);
      if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: '消息不存在或已撤回', ok: false })); return true; }
      const entry = (conversationHistory as any)[idx];
      if (Date.now() - new Date(entry.timestamp).getTime() > 30000) { res.writeHead(410); res.end(JSON.stringify({ error: '超过30秒，无法撤回', ok: false })); return true; }
      if (entry.role !== 'user') { res.writeHead(400); res.end(JSON.stringify({ error: '只能撤回自己的消息', ok: false })); return true; }
      conversationHistory.splice(idx, 1);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message, ok: false })); }
    return true;
  }

  // ── 清除测试对话 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/purge-test') {
    try {
      const sqlite = storage.getSQLite();
      if (sqlite) {
        sqlite.writeRaw("BEGIN");
        sqlite.writeRaw("DELETE FROM conversations WHERE is_test=1");
        const result = sqlite.queryAll("SELECT changes() as cnt");
        const count = (result[0]?.cnt || 0) as number;
        try {
          const rows = sqlite.queryAll("SELECT role, content, timestamp FROM conversations WHERE is_test = 0 OR is_test IS NULL ORDER BY rowid DESC LIMIT 100");
          sqlite.writeRaw("COMMIT");
          if (rows.length > 0) {
            deps.conversationHistory.length = 0;
            deps.conversationHistory.push(...rows.reverse().map(r => ({ role: r.role as 'user' | 'assistant', content: r.content as string, timestamp: r.timestamp as string })));
          }
        } catch (e) { sqlite.writeRaw("ROLLBACK"); throw e; }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, deleted: count }));
      } else { res.writeHead(200); res.end(JSON.stringify({ ok: true, deleted: 0 })); }
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err), ok: false })); }
    return true;
  }

  // ── 候选回复偏好 ──
  if (req.method === 'POST' && url.pathname === '/api/chat/prefer-candidate') {
    try {
      const body = JSON.parse(await readBody(req));
      if (m6 && body.tags && Array.isArray(body.tags)) {
        for (const tag of body.tags) { m6.prefs.recordMention(tag, 0.8); }
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(200); res.end(JSON.stringify({ ok: false })); }
    return true;
  }

  // ── 聊天 SSE 流式 ──
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const rawMessage = url.searchParams.get('message') || '';
    if (!rawMessage) { res.writeHead(400); res.end(JSON.stringify({ error: 'message required' })); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(`: keepalive\n\n`);
    res.flushHeaders?.();
    const result = await processChat(rawMessage.trim());
    const rps = result.reply || '';
    const sentences = rps.split(/(?<=[。！？\n])/g).filter(Boolean).map((s: string) => s.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(sentences.length, 3); i++) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: sentences[i] })}\n\n`);
      await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    }
    if (sentences.length > 3) {
      res.write(`data: ${JSON.stringify({ type: 'text', content: sentences.slice(3).join('') })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'done', content: rps })}\n\n`);
    res.end();
    return true;
  }

  // ── 清除对话历史（仅清前端缓存，不动数据库） ──
  if (req.method === 'POST' && url.pathname === '/api/chat/clear') {
    try {
      // 只清内存中的 conversationHistory，不删数据库
      deps.conversationHistory.length = 0;
      deps.saveConversationHistory();
      console.log('[Clear] 前端缓存已清除');
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
    return true;
  }

  // ── 重置 ──
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    maintenance.stop();
    await resetPipeline();
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', message: '已重置' }));
    return true;
  }

  // ── 状态 ──
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const storageStatus = await storage.getStatus().catch(() => null);
    const familySummary = await familyGraph.getFamilySummary().catch(() => ({ members: [], locations: [] }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'running', version: '0.1.0',
      conversation_turns: Math.floor(conversationHistory.length / 2),
      storage: storageStatus ? { total_records: storageStatus.totalRecords, zone_counts: storageStatus.zoneCounts, seq_pos: storageStatus.currentSeqPos } : null,
      family: { members: familySummary.members.map((m: any) => ({ name: m.name, relation: m.relation_to_user })), total: familySummary.members.length },
    }));
    return true;
  }

  // ── 对话历史（优先返回 conversationHistory，被清除后返回空） ──
  if (req.method === 'GET' && url.pathname === '/api/conversation') {
    try {
      // 🔑 优先返回内存中的 conversationHistory（尊重用户清除操作）
      //    如果内存为空（用户点过清除按钮或新窗口），不再回退到数据库
      if (deps.conversationHistory.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ turns: [] }));
        return true;
      }
      const turns = deps.conversationHistory
        .filter((t: any) => t.role === 'user' || t.role === 'assistant')
        .map((t: any) => ({ role: t.role, content: t.content, timestamp: t.timestamp }));
      // P2-2: 附带当前聊天对象状态（前端打开页面时初始化顶部状态栏）
      const chat_state = buildChatState(deps.entityMeeting);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ turns, chat_state }));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: (err as Error).message })); }
    return true;
  }

  return false;
}

/** 安全序列化：防止循环引用 / BigInt / undefined 等导致 JSON.stringify 抛异常 */
function _sanitizeForJSON(obj: unknown): unknown {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'undefined') return null;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }));
}

function readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ✅ V10.0: 确保 readBodyWithBytes 被导出并被外部引用 🔴
// 此函数供 handleChatRoutes 调用，不要在最终编译产物中丢失

/** 🔧 V10.1: 读取原始字节 + 解码字符串，供字节级会晤触发使用 */
function readBodyWithBytes(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<{ rawBody: Buffer; text: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      resolve({ rawBody, text: rawBody.toString() });
    });
    req.on('error', reject);
  });
}

// 🔴 P0-4.1: _triggerMeetingFromBytes 已废弃删除——字节级/文本级人名匹配触发会晤，
// 导致"普通消息提到人名即误切"的跨实体污染。会晤切换统一由 chat.ts 的
// EntityMeeting.detectUserIntent（精准句式）处理。
