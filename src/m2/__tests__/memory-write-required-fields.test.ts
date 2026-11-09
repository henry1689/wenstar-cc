/**
 * memory-write-required-fields.test.ts — 写侧强制字段与健康计数（MEM-UNIFY-V1 批3）
 * =================================================================================
 * 锁定：
 *   - writeMemory 拒绝缺失强制字段的语义块（并计入健康报告）；
 *   - 合法语义块仍能写入（runSql 被调用）；
 *   - write() / writeMemory 都经过统一的去重键（源码契约）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteAdapter, getMemoryWriteHealth, _resetMemoryWriteHealthForTest } from '../SQLiteAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function makeStub() {
  const a = new SQLiteAdapter('D:/tmp/__unused_required_fields.db') as any;
  a.ensureReady = () => {};
  a.written = 0;
  a.queryAll = () => [];           // 无重复、无 seq 冲突
  a.runSql = () => { a.written++; };
  return a;
}

const GOOD = {
  id: 'mem_test_good',
  seqPos: 1,
  createdAt: '2026-11-09T00:00:00.000Z',
  perceptionV40: '{"__v":2,"dims":[]}',
  calciumScore: 0.5,
  calciumLevel: 1,
  locusPath: 'chat',
  leafZone: 'user',
  rawInput: '今天去海边',
  primaryEmotion: '快乐',
  memoryType: 'dialog',
  memoryKind: 'episodic',
  sourceConversationIds: [1],
  dnaRootId: 'DNA-1',
  entityGenes: [{ name: '玉瑶', type: 'person' }],
  belongEntityUuid: 'TXS-000000001',
};

describe('A. writeMemory 强制字段', () => {
  beforeEach(() => {
    _resetMemoryWriteHealthForTest();
    SQLiteAdapter.setBelongNameResolver(null);
  });

  it('完整字段 → 写入成功', () => {
    const a = makeStub();
    expect(a.writeMemory({ ...GOOD })).toBe(true);
    expect(a.written).toBe(1);
  });

  it('缺归属 → 拒写并计数', () => {
    const a = makeStub();
    expect(a.writeMemory({ ...GOOD, id: 'mem_no_belong', belongEntityUuid: null })).toBe(false);
    expect(a.written).toBe(0);
    const h = getMemoryWriteHealth();
    expect(h.rejected).toBe(1);
    expect(h.reasons.missing_belong).toBe(1);
  });

  it('批7：缺 entity_genes → 放行（无解析器只告警）；有解析器时按归属合成', () => {
    const a = makeStub();
    // 无解析器：不拒写（普通闲聊不丢记忆）
    expect(a.writeMemory({ ...GOOD, id: 'mem_no_genes', entityGenes: [] })).toBe(true);
    expect(a.written).toBe(1);
    // roleplay 豁免不变
    expect(a.writeMemory({ ...GOOD, id: 'mem_roleplay', entityGenes: [], memoryKind: 'roleplay' })).toBe(true);
    // 注册名字解析器：按 belong 合成后写入
    SQLiteAdapter.setBelongNameResolver((uuid: string) => (uuid === 'TXS-000000001' ? '玉瑶' : null));
    expect(a.writeMemory({ ...GOOD, id: 'mem_genes_from_belong', entityGenes: [] })).toBe(true);
    expect(a.written).toBe(3);
    SQLiteAdapter.setBelongNameResolver(null);
  });

  it('缺 40D → 拒写；note 豁免', () => {
    const a = makeStub();
    expect(a.writeMemory({ ...GOOD, id: 'mem_no_p40', perceptionV40: null })).toBe(false);
    expect(a.writeMemory({ ...GOOD, id: 'note_ok', memoryType: 'note', perceptionV40: null, entityGenes: [] })).toBe(true);
  });

  it('缺 source 锚点 → 拒写', () => {
    const a = makeStub();
    expect(a.writeMemory({ ...GOOD, id: 'mem_no_anchor', sourceConversationIds: [], dialogGroupId: null })).toBe(false);
  });
});

describe('B. 源码契约', () => {
  const src = readFileSync(join(REPO, 'src', 'm2', 'SQLiteAdapter.ts'), 'utf8');

  it('writeMemory 调用统一字段校验', () => {
    expect(src).toMatch(/validateMemoryWriteFields\(/);
  });

  it('write() 与 writeMemory() 都走统一去重键（传入归属/角色元数据）', () => {
    const writeCalls = src.match(/_isDuplicateNewWrite\(/g) ?? [];
    expect(writeCalls.length).toBeGreaterThanOrEqual(3); // 定义 + 两个调用点
    expect(src).toMatch(/belongEntityUuid:\s*record\.belongEntityUuid/);
  });
});
