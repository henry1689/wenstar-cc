/**
 * write-channel-single-source.test.ts — 写入通道「列清单单一事实源」回归测试（2026-09-19 批 2）
 * ============================================================================================
 * 事故根因（arch_structural_defect，非单点 bug）：`conversations` / `memories` / `black_diamond`
 * 三张核心表**各自存在多个自行维护列清单的写入点**，没有单一事实源 → 同类漂移反复爆发：
 *   - conversations 双通道：ConversationDB 22 列 ✅ vs SQLiteAdapter 13 列 ❌
 *     → belong_entity_uuid 恒 NULL、message_id 仅 4/3949、entity_names 被写成 JSON 数组、
 *       is_summary 被绑成 is_compacted（V23.1 修复未同步）。
 *   - memories 多套列清单：writeMemory 自身缺 source_type、effective_strength 硬编码 1.0。
 *   - black_diamond dna_root_id 全库 0/390（归属与溯源锚点未同源继承）。
 *
 * 本测试把「收口」固化为**可验证不变量**（尤其是 SQL 逐字比对 —— 一旦有人重新手写列清单即失败）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  buildConversationInsert,
  CONVERSATION_INSERT_COLUMNS,
  CONVERSATION_BOUND_COLUMNS,
} from '../ConversationDB.js';
import { SQLiteAdapter } from '../SQLiteAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FUSION_DB = join(REPO, 'data', 'webui', 'fusion_memory.db');

const placeholders = (sql: string): number => (sql.match(/\?/g) || []).length;

/** 桩 SQLiteAdapter 实例：仅提供被测方法用到的协作方法（不初始化真实 sql.js 库） */
function stubAdapter() {
  const runCalls: Array<{ sql: string; bind: unknown[] }> = [];
  const self = {
    ensureReady: () => {},
    runSql: (sql: string, bind: unknown[]) => {
      runCalls.push({ sql, bind });
    },
    queryAll: () => [{ id: 7 }],
    save: () => {},
  };
  return { self, runCalls };
}

/**
 * 把一条 INSERT 还原成 列名 → 值 的映射（用于断言，避免在测试里硬编码列位置）。
 * SQL 的列清单与 VALUES 内均无嵌套括号，故按括号切片即可。
 */
function mapColumnsToValues(sql: string, bind: unknown[]): Record<string, unknown> {
  const sliceBalanced = (from: number): { text: string; end: number } => {
    let depth = 0;
    for (let i = from; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') { depth--; if (depth === 0) return { text: sql.slice(from + 1, i), end: i }; }
    }
    throw new Error('括号未配平: ' + sql.slice(from, from + 60));
  };
  const colsEnd = sliceBalanced(sql.indexOf('('));
  const colList = colsEnd.text;
  // 🔴 批 4：statement 现在带 `ON CONFLICT(id) DO UPDATE SET ...`，其中也含括号 ⇒
  //   不能用 lastIndexOf(')')，必须从 VALUES 所在括号开始**配平**扫描。
  const vIdx = sql.indexOf('VALUES');
  const valList = sliceBalanced(sql.indexOf('(', vIdx)).text;
  const cols = colList.split(',').map((s) => s.trim());
  const vals = valList.split(',').map((s) => s.trim());
  expect(cols.length, '列数与值的 token 数必须一致').toBe(vals.length);
  const out: Record<string, unknown> = {};
  let bi = 0;
  cols.forEach((c, i) => {
    out[c] = vals[i] === '?' ? bind[bi++] : vals[i];
  });
  expect(bi, 'bind 数必须等于占位符数').toBe(bind.length);
  return out;
}

