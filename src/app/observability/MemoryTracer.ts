/**
 * MemoryTracer — 全链路记忆检索追踪器 (V10.0 P3-2)
 * ======================================================
 * 追踪每轮对话中记忆检索的完整路径：
 *   用户消息 → 检索参数 → 检索结果 → 去重 → 注入 LLM 的最终文本
 *
 * 用法：
 *   import { traceStart, traceEnd, traceInject } from './MemoryTracer.js';
 *   traceStart(message, perception);           // 记录起点
 *   traceRetrieval(memories, source);          // 记录检索结果
 *   traceInject(fragments, kbLen, finalLen);   // 记录注入
 *   const summary = traceEnd();                 // 输出摘要
 *
 * 输出格式：console.log + 可选的 JSON 持久化
 */
import type { PerceptionState24 } from '../../m3/types/perception.js';
import { ConfigService } from '../../config/ConfigService.js';

interface TraceSpan {
  message: string;
  timestamp: number;
  perception?: { pleasure: number; intimacy: number; arousal: number; calcium?: number };
  retrieval: Array<{ source: string; count: number; topSummary: string }>;
  inject: { fragmentCount: number; timelineCount: number; kbChars: number; finalChars: number };
  elapsedMs: number;
}

let _currentSpan: Partial<TraceSpan> | null = null;
let _startTime = 0;

const ENABLED = !ConfigService.getBool('WS_DISABLE_MEMORY_TRACER');

/** 开始追踪一轮对话 */
export function traceStart(message: string, perception?: PerceptionState24): void {
  if (!ENABLED) return;
  _startTime = Date.now();
  _currentSpan = {
    message: message.substring(0, 100),
    timestamp: _startTime,
    perception: perception ? {
      pleasure: perception.pleasure ?? 0,
      intimacy: perception.intimacy ?? 0,
      arousal: perception.arousal ?? 0,
    } : undefined,
    retrieval: [],
    inject: { fragmentCount: 0, timelineCount: 0, kbChars: 0, finalChars: 0 },
    elapsedMs: 0,
  };
}

/** 记录一次检索结果 */
export function traceRetrieval(source: string, count: number, topSummary?: string): void {
  if (!_currentSpan) return;
  _currentSpan.retrieval!.push({
    source,
    count,
    topSummary: (topSummary || '').substring(0, 80),
  });
}

/** 记录记忆注入 */
export function traceInject(fragmentCount: number, timelineCount: number, kbChars: number, finalChars: number): void {
  if (!_currentSpan) return;
  _currentSpan.inject = { fragmentCount, timelineCount, kbChars, finalChars };
}

/** 结束追踪并输出摘要 */
export function traceEnd(replyLength?: number): string | null {
  if (!_currentSpan) return null;
  _currentSpan.elapsedMs = Date.now() - _startTime;

  const s = _currentSpan;
  const totalRetrieved = s.retrieval!.reduce((sum, r) => sum + r.count, 0);
  const injected = s.inject!.fragmentCount + s.inject!.timelineCount;

  const summary = [
    `[Trace] "${s.message}"`,
    `  感知: P=${(s.perception?.pleasure ?? 0).toFixed(2)} I=${(s.perception?.intimacy ?? 0).toFixed(2)}`,
    `  检索: ${totalRetrieved}条 (${s.retrieval!.map(r => `${r.source}:${r.count}`).join(' ')})`,
    `  注入: ${injected}条记忆 + ${s.inject!.kbChars}chars KB → 最终${s.inject!.finalChars}chars`,
    `  回复: ${replyLength ?? '?'}字 | ${s.elapsedMs}ms`,
  ].join('\n');

  console.log(summary);

  // 持久化（JSON 行格式，追加到文件）— 异步 fire-and-forget
  if (ConfigService.getBool('WS_SAVE_TRACE_LOG')) {
    import('node:fs').then(({ appendFileSync, existsSync, mkdirSync }) => {
      import('node:path').then(({ join }) => {
        try {
          const dir = ConfigService.get('TRACE_LOG_DIR', 'data/traces');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const file = join(dir, `trace-${new Date().toISOString().substring(0, 10)}.jsonl`);
          appendFileSync(file, JSON.stringify({
            msg: s.message, ts: new Date(s.timestamp!).toISOString(),
            p: s.perception, ret: s.retrieval, inj: s.inject,
            replyLen: replyLength ?? 0, ms: s.elapsedMs,
          }) + '\n');
        } catch { /* 文件写入失败不阻塞 */ }
      });
    }).catch(() => {});
  }

  const span = _currentSpan;
  _currentSpan = null;
  return summary;
}

/** 获取当前 Span（供外部读取） */
export function currentSpan(): Partial<TraceSpan> | null {
  return _currentSpan;
}

/** 是否启用 */
export function isTracing(): boolean {
  return ENABLED && _currentSpan !== null;
}
