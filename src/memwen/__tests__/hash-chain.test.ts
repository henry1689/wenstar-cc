import { describe, it, expect } from 'vitest';
import {
  canon,
  hashCore,
  chainHash,
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
