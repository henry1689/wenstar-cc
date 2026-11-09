import { describe, it, expect, expectTypeOf } from 'vitest';
import type { MwIdentityPort, MwResolveResult, MwContextView, MwRenderResult } from '../identity-port.js';

/**
 * MemWen OS 守卫 · MwIdentityPort 签名冻结（豆包 P182 裁定③的可执行化）
 *
 * 类型层守卫：接口形状一旦漂移（改名/增减参数/改返回结构）本测试编译失败 ——
 * 这正是「签名冻结」的执行机制。零运行时依赖（纯类型断言）。
 */

type Keys<T> = Exclude<keyof T, never>;

describe('MwIdentityPort · 签名冻结（P181 §4.1 逐字）', () => {
  it('四函数齐备且不可增减', () => {
    expectTypeOf<Keys<MwIdentityPort>>().toEqualTypeOf<
      'resolve' | 'canAttend' | 'viewFor' | 'render'
    >();
  });

  it('resolve(text) → { uuid, confidence, src }', () => {
    expectTypeOf<MwIdentityPort['resolve']>()
      .parameters
      .toEqualTypeOf<[text: string]>();
    expectTypeOf<Keys<MwResolveResult>>().toEqualTypeOf<'uuid' | 'confidence' | 'src'>();
    expectTypeOf<MwResolveResult['uuid']>().toEqualTypeOf<string>();
    expectTypeOf<MwResolveResult['confidence']>().toEqualTypeOf<number>();
    expectTypeOf<MwResolveResult['src']>().toEqualTypeOf<string>();
  });

  it('canAttend(uuid) → boolean', () => {
    expectTypeOf<MwIdentityPort['canAttend']>()
      .parameters
      .toEqualTypeOf<[uuid: string]>();
    expectTypeOf<MwIdentityPort['canAttend']>().returns.toEqualTypeOf<boolean>();
  });

  it('viewFor(uuid) → ContextView | null（事件以 id 表示，适配器映射）', () => {
    expectTypeOf<MwIdentityPort['viewFor']>()
      .parameters
      .toEqualTypeOf<[uuid: string]>();
    expectTypeOf<MwIdentityPort['viewFor']>().returns.toEqualTypeOf<MwContextView | null>();
    expectTypeOf<Keys<MwContextView>>().toEqualTypeOf<
      'seatUuid' | 'readable' | 'metaOnly' | 'addressed'
    >();
    expectTypeOf<MwContextView['readable']>().toEqualTypeOf<readonly string[]>();
  });

  it('render(uuid) → { canonicalName, aliases }', () => {
    expectTypeOf<MwIdentityPort['render']>()
      .parameters
      .toEqualTypeOf<[uuid: string]>();
    expectTypeOf<Keys<MwRenderResult>>().toEqualTypeOf<'canonicalName' | 'aliases'>();
    expectTypeOf<MwRenderResult['canonicalName']>().toEqualTypeOf<string>();
    expectTypeOf<MwRenderResult['aliases']>().toEqualTypeOf<readonly string[]>();
  });

  it('零运行时：identity-port 只有类型，无可执行导出（编译期擦除）', async () => {
    // 纯类型模块在运行时无产物 —— 该断言失败意味着有人塞了实现进 Port（裁定③禁止）
    const mod = await import('../identity-port.js');
    expect(typeof mod).toBe('object');
    expect(Object.keys(mod)).toHaveLength(0); // 运行时导出必须为空
  });
});
