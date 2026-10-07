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
// 批2：受限共享三态（业主裁定「工作微信只对玉瑶 + 徐诗雨开放」）
// ─────────────────────────────────────────────────────────────────────────────

const ME = 'TXS-000000003';   // 熊梓铭（不在微信可见名单里）
const A = 'TXS-000000001';    // 玉瑶
const B = 'TXS-000000007';    // 徐诗雨
const WECHAT_LIST = JSON.stringify([A, B]);

describe('[户籍三元组 批2] 受限共享三态 —— 归属与可见性分离', () => {
  it('restrictedSharing 默认 false，不写就不改语义（私有域零回归面）', () => {
    for (const d of ['private', 'shared'] as const) {
      expect(policyFor(d, [UUID]).restrictedSharing, `域=${d} 未显式开启时必须是 false`).toBe(false);
    }
  });

  it('共享域 SQL 在开启受限共享后仍保留「无归属分支」（不能因加新分支而丢掉旧的）', () => {
    const { clause } = buildSqlClause(policyFor('shared', [ME], { restrictedSharing: true }));
    expect(clause, '受限共享子句必须把可见集与归属两部分都表达出来').toMatch(/visible_entity_uuids/);
    expect(clause, 'visible 为空时必须回落归属判据，故 IS NULL 分支不能丢').toMatch(/belong_entity_uuid IS NULL/);
    expect(clause).toMatch(/json_each/);
  });

  it('受限共享子句的占位符与绑定值等量（错位会把 UUID 绑到别的列）', () => {
    const { clause, params } = buildSqlClause(policyFor('shared', [ME], { restrictedSharing: true }));
    expect(params.length).toBe((clause.match(/\?/g) || []).length);
    expect(params).toEqual([ME, ME]);   // 先 json_each 名单，后 byOwner 归属
  });

  it('行级：可见集非空 ⇒ 由名单决定，归属不再参与', () => {
    const p = policyFor('shared', [A], { restrictedSharing: true });   // 会晤 = 玉瑶
    expect(passes(null, p, WECHAT_LIST), '玉瑶在名单内 ⇒ 放行（即使无归属）').toBe(true);

    const p2 = policyFor('shared', [ME], { restrictedSharing: true }); // 会晤 = 熊梓铭
    expect(passes(null, p2, WECHAT_LIST), '熊梓铭不在名单内 ⇒ 拒绝').toBe(false);

    const p3 = policyFor('shared', [B], { restrictedSharing: true });  // 会晤 = 徐诗雨
    expect(passes(null, p3, WECHAT_LIST), '徐诗雨在名单内 ⇒ 放行').toBe(true);
  });

  it('🔴 回归钉死：受限共享下可见集非空的普通文档归属也不再参与（防漏判放行）', () => {
    // 若可见集非空但名单里没有当前实体，**不得**因「归属碰巧匹配」而放行
    const p = policyFor('shared', [A], { restrictedSharing: true });
    expect(passes(ME, p, JSON.stringify([B])), '归属=熊梓铭 但名单只给徐诗雨 ⇒ 必须拒绝').toBe(false);
  });

  it('可见集为空 ⇒ 完好回落到归属判据（三态的第二/第三态）', () => {
    const p = policyFor('shared', [ME], { restrictedSharing: true });
    expect(passes(ME, p, null), '空可见集 + 归属=自己 ⇒ 私有，放行').toBe(true);
    expect(passes(null, p, ''), '空可见集 + 无归属 ⇒ 共享，放行').toBe(true);
    expect(passes(A, p, null), '空可见集 + 归属=他人 ⇒ 拒绝').toBe(false);
  });

  it('parseVisibleList 失败一律返回空数组（fail-closed，回落归属判据而非放行）', () => {
    const p = policyFor('shared', [ME], { restrictedSharing: true });
    for (const bad of ['not-json', '{bad}', '"a string"', '{"a":1}', undefined, null, '']) {
      expect(passes(A, p, bad as any), `非法可见集 ${JSON.stringify(bad)} 不得放行他人数据`).toBe(false);
    }
  });

  it('未开启 restrictedSharing 时，第三参数一律被忽略（私有域行为零变化）', () => {
    const p = policyFor('private', [A]);
    expect(passes(A, p, WECHAT_LIST)).toBe(true);
    expect(passes(ME, p, WECHAT_LIST), '私有域不看可见集 ⇒ 他人数据仍拒绝').toBe(false);
    expect(passes(null, p, WECHAT_LIST), '私有域无归属仍拒绝（户籍法铁律4）').toBe(false);
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
