import { describe, it, expect } from 'vitest';
import {
  canon,
  hashCore,
  chainHash,
  sha256Hex,
  buildChain,
  verifyChain,
  segmentHead,
  MW_GENESIS,
  type MwImmutableCore,
} from '../index.js';

/**
 * MemWen OS 守卫10 + canon 规范（ADR-024 附录 v2 §6.1/§6.3）
 * 能力断言：不写计数/位置前提 —— 断言「能力成立」而非「实现长什么样」。
 */

const core = (x: string, over: Partial<MwImmutableCore> = {}): MwImmutableCore => ({
  x,
  t_tx: '2026-11-09T12:00:00.000Z',
  belong: 'TXS-000000007',
  src: 'chat',
  ...over,
});

describe('canon 规范 · 跨版本一致性', () => {
  it('Unicode NFC：组合式与分解式同码点序列 → 同 canon、同哈希', () => {
    const composed = '\u00e9'; // é（单码点）
    const decomposed = 'e\u0301'; // e + 组合尖音符（双码点）
    expect(composed).not.toBe(decomposed); // 原始形式确实不同
    expect(canon(core(composed))).toBe(canon(core(decomposed)));
    expect(hashCore(core(composed))).toBe(hashCore(core(decomposed)));
  });

  it('字段书写顺序无关：对象字面量键序不同 → 同 canon', () => {
    const a: MwImmutableCore = { x: '同', t_tx: 1794234000000, belong: 'u1', src: 'chat' };
    const b = { src: 'chat', belong: 'u1', t_tx: 1794234000000, x: '同' } as MwImmutableCore;
    expect(canon(a)).toBe(canon(b));
    expect(hashCore(a)).toBe(hashCore(b));
  });

  it('时间归一：epoch 毫秒与等值 ISO 字符串同形', () => {
    const t = 1794234000000;
    const a = core('同', { t_tx: t });
    const b = core('同', { t_tx: new Date(t).toISOString() });
    expect(canon(a)).toBe(canon(b));
  });

  it('非法时间 fail-fast（静默保留会让同义时间算出不同哈希）', () => {
    expect(() => canon(core('同', { t_tx: 'not-a-time' }))).toThrow(TypeError);
    expect(() => canon(core('同', { t_tx: Number.NaN }))).toThrow(TypeError);
  });

  it('分隔符转义：含 | 与 \\ 的原文不产生拼接歧义', () => {
    // 两种不同内容若因转义缺失而 canon 相同 = 严重缺陷
    const a = core('p|q');
    const b = core('p\\q');
    expect(canon(a)).not.toBe(canon(b));
    expect(hashCore(a)).not.toBe(hashCore(b));
  });
});

describe('哈希链 · 篡改断点定位', () => {
  const entries = [
    { id: 'm1', core: core('第一段原文') },
    { id: 'm2', core: core('第二段原文') },
    { id: 'm3', core: core('第三段原文') },
  ];

  it('完好链：两层验证全过', () => {
    const links = buildChain(entries);
    const cores = new Map(entries.map((e) => [e.id, e.core!]));
    expect(verifyChain(links, cores)).toEqual({ ok: true });
  });

  it('正文被篡改（非墓碑）：定位到被改条目、类型=content', () => {
    const links = buildChain(entries);
    const cores = new Map(entries.map((e) => [e.id, e.core!]));
    cores.set('m2', core('被篡改的原文'));
    const r = verifyChain(links, cores);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.type).toBe('content');
      expect(r.id).toBe('m2');
    }
  });

  it('存储的 h 被篡改（想掩盖）：链层断点定位、类型=chain', () => {
    const links = buildChain(entries).map((l) =>
      l.id === 'm1' ? { ...l, h: 'f'.repeat(64) } : l,
    );
    const cores = new Map(entries.map((e) => [e.id, e.core!]));
    const r = verifyChain(links, cores);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.type).toBe('chain');
      expect(r.id).toBe('m1');
    }
  });
});

