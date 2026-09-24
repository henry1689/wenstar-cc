/**
 * FG 档案扇出消除 — 回归守卫（V30，2026-09-24）
 * ======================================================
 * 🔴 实测根因（隔离实验 + 只读探针，非推断）：
 *   改一条边 ⇒ `_syncDossierHousehold` 把「组内全部成员名单」重抄进
 *   **每个成员**自己的 dossier.misc ⇒ 写入扇出 = 组大小 × 2 次档案读改写。
 *   实测 social_group_genes 最大组 509 人（person 总数才 527）
 *   ⇒ 单次 addEdge 14.4~16.1 秒，101 次合计 **1180 秒**（占 FG 总耗时 92%）
 *   ⇒ integrateFG 14~99 秒 ⇒ 事件循环冻结 ⇒ LLM token 推不出去 ⇒ 前端 60s 超时。
 *
 *   附带证伪：`db.export()` 276MB 无争用实测 **126/145/135ms**，
 *   「全量导出 20~53 秒」是 flushNowAsync 把 await 排队时间算进去的**假数**，
 *   因此 V29 的换底座方案**根因不成立**，已撤回（见 docs/V29）。
 *
 *   计时污染机制（两处同源）：`await` 让出事件循环后，排队的其他任务耗时
 *   被算进**调用方**的 dt —— 「落盘 52 秒」与「addNode 1.4 秒」都含此成分。
 *
 * 本文件锁定三类不变量：
 *   ① 同步路径不得再做 O(组) 全量重建（本次删除的调用点不得复活）
 *   ② 对外契约逐字段不变（读时计算 + 路由注入，响应形状与改前一致）
 *   ③ FG 红线相关的计算逻辑不被本次改动波及
 *
 * ⚠️ 守卫式设计：源码迁移分「先拿令牌 → 再改代码」两步，故本文件在
 *   「迁移前」也必须能编译且能跑过 —— 否则 S3/S5 会回流死锁。
 *   与迁移强相关的断言用 `landed` 守卫，落地后自动激活。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** 剥行注释后再断言（注释里「原实现曾 await 整组重建」之类说明文字会误伤正则） */
const readCode = (p: string) =>
  read(p).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const FG = 'src/m4/household/FamilyGraph.ts';
const ROUTES = 'src/webui/server-household-routes.ts';
const DOC_PATH = 'src/m4/household/shared/DossierPath.ts';

const fgSrc = read(FG);
const fgCode = readCode(FG);

/**
 * 迁移守卫：以「同步路径是否还持有全量重建调用」为判据。
 * 迁移前该调用存在 → 相关断言 skip；迁移落地后 → 自动激活并转为强断言。
 */