describe('[写入通道] conversations — 列清单单一事实源', () => {
  const BASE = {
    role: 'user',
    content: '你好',
    timestamp: '2026-01-01T00:00:00.000Z',
    seqPos: 1,
    entityNames: ['徐诗雨', '熊梓铭'],
  };

  it('列清单必须含守卫登记的关键列与 V23.1 的 is_summary', () => {
    for (const c of [
      'belong_entity_uuid',
      'message_id',
      // 🔴 批 4：补上 dna_root_id —— 它是守卫登记的关键列之一，而 conversations 的 SQL
      //   已是运行时拼接、D8v2（文本扫描）看不到它 ⇒ 本断言是它的**唯一**防线。
      'dna_root_id',
      'global_uid',
      'location_fingerprint',
      'is_summary',
      'entity_names',
      'is_test',
    ]) {
      expect(CONVERSATION_INSERT_COLUMNS, `列清单缺 ${c}`).toContain(c);
    }
  });

  it('占位符数与 bind 数一致，且 bind 顺序由列清单派生', () => {
    const { sql, bind } = buildConversationInsert({ ...BASE, belongEntityUuid: 'TXS-000000007', messageId: 'MSG-1' });
    expect(bind.length).toBe(placeholders(sql));
    expect(bind.length).toBe(CONVERSATION_BOUND_COLUMNS.length);
    const map = mapColumnsToValues(sql, bind);
    expect(map.belong_entity_uuid).toBe('TXS-000000007');
    expect(map.message_id).toBe('MSG-1');
  });

  it('is_summary 与 is_compacted 独立取值（回归 V23.1 未同步缺陷）', () => {
    const { sql, bind } = buildConversationInsert({ ...BASE, isCompacted: 0, isSummary: 1 });
    const map = mapColumnsToValues(sql, bind);
    expect(map.is_compacted, 'is_compacted 不得被 is_summary 覆盖').toBe(0);
    expect(map.is_summary, '摘要条目的 is_summary 必须为 1').toBe(1);
  });

  it('entity_names 必须写成逗号分隔（实库既定形态），不得写成 JSON 数组', () => {
    const { sql, bind } = buildConversationInsert(BASE);
    const map = mapColumnsToValues(sql, bind);
    expect(map.entity_names).toBe('徐诗雨,熊梓铭');
    expect(String(map.entity_names)).not.toMatch(/^\[/);
  });

  it('列清单/占位符必须能对真实 fusion schema prepare 成功', () => {
    if (!existsSync(FUSION_DB)) {
      console.warn('[skip] 无 fusion schema 预言机库:', FUSION_DB);
      return;
    }
    const db = new Database(FUSION_DB, { readonly: true });
    try {
      expect(() => db.prepare(buildConversationInsert(BASE).sql)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('[写入通道] SQLiteAdapter.insertConversation — 必须与构造器同源（收口证明）', () => {
  it('实际执行的 SQL 必须与 buildConversationInsert 产出【逐字相同】', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.insertConversation.call(self as never, 'user', '你好', {
      seqPos: 1,
      belongEntityUuid: 'TXS-000000007',
      messageId: 'MSG-1',
    });
    expect(runCalls).toHaveLength(1);
    const canonical = buildConversationInsert({ role: '', content: '', timestamp: '' }).sql;
    expect(
      runCalls[0].sql,
      'SQLiteAdapter 又自行手写列清单了 —— 这正是双通道漂移的成因，必须回退到共用构造器',
    ).toBe(canonical);
    expect(placeholders(runCalls[0].sql)).toBe(runCalls[0].bind.length);
  });

  it('isSummary 参数必须真正生效（此前该参数不存在，被 as any 静默丢弃）', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.insertConversation.call(self as never, 'assistant', '【对话摘要】x', {
      seqPos: 0,
      isSummary: 1,
    });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    expect(map.is_summary).toBe(1);
    expect(map.is_compacted).toBe(0);
  });

  it('归属与消息 ID 必须真正落到列上（此前该路径两列都缺）', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.insertConversation.call(self as never, 'assistant', 'x', {
      belongEntityUuid: 'TXS-000000009',
      messageId: 'ATOM-9',
    });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    expect(map.belong_entity_uuid).toBe('TXS-000000009');
    expect(map.message_id).toBe('ATOM-9');
  });
});

describe('[写入通道] memories — 唯一公共写入口必须能表达调用方的全部需要', () => {
  const BASE_MEM = {
    id: 'mem_test_1',
    seqPos: -1,
    createdAt: '2026-01-01T00:00:00.000Z',
    calciumScore: 0.5,
    calciumLevel: 1,
    locusPath: 'knowledge_vault',
    leafZone: 'language_semantic_zone',
    rawInput: '测试内容',
    primaryEmotion: '中性',
    memoryType: 'dialog',
  };

  it('列清单必须含 source_type（否则收口会把 knowledge_vault 退化为默认 conversation）', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.writeMemory.call(self as never, {
      ...BASE_MEM,
      sourceType: 'knowledge_vault',
      effectiveStrength: 0.5,
    });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    expect(map.source_type, 'source_type 必须可绑定').toBe('knowledge_vault');
    expect(map.effective_strength, 'effective_strength 必须可绑定（原为硬编码 1.0）').toBe(0.5);
  });

  it('缺省值向后兼容：sourceType → conversation、effectiveStrength → 1.0', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.writeMemory.call(self as never, { ...BASE_MEM });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    expect(map.source_type).toBe('conversation');
    expect(map.effective_strength).toBe(1.0);
  });

  it('列清单/占位符必须能对真实 fusion schema prepare 成功', () => {
    if (!existsSync(FUSION_DB)) {
      console.warn('[skip] 无 fusion schema 预言机库:', FUSION_DB);
      return;
    }
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.writeMemory.call(self as never, { ...BASE_MEM });
    const db = new Database(FUSION_DB, { readonly: true });
    try {
      expect(() => db.prepare(runCalls[0].sql)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('memories 的写入点不得再自行手写列清单（收口不变量）', () => {
    for (const rel of [
      'src/app/vault/VaultManager.ts',
      'src/engine/tianquan/temporal/SleepTimeConsolidator.ts',
      // 🔴 批 3：YuyaoMemoryService 是 memories 最后一处手写列清单（3 个写入点）
      'src/app/yuyao-memory/YuyaoMemoryService.ts',
    ]) {
      const src = readFileSync(join(REPO, rel), 'utf-8');
      expect(src, `${rel} 又出现手写 memories 列清单`).not.toMatch(
        /INSERT (OR IGNORE )?INTO memories \(id, seq_pos, raw_input/,
      );
      expect(src, `${rel} 未收口到 writeMemory`).toMatch(/writeMemory\(\{/);
    }
  });
});

describe('[写入通道] 全部 memories 写入点必须走 writeMemory（收口不变量）', () => {
  it('全仓不得再出现手写 memories 列清单', () => {
    const offenders: string[] = [];
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); }
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    for (const f of walk(join(REPO, 'src'))) {
      const rel = f.replace(/\\/g, '/').split('/src/')[1];
      // SQLiteAdapter.ts 就是**单一事实源本身**（writeMemory 的列清单必须写在那里），故豁免
      if (rel === 'm2/SQLiteAdapter.ts') continue;
      const src = readFileSync(f, 'utf-8');
      // 手写 INSERT INTO memories (id, seq_pos, ...) 才算违规；适配器内部（writeMemory/_insertRecord）的合法列清单
      // 以 `INSERT OR REPLACE INTO memories (id, ...)` 换行形式存在，用下面特征排除：必须含全 6 个身份列之一才算“收口后仍手写”
      const re = /INSERT (?:OR (?:IGNORE|REPLACE) )?INTO memories\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const cols = m[1].split(',').map((c) => c.trim());
        if (cols.includes('note_key') || cols.includes('is_valid')) {
          offenders.push(`${f.replace(/\\/g, '/').split('/src/')[1]} → 手写含 note 列的 memories INSERT`);
        }      }
    }
    expect(offenders, `仍有手写 memories 列清单（应走 writeMemory）：\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('writeMemory 列清单必须含 note 五列（否则记事查询/提醒失效）', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.writeMemory.call(self as never, {
      id: 'note_1', seqPos: 1, createdAt: '2026-01-01T00:00:00.000Z',
      calciumScore: 0, calciumLevel: 0, locusPath: 'note.memory', leafZone: 'note_zone',
      rawInput: '冰箱里有牛奶', primaryEmotion: '中性', memoryType: 'note',
      subType: 'object_location', noteKey: '冰箱', isValid: 1,
    });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    for (const c of ['note_key', 'is_valid', 'remind_at', 'reminded', 'repeat_rule']) {
      expect(Object.keys(map), `writeMemory 列清单缺 ${c}`).toContain(c);
    }
    expect(map.note_key).toBe('冰箱');
    expect(map.is_valid).toBe(1);
  });

  it('note 五列缺省值必须与 DDL 默认值一致（保证现有 4 个调用方零行为变化）', () => {
    const { self, runCalls } = stubAdapter();
    SQLiteAdapter.prototype.writeMemory.call(self as never, {
      id: 'm2', seqPos: 2, createdAt: '2026-01-01T00:00:00.000Z',
      calciumScore: 0.5, calciumLevel: 1, locusPath: 'x', leafZone: 'y', rawInput: 'z',
      primaryEmotion: '中性', memoryType: 'dialog',
    });
    const map = mapColumnsToValues(runCalls[0].sql, runCalls[0].bind);
    expect(map.note_key).toBe(null);
    expect(map.is_valid).toBe(1);
    expect(map.remind_at).toBe(null);
    expect(map.reminded).toBe(0);
    expect(map.repeat_rule).toBe(null);
  });

  it('YuyaoMemoryService 三处写入必须走 writeMemory（含 note_key/remind_at）', () => {
    const src = readFileSync(join(REPO, 'src/app/yuyao-memory/YuyaoMemoryService.ts'), 'utf-8');
    // 🔴 批 4：原正则 `/INSERT INTO memories/` 漏掉 `INSERT OR IGNORE/REPLACE INTO memories`
    //   （实际历史违规形态恰好就是 OR IGNORE）⇒ 断言几乎无效。现覆盖三种形态。
    expect(src).not.toMatch(/INSERT( OR (IGNORE|REPLACE))? INTO memories/i);
    expect((src.match(/writeMemory\(\{/g) || []).length, '三处写入点均应收口').toBe(3);
    expect(src).toMatch(/noteKey: key/);
    expect(src).toMatch(/remindAt,/);
  });
});

describe('[写入通道] black_diamond — 归属与溯源锚点必须同源继承', () => {
  const VM = readFileSync(join(REPO, 'src/app/vault/VaultManager.ts'), 'utf-8');

  it('回查必须一次取 belong_entity_uuid 与 dna_root_id 两列', () => {
    expect(
      VM,
      '回查只取归属、未取溯源锚点 —— dna_root_id 0/390 的直接成因',
    ).toMatch(/SELECT belong_entity_uuid, dna_root_id FROM memories WHERE id = \?/);
  });

  it('addBlackDiamond 的 INSERT 列清单必须含 dna_root_id', () => {
    const m = /INSERT INTO black_diamond \(([^)]*)\)/.exec(VM);
    expect(m, '未找到 addBlackDiamond 写入点').not.toBeNull();
    const cols = m![1].split(',').map((c) => c.trim());
    expect(cols).toContain('belong_entity_uuid');
    expect(cols).toContain('dna_root_id');
  });

  it('列清单/占位符必须能对真实 fusion schema prepare 成功', () => {
    if (!existsSync(FUSION_DB)) {
      console.warn('[skip] 无 fusion schema 预言机库:', FUSION_DB);
      return;
    }
    const m = /`(INSERT INTO black_diamond \([\s\S]*?VALUES \([\s\S]*?\))`/.exec(VM);
    expect(m, '未能抽取 addBlackDiamond SQL 字面量').not.toBeNull();
    const db = new Database(FUSION_DB, { readonly: true });
    try {
      expect(() => db.prepare(m![1].replace(/\s+/g, ' '))).not.toThrow();
    } finally {
      db.close();
    }
  });
});
