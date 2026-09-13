import { describe, it, expect } from 'vitest';
import { logVaultOperation, addBlackDiamond } from '../VaultManager.js';
import { WorkRepository } from '../../works/WorkRepository.js';
import { M8FusionAdapter } from '../../../m8/M8FusionAdapter.js';
import { resolveAnchorOwnership } from '../../../webui/chat/dialog-group-stage.js';

// [②-1 补漏] 归属脏值「透传」收口（2026-09-13）
//
// 背景：②-1 在源头（MemoryAssessor）拦住了 `String(null)` 造出字符串 'null' 的陷阱，
//   但**存量脏值仍在库里**（memories 56 条真实对话），而下游各写入点会「回查已有归属并原样透传」——
//   `x.belong_entity_uuid || null` / `?? null` 只挡 null/undefined，**挡不住字符串 'null'**（它是真值）。
//
// 实测证据（2026-09-13 重启后复查）：black_diamond 里被清掉的 4 条 'null' 又重现，
//   逐条回查 source_id 确认 —— 4 条源记忆的 belong_entity_uuid 全部 typeof=text 的 'null'。
//   传播链：memories('null') → addBlackDiamond 回查透传 → black_diamond('null')。
//
// 举一反三扫描出的同类透传点共 7 处，本测试覆盖其中可行为验证的 6 处：
//   ① logVaultOperation（memories → vault_log）
//   ② addBlackDiamond （memories → black_diamond）  ← 实测已发生
//   ③ WorkRepository.backfillExisting（conversations → works）
//   ④ M8FusionAdapter.markScar（memories → vault_log）
//   ⑤ M8FusionAdapter.promoteMemory（memories → vault_log）
//   ⑥ resolveAnchorOwnership 第三层兜底（conversations → memories 锚点归属）
//   （BlackDiamondGate._logOperation 为私有审计方法，由 ①②⑤ 同族覆盖，不单独设桩。）
//
// 契约：**脏值一律不得向下游传播** —— 落 NULL，而不是落 'null'。
//   注意本测试**不改变**存量数据的归属判定（那 56 条仍保持原样，业主已定「判不出的不猜」），
//   只保证脏值不会继续被搬运到新的表里。

/** 极简 SQLiteAdapter 桩：按规则顺序匹配 SQL，记录全部 writeRaw 调用 */
function makeFake(rules: Array<[RegExp | string, any[]]>) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const queries: string[] = [];
  const fake = {
    writes,
    queries,
    queryAll(sql: string) {
      queries.push(sql);
      for (const [pat, rows] of rules) {
        if (typeof pat === 'string' ? sql.includes(pat) : pat.test(sql)) return rows;
      }
      return [];
    },
    writeRaw(sql: string, ...args: any[]) {
      const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      writes.push({ sql, params });
    },
  };
  return fake as any;
}

/** 取最后一次匹配 sql 的 writeRaw 参数 */
function lastWrite(fake: any, sqlRe: RegExp) {
  const hit = fake.writes.filter((w: any) => sqlRe.test(w.sql));
  return hit.length > 0 ? hit[hit.length - 1].params : null;
}

/** 断言：该值既不是 undefined 也不是字符串 'null' —— 必须落 NULL */
function expectRealNull(v: any) {
  expect(v).not.toBe('null');
  expect(v).not.toBe('undefined');
  expect(v ?? null).toBeNull();
}

