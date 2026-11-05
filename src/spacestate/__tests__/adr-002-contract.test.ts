/**
 * ADR-002《私密模式定义与边界》契约测试（补包 B2 第 4 项）
 *
 * 🔴 这是**契约测试，不是功能测试**。私密模式的生产触发路径尚未接入，
 * 本文件锁定的是「约束不得遗失」：
 *
 * 1. `privateMode` 只能由调用方每次传入 —— 禁止持久化 / 环境变量 / 全局状态 / 内容推断
 * 2. 保守规则：`true` 之外的任何值一律视为关（ADR-002 §4）
 * 3. trace 掩码约束（ADR-002 §3.6 第 3 条）已在代码中记录，S-075 落地时不得遗失
 * 4. 来源限制（ADR-002 §3.1）：只允许显式来源，判定行为本身即侵犯
 *
 * 具体 trace 实现推迟至 S-075，但**此处的记录与扫描必须先在**。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveWeight, type WeightContext } from '../core/aggregation.js';
import { resonanceMask } from '../core/config.js';

const spacestateDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): { name: string; code: string }[] {
  const out: { name: string; code: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 只扫**生产源码**：测试文件里出现这些字样是正当的（正则模式、说明文字）
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      const raw = readFileSync(full, 'utf8');
      // 剥注释：说明性文字里提到环境变量读取不构成违规（与 purity-guard 同口径）
      // 注意：扫描前先剥注释，因此禁止项的字面量只允许出现在注释里
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
        .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
      out.push({ name: entry.name, code });
    }
  }
  return out;
}

describe('ADR-002 §4.3 · privateMode 不持久化', () => {
  const files = sourceFiles(spacestateDir);

  it('扫描到的源文件非空（防扫描路径写错导致永真通过）', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.name === 'config.ts')).toBe(true);
    expect(files.some((f) => f.name === 'aggregation.ts')).toBe(true);
  });

  it('禁止环境变量 / 全局状态 / 内容推断', () => {
    const forbidden = [
      /\bprocess\.env\b/,
      /\blet\s+privateMode\b/,
      /\bvar\s+privateMode\b/,
      /\bsetPrivateMode\b/,
      /RegExp[\s\S]{0,40}privateMode/,
    ];
    const offenders: string[] = [];
    for (const { name, code } of files) {
      for (const re of forbidden) {
        if (re.test(code)) offenders.push(`${name}: ${re.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('privateMode 不出现在任何模块级声明中', () => {
    // 只允许作为函数参数 / 接口字段出现，不允许 `const privateMode = ...`
    const offenders = files
      .filter(({ code }) => /\b(?:const|let|var)\s+privateMode\b/.test(code))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('私密标志不挂在全局对象上（ADR-002 §4.3）', () => {
    // 单独查 globalThis：私密状态若挂上全局对象，就等于跨调用持久化了。
    // 用「该文件是否出现 globalThis」判定，而不是把两个词拼成一条正则——
    // 后者会让本用例自身的扫描模式被验收用的裸 rg 误命中。
    const withGlobalThis = files
      .filter(({ code }) => code.includes('globalThis'))
      .map(({ name }) => name);
    expect(withGlobalThis).toEqual([]);
  });
});

describe('ADR-002 §4 · 保守规则（true 之外一律视为关）', () => {
  const OFF: WeightContext = { privateMode: false };
  const ON: WeightContext = { privateMode: true };

  it('resonanceMask 对非 true 值一律返回 0', () => {
    expect(resonanceMask('D20', false)).toBe(0);
    // 上游已传 === true，但本函数可被单独调用，故自身也要收紧
    expect(resonanceMask('D20', true)).toBe(1);
  });

  it('effectiveWeight 透传保守规则', () => {
    expect(effectiveWeight('D20', 1, 1, 'A', OFF, 0.3)).toBe(0);
    expect(effectiveWeight('D20', 1, 1, 'A', ON, 0.3)).toBeCloseTo(1.3, 12);
    const bad = { privateMode: undefined } as unknown as WeightContext;
    expect(effectiveWeight('D20', 1, 1, 'A', bad, 0.3)).toBe(0);
  });

  it('只观测维度在任何模式下都恒 0', () => {
    expect(effectiveWeight('D29', 1, 1, 'A', ON, 0.3)).toBe(0);
    expect(effectiveWeight('D30', 1, 1, 'A', ON, 0.3)).toBe(0);
  });
});

describe('ADR-002 §3.6 第 3 条 · trace 掩码约束已记录', () => {
  const raw = readFileSync(join(spacestateDir, 'core', 'aggregation.ts'), 'utf8');

  it('effectiveWeight 文档写明 trace 不得输出 D20 的值/精度/贡献量', () => {
    expect(raw).toMatch(/trace 掩码/);
    expect(raw).toMatch(/不得输出其值、精度、贡献量/);
    expect(raw).toMatch(/ADR-002 §3\.6/);
  });

  it('WeightContext 文档写明来源限制与不持久化（ADR-002 §3.1 / §4.3）', () => {
    expect(raw).toMatch(/ADR-002 §3\.1/);
    expect(raw).toMatch(/判定行为本身即侵犯/);
    expect(raw).toMatch(/绝不持久化/);
    expect(raw).toMatch(/ADR-002 §4\.3/);
  });

  it('S-075 落地前，本约束以注释 + 本契约测试双份留痕', () => {
    // 约束必须在代码里可见，不能只存在于任务书或报告
    expect(raw).toMatch(/S-075/);
    expect(raw).toMatch(/契约测试/);
  });
});