describe('哈希链 · 墓碑（合法删除不报篡改）', () => {
  it('墓碑项清正文保留历史 h：链仍完好（守卫10 后半句）', () => {
    const entries = [
      { id: 'm1', core: core('存活原文') },
      { id: 'm2', existingH: hashCore(core('已删除原文')) }, // 删除：正文不在，h 带入
      { id: 'm3', core: core('后续原文') },
    ];
    const links = buildChain(entries);
    expect(links[1]!.tombstone).toBe(true);
    // 正文已不在 cores（Map 里没有 m2）—— 合法删除不应被判 content 失配
    const cores = new Map([['m1', entries[0]!.core!], ['m3', entries[2]!.core!]]);
    expect(verifyChain(links, cores)).toEqual({ ok: true });
  });

  it('段间独立：一段断裂不影响另一段（分段链语义）', () => {
    const segA = buildChain([{ id: 'a1', core: core('A段') }]);
    const segB = buildChain([{ id: 'b1', core: core('B段') }]);
    const coresBroken = new Map([['a1', core('A段被改')]]);
    const coresOk = new Map([['b1', core('B段')]]);
    expect(verifyChain(segA, coresBroken).ok).toBe(false);
    expect(verifyChain(segB, coresOk)).toEqual({ ok: true });
  });

  it('段头链值可外部锚定：genesis 与段内容都变则段头变', () => {
    const s1 = buildChain([{ id: 'x', core: core('内容一') }]);
    const s2 = buildChain([{ id: 'x', core: core('内容二') }]);
    expect(segmentHead(s1)).not.toBe(segmentHead(s2));
    expect(segmentHead([], undefined as never) === MW_GENESIS || segmentHead([]) === MW_GENESIS).toBe(true);
  });

  it('链步进输入校验：非 64 位十六进制即抛', () => {
    expect(() => chainHash('short', 'f'.repeat(64))).toThrow(TypeError);
    expect(() => chainHash(MW_GENESIS, 'xyz')).toThrow(TypeError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// stableStringify（链输入唯一序列化）+ 事件链序列化守卫
// ═══════════════════════════════════════════════════════════════════
import { stableStringify } from '../canon.js';

describe('stableStringify · 稳定序列化（链输入单源）', () => {
  it('键序无关：不同插入序的同一逻辑对象 → 同一文本', () => {
    const a = { ts: 'T', type: 'x', actor: 'A', detail: { b: 1, a: 2 } };
    const b = { detail: { a: 2, b: 1 }, actor: 'A', type: 'x', ts: 'T' };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('嵌套递归排序 + 数组保序（顺序即语义）', () => {
    const a = { z: [{ y: 1, x: 2 }], m: { n: 3 } };
    const b = { m: { n: 3 }, z: [{ x: 2, y: 1 }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1])); // 数组不排序
  });

  it('中文 NFC 归一：不同码点形式同文本', () => {
    expect(stableStringify({ s: 'é' })).toBe(stableStringify({ s: 'é' }));
  });

  it('JSON 语义：undefined/函数跳过，null 保留，循环引用抛错', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify({ a: null })).toBe('{"a":null}');
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => stableStringify(cyc)).toThrow(TypeError);
  });
});

describe('事件链序列化 · 与 bArchiveLog 同源（body 构造逐字一致）', () => {
  const body = (e: { ts: string; type: string; actor: string; detail: Record<string, unknown> }) =>
    stableStringify({ ts: e.ts, type: e.type, actor: e.actor, detail: e.detail });

  it('同一条目不同构造序 → 同链值', () => {
    const e1 = { ts: 'T1', type: 'content_hashed', actor: 'svc', detail: { h: 'aa', g: 'g1' } };
    const e2 = { ts: 'T1', type: 'content_hashed', actor: 'svc', detail: { g: 'g1', h: 'aa' } };
    const c1 = chainHash(MW_GENESIS, sha256Hex(body(e1)));
    const c2 = chainHash(MW_GENESIS, sha256Hex(body(e2)));
    expect(c1).toBe(c2);
  });

  it('条目任一字段被篡改 → 链值变化（断点可检）', () => {
    const e = { ts: 'T1', type: 'content_hashed', actor: 'svc', detail: { h: 'aa' } };
    const base = chainHash(MW_GENESIS, sha256Hex(body(e)));
    for (const alt of [{ ...e, ts: 'T2' }, { ...e, actor: 'evil' }, { ...e, detail: { h: 'bb' } }]) {
      expect(chainHash(MW_GENESIS, sha256Hex(body(alt)))).not.toBe(base);
    }
  });

  it('链式续接：第 2 条依赖第 1 条（改第 1 条 → 第 2 条失配，仿 verifyAppendChain 断点语义）', () => {
    const e1 = { ts: 'T1', type: 'content_hashed' as const, actor: 'a', detail: {} };
    const e2 = { ts: 'T2', type: 'summary_generated' as const, actor: 'a', detail: {} };
    const c1 = chainHash(MW_GENESIS, sha256Hex(body(e1)));
    const c2 = chainHash(c1, sha256Hex(body(e2)));
    // 篡改 e1 → 重算 c1' ≠ c1，而 c2 仍锚定旧 c1 → 断点在第 1 条
    const c1Tampered = chainHash(MW_GENESIS, sha256Hex(body({ ...e1, actor: 'evil' })));
    expect(c1Tampered).not.toBe(c1);
    expect(chainHash(c1Tampered, sha256Hex(body(e2)))).not.toBe(c2);
  });
});
