/**
 * 工程约束静态守卫（任务书「四、工程约束」违反即阻断合并）
 *
 * - 约束 2：core/ 全部纯函数 —— 禁止 import fs/db、Date.now、Math.random、process.env
 *   （本用例**先剥注释与字符串再扫代码**，故说明文字里出现这些字面量不构成违规。
 *    不用裸文本匹配——那会逼文档去迎合 grep，B-3 任务 6 已撤销此类判据）
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
      // 层参数查询函数（layerOf / layerLambda / layerTau / resonanceMask）是
      // 纯函数导出：绑定由 const 声明不可重赋值，函数体自身也无可变状态，
      // 故不参与冻结断言（Object.freeze 对函数只锁属性、锁不住行为，断言无意义）
      if (typeof value === 'function') continue;
      // 切片#3 起 config 含数组/对象/Set 常量（掩码表、层名、层归属、维度开关）：
      // 必须 frozen，否则仍是可被就地改写的可变状态。
      // 🔴 冻结断言前先证明入参是对象：Object.isFrozen(undefined) === true，
      // 对可能为 undefined 的值做冻结断言是永真且零验证的（补包 B 第 6 项）
      expect(typeof value, `${key} 应为对象`).toBe('object');
      expect(value, `${key} 不应为 null`).not.toBeNull();
      expect(Object.isFrozen(value), `${key} 应被 Object.freeze`).toBe(true);
      // Set 的 .add/.delete 不受 Object.freeze 影响，冻结只是必要非充分条件，
      // 这里额外保证开关集合非空——空集会让 OBSERVE_ONLY 之类的约束静默失效
      if (value instanceof Set) {
        expect(value.size, `${key} 不应为空集`).toBeGreaterThan(0);
      }
    }
  });

  it('config 中的数组常量内层也已冻结', async () => {
    // 直接用模块的真实导出类型，**不再用 `as { X?: ... }` 可选断言**——
    // 可选属性断言会把「已删除的属性」变成 undefined 而不报编译错，
    // 正是永真断言的成因（补包 B 第 6 项）
    const config = await import('../core/config.js');

    /** 冻结断言前先证明入参是对象：Object.isFrozen(undefined) === true，恒真零验证 */
    const assertFrozenObject = (value: unknown, label: string): void => {
      expect(typeof value, `${label} 应为对象`).toBe('object');
      expect(value, `${label} 不应为 null`).not.toBeNull();
      expect(Object.isFrozen(value), `${label} 应被 Object.freeze`).toBe(true);
    };

    const masks = config.DEFAULT_MASKS;
    assertFrozenObject(masks, 'DEFAULT_MASKS');
    for (const [name, arr] of Object.entries(masks)) {
      assertFrozenObject(arr, `DEFAULT_MASKS.${name}`);
    }

    // 🔴 已删除常量的**正向**断言。旧写法是
    //   Object.isFrozen(config.LOCKED_WEIGHT_DIMS) === true
    // 属性删除后取到 undefined，而 Object.isFrozen(undefined) 恒为 true ——
    // 断言永远通过、却什么都不验证。改为断言「该属性确实不存在」。
    expect('LOCKED_WEIGHT_DIMS' in config).toBe(false);

    assertFrozenObject(config.LAYER_NAMES, 'LAYER_NAMES');

    // 层归属表是全局唯一的维度语义映射：被就地改写会让全部层的证据悄悄错配，
    // 且不会抛任何错——故外层与每个层的数组都必须冻结。
    const dimsByLayer = config.DIMS_BY_LAYER;
    assertFrozenObject(dimsByLayer, 'DIMS_BY_LAYER');
    for (const [layer, list] of Object.entries(dimsByLayer)) {
      assertFrozenObject(list, `DIMS_BY_LAYER.${layer}`);
    }

    // 层参数与三个维度级开关（补包 B 第 4 项同源：这些常量必须有消费者断言）
    assertFrozenObject(config.LAYER_PARAMS, 'LAYER_PARAMS');
    for (const [layer, param] of Object.entries(config.LAYER_PARAMS)) {
      assertFrozenObject(param, `LAYER_PARAMS.${layer}`);
    }
    assertFrozenObject(config.NO_KALMAN_DIMS, 'NO_KALMAN_DIMS');
    assertFrozenObject(config.OBSERVE_ONLY_DIMS, 'OBSERVE_ONLY_DIMS');
    assertFrozenObject(config.PRIVATE_ONLY_DIMS, 'PRIVATE_ONLY_DIMS');
  });

  it('core/ 内禁止 Object.freeze(new Set / new Map（假冻结）', () => {
    // B-3 任务 2。
    // 理由：Object.freeze 不冻结 Set/Map 的内部槽位，只冻结属性 ——
    // 冻结后 .add()/.delete() 照样能用，而 Object.isFrozen() 返回 true，
    // 守卫全绿但约束无效。这是本项目第二次踩同一个坑
    // （第一次是 Object.isFrozen(undefined) === true 的永真断言）。
    const PATTERN = /Object\.freeze\(\s*new\s+(?:Set|Map)\b/;

    const offenders = sources
      .filter(({ raw }) => PATTERN.test(stripNonCode(raw)))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);

    // ★ 正向对照：证明该模式确实能命中，否则本用例是永真的。
    // （等价于任务书要求的「故意写一行验证它会红」——用合成样例代替真改源码，
    //  避免在并行会话共享的工作树上制造瞬时脏状态）
    expect(PATTERN.test('const s = Object.freeze(new Set([1]));')).toBe(true);
    expect(PATTERN.test('const m = Object.freeze(new Map());')).toBe(true);
    expect(PATTERN.test('const s = readonlySet([1]);')).toBe(false);
    // 注释里的示例不算违规（先剥注释再扫）
    expect(PATTERN.test(stripNonCode('// 例：Object.freeze(new Set())'))).toBe(false);
    expect(PATTERN.test(stripNonCode('const s = Object.freeze(new Set());'))).toBe(true);
  });

  it('本文件无残留的可选属性类型断言（会掩盖已删除属性）', async () => {
    // 本用例是「排查规则」的落点：新增断言时若再引入可选属性断言，
    // 下面的源码扫描会报红，逼迫改用真实导出类型 + 正向存在性断言。
    // 扫描前先剥注释与字符串，避免说明文字里的示例被误判为代码。
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'purity-guard.test.ts'),
      'utf8',
    );
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
      .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
    const offenders = code.match(/as\s*\{\s*\w+\s*\??:/g) ?? [];
    expect(offenders).toEqual([]);
  });
});
