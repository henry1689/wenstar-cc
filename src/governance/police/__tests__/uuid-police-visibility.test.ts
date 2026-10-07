/**
 * uuid-police-visibility.test.ts — 户籍三元组批1：`allowUnowned` 单一决定点 + 按域分治
 * ==================================================================================
 * 依据：《户籍三元组全域统一任务书 V1》法条第三条（按域分治）、
 *       业主 2026-10-07 裁定「无归属的允许存在…是知识库的主流…就是共享的」。
 *
 * 本测试锁定的三件事：
 *   A. `policyFor()` 是 `allowUnowned` 与 `searchScope` 的**唯一产出处**，且两者**同源**
 *   B. 两域语义互不援引：共享域无归属可见 / 私有域无归属不可见
 *   C. 全仓不得再出现手写 `allowUnowned`（防口径再次分叉 —— 任务书缺陷 D5）
 *
 * 🔴 事故背景（实测，非推测）：
 *   `buildSqlClause` **只读 `searchScope`、不读 `allowUnowned`**。而
 *   `KnowledgeEngine:607/:958` 历史上只传 `allowUnowned: true`、没传 `searchScope`
 *   ⇒ 实际走 `strict` ⇒ `AND belong_entity_uuid IN (?)` ⇒ **无归属行被整个排除**。
 *   后果：业主实测「熊梓铭看得到自己的档案，却看不到其它知识文档」——
 *   33+ 篇无归属公共文档在 `weightedSearch` 主 SQL 就被滤掉了，
 *   `KnowledgeContextBuilder` 的 post-filter 事后无法把它们找回来（上游就没了）。
 *   ⇒ 下面用「同一策略产出的 SQL 里必须含 `IS NULL`」把这类错配钉死。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { policyFor, buildSqlClause, passes } from '../UUIDPoliceFilter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const UUID = 'TXS-000000003';

describe('[户籍三元组] policyFor — allowUnowned 与 searchScope 同源产出', () => {
  it('共享域（知识库=实体档案件）：无归属 = 共享 ⇒ 行级放行', () => {
    const p = policyFor('shared', [UUID]);
    expect(p.allowUnowned, '共享域必须允许无归属').toBe(true);
    // 🔴 关键：SQL 级必须与行级一致。只设 allowUnowned 不设 searchScope 就是本次的事故形态。
    expect(p.searchScope, '共享域 SQL 级必须走 allow-unowned，否则两个字段不同源').toBe('allow-unowned');
  });

  it('私有域（记忆/对话/黑钻/金库=经历记忆件）：无归属 = 未登记 ⇒ 行级拒绝', () => {
    const p = policyFor('private', [UUID]);
    expect(p.allowUnowned, '私有域不得允许无归属（户籍法铁律4）').toBe(false);
    expect(p.searchScope).toBe('strict');
  });

  it('两域语义不得互相援引 —— 同一 UUID、同一无归属行，结论必须相反', () => {
    const shared = policyFor('shared', [UUID]);
    const priv = policyFor('private', [UUID]);
    expect(passes(null, shared), '共享域：无归属应放行').toBe(true);
    expect(passes(null, priv), '私有域：无归属应拒绝').toBe(false);
    // 白名单内的行两域都放行（差异只在"无归属"这一维）
    expect(passes(UUID, shared)).toBe(true);
    expect(passes(UUID, priv)).toBe(true);
    // 白名单外的行两域都拒绝
    expect(passes('TXS-000000999', shared)).toBe(false);
    expect(passes('TXS-000000999', priv)).toBe(false);
  });

  it('🔴 回归守卫：共享域产出的 SQL 必须含无归属分支（本次事故的直接判据）', () => {
    const { clause, params } = buildSqlClause(policyFor('shared', [UUID]));
    expect(
      clause,
      '共享域 SQL 缺 `belong_entity_uuid IS NULL` ⇒ 无归属的公共知识会被整个排除（历史 bug 复现）',
    ).toMatch(/belong_entity_uuid IS NULL/);
    expect(clause).toMatch(/belong_entity_uuid IN \(\?\)/);
    expect(params, '占位符与绑定值必须等量，错位会把 UUID 绑到别的列').toEqual([UUID]);
  });

  it('私有域产出的 SQL 不得含无归属分支', () => {
    const { clause } = buildSqlClause(policyFor('private', [UUID]));
    expect(clause).not.toMatch(/IS NULL/);
    expect(clause).toMatch(/belong_entity_uuid IN \(\?\)/);
  });

  it('空白名单仍然 fail-closed（宁拒不放），不因换域而放宽', () => {
    for (const d of ['shared', 'private'] as const) {
      expect(buildSqlClause(policyFor(d, [])).clause, `域=${d} 空白名单必须 AND 1=0`).toMatch(/1=0/);
    }
  });

  it('enforce:false 时返回空子句（仅供离线巡检探针，生产不可用）', () => {
    expect(buildSqlClause(policyFor('shared', [UUID], { enforce: false })).clause).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 全仓守卫：禁止口径再次分叉
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 🔴 剥注释后再扫 —— 本测试第一版没剥，结果**被自己写的说明注释绊倒**：
 *   KnowledgeEngine.ts 的收口注释里原样引用了旧的手写判据
 *   （`!r.belong_entity_uuid || r.belong_entity_uuid === x`），正则照单全收。
 *   用源码文本做守卫时，"描述旧代码"和"就是旧代码"在字面上不可分 —— 必须剥注释。
 *   （同类教训：本项目 P0-3 曾把迁移脚本的注释当成活代码。）
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('[户籍三元组] 收敛守卫 — 同一规则不得多处实现（不变量 #7）', () => {
  const TS_FILES = walk(join(REPO, 'src'));
  const rel = (p: string) => p.slice(REPO.length + 1).replace(/\\/g, '/');

  /**
   * 🔴 本批（批1）的收敛范围 = **知识库域**。
   *
   * 实测：全仓仍有 6 个文件手写 `allowUnowned`（合计 11 处），全部属于**私有域**
   * （经历记忆件）的检索链路，其中 `src/m4/retrieval/adapter.ts:147 buildPolicePolicy`
   * 本身就是**第二个策略构造器**（按 会晤/普通/户主 三态决定白名单与无归属语义），
   * 还含 `enforce:false` / `searchScope:'full'` 这类无法简单归约成"域"的特殊态。
   *
   * ⇒ 把私有域也收敛进来需要触及 `src/webui/chat.ts`（HIGH）与 `src/m2/SQLiteAdapter.ts`
   *   （HIGH + 九层流水线 CK-01 的存量失败源），**超出批1 已批准范围**，另立批次。
   *
   * 本断言的作用：把这份欠账**钉成不增长清单** —— 新增一处即失败，
   * 避免"收敛了一个域、又冒出两个新口子"。
   */
  const KNOWN_HANDWRITTEN = [
    'src/m2/SQLiteAdapter.ts',
    'src/m4/retrieval/adapter.ts', // ← buildPolicePolicy：私有域的第二个策略构造器
    'src/m4/UnifiedSearchEngine.ts',
    'src/webui/chat.ts',
    'src/webui/chat/retrieval-stage.ts',
  ];

  it('知识库域**之外**的手写 allowUnowned 不得增多（欠账钉死，只减不增）', () => {
    const found: string[] = [];
    for (const f of TS_FILES) {
      const r = rel(f);
      if (r === 'src/governance/police/UUIDPoliceFilter.ts') continue;
      if (r.endsWith('.test.ts')) continue;
      if (stripComments(readFileSync(f, 'utf-8')).includes('allowUnowned')) found.push(r);
    }
    const unexpected = found.filter((r) => !KNOWN_HANDWRITTEN.includes(r));
    expect(
      unexpected,
      '新出现的 allowUnowned 手写点 —— 口径又分叉了。请改调 policyFor(domain, uuids)；' +
        '若确属私有域欠账，请把它加进 KNOWN_HANDWRITTEN 并在注释里说明批次。',
    ).toEqual([]);
  });

  it('知识库域**内**必须已全部走 policyFor（本批的实际收敛目标）', () => {
    for (const r of [
      'src/app/knowledge/KnowledgeEngine.ts',
      'src/app/knowledge/KnowledgeContextBuilder.ts',
    ]) {
      // 只允许出现在注释里（说明收口历史），不允许出现在代码里
      const code = stripComments(readFileSync(join(REPO, r), 'utf-8'));
      expect(code, `${r} 的正文仍有 allowUnowned 手写`).not.toMatch(/\ballowUnowned\b/);
    }
  });

  it('知识库侧不得再手写 belong_entity_uuid 的**筛除**判据', () => {
    // 允许「排序/分组」（=== 比较用于 own/other 分组），禁止「筛除」（作为 filter/WHERE 的归属谓词）
    const KB_FILES = [
      'src/app/knowledge/KnowledgeEngine.ts',
      'src/app/knowledge/KnowledgeContextBuilder.ts',
    ];
    const offenders: string[] = [];
    for (const r of KB_FILES) {
      const src = stripComments(readFileSync(join(REPO, r), 'utf-8'));
      // 手写筛除的两种历史形态：`!r.belong_entity_uuid || r.belong_entity_uuid === x`
      // 与 `!ku || ku === _meetingEntityUuid`
      if (/!\s*\w+\.belong_entity_uuid\s*\|\|/.test(src) || /return\s+!ku\s*\|\|/.test(src)) {
        offenders.push(r);
      }
    }
    expect(
      offenders,
      '这些文件又出现了手写的归属筛除判据 —— 应改调 UUIDPoliceFilter.passes()',
    ).toEqual([]);
  });

  it('知识库域的策略必须经 policyFor 声明（不得直接 new Set 白名单后自行决定可见性）', () => {
    for (const r of [
      'src/app/knowledge/KnowledgeEngine.ts',
      'src/app/knowledge/KnowledgeContextBuilder.ts',
    ]) {
      const src = stripComments(readFileSync(join(REPO, r), 'utf-8'));
      expect(src, `${r} 未接入 policyFor`).toMatch(/policyFor\(\s*'shared'/);
    }
  });
});
