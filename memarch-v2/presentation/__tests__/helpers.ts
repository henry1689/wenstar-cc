/**
 * 测试辅助：基于 better-sqlite3 内存库的 PathwayStore + 录制型 Fake Sinks。
 * 满足任务书"用 better-sqlite3 内存库跑测试"的要求。
 */

import Database from 'better-sqlite3';
import type {
  NormalizedEvidence,
  Pathway,
  PathwayStore,
  ReinforceSignal,
  ReinforceSink,
  WriteResult,
  WriteSink,
} from '../types.js';

export function makeInMemoryDB(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pathway_table (
      uuid TEXT PRIMARY KEY,
      pathway TEXT NOT NULL CHECK (pathway IN ('A','B')),
      boost REAL NOT NULL DEFAULT 0,
      reinforce_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE reinforce_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL,
      signal TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE write_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  return db;
}

export class SQLitePathwayStore implements PathwayStore {
  constructor(private db: Database.Database) {}

  getPathway(uuid: string): Pathway {
    const row = this.db.prepare('SELECT pathway FROM pathway_table WHERE uuid = ?').get(uuid) as
      | { pathway: Pathway }
      | undefined;
    return row?.pathway ?? 'B';
  }

  promoteToA(uuid: string, boost: number): void {
    this.db
      .prepare(
        `INSERT INTO pathway_table (uuid, pathway, boost, reinforce_count)
         VALUES (?, 'A', ?, 0)
         ON CONFLICT(uuid) DO UPDATE SET pathway='A', boost = boost + ?`,
      )
      .run(uuid, boost, boost);
  }

  getReinforcementCount(uuid: string): number {
    const row = this.db
      .prepare('SELECT reinforce_count FROM pathway_table WHERE uuid = ?')
      .get(uuid) as { reinforce_count: number } | undefined;
    return row?.reinforce_count ?? 0;
  }

  bumpReinforcement(uuid: string): number {
    // 不存在则插一条 B，再 +1
    this.db
      .prepare(
        `INSERT INTO pathway_table (uuid, pathway, boost, reinforce_count)
         VALUES (?, 'B', 0, 1)
         ON CONFLICT(uuid) DO UPDATE SET reinforce_count = reinforce_count + 1`,
      )
      .run(uuid);
    const row = this.db
      .prepare('SELECT reinforce_count FROM pathway_table WHERE uuid = ?')
      .get(uuid) as { reinforce_count: number };
    return row.reinforce_count;
  }

  seed(uuid: string, pathway: Pathway, reinforceCount = 0): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pathway_table (uuid, pathway, boost, reinforce_count)
         VALUES (?, ?, 0, ?)`,
      )
      .run(uuid, pathway, reinforceCount);
  }
}

export class RecordingReinforceSink implements ReinforceSink {
  calls: { uuid: string; signal: ReinforceSignal }[] = [];
  constructor(private db: Database.Database) {}
  reinforce(uuid: string, signal: ReinforceSignal): void {
    this.calls.push({ uuid, signal });
    this.db
      .prepare('INSERT INTO reinforce_log (uuid, signal, ts) VALUES (?, ?, ?)')
      .run(uuid, signal, Date.now());
  }
}

export class RecordingWriteSink implements WriteSink {
  writes: { message_id: string; role: string; content: string }[] = [];
  constructor(private db: Database.Database) {}
  write(input: {
    message_id: string;
    role: string;
    content: string;
    ts_utc?: number;
    namespace?: string;
  }): WriteResult {
    this.writes.push({ message_id: input.message_id, role: input.role, content: input.content });
    this.db
      .prepare('INSERT INTO write_log (message_id, role, content, ts) VALUES (?, ?, ?, ?)')
      .run(input.message_id, input.role, input.content, input.ts_utc ?? Date.now());
    return { trace_id: `trace_${input.message_id}`, gate: 'WRITE' };
  }
}

/** 构造测试用 NormalizedEvidence 便捷函数 */
export function ev(partial: Partial<NormalizedEvidence> & { uuid: string; raw_text: string }): NormalizedEvidence {
  return {
    timestamp: Date.now(),
    score: 0.5,
    recency: 7,
    strength: 0.5,
    source_namespace: 'v_conv_real',
    tombstone: false,
    suppressed: false,
    pathway: 'A',
    ...partial,
  };
}
