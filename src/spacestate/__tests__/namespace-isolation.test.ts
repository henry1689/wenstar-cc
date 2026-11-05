/**
 * 切片#3 补包 · 命名空间隔离（FieldDim / LegacyDim）
 *
 * 保证 v3.1 的 `DimId` 与 v2.1 旧键 `LegacyDim` **编译期与运行期都互不兼容**：
 * 两个联合交集为空，赋值必然报错，无需 branded symbol。
 *
 * 🔴 本包**不实现 adapter**，只固化三条硬约束（见 contract/legacy-dim.ts）：
 * 1. 旧键一律 `L:` 前缀
 * 2. 旧「当前全 0」扇区一律输出 π=0（未知），不是「值 0 + 正常精度」
 * 3. 旧表不得用作层归属 / 双极判定 / 维度语义来源
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_PREFIX, LEGACY_ZERO_SECTORS, legacyDim, type LegacyDim } from '../contract/legacy-dim.js';
import type { DimId } from '../core/layout.js';

const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'core');

describe('编译期隔离 · 两个联合交集为空', () => {
  it('LegacyDim → DimId 必须报错', () => {
    const legacy = legacyDim('L:d07_self_heal');
    // @ts-expect-error 旧键不得赋给 Field 侧维度类型
    const _toField: DimId = legacy;
    expect(_toField).toBe('L:d07_self_heal');
  });

  it('DimId → LegacyDim 必须报错', () => {
    const field: DimId = 'D07';
    // @ts-expect-error Field 侧维度不得赋给旧键类型
    const _toLegacy: LegacyDim = field;
    expect(_toLegacy).toBe('D07');
  });

  it('裸字符串赋给 LegacyDim 必须报错（缺 L: 前缀）', () => {
    // @ts-expect-error 未加前缀的旧键在类型层就不合法
    const _bad: LegacyDim = 'd07_self_heal';
    expect(_bad).toBe('d07_self_heal');
  });
});

describe('core/ 源码扫描 · 旧键零泄漏', () => {
  it('core/ 下任何 .ts 都不得出现 LegacyDim / legacyDim / L: 前缀', () => {
    const files = readdirSync(coreDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      const raw = readFileSync(join(coreDir, name), 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      if (/LegacyDim|legacyDim|LEGACY_PREFIX/.test(code)) offenders.push(`${name}: 旧键标识符`);
      if (/(^|[^A-Za-z0-9_])L:/.test(code)) offenders.push(`${name}: L: 前缀`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('legacyDim · 前缀强制校验', () => {
  it('不以 L: 开头一律抛错（否则旧坐标会绕过隔离层）', () => {
    expect(() => legacyDim('D07')).toThrow(/必须以 'L:' 开头/);
    expect(() => legacyDim('d07_self_heal')).toThrow();
    expect(() => legacyDim('')).toThrow();
  });

  it('L: 前缀通过，且前缀常量唯一', () => {
    expect(LEGACY_PREFIX).toBe('L:');
    expect(legacyDim('L:d07_self_heal')).toBe('L:d07_self_heal');
    expect(legacyDim('L:D32')).toBe('L:D32');
  });
});

describe('旧扇区 π=0 约束登记（本包不实现 adapter）', () => {
  it('三个「当前全 0」扇区已登记', () => {
    expect([...LEGACY_ZERO_SECTORS]).toEqual([
      'physical_body',
      'spatiotemporal',
      'dynamic_growth',
    ]);
    expect(Object.isFrozen(LEGACY_ZERO_SECTORS)).toBe(true);
  });

  it('三条硬约束以常量形式留痕，供 adapter 切片引用', () => {
    // ① 旧键一律 L: 前缀 —— 由 LEGACY_PREFIX 与 legacyDim() 强制
    // ② 三个扇区一律输出 π=0（未知），而非「值 0 + 正常精度」
    //    理由：值 0 是确定的中性判断会当真实印记参与证据计算，
    //          π=0 才是未知（dimEvidence 直接返回 0，S-060）
    // ③ 旧表不得用作层归属 / 双极判定 / 维度语义来源
    expect(LEGACY_ZERO_SECTORS.length).toBeGreaterThan(0);
    expect(LEGACY_PREFIX).toBe('L:');
  });
});