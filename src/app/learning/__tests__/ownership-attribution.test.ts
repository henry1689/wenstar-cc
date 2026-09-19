/**
 * ownership-attribution.test.ts — 写入端归属传递回归测试（2026-09-19 批 1）
 * ======================================================================
 * 事故来源：写入点**静默丢失** belong_entity_uuid，两种形态：
 *   ① 列清单缺席 —— INSERT 未列出该列 → 新行恒 NULL
 *   ② 列在但 bind 字面 NULL —— 守卫只查「列是否列出」，看不见值（更隐蔽）
 * 实测恶果：black_diamond.dna_root_id 全库 0/390；knowledge_base 98 行仅 1 行有归属。
 *
 * 本测试锁定修复后的两条不变量：
 *   A. 归属**可解析**时必须传递真值（ConflictDetector ← EntityGene.uuid）；
 *   B. 归属**确实无法解析**时（跨实体聚合 / 无户籍的 emotion 实体）必须显式 unowned，
 *      且列必须留在清单里 —— 否则「合法 unowned」与「漏列导致的值缺失」在文本上无法区分。
 *
 * 归属语义依据：《UUID 户籍管理法》第七条（无户口写入 → 仅户主钥匙场景可写，打 unowned 标记）。
 * ⚠️ 注意 OWNER_UUID='TXS-000000001' 是**玉瑶（系统默认本体）**而非用户本人，
 *    故聚合件不得以「感觉像户主的」为由写成 OWNER_UUID。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ConflictDetector } from '../ConflictDetector.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FUSION_DB = join(REPO, 'data', 'webui', 'fusion_memory.db');

/**
 * 桩 storage —— queryAll 返回给定历史内容，writeRaw 捕获 SQL 与绑定值。
 * 绑定展开规则镜像 SQLiteAdapter.writeRaw（兼容 `(sql, a, b)` 与 `(sql, [a, b])` 两种风格）。
 */
function makeStorage(historyContent: string[]) {
  const captured: Array<{ sql: string; bind: unknown[] }> = [];
  const sqlite = {
    queryAll: (_sql: string, _params?: unknown[]) => historyContent.map((content) => ({ content })),
    writeRaw: (sql: string, ...params: unknown[]) => {
      const bind = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
      captured.push({ sql, bind });
    },
  };
  return { storage: { getSQLite: () => sqlite } as any, captured };
}

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) || []).length;
}

