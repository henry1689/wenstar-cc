import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 回归守卫：**禁止按正文推断归属**（P0-3b 立项 · P0-3d 扩展到全部通道）
 *
 * 被守的是什么：三处「按正文提及的人名」认领 `belong_entity_uuid` 的 SQL。
 *
 * ── P0-3b 摘掉的第一处：`SQLiteAdapter.initialize()` 的启动回填（V10.5）──
 *   ① conversations 全文匹配   content LIKE '%名字%'
 *   ② conversations 自称检测   content LIKE '%我是名字%' / '%名字来了%' …
 *   ③ memories 从会话传导      content LIKE '%' || substr(raw_input,1,30) || '%'
 *   ④ roleplay 直接匹配        raw_input LIKE '%' || e.name || '%'
 *
 * ── P0-3d 摘掉的另四处（P0-3b 当时没查到，故本批扩守卫）──
 *   ⑤ `MigrationManager.repairDataIntegrity()` 2a：raw_input      LIKE '%人名%'
 *   ⑥ 同函数 2b：                                fg_entity_names LIKE '%人名%'
 *   ⑦ `EntityUUIDBackfill.ts`：conversations.content / memories.raw_input 两处 LIKE
 *   ⑧ 同函数 2c：`SELECT id, fg_entity_names …` → 按 id 写回
 *      一度以为 2c「按 id 精确写入」所以无害 —— **错的**：`fg_entity_names` 的语义就是
 *      「这条记忆的正文里提到了谁」，本身即文本派生列；用它决定归属与 2a/2b 是同一件事。
 *      实测：删掉 2a/2b 后重启，2c **独自认领回 21 条**。
 *
 * ⚠️ 方法论教训（本项目 V34 已踩过一次同类坑）：**三步彼此掩蔽，顺序测必然错判。**
 *   第一版受控实验顺序执行 2a→2b→2c，前两步先把行填满，而 2c 的谓词含 `belong IS NULL`
 *   ⇒ 无行可填 ⇒ 错判"2c 贡献 0"。改成**每步各自在全新副本上独立执行**才看清：
 *   2a 独 17 条 / 2b 独 22 条 / 2c 独 22 条。**测"某步有没有贡献"必须让它独占起跑线。**
 *
 * 🔴 为什么必须守：《P0 记忆体系止血任务书 V3》§3.1 **分类禁止**。其实测依据 ——
 *   166 条无归属记录里 **142 条根本不提任何人名**；全表 **29.2%** 的已归属记忆
 *   正文提到的是**别人**（提到 A 就认领成 A，实际归属可能是 B）⇒ 名字推断会整体串档。
 *
 * 🔴 危害已被实测过两次，且第二次是"打脸式"的：
 *   · P0-3 回滚演练：清洗刚把 24 条置 NULL，重启就被 V10.5 认领回 22 条。
 *   · P0-3c（2026-10-07）：把 24 条还原为 NULL、runner 复核通过（9431/166，达成 V3 §3.3 判据），
 *     **重启 60 秒内 22 条再次被认领**，磁盘库回到 9453/144。真凶是 ⑤⑥：
 *     `repairDataIntegrity` 不受 schema_version 门控、每次启动都跑、且立即强制 export 落盘。
 *     受控实验（副本上先置 NULL 再逐步执行）：2a 独自认领 **17 条**、2b 再 **5 条**。
 *
 * ⚠️ 实测教训（写在这里防复发）：`[Backfill] memories标注: X→Y` 这个计数器**排在 `[Repair]` 之后**
 *   —— P0-3b 就是靠它验证"零认领"的，读数时污染已经发生。而 `[Repair] belong_entity_uuid 回填: N 条`
 *   当时打印的是 COUNT(*) **总量**（恒约 9400），**读不出增量**。两个计数器叠加，使这条通道
 *   跨过 P0-3 与 P0-3b 两轮验证都没被发现。→ P0-3d 已把 `[Repair]` 改为回报增量。
 *
 * 🔴 **对本仓 commit ea1f9cb（P0-3b）提交信息「2 条认错」的更正**：
 *   该结论的判据是「结构列 entity_genes / fg_entity_names 指向别的实体」。经 P0-3c 复核，
 *   **判据不成立** —— 全表 9453 条已归属记忆中结构列不含该归属的有 1331 条（14.1%），
 *   而不一致的样例里混着大量**非人名 token**（句子片段与关系词，如 [干脆] [妹妹] [那篇小]
 *   [尤其] [出差]）⇒ **不一致只说明"不一致"，不能证明"错"**。
 *   正确表述：那 24 条由**已被删除的文本推断方法**给出、**来源不可靠**；
 *   **不是**「已证明其中 2 条错」。后人不得再拿那个不成立的判据去改数据。
 *
 * 断言策略：扫源码而非跑行为 —— 要防的正是"日后有人顺手加回这段 SQL"，而它们多在启动期
 *   才执行，行为测试（需起整库）成本高得多。
 * 🔴 **先剥注释再扫**：源文件里刻意保留了被删模式的原文供追溯，不剥注释会误报
 *   （这正是本守卫唯一的坑）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 剥离块注释与行注释后剩下可执行代码 */
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')    // /* ... */
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // // ...（[^:] 避开 http:// 之类）
}