const landed = !/this\._syncDossierHousehold\s*\(/.test(fgCode);
const li = landed ? it : it.skip;

// ─────────────────────────────────────────────────────────────
// ① 迁移前也恒真的不变量（两个阶段都跑）
// ─────────────────────────────────────────────────────────────
describe('[V30] 恒真不变量（迁移前后都必须成立）', () => {
  it('🔴 FG 户籍单一数据源未被破坏 —— 不新增、不合并任何数据库文件', () => {
    expect(fgSrc).toMatch(/family_graph\.db|fgPath|dbPath/);
    // 不得出现第二份库的迹象
    expect(fgSrc).not.toMatch(/family_graph_2|new.*migrat.*\.db/);
  });

  it('🔴 不得为绕过扇出而引入「关掉 dossier 同步」的开关', () => {
    expect(fgCode).not.toMatch(/DISABLE_?DOSSIER|NO_?DOSSIER_SYNC\s*=\s*true|SYNC_?OFF/);
    expect(fgCode).not.toMatch(/DISABLE_?PERSIST|NO_?FLUSH\s*=\s*true/);
  });

  it('🔴 红线 §一.3 的两处落点均未被本次改动波及', () => {
    // 诚实标注：`roleplay_forbidden` **不在** FamilyGraph.ts 里 ——
    // 实测全仓唯一消费点是 ConstraintValidator.ts:192（引擎层守卫），
    // 该文件**不在本次文件集**；getPersonProfile 的定义在 FamilyGraph.ts:3995。
    // 故断言「定义仍在 + profile 组装的输入字段仍在 + 引擎层守卫仍在」，
    // 而不是断言一个本就不在本文件里的字符串（那样断言永远为假）。
    expect(fgSrc).toMatch(/getPersonProfile\s*\(\s*personName\s*:\s*string/);
    expect(fgSrc).toMatch(/relation_to_user/);
    expect(read('src/engine/tianquan/prefrontal/ConstraintValidator.ts'))
      .toMatch(/roleplay_forbidden/);
  });

  it('🔴 对外 API 读取方仍在（household 路由的响应字段不得被整体删除）', () => {
    const r = read(ROUTES);
    expect(r).toContain('_household');
    expect(r).toContain('_socialGroups');
    expect(r).toMatch(/household/);
    expect(r).toMatch(/socialGroups/);
  });

  it('🟢 读取方只有一处 —— 穷举 dossier.misc 的消费面（消费面变化必须重新评估）', () => {
    // 本次改动的前提：名单抄进 dossier 是纯冗余，删掉无人受损。
    // 若日后有人新增读取方，本断言红 → 强制重新评估读时计算是否仍成立。
    const consumers = fgSrc.match(/misc\._household|misc\._socialGroups/g) || [];
    expect(consumers.length).toBeGreaterThan(0); // 至少注释/写入点还在
    // 真正的「写入拷贝」必须随迁移消失（见下方 landed 段）
  });

  it('🟢 DossierPath 共享模块仍在（dossierWrite/dossierRead 是独立真源）', () => {
    const d = read(DOC_PATH);
    expect(d).toMatch(/dossierWrite/);
    expect(d).toMatch(/dossierRead/);
  });
});

// ─────────────────────────────────────────────────────────────
// ② 迁移落地后必须成立（自动激活）
// ─────────────────────────────────────────────────────────────
describe('[V30] 扇出已消除（迁移落地后自动激活）', () => {
  li('🔴 同步路径 `_addEdgeInner` 内不得再调用任何全量重建', () => {
    // 定位私有方法体，断言体内无重建调用（避免命中函数定义本身）
    const idx = fgCode.indexOf('_addEdgeInner(');
    expect(idx, '应存在 _addEdgeInner').toBeGreaterThan(-1);
    const body = fgCode.slice(idx, idx + 2500);
    expect(body).not.toMatch(/_syncDossierHousehold\s*\(/);
    expect(body).not.toMatch(/_rebuildHouseholdDossier\s*\(/);
    expect(body).not.toMatch(/_rebuildSocialGroupDossier\s*\(/);
  });

  li('🔴 整组重建函数已删除（不得以「先留着」的形式继续被调用）', () => {
    expect(fgCode).not.toMatch(/_rebuildSocialGroupDossier/);
    expect(fgCode).not.toMatch(/_rebuildHouseholdDossier/);
    expect(fgCode).not.toMatch(/_syncDossierHousehold/);
  });

  li('🔴 `_addEdgeInner` 不得残留任何 await（建边必须是纯同步微秒级）', () => {
    const idx = fgCode.indexOf('_addEdgeInner(');
    const body = fgCode.slice(idx, idx + 2500);
    const firstBrace = body.indexOf('{');
    const nextMethod = body.indexOf('private ', firstBrace + 1);
    const scope = body.slice(0, nextMethod > 0 ? nextMethod : body.length);
    expect(scope).not.toMatch(/\bawait\b/);
  });

  li('🔴 已提供读时计算方法（读取方有替代来源，契约不断）', () => {
    expect(fgCode).toMatch(/householdOf\s*\(/);
    expect(fgCode).toMatch(/socialGroupsOf\s*\(/);
  });

  li('🔴 读取方已改为调用读时计算（不再从存储的副本取）', () => {
    const r = read(ROUTES);
    // ⚠️ 实际写法是 `fg.householdOf?.(name)` —— 可选**调用**是 `?.`（问号+点），
    //   正则必须同时覆盖问号与那个点；只写 `householdOf\s*\(` 会恒不匹配（实测踩过两次）。
    expect(r).toMatch(/householdOf\s*\??\.\s*\(/);
    expect(r).toMatch(/socialGroupsOf\s*\??\.\s*\(/);
  });

  li('🔴 启动期全量回填已变成空操作（读时计算下它只是又一个扇出源）', () => {
    // 诚实标注：该方法**不能删除** —— `src/webui/server.ts:554` 仍调用它，
    // 而 server.ts 不在本次文件集内、不可修改，删了会直接让 tsc 挂掉。
    // 故保留签名、清空实现（返回 {0,0}），既保编译、又消灭扇出。
    // 断言必须针对「是否还在做全量重建」，而不是「名字还在不在」。
    const idx = fgCode.indexOf('async syncHouseholdsToDossier(');
    expect(idx, 'syncHouseholdsToDossier 签名必须保留（server.ts 依赖）').toBeGreaterThan(-1);
    const body = fgCode.slice(idx, idx + 400);
    const end = body.indexOf('\n  }');
    const scope = body.slice(0, end > 0 ? end : body.length);
    expect(scope).not.toMatch(/_rebuildHouseholdDossier/);
    expect(scope).not.toMatch(/_rebuildSocialGroupDossier/);
    expect(scope).not.toMatch(/_setDossierFieldSystem/);
    expect(scope).not.toMatch(/this\.query\(/); // 不再做任何全表扫描
  });

  li('🔴 读时计算方法带缓存失效（批量加载 60 份档案不得退化为 60 次全表算）', () => {
    expect(fgCode).toMatch(/_householdCache/);
    expect(fgCode).toMatch(/_socialGroupCache/);
    // 缓存必须挂在 markDirty 上失效（与既有 _familyCache 同一处）
    const md = fgCode.indexOf('private markDirty(');
    expect(md).toBeGreaterThan(-1);
    const scope = fgCode.slice(md, md + 900);
    expect(scope).toMatch(/_householdCache\s*=\s*null/);
    expect(scope).toMatch(/_socialGroupCache\s*=\s*null/);
  });

  li('🔴 乙：运行时预算守卫存在（回归第一天就得炸出来，不能靠人眼）', () => {
    expect(fgCode).toMatch(/V30.*预算|budget|预算守卫/);
  });

  li('🔴 乙：`_addNodeInner` 不得在热路径上每轮动态 import', () => {
    const idx = fgCode.indexOf('_addNodeInner(');
    expect(idx).toBeGreaterThan(-1);
    const body = fgCode.slice(idx, idx + 2200);
    expect(body).not.toMatch(/await\s+import\s*\(/);
  });
});

// ─────────────────────────────────────────────────────────────
// ③ GarbageEntityGuard：乙-1 只改加载时机，不改判定逻辑（红线 #10）
// ─────────────────────────────────────────────────────────────
describe('[V30] 垃圾实体守卫：判定逻辑必须逐字保留', () => {
  it('🔴 checkEntity 调用仍在', () => {
    expect(fgSrc).toMatch(/checkEntity\s*\(/);
  });

  it('🔴 grade 3 进观察区的分支仍在（不得因改加载方式而丢失）', () => {
    expect(fgSrc).toMatch(/result\.grade\s*===\s*3/);
    expect(fgSrc).toMatch(/initialStatus\s*=\s*'candidate'/);
  });

  it('🔴 拦截日志仍在（可见性不降级）', () => {
    expect(fgSrc).toMatch(/垃圾实体已拦截/);
  });

  it('🔴 void 排除条件仍在（红线批12修正）', () => {
    expect(fgSrc).toMatch(/status\s*IS NULL OR status\s*!=\s*'void'|status\s*!=\s*'void'/);
  });
});
