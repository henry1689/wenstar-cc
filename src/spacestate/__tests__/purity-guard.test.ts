/**
 * 工程约束静态守卫（任务书「四、工程约束」违反即阻断合并）
 *
 * - 约束 2：core/ 全部纯函数 —— 禁止 import fs/db、Date.now、Math.random、process.env
 * - 约束 3：全部 float64，禁止 Float32Array
 * - 约束 4：参数集中在配置源，core 中除 0/1/2/0.5 外不出现数值字面量
 *
 * 约束 1（代码只在 src/spacestate/ 下）由 git diff 验证，见自测报告。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'core');
const sourceNames = readdirSync(coreDir).filter((f) => f.endsWith('.ts'));
const sources = sourceNames.map((name) => ({
  name,
  raw: readFileSync(join(coreDir, name), 'utf8'),
}));

/** 配置源本身就是数值字面量的合法落点，豁免出字面量守卫 */
const CONFIG_FILE = 'config.ts';

/** 约束 4 明确放行的四个数值 */
const NUMERIC_WHITELIST = new Set(['0', '1', '2', '0.5']);

/** 剥掉注释与字符串字面量，避免文档示例里的数字被误判为代码字面量 */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
}

describe('约束 2 · core 纯函数', () => {
  it('不 import fs / db / 路径等副作用模块', () => {
    // 覆盖 node:fs、fs/promises 这类带子路径的写法
    const forbiddenImport =
      /\bfrom\s+['"](?:node:)?(?:fs|path|os|http|https|child_process|db|database)(?:\/[\w.-]+)?['"]/;
    // 覆盖 CJS require 动态加载
    const forbiddenRequire =
      /\brequire\s*\(\s*['"](?:node:)?(?:fs|path|os|http|https|child_process|db|database)(?:\/[\w.-]+)?['"]/;
    for (const { name, raw } of sources) {
      // 剥注释：说明性文字里提到 Date.now 不构成违规
      const code = stripNonCode(raw);
      expect(forbiddenImport.test(code), `${name} 引入了副作用模块`).toBe(false);
      expect(forbiddenRequire.test(code), `${name} 通过 require 引入副作用模块`).toBe(false);
    }
  });

  it('不调用 Date.now / Math.random / process.env', () => {
    const forbiddenCall = /\b(?:Date\.now|Math\.random|process\.env)\b/;
    for (const { name, raw } of sources) {
      // 剥注释：dial.ts 的文档注释里写了「core 禁止 Date.now」，那是说明不是调用
      expect(forbiddenCall.test(stripNonCode(raw)), `${name} 出现非纯调用`).toBe(false);
    }
  });

  it('无模块级可变状态（不出现 let / var 声明）', () => {
    // \s+ 后接 [\w$] 会漏掉解构声明 `let [a]` / `let {a}`，故一并覆盖
    const mutableDecl = /\b(?:let|var)\s+(?:[\w$]+|\[|\{)/;
    for (const { name, raw } of sources) {
      const code = stripNonCode(raw);
      expect(mutableDecl.test(code), `${name} 出现模块级可变声明`).toBe(false);
    }
  });
});

describe('约束 3 · float64 only', () => {
  it('不出现 TypedArray，也不用 Math.fround 做 float32 强转', () => {
    const forbidden =
      /\b(?:Float32Array|Float64Array|Int8Array|Uint8Array|Int16Array|Uint16Array|Int32Array|Uint32Array|Math\.fround)\b/;
    for (const { name, raw } of sources) {
      expect(forbidden.test(raw), `${name} 使用了 TypedArray 或 float32 强转`).toBe(false);
    }
  });
});

describe('约束 4 · 参数集中配置源', () => {
  it('core（除 config.ts）除 0/1/2/0.5 外不出现数值字面量', () => {
    const offenders: string[] = [];
    for (const { name, raw } of sources) {
      if (name === CONFIG_FILE) continue;
      const code = stripNonCode(raw);
      const literals = code.match(/(?<![\w$.])\d+(?:\.\d+)?(?![\w])/g) ?? [];
      const bad = literals.filter((n) => !NUMERIC_WHITELIST.has(n));
      if (bad.length > 0) offenders.push(`${name}: ${[...new Set(bad)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('配置源导出全部必需参数', async () => {
    const config = await import('../core/config.js');
    expect(config.INT8_MAX).toBe(127);
    expect(config.PI_BYTE_OFFSET).toBe(128);
    expect(config.PI_LOG2_SCALE).toBe(14.75);
    expect(config.PI_CODE_MIN).toBe(1);
    expect(config.PI_CODE_MAX).toBe(255);
    expect(config.PI_MAX).toBe(400);
    expect(config.MINUTES_PER_DAY).toBe(1440);
  });

  it('配置源为纯常量导出（无可变状态）', async () => {
    const config = await import('../core/config.js');
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), key).toBe(true);
        continue;
      }
      // 切片#3 起 config 含数组/对象常量（掩码表、锁定维度、层名）：
      // 必须 frozen，否则仍是可被就地改写的可变状态
      expect(Object.isFrozen(value), `${key} 应被 Object.freeze`).toBe(true);
    }
  });

  it('config 中的数组常量内层也已冻结', async () => {
    const config = await import('../core/config.js');
    const masks = (config as { DEFAULT_MASKS?: Record<string, readonly number[]> }).DEFAULT_MASKS;
    expect(masks).toBeDefined();
    for (const [name, arr] of Object.entries(masks!)) {
      expect(Object.isFrozen(arr), `DEFAULT_MASKS.${name} 内层应冻结`).toBe(true);
    }
    const locked = (config as { LOCKED_WEIGHT_DIMS?: readonly string[] }).LOCKED_WEIGHT_DIMS;
    expect(Object.isFrozen(locked)).toBe(true);
    expect(Object.isFrozen(config.LAYER_NAMES)).toBe(true);
  });
});