const TARGETS = [
  {
    path: join(HERE, '..', 'SQLiteAdapter.ts'),
    label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）',
  },
  {
    path: join(HERE, '..', 'MigrationManager.ts'),
    label: 'MigrationManager.ts（P0-3d 摘掉的 2a/2b）',
  },
  {
    path: join(HERE, '..', '..', 'm4', 'household', 'EntityUUIDBackfill.ts'),
    label: 'EntityUUIDBackfill.ts（P0-3d 摘掉的两处）',
  },
] as const;

const RAW = new Map<string, string>();
const CODE = new Map<string, string>();
for (const t of TARGETS) {
  const raw = readFileSync(t.path, 'utf8');
  RAW.set(t.label, raw);
  CODE.set(t.label, stripComments(raw));
}

/** 被禁模式：按目标文件分组（含 P0-3b 的四处 + P0-3d 的三处） */
const FORBIDDEN: Array<{ label: string; name: string; re: RegExp }> = [
  // ── SQLiteAdapter.ts（P0-3b）──
  { label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）', name: '① conversations 全文匹配（content LIKE %名字%）', re: /content\s+LIKE\s+'%\$\{_n\}%'/ },
  { label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）', name: '② conversations 自称检测（我是/我叫 名字）', re: /(我是|我叫|我就是)\$\{_n\}/ },
  { label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）', name: '② conversations 自称检测（名字来了/在呢）', re: /\$\{_n\}(来了|在呢)/ },
  { label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）', name: '③ memories 从会话传导（raw_input 前 30 字匹配）', re: /substr\(\s*memories\.raw_input\s*,\s*1\s*,\s*30\s*\)/ },
  { label: 'SQLiteAdapter.ts（P0-3b 摘掉的四处）', name: '④ roleplay 直接匹配（raw_input LIKE e.name）', re: /memories\.raw_input\s+LIKE\s+'%'\s*\|\|\s*e\.name/ },

  // ── MigrationManager.ts（P0-3d · repairDataIntegrity 第 2 段）──
  { label: 'MigrationManager.ts（P0-3d 摘掉的 2a/2b）', name: '⑤ 2a raw_input LIKE %人名%（按正文认领）', re: /UPDATE\s+memories\s+SET\s+belong_entity_uuid[\s\S]{0,200}?raw_input\s+LIKE\s+\?/ },
  { label: 'MigrationManager.ts（P0-3d 摘掉的 2a/2b）', name: '⑥ 2b fg_entity_names LIKE %人名%（按正文认领）', re: /UPDATE\s+memories\s+SET\s+belong_entity_uuid[\s\S]{0,200}?fg_entity_names\s+LIKE\s+\?/ },
  { label: 'MigrationManager.ts（P0-3d 摘掉的 2a/2b）', name: '⑧ 2c 以 fg_entity_names 驱动按 id 写回归属（文本派生列推断）', re: /SELECT\s+id\s*,\s*fg_entity_names\s+FROM\s+memories/ },

  // ── EntityUUIDBackfill.ts（P0-3d）──
  { label: 'EntityUUIDBackfill.ts（P0-3d 摘掉的两处）', name: '⑦ conversations content LIKE %人名%', re: /UPDATE\s+conversations\s+SET\s+belong_entity_uuid[\s\S]{0,200}?content\s+LIKE\s+\?/ },
  { label: 'EntityUUIDBackfill.ts（P0-3d 摘掉的两处）', name: '⑦ memories raw_input LIKE %人名%', re: /UPDATE\s+memories\s+SET\s+belong_entity_uuid[\s\S]{0,200}?raw_input\s+LIKE\s+\?/ },
];

describe('禁止按正文推断归属（源码守卫 · P0-3b + P0-3d）', () => {
  it('三个目标文件都读到了（防止路径写错导致守卫静默空转）', () => {
    for (const t of TARGETS) {
      expect(RAW.get(t.label)?.length ?? 0, `${t.label} 读取失败或为空`).toBeGreaterThan(1000);
    }
  });

  it('注释剥离本身有效（回归：防止守卫因剥注释失败而变空转）', () => {
    for (const t of TARGETS) {
      const raw = RAW.get(t.label)!;
      const code = CODE.get(t.label)!;
      expect(code.length, `${t.label} 剥完注释后剩得太少，剥离规则可能失效`).toBeGreaterThan(raw.length * 0.3);
    }
    // 被删模式的原文**刻意保留在注释里**供追溯 —— 它必须已被剥掉，否则下面必然误报
    expect(CODE.get('MigrationManager.ts（P0-3d 摘掉的 2a/2b）')!).not.toContain('WHERE raw_input      LIKE');
    expect(CODE.get('EntityUUIDBackfill.ts（P0-3d 摘掉的两处）')!).not.toContain("· UPDATE memories");
  });

  for (const f of FORBIDDEN) {
    it(`🔴 不得出现：${f.name}`, () => {
      const code = CODE.get(f.label)!;
      const m = code.match(f.re);
      expect(m, `在 ${f.label} 发现被禁模式 ${JSON.stringify(m?.[0])} —— V3 §3.1 分类禁止按正文推断归属`).toBeNull();
    });
  }

  // ── 保留项：只删文本判据，结构关联一律不动 ──

  it('⑤ 结构关联回填必须保留（black_diamond 走 source_id → memories.id，纯结构）', () => {
    expect(CODE.get('SQLiteAdapter.ts（P0-3b 摘掉的四处）')!)
      .toMatch(/UPDATE black_diamond SET belong_entity_uuid\s*=\s*\(\s*SELECT m\.belong_entity_uuid FROM memories m/);
  });

  it('fg_entity_names 幂等派生必须保留（从 entity_genes 确定性派生，不碰文本）', () => {
    const code = CODE.get('SQLiteAdapter.ts（P0-3b 摘掉的四处）')!;
    expect(code).toContain('fg_entity_names');
    expect(code).toMatch(/SELECT id, entity_genes FROM memories/);
  });

  it('SKIP_BACKFILL 总闸仍然存在（P0-3b 刻意不动它，只精确摘除文本判据）', () => {
    expect(CODE.get('SQLiteAdapter.ts（P0-3b 摘掉的四处）')!).toContain("SKIP_BACKFILL !== 'true'");
  });

  it('MigrationManager 启动期**不得再有任何**给 memories 写具体归属的 SQL', () => {
    const code = CODE.get('MigrationManager.ts（P0-3d 摘掉的 2a/2b）')!;
    // 唯一允许的写法是「置 NULL」的清理（假 uuid-*），它是收窄不是推断
    const writes = code.match(/UPDATE\s+memories\s+SET\s+belong_entity_uuid\s*=\s*[^;]*/g) || [];
    const offenders = writes.filter((s) => !/=\s*NULL\s+WHERE\s+belong_entity_uuid\s+LIKE\s+'uuid-%'/.test(s));
    expect(offenders, `启动期出现写归属的语句：${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('MigrationManager 必须回报归属的**增量**（不能只有总量，否则回归再次隐身）', () => {
    const code = CODE.get('MigrationManager.ts（P0-3d 摘掉的 2a/2b）')!;
    expect(code, '缺少"本次回填 N 条"的增量日志 —— 这是 P0-3c 那 22 条长期没被发现的直接原因')
      .toContain('本次回填');
  });

  it('EntityUUIDBackfill 的结构传播必须保留（black_diamond 走 source_id，纯结构）', () => {
    expect(CODE.get('EntityUUIDBackfill.ts（P0-3d 摘掉的两处）')!)
      .toMatch(/UPDATE\s+black_diamond\s+SET\s+belong_entity_uuid\s*=\s*\?[\s\S]{0,200}?source_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+memories/);
  });
});
