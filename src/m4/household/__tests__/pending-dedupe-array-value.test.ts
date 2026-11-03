import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';

/**
 * P136 · normalizePendingKey 数组 value 崩溃修复回归
 * ============================================================
 * 缺陷（6ac709b / 2026-07-19 引入，err.log 5 次实证）：
 *   pendingItems 中 taboos/dislikes/traits 类 value 为数组，原签名 `value: string`
 *   在 .trim() 抛 TypeError → dedupePendingItems 中断 → 该轮 pending 写入静默失败。
 *
 * 本文件锁定：
 *   ① 数组 value 不再抛
 *   ② 同 field+同数组去重合并（key 稳定）
 *   ③ 字符串条目去重语义与原实现等价
 *   ④ 生产复现路径：带数组 pending 的节点走 updatePersonProfile（原 5 次崩溃链）不抛、pending 保留
 *
 * 🔴 隐私红线遵守：本测试仅使用中性占位文本，不引用任何实体的个人信息。
 */

const DB = join('D:/tmp', `__p136_dedupe_${process.pid}.db`);

async function freshFg(): Promise<any> {
  try { if (existsSync(DB)) rmSync(DB); } catch { /* ignore */ }
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  return fg;
}

const ARR_ITEM = {
  field: 'selfProfile.taboos',
  value: ['测试禁则甲', '测试禁则乙'],
  timestamp: '2026-10-30T00:00:00.000Z',
  confirmed: false,
  occurrences: 1,
};
const STR_ITEM = {
  field: 'selfProfile.languageHabits',
  value: '说话以第三人称自称',
  timestamp: '2026-10-30T00:00:00.000Z',
  confirmed: false,
  occurrences: 1,
};

describe('P136 · normalizePendingKey 数组 value 修复', () => {
  let fg: any;
  beforeEach(async () => { fg = await freshFg(); });
  afterEach(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (existsSync(DB)) rmSync(DB); } catch { /* ignore */ }
  });

  it('① 数组 value 过 dedupe 不再抛 TypeError（原崩溃点）', () => {
    expect(() => (fg as any).dedupePendingItems([ARR_ITEM])).not.toThrow();
  });

  it('② 同 field+同数组 → 同 key 去重为 1 条，数组内容原样保留', () => {
    const out = (fg as any).dedupePendingItems([ARR_ITEM, { ...ARR_ITEM, timestamp: '2026-10-30T01:00:00.000Z' }]);
    expect(out.length).toBe(1);
    expect(out[0].value).toEqual(['测试禁则甲', '测试禁则乙']);
  });

  it('③ 字符串条目去重语义与原实现等价（同 field+同值合并为 1）', () => {
    const out = (fg as any).dedupePendingItems([STR_ITEM, { ...STR_ITEM }]);
    expect(out.length).toBe(1);
    expect(out[0].value).toBe('说话以第三人称自称');
    // 不同值不误合
    const out2 = (fg as any).dedupePendingItems([STR_ITEM, { ...STR_ITEM, value: '另一条习惯' }]);
    expect(out2.length).toBe(2);
  });

  it('④ 生产复现路径：带数组 pending 的节点走 updatePersonProfile 不抛且 pending 保留', async () => {
    const props = JSON.stringify({
      name: '测试实体',
      pendingItems: [ARR_ITEM, STR_ITEM],
      mention_count: 3,
    });
    fg.run(
      'INSERT INTO nodes (id, type, name, aliases, properties, created_at, updated_at, uuid) VALUES (?,?,?,?,?,?,?,?)',
      ['t-p136', 'person', '测试实体', '[]', props, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'TXS-P136'],
    );
    // 原 5 次崩溃链：updatePersonProfile → dedupePendingItems(全量含数组) → normalizePendingKey
    await expect(fg.updatePersonProfile('测试实体', { mention_count: 4 })).resolves.toBeUndefined();
    const row = fg.query('SELECT properties FROM nodes WHERE id = ?', ['t-p136'])[0];
    const p = JSON.parse(row.properties);
    expect(Array.isArray(p.pendingItems)).toBe(true);
    expect(p.pendingItems.length).toBe(2);
    expect(p.mention_count).toBe(4);
  });
});