describe('[归属传递] ConflictDetector — 可解析时必须写真实实体 UUID', () => {
  it('传入 entityUuid 时，落库 belong_entity_uuid = 该值（不得为 NULL）', async () => {
    // 历史说「喜欢」、当前说「讨厌」→ 极性相反 → 必然检出冲突
    const { storage, captured } = makeStorage(['我喜欢看电影']);
    const det = new ConflictDetector(storage);
    const rec = await det.check('徐诗雨', '我讨厌看电影', 'person', {} as any, 'TXS-000000007');

    expect(rec, '极性相反必须检出冲突（否则测试前提失效）').not.toBeNull();
    expect(captured, '冲突缓存必须落一条 knowledge_base').toHaveLength(1);

    const { sql, bind } = captured[0];
    expect(sql).toMatch(/belong_entity_uuid/);
    expect(bind[bind.length - 1], '归属必须为传入的户籍 UUID').toBe('TXS-000000007');
    // 占位符与绑定值数量必须一致：错位会导致 UUID 被绑到别的列（静默写错列）
    expect(bind.length, `占位符 ${placeholderCount(sql)} 个 vs 绑定值 ${bind.length} 个`).toBe(
      placeholderCount(sql),
    );
  });

  it('未传 entityUuid（emotion 等无户籍实体）时，列仍在清单里且值为 null', async () => {
    const { storage, captured } = makeStorage(['我喜欢看电影']);
    const det = new ConflictDetector(storage);
    await det.check('烦', '我讨厌看电影', 'emotion', {} as any);

    const { sql, bind } = captured[0];
    expect(sql, 'unowned 也必须是显式列（否则与「漏列」无法区分）').toMatch(/belong_entity_uuid/);
    expect(bind[bind.length - 1]).toBeNull();
    expect(bind.length).toBe(placeholderCount(sql));
  });

  it('落库 SQL 必须能对真实 fusion schema prepare 成功（列名与真实列一致）', async () => {
    if (!existsSync(FUSION_DB)) {
      console.warn('[skip] 无 fusion schema 预言机库:', FUSION_DB);
      return;
    }
    const { storage, captured } = makeStorage(['我喜欢看电影']);
    const det = new ConflictDetector(storage);
    await det.check('徐诗雨', '我讨厌看电影', 'person', {} as any, 'TXS-000000007');

    const db = new Database(FUSION_DB, { readonly: true });
    try {
      // prepare 只做编译（不读数据）→ 列名不存在会抛 no such column
      expect(() => db.prepare(captured[0].sql)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('AutoLearnPlugin 必须把 EntityGene.uuid 传给检测器（否则归属永远解析不出）', () => {
    const src = readFileSync(join(REPO, 'src/app/learning/AutoLearnPlugin.ts'), 'utf-8');
    expect(src, 'EntitiyGene.uuid 未透传给 ConflictDetector.check').toMatch(
      /conflictDetector\.check\([\s\S]{0,240}?entity\.uuid \?\? null/,
    );
  });
});

describe('[归属传递] 派生写入必须继承源记忆的归属与溯源锚点', () => {
  const SC = readFileSync(join(REPO, 'src/engine/tianquan/temporal/SleepTimeConsolidator.ts'), 'utf-8');

  it('金库→黑钻晋升：列清单必须含 belong_entity_uuid + dna_root_id', () => {
    const m = /INSERT OR IGNORE INTO black_diamond \(([^)]*)\)/.exec(SC);
    expect(m, '未找到金库→黑钻晋升写入点（正则失效或写入点被改）').not.toBeNull();
    const cols = m![1].split(',').map((c) => c.trim());
    expect(cols).toContain('belong_entity_uuid');
    expect(cols, 'dna_root_id 是金库→黑钻的溯源锚点（曾全库 0/390）').toContain('dna_root_id');
  });

  it('金库→黑钻晋升：源 SELECT 必须取到那两列（否则绑的是 undefined）', () => {
    expect(SC).toMatch(
      /SELECT id, raw_input, calcium_score, recall_count, belong_entity_uuid, dna_root_id\s+FROM memories/,
    );
    expect(SC, '归属取值必须复用既有规范出函数 deriveBelongUuid').toMatch(
      /deriveBelongUuid\(row\) \?\? null/,
    );
  });

  it('系统巩固写 kb：必须绑真实归属，不得 bind 字面 NULL', () => {
    // 旧实现：列清单列了 belong_entity_uuid 却在 VALUES 里写死 NULL —— 列在、值恒空
    expect(SC, "systems_consolidation 写入点仍在 bind 字面 NULL（形态②回归）").toMatch(
      /'systems_consolidation', \?, \?, \?, 1, '系统巩固', 0, 'other', \?\)/,
    );
    expect(SC).toMatch(/deriveBelongUuid\(mem\) \?\? null/);
  });
});

describe('[归属传递] 确实无唯一户口的聚合件必须显式登记 unowned（第七条）', () => {
  const AGGREGATES: Array<[string, RegExp]> = [
    ['src/app/learning/DailyMaintenanceScheduler.ts', /INSERT OR REPLACE INTO knowledge_base \(([^)]*)\)/],
    ['src/engine/tianquan/temporal/ProspectiveSimulator.ts', /INSERT OR REPLACE INTO knowledge_base \(([^)]*)\)/],
  ];

  for (const [rel, re] of AGGREGATES) {
    it(`${rel} 的 REPLACE 列清单必须含 belong_entity_uuid`, () => {
      const src = readFileSync(join(REPO, rel), 'utf-8');
      const m = re.exec(src);
      expect(m, `${rel} 未找到写入点（正则失效或写入点被改）`).not.toBeNull();
      const cols = m![1].split(',').map((c) => c.trim());
      expect(cols).toContain('belong_entity_uuid');
    });
  }

  it('跨实体聚合的 unowned 判定必须写明法律依据（可审计，而非裸 NULL）', () => {
    const SC = readFileSync(join(REPO, 'src/engine/tianquan/temporal/SleepTimeConsolidator.ts'), 'utf-8');
    const DM = readFileSync(join(REPO, 'src/app/learning/DailyMaintenanceScheduler.ts'), 'utf-8');
    const PS = readFileSync(join(REPO, 'src/engine/tianquan/temporal/ProspectiveSimulator.ts'), 'utf-8');
    for (const [name, src] of [['SleepTimeConsolidator', SC], ['DailyMaintenanceScheduler', DM], ['ProspectiveSimulator', PS]] as const) {
      expect(src, `${name} 的 unowned 判定缺少《UUID 户籍管理法》第七条依据`).toMatch(/第七条/);
      expect(src, `${name} 未警示 OWNER_UUID 是玉瑶本体（易被误用为「用户本人」）`).toMatch(/TXS-000000001/);
    }
  });
});