describe('[②-1补漏] 归属脏值不得向下游透传', () => {
  // ── ① memories → vault_log ──
  it('① logVaultOperation：源记忆归属为字符串 "null" → vault_log 落 NULL', () => {
    const fake = makeFake([[/FROM memories WHERE id = \?/i, [{ belong_entity_uuid: 'null' }]]]);
    logVaultOperation(fake, 'promote', 'memory', 'mem_x', undefined, 'detail');
    const params = lastWrite(fake, /INSERT INTO vault_log/i);
    expect(params).not.toBeNull();
    expectRealNull(params![params!.length - 1]);
  });

  it('① logVaultOperation：源记忆归属合法 → 原样保留（不得误伤）', () => {
    const fake = makeFake([[/FROM memories WHERE id = \?/i, [{ belong_entity_uuid: 'TXS-000000007' }]]]);
    logVaultOperation(fake, 'promote', 'memory', 'mem_x', undefined, 'detail');
    const params = lastWrite(fake, /INSERT INTO vault_log/i);
    expect(params![params!.length - 1]).toBe('TXS-000000007');
  });

  it('① logVaultOperation：显式传入的归属优先，不回查', () => {
    const fake = makeFake([[/FROM memories WHERE id = \?/i, [{ belong_entity_uuid: 'null' }]]]);
    logVaultOperation(fake, 'promote', 'memory', 'mem_x', undefined, 'detail', undefined, 'TXS-000000011');
    const params = lastWrite(fake, /INSERT INTO vault_log/i);
    expect(params![params!.length - 1]).toBe('TXS-000000011');
  });

  // ── ② memories → black_diamond（实测已发生的传播）──
  it('② addBlackDiamond：源记忆归属为字符串 "null" → black_diamond 落 NULL', () => {
    const fake = makeFake([
      [/FROM black_diamond WHERE id = \?/i, []],
      [/SELECT COUNT\(\*\) as cnt FROM black_diamond/i, [{ cnt: 0 }]],
      [/FROM memories WHERE id = \?/i, [{ belong_entity_uuid: 'null' }]],
    ]);
    addBlackDiamond(fake, { summary: 's', source_id: 'mem_x' });
    const params = lastWrite(fake, /INSERT INTO black_diamond/i);
    expect(params).not.toBeNull();
    // INSERT 列序：…, namespace, belong_entity_uuid → 末位
    expectRealNull(params![params!.length - 1]);
  });

  it('② addBlackDiamond：源记忆归属合法 → 原样保留', () => {
    const fake = makeFake([
      [/FROM black_diamond WHERE id = \?/i, []],
      [/SELECT COUNT\(\*\) as cnt FROM black_diamond/i, [{ cnt: 0 }]],
      [/FROM memories WHERE id = \?/i, [{ belong_entity_uuid: 'TXS-000000001' }]],
    ]);
    addBlackDiamond(fake, { summary: 's', source_id: 'mem_x' });
    const params = lastWrite(fake, /INSERT INTO black_diamond/i);
    expect(params![params!.length - 1]).toBe('TXS-000000001');
  });

  // ── ③ conversations → works ──
  it('③ WorkRepository.backfillExisting：源对话归属为字符串 "null" → works 落 NULL', () => {
    const longText = '小说 第一章 ' + '正文内容。'.repeat(120);
    const fake = makeFake([
      [/FROM works/i, []],
      [/FROM conversations WHERE LENGTH/i, [{ id: 'c1', content: longText, belong_entity_uuid: 'null', dialog_group_id: null }]],
    ]);
    const repo = new WorkRepository(fake);
    repo.backfillExisting();
    const params = lastWrite(fake, /INSERT OR IGNORE INTO works/i);
    expect(params).not.toBeNull();
    // 参数序：work_id, title, first_sentence, summary, full_text, belong_entity_uuid, …
    expect(5).toBeLessThan(params!.length);
    expectRealNull(params![5]);
  });

  it('③ WorkRepository.backfillExisting：源对话归属合法 → 原样保留', () => {
    const longText = '小说 第一章 ' + '正文内容。'.repeat(120);
    const fake = makeFake([
      [/FROM works/i, []],
      [/FROM conversations WHERE LENGTH/i, [{ id: 'c1', content: longText, belong_entity_uuid: 'TXS-000000019', dialog_group_id: null }]],
    ]);
    const repo = new WorkRepository(fake);
    repo.backfillExisting();
    const params = lastWrite(fake, /INSERT OR IGNORE INTO works/i);
    expect(params![5]).toBe('TXS-000000019');
  });

  // ── ④⑤ memories → vault_log（M8 疤痕/地标）──
  it('④ M8FusionAdapter.markScar：源记忆归属为字符串 "null" → vault_log 落 NULL', async () => {
    const fake = makeFake([
      [/FROM memories WHERE id = \?/i, [{ raw_input: 'x', created_at: 'now', belong_entity_uuid: 'null' }]],
    ]);
    const adapter = new M8FusionAdapter({ markScar: async () => true, getSQLite: () => fake } as any);
    await adapter.markScar('mem_x', 'typeA');
    const params = lastWrite(fake, /INSERT INTO vault_log/i);
    expect(params).not.toBeNull();
    // 参数序：[detail, content_md, source_id, belong_entity_uuid]
    expectRealNull(params![params!.length - 1]);
  });

  it('⑤ M8FusionAdapter.promoteMemory：源记忆归属为字符串 "null" → vault_log 落 NULL', async () => {
    const fake = makeFake([
      [/FROM memories WHERE id = \?/i, [{ raw_input: 'x', created_at: 'now', belong_entity_uuid: 'null' }]],
    ]);
    const adapter = new M8FusionAdapter({ promoteToLandmark: async () => true, getSQLite: () => fake } as any);
    await adapter.promoteMemory('mem_x', 'tagA');
    const params = lastWrite(fake, /INSERT INTO vault_log/i);
    expect(params).not.toBeNull();
    expectRealNull(params![params!.length - 1]);
  });

  // ── ⑥ conversations → memories 锚点归属（第三层 SQL 兜底）──
  it('⑥ resolveAnchorOwnership：第三层兜底 SQL 必须排除字符串 "null"', () => {
    const fake = makeFake([[/FROM conversations/i, []]]);
    resolveAnchorOwnership(
      { entities: [], rounds: [{ seqPos: 10 }] },
      fake,
      { getUUIDByName: () => undefined },
      {},
    );
    const convSql = fake.queries.filter((s: string) => /FROM conversations/i.test(s));
    expect(convSql.length).toBeGreaterThan(0);
    expect(convSql.some((s: string) => /belong_entity_uuid\s*!=\s*'null'/i.test(s))).toBe(true);
  });

  it('⑥ resolveAnchorOwnership：即使兜底查询漏出 "null"，也不得采信为归属', () => {
    const fake = makeFake([[/FROM conversations/i, [{ belong_entity_uuid: 'null' }]]]);
    const r = resolveAnchorOwnership(
      { entities: [], rounds: [{ seqPos: 10 }] },
      fake,
      { getUUIDByName: () => undefined },
      {},
    );
    expect(r.uuid).not.toBe('null');
    expect(r.uuid ?? null).toBeNull();
    expect(r.source).toBe('none');
  });

  it('⑥ resolveAnchorOwnership：无任何兜底时仍返回 none（守链不回归）', () => {
    const fake = makeFake([[/FROM conversations/i, []]]);
    const r = resolveAnchorOwnership(
      { entities: [], rounds: [{ seqPos: 10 }] },
      fake,
      { getUUIDByName: () => undefined },
      {},
    );
    expect(r).toEqual({ uuid: null, source: 'none' });
  });
});
