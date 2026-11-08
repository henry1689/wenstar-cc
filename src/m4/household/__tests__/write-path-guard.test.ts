import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRealDbForTest } from '../../../__tests__/helpers/safe-db-copy.js';

/**
 * B 阶段写入端根治正负样本双向锁定（2026-11-05，业主批准 A→C→B）
 * ============================================================
 * B1 前缀切片计数冻结：真名+1~2字的未建档切片不计 mention、不累积观察区证据
 *    （结构依据：切片的每次文本命中必然也是真名命中，证据全部源自真名语境）；
 *    逃生口 = 获得真实档案即解冻；同实体自身别名链豁免。
 * B2 changeHistory 单条字节封顶 + 条数上限（统一入口）。
 * B3 setDossierField 数组并集合并 + 幂等 + traitHints 同 value 去重。
 *
 * 夹具：copyRealDbForTest 受控复制真实 FG 库（缺失/空库一律失败，不允许零断言假通过）。
 * 测试名均为合成 fixture，不使用真实人名。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_PATH_MOD = '../FamilyGraph.js';
const REPO = join(HERE, '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

describe('B 阶段 · FamilyGraph 写入端根治', () => {
  let fg: any = null;
  let tmpDir = '';

  beforeAll(async () => {
    const copied = await copyRealDbForTest(FG_SRC, { prefix: 'write-path-guard-' });
    tmpDir = copied.dir;
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copied.path);
    await fg.initialize();
    const rows = fg.query('SELECT COUNT(*) AS c FROM nodes') as Array<{ c: number }>;
    if (!rows.length || Number(rows[0].c) <= 0) {
      throw new Error('[B阶段测试] 夹具库 nodes 为空 — 判定失败');
    }
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** 直接插测试节点（绕过 addNode 闸门，纯夹具构造） */
  const insertNode = (name: string, status: string, props: Record<string, unknown> = {}, id?: string) => {
    const now = new Date().toISOString();
    fg.run(
      `INSERT OR REPLACE INTO nodes (id, type, name, aliases, properties, created_at, updated_at, status, uuid)
       VALUES (?, 'person', ?, '[]', ?, ?, ?, ?, ?)`,
      [id ?? `t-${name}`, name, JSON.stringify(props), now, now, status, `TXS-T-${id ?? name}`],
    );
  };

  const readProps = (name: string): any => {
    const rows = fg.query('SELECT properties FROM nodes WHERE name = ?', [name]) as Array<{ properties: string }>;
    if (!rows.length) throw new Error('节点不存在: ' + name);
    return JSON.parse(rows[0].properties || '{}');
  };

  beforeEach(() => {
    if (!fg) throw new Error('[B阶段测试] FamilyGraph 夹具未就绪 — 判定失败');
  });

  // ───────────────────────── B1 前缀切片冻结 ─────────────────────────

  describe('B1 · 前缀切片计数冻结', () => {
    it('正样本：未建档的 真名+1字 切片 — mention 不增', async () => {
      insertNode('切片基名甲', 'active', { description: '基座真人' });
      insertNode('切片基名甲一', 'candidate', {});
      const before = readProps('切片基名甲一').mention_count || 0;
      await fg.updatePersonProfile('切片基名甲一', {} as any, { countMention: true });
      expect(readProps('切片基名甲一').mention_count || 0).toBe(before);
    });

    it('正样本：未建档的 真名+2字 切片 — mention 不增', async () => {
      insertNode('切片基名乙', 'active', { description: '基座真人' });
      insertNode('切片基名乙XY', 'candidate', {});
      const before = readProps('切片基名乙XY').mention_count || 0;
      await fg.updatePersonProfile('切片基名乙XY', {} as any, { countMention: true });
      expect(readProps('切片基名乙XY').mention_count || 0).toBe(before);
    });

    // 🔴 批3（ADR-021）：观察区证据累积方法已物理删除，原「切片在观察区不累积证据」
    //   用例随之退役（该路径已不存在）。

    it('逃生口：同名切片获得真实档案后 — 计数立即恢复', async () => {
      insertNode('切片基名丁', 'active', { description: '基座真人' });
      insertNode('切片基名丁一', 'candidate', {});
      await fg.updatePersonProfile('切片基名丁一', { description: '独立档案' } as any, { countMention: false });
      const before = readProps('切片基名丁一').mention_count || 0;
      await fg.updatePersonProfile('切片基名丁一', {} as any, { countMention: true });
      expect(readProps('切片基名丁一').mention_count || 0).toBe(before + 1);
    });

    it('负样本：非切片新人 — 计数正常', async () => {
      insertNode('全新独立人', 'candidate', {});
      await fg.updatePersonProfile('全新独立人', {} as any, { countMention: true });
      expect(readProps('全新独立人').mention_count || 0).toBe(1);
    });

    it('负样本：基座真人自身 — 计数正常', async () => {
      insertNode('切片基名戊', 'active', { description: '基座真人' });
      await fg.updatePersonProfile('切片基名戊', {} as any, { countMention: true });
      expect(readProps('切片基名戊').mention_count || 0).toBe(1);
    });

    it('负样本：有档案的"切片形"名字 — 不冻结（逃生口方向）', async () => {
      insertNode('切片基名己', 'active', { description: '基座真人' });
      insertNode('切片基名己一', 'active', { description: '独立真人档案', relation_to_user: '同事' });
      await fg.updatePersonProfile('切片基名己一', {} as any, { countMention: true });
      expect(readProps('切片基名己一').mention_count || 0).toBe(1);
    });

    it('豁免：显式传 mention_count 数值（合并/修复路径）不受冻结影响', async () => {
      insertNode('切片基名庚', 'active', { description: '基座真人' });
      insertNode('切片基名庚一', 'candidate', { mention_count: 5 });
      await fg.updatePersonProfile('切片基名庚一', { mention_count: 42 } as any, { countMention: false });
      expect(readProps('切片基名庚一').mention_count).toBe(42);
    });
  });

  // ───────────────────────── B2 changeHistory 字节封顶 ─────────────────────────

  describe('B2 · _changeHistory 单条字节封顶 + 条数上限', () => {
    it('超大单条（10KB 数组）被截断为摘要，条目总字节 ≤ 2048', () => {
      insertNode('历史封顶人', 'active', { description: '真人' });
      const huge = Array.from({ length: 500 }, (_, i) => `填充内容第${i}项-abcdef`);
      fg.addProfileChange('历史封顶人', 'bigField', huge, [...huge, '新增']);
      const h = readProps('历史封顶人')._changeHistory;
      expect(h.length).toBeGreaterThan(0);
      const last = h[h.length - 1];
      expect(Buffer.byteLength(JSON.stringify(last), 'utf8')).toBeLessThanOrEqual(2048);
      // 摘要形态：保留 field/timestamp 审计骨架
      expect(last.field).toBe('bigField');
      expect(last.timestamp).toBeTruthy();
    });

    it('普通小条目原样保留（不误伤）', () => {
      insertNode('历史封顶人2', 'active', { description: '真人' });
      fg.addProfileChange('历史封顶人2', 'smallField', 'a', 'b');
      const h = readProps('历史封顶人2')._changeHistory;
      const last = h[h.length - 1];
      expect(last.oldValue).toBe('a');
      expect(last.newValue).toBe('b');
    });

    it('条数上限仍生效（>200 截断到 200）', () => {
      insertNode('历史封顶人3', 'active', { description: '真人' });
      for (let i = 0; i < 210; i++) {
        fg.addProfileChange('历史封顶人3', `f${i}`, i, i + 1);
      }
      const h = readProps('历史封顶人3')._changeHistory;
      expect(h.length).toBe(200);
      // 保留的是最近的
      expect(h[h.length - 1].field).toBe('f209');
    });
  });

  // ───────────────────────── B3 数组合并 + 去重 ─────────────────────────

  describe('B3 · setDossierField 数组并集合并', () => {
    it('数组提交 → 与旧数组并集（旧序保留 + 新项追加）', async () => {
      insertNode('档案合并人', 'active', { description: '真人' });
      await fg.setDossierField('档案合并人', 'tags', ['旧一', '旧二']);
      await fg.setDossierField('档案合并人', 'tags', ['旧二', '新一']);
      const d = readProps('档案合并人').dossier;
      expect(d.tags).toEqual(['旧一', '旧二', '新一']);
    });

    it('幂等：重复提交同一数组 → 值不变且不新增历史', async () => {
      insertNode('档案合并人2', 'active', { description: '真人' });
      await fg.setDossierField('档案合并人2', 'tags', ['甲', '乙']);
      const h1 = (readProps('档案合并人2')._changeHistory || []).length;
      await fg.setDossierField('档案合并人2', 'tags', ['甲', '乙']);
      const h2 = (readProps('档案合并人2')._changeHistory || []).length;
      expect(h2).toBe(h1);
      expect(readProps('档案合并人2').dossier.tags).toEqual(['甲', '乙']);
    });

    it('非数组字段维持整替语义（不受合并影响）', async () => {
      insertNode('档案合并人3', 'active', { description: '真人' });
      await fg.setDossierField('档案合并人3', 'note', '第一版');
      await fg.setDossierField('档案合并人3', 'note', '第二版');
      expect(readProps('档案合并人3').dossier.note).toBe('第二版');
    });

    it('对象字段维持整替语义（非数组不合并）', async () => {
      insertNode('档案合并人4', 'active', { description: '真人' });
      await fg.setDossierField('档案合并人4', 'map', { a: 1 });
      await fg.setDossierField('档案合并人4', 'map', { b: 2 });
      expect(readProps('档案合并人4').dossier.map).toEqual({ b: 2 });
    });
  });

  describe('B3 · traitHints 同 value 去重', () => {
    it('text 同时命中「大方|豪爽」与「不小气」两模式 → traits 只推入一个「大方」', async () => {
      insertNode('性格提取人', 'active', {});
      // 该 text 同时命中 /大方|豪爽|不小气/ 的全部分支词（大方 + 豪爽 + 不小气）
      await fg.extractProfileFromText('性格提取人', '他性格很大方，为人豪爽，一点也不小气');
      const traits = readProps('性格提取人').traits || [];
      expect(traits.filter((t: string) => t === '大方').length).toBe(1);
    });
  });
});
