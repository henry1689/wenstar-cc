/**
 * MemoryWriteGateway 单元测试（批次6，2026-09-16）
 * ==========================================================
 * 测试范围：
 *   A. 五要素守卫：entity_genes 为空时拒绝非 roleplay 写入
 *   B. roleplay 豁免：entity_genes 为空时允许 roleplay 写入
 *   C. fgEntityNames 自动派生：从 entityGenes 同源过滤 self
 *   D. writeMemory 透传：所有 opts 字段正确传递
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryWriteGateway, type MemoryWriteOpts } from '../MemoryWriteGateway.js';
import type { SQLiteAdapter } from '../SQLiteAdapter.js';

// ─── Mock ──────────────────────────────────────────────

function makeMockSQLite() {
  const callLog: MemoryWriteOpts[] = [];
  const writeMemory = vi.fn((opts: MemoryWriteOpts) => {
    callLog.push(opts);
    return true;
  });
  return { writeMemory, callLog } as any;
}

function makeOpts(overrides: Partial<MemoryWriteOpts> = {}): MemoryWriteOpts {
  return {
    id: 'mem_test_001',
    seqPos: 1,
    createdAt: '2026-09-16T00:00:00.000Z',
    calciumScore: 0.7,
    calciumLevel: 2,
    locusPath: 'general',
    leafZone: 'user',
    rawInput: '你好',
    primaryEmotion: '愉快',
    ...overrides,
  };
}

// ─── A. 五要素守卫 ─────────────────────────────────────

describe('A — 五要素守卫：entity_genes 为空拒绝非 roleplay', () => {
  it('entityGenes 为 undefined → 拒绝', () => {
    const { writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const ok = gw.write(makeOpts());
    expect(ok).toBe(false);
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it('entityGenes 为空数组 → 拒绝', () => {
    const { writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const ok = gw.write(makeOpts({ entityGenes: [] }));
    expect(ok).toBe(false);
    expect(writeMemory).not.toHaveBeenCalled();
  });

  it('entityGenes 有值 → 放行', () => {
    const { writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const ok = gw.write(makeOpts({
      entityGenes: [{ name: '玉瑶', type: 'person', allele: '瑶', phenotype: 'neutral', knowledge_type: 'factual' }],
    }));
    expect(ok).toBe(true);
    expect(writeMemory).toHaveBeenCalledTimes(1);
  });
});

// ─── B. roleplay 豁免 ──────────────────────────────────

describe('B — roleplay 豁免：entity_genes 为空也允许', () => {
  it('memoryKind=roleplay + entityGenes 为空 → 放行', () => {
    const { writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const ok = gw.write(makeOpts({ memoryKind: 'roleplay', entityGenes: [] }));
    expect(ok).toBe(true);
    expect(writeMemory).toHaveBeenCalledTimes(1);
  });

  it('memoryKind 未指定 + entityGenes 为空 → 仍拒绝（默认非 roleplay）', () => {
    const { writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const ok = gw.write(makeOpts({ entityGenes: null }));
    expect(ok).toBe(false);
  });
});

// ─── C. fgEntityNames 自动派生 ────────────────────────

describe('C — fgEntityNames 自动派生', () => {
  it('从 entityGenes 派生，过滤 self 类型', () => {
    const { callLog, writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    gw.write(makeOpts({
      entityGenes: [
        { name: '玉瑶', type: 'person', allele: '瑶', phenotype: 'neutral', knowledge_type: 'factual' },
        { name: '我', type: 'self', allele: '我', phenotype: 'neutral', knowledge_type: 'factual' },
        { name: '徐诗韵', type: 'person', allele: '韵', phenotype: 'neutral', knowledge_type: 'factual' },
      ],
    }));
    const call = callLog[0];
    expect(call.fgEntityNames).toBe('玉瑶,徐诗韵');
  });

  it('entityGenes 有值 → fgEntityNames 正确派生', () => {
    const { callLog, writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    gw.write(makeOpts({
      entityGenes: [{ name: '安琪', type: 'person', allele: '琪', phenotype: 'neutral', knowledge_type: 'factual' }],
    }));
    const call = callLog[0];
    expect(call.fgEntityNames).toBe('安琪');
  });
});

// ─── D. 字段透传 ───────────────────────────────────────

describe('D — opts 字段透传到 writeMemory', () => {
  it('所有关键列正确透传到 writeMemory', () => {
    const { callLog, writeMemory } = makeMockSQLite();
    const gw = new MemoryWriteGateway({ writeMemory } as any);
    const opts = makeOpts({
      dialogGroupId: 'dg_001',
      topicLabel: '日常聊天',
      anchorScore: 0.8,
      belongEntityUuid: 'TXS-000000001',
      dnaRootId: 'DNA-001',
      globalUid: 'MM-A1B2C3D4',
      locationFingerprint: 'fp-abc123',
      timePeriod: 'morning',
      season: 'summer',
      lunarTerm: '夏至',
      isForesight: false,
      entityGenes: [{ name: '测试', type: 'person', allele: '试', phenotype: 'neutral', knowledge_type: 'factual' }],
    });
    gw.write(opts);
    const call = callLog[0];
    expect(call.id).toBe('mem_test_001');
    expect(call.dialogGroupId).toBe('dg_001');
    expect(call.topicLabel).toBe('日常聊天');
    expect(call.anchorScore).toBe(0.8);
    expect(call.belongEntityUuid).toBe('TXS-000000001');
    expect(call.dnaRootId).toBe('DNA-001');
    expect(call.globalUid).toBe('MM-A1B2C3D4');
    expect(call.locationFingerprint).toBe('fp-abc123');
    expect(call.timePeriod).toBe('morning');
    expect(call.season).toBe('summer');
    expect(call.lunarTerm).toBe('夏至');
  });
});
