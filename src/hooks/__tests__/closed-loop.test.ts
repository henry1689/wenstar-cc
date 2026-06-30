/**
 * S4.3 🥇 最小闭环验证
 *
 * 验证核心链路：1 个埋点 → 入库 → 规则分析 → 指令生成 → AutoRec 执行 → 状态回写
 *
 * 不启动 HTTP 服务，纯单元测试验证闭环逻辑
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import { insertEvent, getPendingCommands, createCommand, analyze, updateCommandStatus } from '../backend.js';
import type { HookEvent } from '../types.js';
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';

describe('最小闭环验证', () => {
  let sqlite: any;

  beforeAll(async () => {
    // 创建内存 SQLite
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    sqlite = {
      writeRaw: (sql: string, ...params: any[]) => db.run(sql, params),
      queryAll: (sql: string, params?: any[]) => {
        const stmt = db.prepare(sql);
        if (params) stmt.bind(params);
        const rows: any[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
    };

    // 建表
    db.run(`CREATE TABLE IF NOT EXISTS hooks_events (
      id TEXT PRIMARY KEY, dna_code TEXT, operation_type TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'success',
      input_tags TEXT, source_tier TEXT, target_tier TEXT,
      payload_size INTEGER DEFAULT 0, match_count INTEGER DEFAULT 0,
      error_info TEXT, created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS hooks_commands (
      id TEXT PRIMARY KEY, command_type TEXT NOT NULL, target_dna TEXT,
      target_module TEXT, status TEXT NOT NULL DEFAULT 'pending',
      source_analysis TEXT, payload TEXT,
      created_at TEXT NOT NULL, dispatched_at TEXT, done_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, raw_input TEXT, calcium_score REAL DEFAULT 0,
      recall_count INTEGER DEFAULT 0, promoted_to_diamond INTEGER DEFAULT 0,
      created_at TEXT
    )`);
    // 插入一条测试记忆
    db.run("INSERT INTO memories (id, raw_input, calcium_score, recall_count, promoted_to_diamond, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      ['mem_test_001', '今天真的很开心', 4.8, 0, new Date().toISOString()]);
  });

  it('🟢 步骤 1: 埋点触发 → Hooks 事件入库', () => {
    const event: HookEvent = {
      operation_type: 'module_encode',
      duration_ms: 42,
      status: 'success',
      dna_code: 'evt_test_001',
      timestamp: new Date().toISOString(),
    };
    const id = insertEvent(sqlite, event);
    expect(id).toBeTruthy();

    const rows = sqlite.queryAll('SELECT COUNT(*) as c FROM hooks_events');
    expect(rows[0].c).toBe(1);
  });

  it('🟢 步骤 2: 规则引擎分析 → 生成晋升指令', () => {
    const result = analyze(sqlite);
    expect(result.commands.length).toBeGreaterThanOrEqual(1);
    const promoteCmd = result.commands.find(c => c.command_type === 'promote');
    expect(promoteCmd).toBeDefined();
    expect(promoteCmd!.command_type).toBe('promote');
    expect(promoteCmd!.target_dna).toBe('mem_test_001');
  });

  it('🟢 步骤 3: 指令状态管理', () => {
    const cmds = getPendingCommands(sqlite);
    expect(cmds.length).toBeGreaterThanOrEqual(1);

    // 模拟 AutoRec 消费：更新为 done
    updateCommandStatus(sqlite, cmds[0].id, 'dispatched');
    updateCommandStatus(sqlite, cmds[0].id, 'done');

    const done = sqlite.queryAll("SELECT status FROM hooks_commands WHERE id = ?", [cmds[0].id]);
    expect(done[0]?.status).toBe('done');
  });

  it('🔄 全链路闭环验证', async () => {
    // 模拟完整链路：批量事件 → 分析 → 指令 → 执行
    const events: HookEvent[] = [
      { operation_type: 'module_clean', duration_ms: 12, status: 'success', timestamp: new Date().toISOString() },
      { operation_type: 'module_encode', duration_ms: 35, status: 'success', dna_code: 'evt_chain_001', timestamp: new Date().toISOString() },
      { operation_type: 'module_vector_align', duration_ms: 180, status: 'success', timestamp: new Date().toISOString() },
    ];
    for (const ev of events) insertEvent(sqlite, ev);

    const total = sqlite.queryAll('SELECT COUNT(*) as c FROM hooks_events');
    expect(total[0].c).toBe(4); // 1(之前) + 3

    // 分析 → 应产出指令
    const result = analyze(sqlite);
    console.log(`[闭环] 分析完成: ${result.summary}`);
    expect(result.commands).toBeDefined();
  });
});
