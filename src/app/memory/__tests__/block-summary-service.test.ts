/**
 * BlockSummaryService 回归测试（R013-A2(3) / R012 铁律2）
 *
 * 覆盖：
 *  1. 正常 JSON → done，三层齐全，写入索引
 *  2. 首次非 JSON、重试成功 → done（重试路径）
 *  3. 两次都不是 JSON → skipped + summary_error，不写摘要、不写索引（不伪造契约）
 *  4. meeting_entry → 直接 skipped，**不调用 LLM**
 *  5. 幂等：已生成的组不会被再次扫描
 *
 * 用 sql.js 建真实表结构，避免 mock SQL 语句导致测试与实际查询漂移。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { BlockSummaryService } from '../BlockSummaryService.js';

const VALID_JSON =
  '{"tags":["天气","周末","出游"],"narrative":"两人讨论周末天气并计划一起出门。","emotion":"轻松愉快"}';
const PROSE = '这是一段没有按 JSON 格式返回的普通文字内容，用于触发解析失败路径。';

let db: any;
let sql: any;

function addGroup(id: string, reason: string, opts: { content?: string; state?: string } = {}) {
  // 必须 > minChars(120)，否则会被「文本过短」分支提前标 skipped，测不到目标路径
  const content = opts.content ??
    '用户：周末天气怎么样？看起来不错，我们可以去海边走走，顺便带上相机拍点照片，' +
    '中午在附近找家小店吃饭，下午沿着海岸线散步，傍晚还能看日落，晚上再一起吃海鲜。\n' +
    '玉瑶：好呀，那我们准备一下，带上水和零食，下午三点出发，路线我提前查好了，' +
    '防晒和外套都别忘了，海边风大，回来可能会凉。';
  db.run(
    `INSERT INTO dialog_groups (dialog_group_id, belong_entity_uuid, block_close_reason, block_summary, summary_state, summary_error, first_ts, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, 'UUID-A', reason, null, opts.state ?? null, null, '2026-10-19T00:00:00Z', null],
  );
  db.run(
    `INSERT INTO conversations (dialog_group_id, role, content, timestamp, seq_pos, is_test, belong_entity_uuid)
     VALUES (?,?,?,?,?,?,?)`,
    [id, 'user', content, '2026-10-19T00:00:01Z', 1, 0, 'UUID-A'],
  );
  db.run(
    `INSERT INTO conversations (dialog_group_id, role, content, timestamp, seq_pos, is_test, belong_entity_uuid)
     VALUES (?,?,?,?,?,?,?)`,
    [id, 'assistant', '玉瑶：好呀，那我们准备一下。', '2026-10-19T00:00:02Z', 2, 0, 'UUID-A'],
  );
}

function makeService(rawCall: (m: any[], maxTokens?: number, temperature?: number) => Promise<string>) {
  return new BlockSummaryService({
    getSql: () => sql,
    rawCall,
    intervalMs: 60_000_000,
    initialDelayMs: 60_000_000,
  });
}

function groupRow(id: string) {
  return sql.queryAll('SELECT * FROM dialog_groups WHERE dialog_group_id=?', [id])[0];
}

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(`CREATE TABLE dialog_groups (
    dialog_group_id TEXT PRIMARY KEY,
    belong_entity_uuid TEXT,
    block_close_reason TEXT,
    block_summary TEXT,
    summary_state TEXT,
    summary_error TEXT,
    first_ts TEXT,
    updated_at TEXT,
    -- 🔴 P145（v31/v32 生产结构对齐）：摘要哈希与追加日志。
    --   缺这两列时 BlockSummaryService 的 UPDATE 会命中不存在的列，
    --   被 catch 吞掉后表现为「done=0」，测试红成「摘要没生成」——掩盖真实原因。
    summary_hash TEXT,
    append_log TEXT
  )`);
  db.run(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dialog_group_id TEXT,
    role TEXT,
    content TEXT,
    timestamp TEXT,
    seq_pos INTEGER,
    is_test INTEGER,
    belong_entity_uuid TEXT
  )`);
  db.run(`CREATE TABLE search_index (
    term TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    belong_entity_uuid TEXT,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (term, source_type, source_id)
  )`);

  sql = {
    queryAll: (q: string, p?: unknown[]) => {
      const st = db.prepare(q);
      if (p) st.bind(p as any);
      const rows: any[] = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return rows;
    },
    writeRaw: (q: string, ...params: unknown[]) => {
      const bind = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
      db.run(q, bind as any);
    },
  };
});

describe('BlockSummaryService 三层契约', () => {
  it('正常 JSON → done，三层齐全并写入索引', async () => {
    addGroup('DG_OK', 'topic_switch');
    const svc = makeService(async () => VALID_JSON);
    const r = await svc.runBatch();

    expect(r.done).toBe(1);
    const row = groupRow('DG_OK');
    expect(row.summary_state).toBe('done');
    expect(row.block_summary).toContain('【标签】');
    expect(row.block_summary).toContain('【叙事】');
    expect(row.block_summary).toContain('【情感】');
    const idx = sql.queryAll("SELECT COUNT(*) AS n FROM search_index WHERE source_type='dialog_group' AND source_id='DG_OK'")[0];
    expect(Number(idx.n)).toBeGreaterThan(0);
  });

  it('首次非 JSON、重试成功 → done', async () => {
    addGroup('DG_RETRY', 'topic_switch');
    let calls = 0;
    const svc = makeService(async () => (++calls === 1 ? PROSE : VALID_JSON));
    const r = await svc.runBatch();

    expect(calls).toBe(2);
    expect(r.done).toBe(1);
    expect(groupRow('DG_RETRY').block_summary).toContain('【叙事】');
  });

  it('两次都不是 JSON → skipped + summary_error，不写摘要/索引（不伪造契约）', async () => {
    addGroup('DG_BAD', 'topic_switch');
    const svc = makeService(async () => PROSE);
    const r = await svc.runBatch();

    expect(r.skipped).toBe(1);
    const row = groupRow('DG_BAD');
    expect(row.summary_state).toBe('skipped');
    expect(row.summary_error).toBe('llm_unstructured_after_retry');
    expect(row.block_summary).toBeNull();
    const idx = sql.queryAll("SELECT COUNT(*) AS n FROM search_index WHERE source_type='dialog_group' AND source_id='DG_BAD'")[0];
    expect(Number(idx.n)).toBe(0);
  });

  it('meeting_entry → 直接 skipped，不调用 LLM', async () => {
    addGroup('DG_MEET', 'meeting_entry');
    let calls = 0;
    const svc = makeService(async () => { calls++; return VALID_JSON; });
    const r = await svc.runBatch();

    expect(calls).toBe(0);
    expect(r.skipped).toBe(1);
    const row = groupRow('DG_MEET');
    expect(row.summary_state).toBe('skipped');
    expect(row.summary_error).toBe('meeting_entry_no_llm');
  });

  it('组内无对话 → skipped + no_conversations', async () => {
    db.run(
      `INSERT INTO dialog_groups (dialog_group_id, belong_entity_uuid, block_close_reason, block_summary, summary_state, summary_error, first_ts, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['DG_EMPTY', 'UUID-A', 'topic_switch', null, null, null, '2026-10-19T00:00:00Z', null],
    );
    const svc = makeService(async () => VALID_JSON);
    const r = await svc.runBatch();

    expect(r.skipped).toBe(1);
    const row = groupRow('DG_EMPTY');
    expect(row.summary_state).toBe('skipped');
    expect(row.summary_error).toBe('no_conversations');
  });

  it('文本过短 → skipped + text_too_short，不调用 LLM', async () => {
    addGroup('DG_SHORT', 'topic_switch', { content: '用户：在吗？\n玉瑶：在的。' });
    let calls = 0;
    const svc = makeService(async () => { calls++; return VALID_JSON; });
    const r = await svc.runBatch();

    expect(calls).toBe(0);
    expect(r.skipped).toBe(1);
    const row = groupRow('DG_SHORT');
    expect(row.summary_state).toBe('skipped');
    expect(row.summary_error).toBe('text_too_short');
  });

  it('幂等：已生成的组不会被再次扫描', async () => {
    addGroup('DG_IDEM', 'topic_switch');
    let calls = 0;
    const svc = makeService(async () => { calls++; return VALID_JSON; });
    await svc.runBatch();
    const r2 = await svc.runBatch();

    expect(calls).toBe(1);
    expect(r2.scanned).toBe(0);
    expect(r2.done).toBe(0);
  });
});
