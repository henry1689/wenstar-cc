/**
 * 批17 第3步b: 批量档案加载的【行为等价性】测试
 *
 * 背景：batchProfile 从"逐个 getPersonProfileWithBio"改为"批量 + 兜底"，
 *      这是性能关键路径，必须证明**结果与单条版一致**（不能靠推理）。
 *
 * 覆盖：
 *  1. 批量结果 == 逐个结果（同一组真实名字，逐字段比对）
 *  2. 别名命中等价（用别名查 → 与单条版同样命中主名）
 *  3. 不存在的名字 → 两边都为 null
 *  4. 空输入 / 重复名 / 顺序无关
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { copyRealDbForTest } from '../../../__tests__/helpers/safe-db-copy.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_PATH_MOD = '../FamilyGraph.js';
const REPO = join(HERE, '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

describe('批17-3b · 批量档案加载行为等价性', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    if (!existsSync(FG_SRC)) {
      throw new Error('[批17测试] 缺少真实 FG 库：' + FG_SRC);
    }
    const copied = await copyRealDbForTest(FG_SRC, { prefix: 'v27b17-batch-' });
    tmpDir = copied.dir;
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copied.path);
    await fg.initialize();
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** 取一组真实 active 人名作为被测样本 */
  const sampleNames = (): string[] => {
    const rows = fg.query(
      "SELECT name FROM nodes WHERE type='person' AND status='active' LIMIT 12",
    ) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  };

  it('🔴 批量结果与逐个结果【逐字段一致】', () => {
    if (!fg) return;
    const names = sampleNames();
    expect(names.length, '样本必须非空（否则测试无意义）').toBeGreaterThan(0);

    const batch = fg.getPersonProfilesWithBioBatch(names);
    const singles: Record<string, any> = {};
    for (const n of names) singles[n] = fg.getPersonProfileWithBio(n);

    for (const n of names) {
      expect(batch[n], '键必须存在: ' + n).toBeDefined();
      expect(batch[n].profile, 'profile 存在性应一致: ' + n)
        .toEqual(singles[n].profile);
      expect(batch[n].bio, 'bio 应一致: ' + n).toEqual(singles[n].bio);
    }
  });

  it('不存在的名字 → 两边都是 null（不得凭空造档案）', () => {
    if (!fg) return;
    const ghost = '批17不存在的人甲';
    const batch = fg.getPersonProfilesWithBioBatch([ghost]);
    const single = fg.getPersonProfileWithBio(ghost);
    expect(batch[ghost].profile).toBeNull();
    expect(single.profile).toBeNull();
  });

  it('空输入 → 空结果（不抛错）', () => {
    if (!fg) return;
    expect(fg.getPersonProfilesWithBioBatch([])).toEqual({});
    expect(fg.getPersonProfilesWithBioBatch(null as any)).toEqual({});
  });

  it('重复名 / 顺序无关 —— 结果键集合一致', () => {
    if (!fg) return;
    const names = sampleNames().slice(0, 5);
    const a = fg.getPersonProfilesWithBioBatch([...names, ...names]);       // 重复
    const b = fg.getPersonProfilesWithBioBatch([...names].reverse());      // 逆序
    expect(Object.keys(a).sort()).toEqual([...new Set(names)].sort());
    expect(Object.keys(b).sort()).toEqual([...new Set(names)].sort());
    for (const n of names) expect(a[n]).toEqual(b[n]);
  });

  it('别名查询与单条版等价（若样本含别名）', () => {
    if (!fg) return;
    // 找一个带别名的真实节点
    const rows = fg.query(
      "SELECT name, aliases FROM nodes WHERE type='person' AND status='active' AND aliases IS NOT NULL AND aliases != '[]' LIMIT 1",
    ) as Array<{ name: string; aliases: string }>;
    if (rows.length === 0) return;   // 无别名样本则跳过（非失败）
    let aliases: string[] = [];
    try { aliases = JSON.parse(rows[0].aliases); } catch { return; }
    const alias = aliases[0];
    if (!alias) return;

    const batch = fg.getPersonProfilesWithBioBatch([alias]);
    const single = fg.getPersonProfileWithBio(alias);
    expect(batch[alias]?.profile, '别名应能命中').toEqual(single.profile);
  });
});
