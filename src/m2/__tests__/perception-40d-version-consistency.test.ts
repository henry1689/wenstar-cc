/**
 * perception-40d-version-consistency.test.ts — detect/decode 版本判定一致性回归(结构版)
 *
 * 结构根因:decode(看 __v===2)与 detect(看 dims 数组)对"v2 形状"各写一遍判定 → 分裂:
 *   {__v:3,dims:[40]} / {dims:[40]}(无 __v)→ detect 判 2(合规),decode 却落 v0 命名分支静默全零。
 * 结构修复:抽共享格式闸 hasV2Shape + 完整性闸 parseV2Dims,decode/detect 同源。
 */
import { describe, it, expect } from 'vitest';
import { decodePerceptionV40, detectPerceptionV40Version } from '../PerceptionVector40DCodec.js';
import { PERCEPTION_40D_DIM, PERCEPTION_40D_KEYS } from '../../m3/types/perception-40d.js';

function dimsOf(index: number, value: number): number[] {
  const d = new Array<number>(PERCEPTION_40D_DIM).fill(0);
  d[index] = value;
  return d;
}

describe('detect/decode 版本判定一致性(结构版)', () => {
  it('decode: __v 不匹配(3)但 dims 完整 → 按 v2 解析(不再静默全零)', () => {
    const s = JSON.stringify({ __v: 3, dims: dimsOf(1, 0.5) });
    expect(detectPerceptionV40Version(s)).toBe(2);
    const p = decodePerceptionV40(s);
    expect(p).not.toBeNull();
    expect(p![PERCEPTION_40D_KEYS[1]]).toBe(0.5);
  });

  it('decode: 无 __v 但带 dims 数组 → 按 v2 解析', () => {
    const s = JSON.stringify({ dims: dimsOf(11, 0.7) });
    expect(detectPerceptionV40Version(s)).toBe(2);
    const p = decodePerceptionV40(s);
    expect(p).not.toBeNull();
    expect(p![PERCEPTION_40D_KEYS[11]]).toBe(0.7);
  });

  it('decode: __v===2 却无 dims → null(畸形 v2,不落 v0)', () => {
    expect(decodePerceptionV40('{"__v":2}')).toBeNull();
    expect(decodePerceptionV40('{"__v":2,"dims":"not-array"}')).toBeNull();
  });

  it('decode: dims 完整性闸——长度非法 → null', () => {
    expect(decodePerceptionV40('{"__v":3,"dims":[1,2]}')).toBeNull();
    expect(decodePerceptionV40('{"dims":[1,2]}')).toBeNull();
  });

  it('decode: dims 含非数值 → null', () => {
    const arr = dimsOf(0, 0.5);
    arr[PERCEPTION_40D_DIM - 1] = 'abc' as unknown as number; // 字符串混入 → Number('abc')=NaN → 非法
    expect(decodePerceptionV40(JSON.stringify({ dims: arr }))).toBeNull();
  });

  it('decode: dims 非数组(对象) → 非 v2 形状,走 v0 命名分支', () => {
    // {dims: 对象} 无 dims 数组 → hasV2Shape=false → 非 __v:2 畸形 → v0 命名对象(无命名键 → 全零)
    const p = decodePerceptionV40(JSON.stringify({ dims: { length: PERCEPTION_40D_DIM, 0: 0.5 } }));
    expect(p).not.toBeNull();
    expect(p![PERCEPTION_40D_KEYS[0]]).toBe(0); // 命名键缺失 → 0,不抛不崩
  });

  it('标准 v2(__v:2 + dims 40)解码不变', () => {
    const good = { __v: 2, dims: dimsOf(0, 0.9) };
    const p = decodePerceptionV40(JSON.stringify(good));
    expect(p).not.toBeNull();
    expect(p![PERCEPTION_40D_KEYS[0]]).toBe(0.9);
  });

  it('标准 v1 纯数组解码不变', () => {
    const arr = new Array(PERCEPTION_40D_DIM).fill(0);
    arr[5] = 0.3;
    const p = decodePerceptionV40(JSON.stringify(arr));
    expect(p).not.toBeNull();
    expect(p![PERCEPTION_40D_KEYS[5]]).toBe(0.3);
  });

  it('标准 v0 命名对象(无 dims)解码不变', () => {
    const p = decodePerceptionV40(JSON.stringify({ d12_enjoyment: 0.9 }));
    expect(p).not.toBeNull();
    expect(p!.d12_enjoyment).toBe(0.9);
  });
});
