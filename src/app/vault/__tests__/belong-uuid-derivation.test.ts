import { describe, it, expect } from 'vitest';
import * as MA from '../MemoryAssessor.js';

// [②-1] 归属 UUID 推导守卫（2026-09-13）
//
// 根因（实测取证）：MemoryAssessor 砂金→金库晋升时用
//     belongEntityUuid: String(conv.belong_entity_uuid || conv.entity_uuid || null)
// 当两个来源都为空 → `String(null)` === **字符串 'null'**（真值！），
// 绕过所有 `IS NOT NULL` / `!= ''` 判空 → 写入 memories。
//
// 实测污染面：memories 64 条 | vault_log 38 条 | black_diamond 4 条（均为其下游传播）。
// 后果：这 64 条真实对话（时间跨度 2026-08-28 ~ 09-12）在检索侧被
//   UUIDPoliceFilter 白名单 fail-closed 一律拒绝 → 永远召不回（"已记住却召不回"的一块）。
// 另：启动日志 `UUID=null` 而非 `UUID=none` 亦由此而来（`'null' || 'none'` 取真值）。
//
// 修复：把推导收口为导出纯函数 deriveBelongUuid —— 除了修正 String(null) 陷阱，
//   还主动拦截历史脏值（字符串 'null' / 'undefined' / 纯空白），返回 undefined 交写入侧落 NULL。
//
// 红测试写法：待实现导出用 Record 断言取用，避免实现落地前让 S3 的 tsc 前置检查失败。

type DeriveFn = (conv: any) => string | undefined;

const maMod = MA as unknown as Record<string, unknown>;
const deriveBelongUuid = maMod.deriveBelongUuid as DeriveFn | undefined;

describe('[②-1] 归属 UUID 推导 —— 杜绝 String(null) 字符串陷阱', () => {
  it('导出 deriveBelongUuid', () => {
    expect(typeof deriveBelongUuid).toBe('function');
  });

  it('正常归属 → 原样返回', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: 'TXS-000000007' })).toBe('TXS-000000007');
  });

  it('🔴 两个来源都为空 → 返回 undefined，而不是字符串 "null"', () => {
    const r = deriveBelongUuid!({ belong_entity_uuid: null, entity_uuid: null });
    expect(r).toBeUndefined();
    expect(r).not.toBe('null');   // 这正是原缺陷的产物
  });

  it('两个字段都缺失 → undefined', () => {
    expect(deriveBelongUuid!({})).toBeUndefined();
  });

  it('回退到 entity_uuid', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: null, entity_uuid: 'TXS-000000011' })).toBe('TXS-000000011');
  });

  it('拦截历史脏值：字符串 "null" → undefined', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: 'null' })).toBeUndefined();
  });

  it('拦截历史脏值：字符串 "undefined" → undefined', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: 'undefined' })).toBeUndefined();
  });

  it('拦截空串与纯空白 → undefined', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: '' })).toBeUndefined();
    expect(deriveBelongUuid!({ belong_entity_uuid: '   ' })).toBeUndefined();
  });

  it('数字/非字符串原始值不产生 "null" 字面量', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: 0 })).toBeUndefined();
    expect(deriveBelongUuid!({ belong_entity_uuid: false })).toBeUndefined();
  });

  it('脏值在前、合法值在后 → 回退取合法值', () => {
    expect(deriveBelongUuid!({ belong_entity_uuid: 'null', entity_uuid: 'TXS-000000019' })).toBe('TXS-000000019');
  });

  it('传入 null / undefined 容器不抛错', () => {
    expect(deriveBelongUuid!(null)).toBeUndefined();
    expect(deriveBelongUuid!(undefined)).toBeUndefined();
  });
});
