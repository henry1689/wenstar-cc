/**
 * BlockSummaryService — B 链路对话组摘要生成器（T002 Phase 1）
 * ============================================================
 * 职责：为 `dialog_groups.block_summary` 补三层摘要，并把它写入 n-gram 倒排索引，
 *       使摘要**既是召回入口，也是注入内容**（双通道召回的另一半在 DialogGroupAdapter）。
 *
 * 🔴 为什么异步、不放在闭组热路径
 *   闭组（flushDialogGroup）是对话响应链路的一部分，加一次 LLM 调用会直接拖慢用户感知。
 *   闭组仍然只写 NULL；本服务在后台按批扫描 `block_summary IS NULL` 的组。
 *   无待处理组时**一次 LLM 都不调用**（符合「Harness 零 LLM 监控」铁律：监控本身零 LLM）。
 *
 * 🔴 断点续传靠数据库，不靠内存队列
 *   扫描条件就是「还没摘要的组」，进程重启后自动接着跑；不需要额外的任务表或内存队列。
 *   失败计数只在进程内保存（重启后重置），最坏情况是每组每次重启最多再试 maxAttempts 次。
 *
 * 🔴 写入必须经运行中的服务
 *   本服务只通过传入的 SQLiteAdapter 写入（writeRaw 触发防抖落盘）。
 *   禁止另起 sql.js 实例离线改库 —— 内存库 flush 会覆盖磁盘（本仓已有 229MB→3.9MB 事故记录）。
 *
 * 摘要格式（T002 三层）：
 *   【标签】关键词 5-10 个
 *   【叙事】2-3 句概括
 *   【情感】主情绪 + 情感走向
 *   注：`narrative_tag` 列承载的是 BlockDecayClass（衰减类别），**不**用摘要覆盖它。
 *
 * 状态机（`summary_state` 列，migration v20）：
 *   NULL/''  待生成
 *   done     已生成
 *   skipped  组内文本过短（< minChars），不值得消耗 token
 *   failed   连续失败达上限；**仍可通过原文通道召回**，只是没有摘要
 */

import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { buildNgrams } from '../../m4/SearchIndexBuilder.js';

/** 与 ProfileAcquisitionEngine.RawLLMCaller 同签名，复用 server.ts 的 llmProvider.rawCall */
export type BlockSummaryRawCaller = (
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  temperature?: number,
) => Promise<string>;

export interface BlockSummaryServiceOptions {
  /** 惰性取 SQLiteAdapter（server 初始化期 storage 才赋值） */
  getSql: () => SQLiteAdapter | null;
  rawCall: BlockSummaryRawCaller;
  /** 后台扫描间隔，默认 5 分钟 */
  intervalMs?: number;
  /** 单批最多处理多少组，默认 50（业主确认的分批粒度） */
  batchSize?: number;
  /** 组内文本低于该字符数 → 标 skipped，默认 120（过滤纯寒暄） */
  minChars?: number;
  /** 失败重试上限（进程内），默认 3 */
  maxAttempts?: number;
  /** 首次启动延迟，默认 30 秒（避开服务启动高峰） */
  initialDelayMs?: number;
}

export interface BlockSummaryBatchResult {
  scanned: number;
  done: number;
  skipped: number;
  failed: number;
  pending: number;
}

/** search_index 的 source_type；与 DialogGroupAdapter 共用同一字面量 */
export const BLOCK_SUMMARY_SOURCE_TYPE = 'dialog_group';

/** 摘要上限：过长会稀释 n-gram 精度，也拉高注入 token */
const MAX_SUMMARY_CHARS = 600;

