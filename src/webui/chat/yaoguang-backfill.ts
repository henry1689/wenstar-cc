/**
 * yaoguang-backfill.ts — 瑶光客观维异步回填队列（fire-and-forget）
 * ============================================================
 * M3 直接产出 40D 语义维（D09/D12/D14/D15/D17/D19/D33-D40）后，
 * 客观维（D01-D08 肉身 / D21-D32 时空成长）由瑶光 wf_perception_filter
 * 提供 medical 原始值 → 归一化填充。
 *
 * 🔴 设计约束（历史铁律表述「40D 走 24D 原路径」；现行：《40D 量纲统一法令》40D 唯一合法，中间层 P074 待废 + 瑶光延迟容忍）：
 *   - fire-and-forget：绝不内联阻塞 chat 主链（瑶光最坏 ~47s）
 *   - 并发上限 1 + 按 dnaRootId 单飞去重
 *   - 瑶光不可达/未就绪 → 静默跳过（保持 M3 语义维 40D，14 维非零）
 *   - 归一化由 YaoguangNormalizer 纯函数完成（锚点 = 瑶光 standard_range）
 */
import type { PerceptionV40 } from '../../m3/types/perception-40d.js';
import { fillObjectiveDims } from '../../m2/YaoguangNormalizer.js';
import { encodePerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';

export interface YaoguangBackfillJob {
  /** 🔴 S4-P1 修复：调用方 ChatContext（含 storage，用于写 perception_40d 列）。
   *  由 enqueueYaoguangBackfill 注入，调用方无需传。 */
  ctx?: any;
  /** DNA 根码（瑶光 wf_perception_filter 硬性要求，非空） */
  dnaRootId: string;
  /** 全局锚点 */
  globalUid?: string;
  /** 区位指纹（32 位 hex，瑶光硬性要求） */
  locationFingerprint: string;
  sceneTags?: string[];
  /** 在场人员（dna.entity_genes 中的 person 名，非"我"） */
  interpersonalLabels?: string[];
  /** 当前用户消息 */
  rawInputText: string;
  /** 要回填的 memory id 列表（[idUser, idAssist]） */
  memoryIds: string[];
  /** M3 产出的 40D 语义维基底 */
  p40Semantic: PerceptionV40;
}

// ── 模块级队列状态 ──────────────────────────────
let _queue: YaoguangBackfillJob[] = [];
let _processing = false;
let _inFlight = new Set<string>(); // dnaRootId 单飞去重

// ── 🛰️ 2026-08-24 和风真实天气 → 公共模块（chat.ts 共用，30分钟缓存+重试）──
import { getRealWeather } from '../../common/weather.js';

/** 写入 perception_40d 列（经 SQLite writeRaw） */
async function _writeP40(
  ctx: any,
  memoryId: string,
  p40: PerceptionV40,
): Promise<void> {
  try {
    const sqlite = ctx.storage?.getSQLite?.() ?? ctx.sqlite ?? ctx.storage?.sqlite;
    if (!sqlite?.writeRaw) return;
    sqlite.writeRaw(
      'UPDATE memories SET perception_40d = ? WHERE id = ?',
      encodePerceptionV40(p40),
      memoryId,
    );
  } catch (e) {
    console.warn('[YaoguangBackfill] 写 perception_40d 失败:', (e as Error)?.message);
  }
}

/** 取瑶光客户端：ctx.masterHarris → globalThis.__masterHarris */
function _getMasterHarris(ctx: any): any {
  return ctx?.masterHarris ?? (globalThis as any).__masterHarris ?? null;
}

async function _processNext(): Promise<void> {
  if (_processing) return;
  _processing = true;
  try {
    while (_queue.length > 0) {
      const job = _queue.shift()!;
      try {
        // 🔴 S4-P1 修复：用 job.ctx 解析 sqlite / masterHarris（此前 ctx 被丢弃 → 回填永不落库）
        const mh = _getMasterHarris(job.ctx);
        // 1. 客户端未就绪 → 跳过（保持 M3 语义维 40D）
        if (!mh?.tianquanReady) {
          console.warn('[YaoguangBackfill] 天权 RPC 未就绪，跳过本轮回填');
          continue;
        }
        // 2. 拉瑶光客观 40D + 瑶灵主观 40D（include_yaoling=true，双域全采）
        // 🛰️ 2026-08-24 和风真实天气（先取再传，避免 Promise 序列化为 {}）
        const _wx = await getRealWeather();
        if (_wx) console.log('[QWeather] 回填天气: ' + _wx.summary);
        const res = await mh.collect40DSnapshot(
          {
            dna_root_id: job.dnaRootId,
            global_uid: job.globalUid,
            location_fingerprint: job.locationFingerprint,
            scene_tags: job.sceneTags,
            interpersonal_labels: job.interpersonalLabels,
            raw_input_text: job.rawInputText,
            scene_desc: job.rawInputText,
            environmental_params: _wx ? { temperature: _wx.temperature, humidity: _wx.humidity, weather_text: _wx.weather_text, weather_raw: _wx.weather_raw, wind_dir: _wx.wind_dir, wind_scale: _wx.wind_scale } : undefined,
            temporal_context: _wx ? { weather_raw: _wx.weather_raw } : undefined,
          },
          { include_yaoling: true, timeout_ms: 30_000 },
        );
        // 3. 失败/无 objective → 跳过
        const objective = res?.yaoguang?.snapshot?.objective as
          | Record<string, { standard_value?: number; standard_range?: [number, number] }>
          | undefined;
        if (res?.code !== 0 || !objective) {
          console.warn('[YaoguangBackfill] 瑶光返回失败或缺失 objective，跳过');
          continue;
        }
        // 4. 融合：M3 语义维 + 瑶光客观维 → 写回各 memory
        const merged = fillObjectiveDims(job.p40Semantic, objective);
        for (const memoryId of job.memoryIds) {
          await _writeP40(job.ctx, memoryId, merged);
        }
        console.log(`[YaoguangBackfill] ✅ ${job.dnaRootId} 客观维回填完成（${job.memoryIds.length} 条）`);
      } finally {
        // 🔴 S4-P3 修复：无论成功/跳过/异常，都释放单飞去重（防泄漏）
        _inFlight.delete(job.dnaRootId);
      }
    }
  } catch (e) {
    console.warn('[YaoguangBackfill] 处理异常:', (e as Error)?.message);
  } finally {
    _processing = false;
    // 处理期间又有新任务入队 → 继续
    if (_queue.length > 0) void _processNext();
  }
}

/**
 * 入队瑶光客观维回填（fire-and-forget）。
 * 在 persistence-stage persistConversation 写完成 idUser/idAssist 后调用。
 */
export function enqueueYaoguangBackfill(ctx: any, job: YaoguangBackfillJob): void {
  // 单飞去重：同一 dnaRootId 只排一次（防并发重复拉瑶光）
  if (_inFlight.has(job.dnaRootId) || _queue.some(j => j.dnaRootId === job.dnaRootId)) {
    return;
  }
  // 🔴 S4-P1 修复：ctx 合入 job（_processNext 用 job.ctx 解析 sqlite / masterHarris）
  job.ctx = ctx;
  _inFlight.add(job.dnaRootId);
  _queue.push(job);
  void _processNext();
}

/** 测试辅助：清空队列 */
export function _resetBackfillQueue(): void {
  _queue = [];
  _processing = false;
  _inFlight.clear();
}
