/**
 * 实体准入「名尾非人名用字」判据回归（2026-09-11）
 * =================================================
 * 事故来源（真实对话实测复现）：
 *   我发「诗韵，最近学习累不累？」→ 滑窗跨词边界切出 **「习累」**
 *   → `hasSurname('习累')=true`（习是低频姓氏）→ 判 L3 候选姓名 → **入 FG 户籍**（TXS-000000151）。
 *   且因 L3 会加载「FG 人名库」，垃圾一旦入库会被后续每轮**反复重新识别**（自强化循环）。
 *
 * 修复（两条，均复用既有机制、均非人名硬编码）：
 *   ① 把 `习` 纳入既有 WEAK_EVIDENCE_SURNAMES（语义一致：字义高频、姓氏低频）
 *   ② 新增 NON_NAME_TAIL_CHARS：候选的**尾字**若是高频虚词/代词/助词/常见动词形容词
 *      → 判为句子片段。取材为「只出现在垃圾集、从未出现在真实人名中」的字
 *      （92 个已确认垃圾 vs 34 个真实人名/别名 的字符分布差异），
 *      并**刻意排除**真实姓氏用字（成/胡/时/温/舒/边/和/易…）以免误伤未来真人。
 *
 * 本文件同时是该判据的**误伤防线**：数据驱动 ≠ 可以只看垃圾集，
 * 必须同时用真实人名做回归（下方第 3 条）。
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeEntity, looksLikeSentenceFragment } from '../EntityCandidateGrader.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FG_DB = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');
const FUSION_DB = join(REPO, 'data', 'webui', 'fusion_memory.db');

/** 注：已确认垃圾（习累 TXS-151 / 秋节快 152 / 马上 153）均已 void，
 *  故下方 status='active' 查询会自动排除，无需在此硬编码名单。 */

describe('[实体准入] 跨词边界片段（习累）必须被拦 + 真人名零误伤', () => {
  it('事故用例：习累 不再是 L3 候选（判为句子片段/弱证据）', () => {
    const r = gradeEntity('习累', new Set());
    expect(r.grade, `习累 应被拦下，实际 grade=${r.grade} (${r.reason})`).toBeLessThan(3);
    expect(looksLikeSentenceFragment('习累')).toBe(true);
  });

  it('同类跨词边界片段样本一并拦下', () => {
    // 均为真实库中「type=person 且从未获得 UUID」的候选（即从未成为 FG 真身）
    const samples = ['习累', '满足', '喜欢', '幸福', '舒服', '压力', '考试', '学习'];
    const stillAccepted = samples.filter((s) => gradeEntity(s, new Set()).grade >= 3);
    expect(stillAccepted, `以下片段仍被判 L3 候选：${stillAccepted.join('、')}`).toEqual([]);
  });

  it('二轮实测漏网案例：秋节快（中秋节快乐）/ 马上 必须被拦', () => {
    // 真实对话实测再次漏网的两个（同类滑窗片段），已纳入判据
    for (const s of ['秋节快', '马上']) {
      expect(looksLikeSentenceFragment(s), `${s} 应被判为句子片段`).toBe(true);
      expect(gradeEntity(s, new Set()).grade, `${s} 不应达 L3`).toBeLessThan(3);
    }
  });

  it('误伤防线：FG 全部 active 真人名（含别名）不得被判为句子片段', () => {
    if (!existsSync(FG_DB)) return; // 无库则跳过（守卫价值由 CI/本地存在时体现）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(FG_DB, { readonly: true });
    const rows = db.prepare("SELECT name, aliases, uuid FROM nodes WHERE type='person' AND status='active'").all() as Array<{ name: string; aliases: string; uuid: string }>;
    db.close();

    const hurt: string[] = [];
    for (const r of rows) {
      let aliases: string[] = [];
      try { aliases = JSON.parse(r.aliases || '[]'); } catch { /* ignore */ }
      for (const n of [r.name, ...aliases]) {
        if (!n || String(n).length < 2) continue; // 单字别名不参与（gradeEntity 本身要求 >=2）
        if (looksLikeSentenceFragment(String(n))) hurt.push(`${n}(from ${r.name})`);
      }
    }
    expect(hurt, `以下真实人名被新判据误伤（必须修正判据，不得放行）：\n  ${hurt.join('\n  ')}`).toEqual([]);
  });

  it('误伤防线：真实人名样例仍为候选（L2/L3/L4）', () => {
    const realNames = ['徐诗韵', '熊梓铭', '刘运新', '王全芬', '徐诗雨', '林土锋', '陈雪花', '警幻仙姑'];
    const wrong = realNames.filter((n) => gradeEntity(n, new Set()).grade < 2);
    expect(wrong, `以下真实人名被判为过低级：${wrong.join('、')}`).toEqual([]);
  });

  it('误伤防线：含常见人名用字的姓名不得被尾字判据误伤（李峰/张爱玲/王一/李梦/白露 等）', () => {
    // 尾字集刻意排除了这些歧义字 —— 若后人扩充时误加，本用例会失败
    const wouldBeHurts = ['李峰', '张爱玲', '王一', '李梦', '白露', '万方', '陈英', '徐东伟', '熊梓玥'];
    const wrong = wouldBeHurts.filter((n) => looksLikeSentenceFragment(n));
    expect(wrong, `以下真实姓名被尾字判据误伤：${wrong.join('、')}`).toEqual([]);
  });

  it('反例防线：非人名高频用字不得因本判据被“反向放行”（黑名单/称谓仍拦）', () => {
    for (const bad of ['妈妈', '爸爸', '姐姐', '朋友']) {
      expect(gradeEntity(bad, new Set()).grade).toBeLessThan(3);
    }
  });

  it('已知垃圾候选集的拦截率（信息性，不设硬阈值以免脆弱）', () => {
    if (!existsSync(FUSION_DB)) return;
    const Database = require('better-sqlite3');
    const db = new Database(FUSION_DB, { readonly: true });
    const names = (db.prepare("SELECT name FROM entities WHERE type='person' AND (uuid IS NULL OR uuid='')").all() as Array<{ name: string }>).map((r) => r.name);
    db.close();
    const blocked = names.filter((n) => gradeEntity(n, new Set()).grade < 3).length;
    console.log(`[实体准入] 历史垃圾候选 ${names.length} 个 → 现判据拦下 ${blocked} 个（${((blocked / names.length) * 100).toFixed(1)}%）`);
    expect(blocked / names.length).toBeGreaterThan(0.5); // 至少拦一半（防判据完全失效）
  });
});