export class BlockSummaryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private attempts = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly minChars: number;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;

  constructor(private readonly opts: BlockSummaryServiceOptions) {
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.batchSize = opts.batchSize ?? 50;
    this.minChars = opts.minChars ?? 120;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.initialDelayMs = opts.initialDelayMs ?? 30_000;
  }

  /** 启动后台定时器（幂等）。定时器 unref，不阻止进程退出。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runBatch().catch((e) => console.warn('[BlockSummary] 批处理异常:', (e as Error)?.message));
    }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();

    this.initialTimer = setTimeout(() => {
      void this.runBatch()
        .then(() => this.selfCheck())
        .catch((e) => console.warn('[BlockSummary] 首轮异常:', (e as Error)?.message));
    }, this.initialDelayMs);
    (this.initialTimer as unknown as { unref?: () => void }).unref?.();
    console.log(`[BlockSummary] 已启动（每 ${Math.round(this.intervalMs / 60000)} 分钟一批 ${this.batchSize} 组）`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
  }

  /**
   * 跑一批：扫描 → 生成 → 写库 → 建索引。
   * 同一时刻只允许一个批次（防定时器重叠）；重叠时直接返回空结果。
   */
  async runBatch(): Promise<BlockSummaryBatchResult> {
    const empty: BlockSummaryBatchResult = { scanned: 0, done: 0, skipped: 0, failed: 0, pending: 0 };
    if (this.running) return empty;
    const sql = this.opts.getSql();
    if (!sql) return empty;

    this.running = true;
    let done = 0;
    let skipped = 0;
    let failed = 0;
    let scanned = 0;
    try {
      const rows = sql.queryAll<{ dialog_group_id: string; block_close_reason: string | null }>(
        "SELECT dialog_group_id, block_close_reason FROM dialog_groups " +
        "WHERE block_summary IS NULL AND (summary_state IS NULL OR summary_state = '') " +
        "ORDER BY first_ts ASC LIMIT ?",
        [this.batchSize],
      );
      scanned = rows.length;

      for (const row of rows) {
        const dgId = String(row.dialog_group_id);
        try {
          const outcome = await this.generateOne(sql, dgId, row.block_close_reason ?? '');
          if (outcome === 'done') done++;
          else skipped++;
        } catch (e) {
          failed++;
          const n = (this.attempts.get(dgId) || 0) + 1;
          this.attempts.set(dgId, n);
          console.warn(`[BlockSummary] ${dgId} 生成失败 ${n}/${this.maxAttempts}:`, (e as Error)?.message);
          // 达到上限才标 failed；否则留 NULL，下一批自动重试（天然断点续传）
          if (n >= this.maxAttempts) {
            this.markState(sql, dgId, 'failed');
            this.attempts.delete(dgId);
          }
        }
      }

      const pending = this.countPending(sql);
      // R012 铁律2：运行时自检 —— 每批结束检查格式契约违例，>0 必须可见
      const violations = this.countContractViolations(sql);
      if (scanned > 0) {
        console.log(
          `[BlockSummary] 批完成: 扫描${scanned} 成功${done} 跳过${skipped} 失败${failed} 待处理${pending}` +
          (violations > 0 ? ` ⚠️契约违例${violations}` : ''),
        );
        if (violations > 0) {
          console.warn(`[BlockSummary] ⚠️ 格式契约违例 ${violations} 组（done 中缺【标签】/【叙事】/【情感】任一层）`);
        }
      }
      return { scanned, done, skipped, failed, pending };
    } finally {
      this.running = false;
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async generateOne(sql: SQLiteAdapter, dgId: string, closeReason: string): Promise<'done' | 'skipped'> {
    // R011 任务A(4)：meeting_entry 是「叫 XX 聊聊」这类会晤入口指令，无实质对话内容，
    // 生成摘要也是废话，直接标 skipped，不消耗 LLM。
    if (closeReason === 'meeting_entry') {
      this.markState(sql, dgId, 'skipped', 'meeting_entry_no_llm');
      return 'skipped';
    }

    const convs = sql.queryAll<{ role: string; content: string }>(
      'SELECT role, content FROM conversations ' +
      'WHERE dialog_group_id = ? AND (is_test IS NULL OR is_test = 0) ' +
      'ORDER BY timestamp ASC, seq_pos ASC',
      [dgId],
    );
    if (convs.length === 0) {
      this.markState(sql, dgId, 'skipped');
      return 'skipped';
    }

    // 单条截断 500 字：摘要只需要语义骨架，原文仍完整保留在 conversations
    const transcript = convs
      .map((c) => `${c.role === 'user' ? '用户' : '玉瑶'}: ${String(c.content || '').slice(0, 500)}`)
      .join('\n');

    if (transcript.replace(/\s/g, '').length < this.minChars) {
      this.markState(sql, dgId, 'skipped');
      return 'skipped';
    }

    // 🔴 R012 铁律2 / R013-A2(1)：格式契约必须是【标签】【叙事】【情感】三层齐全。
    //   解析失败 → 用更严格提示重试一次；仍不完整 → 标 skipped 并记录原因，
    //   **不再把原始文本包成【叙事】伪造契约**（那是现象级兜底，掩盖问题）。
    let parsed = this.formatSummary(await this.callLLM(transcript, false));
    if (!parsed.complete) {
      const retry = this.formatSummary(await this.callLLM(transcript, true));
      if (retry.complete) parsed = retry;
      else if (!parsed.text && retry.text) parsed = retry;
    }
    if (!parsed.complete) {
      const reason = parsed.text ? 'llm_unstructured_after_retry' : 'llm_empty';
      this.markState(sql, dgId, 'skipped', reason);
      console.warn(`[BlockSummary] ${dgId} 三层契约未达成（${reason}），已标 skipped`);
      return 'skipped';
    }
    const summary = parsed.text;

    const meta = sql.queryAll<{ belong_entity_uuid: string | null }>(
      'SELECT belong_entity_uuid FROM dialog_groups WHERE dialog_group_id = ?',
      [dgId],
    )[0];
    const uuid = meta?.belong_entity_uuid ?? null;

    sql.writeRaw(
      'UPDATE dialog_groups SET block_summary = ?, summary_state = ?, updated_at = ? WHERE dialog_group_id = ?',
      summary, 'done', new Date().toISOString(), dgId,
    );
    this.indexSummary(sql, dgId, summary, uuid);
    this.attempts.delete(dgId);
    return 'done';
  }

  /**
   * 调用 LLM 生成摘要。strict=true 用于「第一次未按 JSON 返回」后的重试：
   * 只允许输出 JSON，禁止解释 / Markdown 代码块 / 前后缀。
   */
  private async callLLM(transcript: string, strict: boolean): Promise<string> {
    const system = strict
      ? '只输出一个 JSON 对象。禁止输出任何解释、Markdown 代码块、前后缀或额外文字。'
      : '你是记忆索引助手。把一段对话压缩成便于日后检索的摘要；只输出 JSON，不解释、不扮演角色、不编造未出现的信息。';
    const user = strict
      ? '严格输出 JSON（不要代码块）：{"tags":["5-10个检索关键词"],"narrative":"2-3句话概括","emotion":"主情绪与情感走向"}\n\n' +
        `对话原文：\n${transcript}`
      : '请输出 JSON：{"tags":["5-10个检索关键词"],"narrative":"2-3句话概括这段对话讲了什么","emotion":"主情绪与情感走向"}\n\n' +
        `对话原文：\n${transcript}`;
    // R011 任务A(1)：400 → 600，避免截断
    return this.opts.rawCall(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      600,
      0.2,
    );
  }

  /** 是否满足三层格式契约（【标签】【叙事】【情感】全部存在） */
  private isStructured(summary: string): boolean {
    const s = String(summary || '');
    return s.includes('【标签】') && s.includes('【叙事】') && s.includes('【情感】');
  }

  /**
   * 解析 LLM 输出为三层摘要。
   * 返回 complete=false 表示三层不齐（调用方据此标 skipped，不伪造格式）。
   */
  private formatSummary(raw: string): { text: string; complete: boolean } {
    const text = String(raw || '').trim();
    if (!text) return { text: '', complete: false };
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed: Record<string, unknown> | null = null;
    const l = cleaned.indexOf('{');
    const r = cleaned.lastIndexOf('}');
    if (l >= 0 && r > l) {
      try { parsed = JSON.parse(cleaned.slice(l, r + 1)) as Record<string, unknown>; }
      catch { parsed = null; }
    }

    let out = '';
    if (parsed) {
      const tags = Array.isArray(parsed.tags)
        ? (parsed.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
        : [];
      const narrative = String(parsed.narrative ?? '').trim();
      const emotion = String(parsed.emotion ?? '').trim();
      if (tags.length > 0) out += `【标签】${tags.join('、')}\n`;
      if (narrative) out += `【叙事】${narrative}\n`;
      if (emotion) out += `【情感】${emotion}`;
      out = out.trim();
    }
    // 解析失败时保留原文仅为「可诊断」；complete=false ⇒ 调用方标 skipped，不会写库
    if (!out) out = cleaned;

    if (out.replace(/\s/g, '').length < 10) return { text: '', complete: false };
    const bounded = out.slice(0, MAX_SUMMARY_CHARS);
    return { text: bounded, complete: this.isStructured(bounded) };
  }

  /**
   * 摘要写入 search_index（source_type='dialog_group'）。
   * 🔴 摘要不是 conversations 的聚合副本，而是**新增内容** —— 故必须单独建索引，
   *    否则「原文没有字面命中、只有摘要能命中」的查询永远召不回该组。
   */
  private indexSummary(sql: SQLiteAdapter, dgId: string, summary: string, uuid: string | null): void {
    const grams = buildNgrams(summary);
    for (let i = 0; i < grams.length; i++) {
      sql.writeRaw(
        'INSERT OR REPLACE INTO search_index (term, source_type, source_id, belong_entity_uuid, position) ' +
        'VALUES (?, ?, ?, ?, ?)',
        grams[i], BLOCK_SUMMARY_SOURCE_TYPE, String(dgId), uuid, i,
      );
    }
  }

  private markState(sql: SQLiteAdapter, dgId: string, state: 'failed' | 'skipped', error?: string): void {
    try {
      sql.writeRaw(
        'UPDATE dialog_groups SET summary_state = ?, summary_error = ?, updated_at = ? WHERE dialog_group_id = ?',
        state, error ?? null, new Date().toISOString(), dgId,
      );
    } catch (e) {
      console.warn('[BlockSummary] 状态写入失败:', (e as Error)?.message);
    }
  }

  /** done 组中三层不齐的数量（应为 0） */
  private countContractViolations(sql: SQLiteAdapter): number {
    const rows = sql.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dialog_groups WHERE summary_state='done' AND (" +
      "block_summary IS NULL OR block_summary NOT LIKE '%【标签】%' " +
      "OR block_summary NOT LIKE '%【叙事】%' OR block_summary NOT LIKE '%【情感】%')",
    );
    return Number(rows[0]?.n) || 0;
  }

  /**
   * 启动自检（R012 铁律2）：输出摘要格式契约合规率与 skipped/pending 规模。
   * 只读，不修改任何数据；异常静默（自检失败不影响主流程）。
   */
  selfCheck(): void {
    try {
      const sql = this.opts.getSql();
      if (!sql) return;
      const row = sql.queryAll<{ done: number; bad: number; skipped: number; pending: number }>(
        "SELECT " +
        "SUM(CASE WHEN summary_state='done' THEN 1 ELSE 0 END) AS done, " +
        "SUM(CASE WHEN summary_state='done' AND (block_summary IS NULL " +
        "  OR block_summary NOT LIKE '%【标签】%' OR block_summary NOT LIKE '%【叙事】%' " +
        "  OR block_summary NOT LIKE '%【情感】%') THEN 1 ELSE 0 END) AS bad, " +
        "SUM(CASE WHEN summary_state='skipped' THEN 1 ELSE 0 END) AS skipped, " +
        "SUM(CASE WHEN summary_state IS NULL OR summary_state='' THEN 1 ELSE 0 END) AS pending " +
        'FROM dialog_groups',
      )[0];
      const done = Number(row?.done) || 0;
      const bad = Number(row?.bad) || 0;
      const rate = done > 0 ? (((done - bad) / done) * 100).toFixed(1) : '100.0';
      const msg = `[BlockSummary] 启动自检: done=${done} 合规=${done - bad}(${rate}%) 违例=${bad} ` +
        `skipped=${Number(row?.skipped) || 0} pending=${Number(row?.pending) || 0}`;
      if (bad > 0) console.warn('⚠️ ' + msg);
      else console.log(msg);
    } catch (e) {
      console.warn('[BlockSummary] 启动自检跳过:', (e as Error)?.message);
    }
  }

  private countPending(sql: SQLiteAdapter): number {
    const rows = sql.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dialog_groups " +
      "WHERE block_summary IS NULL AND (summary_state IS NULL OR summary_state = '')",
    );
    return Number(rows[0]?.n) || 0;
  }
}
