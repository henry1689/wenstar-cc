/**
 * recall-quota.test — Phase 2.3（F / T005）A/B 链路统一召回配额 回归测试
 * ============================================================
 * 被测对象：src/m4/retrieval/recall-quota.ts（纯函数，零 DB / 零配置读取）。
 * 标签形态**复刻 retrieval-stage 的真实拼装结果**（memFragWithTime = `【标签·MM-DD】正文`），
 * 避免「测试用一套标签、生产用另一套」的假绿。
 *
 * 锁定的四条验收（R020 §三 G2 的四项，前置覆盖）：
 *   1. 配额分配：会晤 40/40/20、非会晤 60/40，类内按注入顺序截断
 *   2. 泛词降权：A 类降到 generic_query_high_calcium（0.15），余量按原比例回给 B / 近期记忆
 *   3. 同组去重：extractDialogGroupId 只认两个组域（F3 的注入侧拦截依赖它）
 *   4. 兜底：enabled=false 不裁剪、预算非法降级、OTHER 不占配额
 */
import { describe, it, expect } from 'vitest';
import {
  applyRecallQuota,
  classifyFragment,
  extractDialogGroupId,
  TAG,
  type RecallQuotaConfig,
} from '../../../m4/retrieval/recall-quota.js';

/**
 * 复刻 retrieval-stage.memFragWithTime 的产物形态（当年 `·10-20`）。
 * 返回的字符串**总长度恰为 totalLen**（含标签），配额按字符切分，断言才可直接做算术。
 */
function frag(label: string, totalLen: number): string {
  const head = `【${label}·10-20】`;
  const bodyLen = Math.max(0, totalLen - head.length);
  return head + '字'.repeat(bodyLen);
}

const CFG: RecallQuotaConfig = {
  enabled: true,
  release_empty_class_quota: true,
  generic_query_min_hits: 1,
  meeting: { high_calcium_group: 0.4, block_summary: 0.4, recent_memory: 0.2 },
  normal: { block_summary: 0.6, high_calcium_group: 0.4 },
  generic_query_high_calcium: 0.15,
};

const HC = '徐诗韵' + TAG.highCalciumGroup;      // 会晤 A 链路
const DG = '徐诗韵' + TAG.dialogGroup;          // 会晤 B 链路
const MEM = '徐诗韵' + TAG.memory;              // 单条记忆

describe('classifyFragment — 标签→配额类别（含 T003 时间坐标后缀）', () => {
  it('A 链路：会晤高钙组（带实体名 / 裸形态都认）', () => {
    expect(classifyFragment(`【${HC}·10-20】摘要`)).toBe('high_calcium_group');
    expect(classifyFragment(`【${TAG.highCalciumGroupBare}·10-20】摘要`)).toBe('high_calcium_group');
    expect(classifyFragment(`【${TAG.highCalciumGroupBare}】摘要`)).toBe('high_calcium_group');
    // 跨年形态：时间坐标是四位年份
    expect(classifyFragment(`【${HC}·2025-12-31】摘要`)).toBe('high_calcium_group');
    // **启用配额时**的标签形态（含「记忆」）——与关闭开关时的旧形态必须同时认
    expect(classifyFragment(`【徐诗韵${TAG.highCalciumGroupMemory}·10-20】摘要`)).toBe('high_calcium_group');
    expect(classifyFragment(`【${TAG.highCalciumGroupMemoryBare}·10-20】摘要`)).toBe('high_calcium_group');
  });

  it('B 链路：对话组摘要 + 砂金库兜底的「更早原文」', () => {
    expect(classifyFragment(`【${DG}·10-20】摘要`)).toBe('block_summary');
    expect(classifyFragment(`【${TAG.dialogGroupBare}·10-20】摘要`)).toBe('block_summary');
    expect(classifyFragment(`【对话·徐诗韵·更早原文·10-20】原文`)).toBe('block_summary');
    // 启用配额时的标签形态（含「记忆」）
    expect(classifyFragment(`【徐诗韵${TAG.dialogGroupMemory}·10-20】摘要`)).toBe('block_summary');
    expect(classifyFragment(`【${TAG.dialogGroupMemoryBare}·10-20】摘要`)).toBe('block_summary');
  });

  it('近期记忆：单条记忆 / 关键词命中记忆 / 高钙砂金 / 情感召回', () => {
    expect(classifyFragment(`【${MEM}·10-20】正文`)).toBe('recent_memory');
    expect(classifyFragment(`【${MEM}·相关·10-20】正文`)).toBe('recent_memory');
    expect(classifyFragment('【💎重要记忆·10-20】正文')).toBe('recent_memory');
    expect(classifyFragment('【📌重要记忆·10-20】正文')).toBe('recent_memory');
    expect(classifyFragment('【用户曾提到·10-20】"…"')).toBe('recent_memory');
    expect(classifyFragment('【回忆·10-20】…')).toBe('recent_memory');
  });

  it('OTHER：铁律 / 金库 / 作品 / 长文 / 时间检索 / 用户状态 / 未标注一律不占配额', () => {
    const others = [
      '【反编造铁律】如果你的档案和以上记忆中都没有…',
      '【金库记忆·10-20】承诺内容',
      '【作品】《某某》(小说)\n全文',
      '【对话原文·权威记录】\n长文全文',
      '【时间检索】昨天的对话：…',
      '【用户状态】心跳快',
      '【知识库档案】档案正文',
      '【珍藏记忆】黑钻正文',
      '💭 未打标签的 Foundation 片段',
      '💎 未打标签的黑钻',
      '📖 title: content',
    ];
    for (const f of others) expect(classifyFragment(f)).toBe('other');
  });

  it('空片段 / 纯文本 → other（fail-open：未知形态绝不被配额裁掉）', () => {
    expect(classifyFragment('')).toBe('other');
    expect(classifyFragment('没有标签的正文')).toBe('other');
  });
});

describe('extractDialogGroupId — F3 同组去重的判据', () => {
  it('只认两个组域，其余域一律 null（不猜 payload）', () => {
    expect(extractDialogGroupId({ id: 'DG-1', domain: 'dialog_group' })).toBe('DG-1');
    expect(extractDialogGroupId({ id: 'DG-1', domain: 'high_calcium_group' })).toBe('DG-1');
    expect(extractDialogGroupId({ id: 'MEM-9', domain: 'memory' })).toBeNull();
    expect(extractDialogGroupId({ id: 'V-3', domain: 'vault' })).toBeNull();
    expect(extractDialogGroupId(null)).toBeNull();
    expect(extractDialogGroupId({ domain: 'dialog_group' })).toBeNull();
    expect(extractDialogGroupId({ id: '  ', domain: 'dialog_group' })).toBeNull();
  });
});

describe('applyRecallQuota — 会晤 40 / 40 / 20', () => {
  it('按类各自切额度，类内按注入顺序截断，顺序保持', () => {
    // 预算 1000 ⇒ A=400 B=400 R=200
    const frags = [
      frag(HC, 100), frag(HC, 100),           // A: 200/400 全保留
      frag(DG, 150), frag(DG, 150), frag(DG, 150), frag(DG, 150), frag(DG, 150), // B: 750 → 只留前 2 条(300)
      frag(MEM, 100), frag(MEM, 100), frag(MEM, 100),                            // R: 300 → 只留前 2 条(200)
    ];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: CFG });
    expect(r.applied).toBe(true);
    expect(r.classes.high_calcium_group.quotaChars).toBe(400);
    expect(r.classes.block_summary.quotaChars).toBe(400);
    expect(r.classes.recent_memory.quotaChars).toBe(200);
    expect(r.classes.high_calcium_group.dropped).toBe(0);
    expect(r.classes.block_summary.dropped).toBe(3);
    expect(r.classes.recent_memory.dropped).toBe(1);
    expect(r.dropped).toBe(4);
    // 保留的仍是**先注入**的那几条（顺序与原数组一致）：A 2 条 + B 2 条 + R 2 条
    expect(r.kept.length).toBe(6);
    expect(r.kept[0]).toBe(frags[0]);
    expect(r.kept[2]).toBe(frags[2]);
    expect(r.kept[5]).toBe(frags[8]);
    // OTHER 永不占配额：插一条铁律进去，它必须原样保留
    const withGuard = ['【反编造铁律】绝不能编造', ...frags];
    const r2 = applyRecallQuota(withGuard, { scenario: 'meeting', budget: 1000, cfg: CFG });
    expect(r2.kept[0]).toBe(withGuard[0]);
    expect(r2.other.total).toBe(1);
  });

  it('单条超过该类额度 → 整条丢弃（不截断正文，宁缺勿断句）', () => {
    // 用 release=false 锁住 A 的 400 额度（否则 A 独占供给时额度会被释放到全额，测不出截断）
    const cfg = { ...CFG, release_empty_class_quota: false };
    const frags = [frag(HC, 500), frag(HC, 500)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg });
    expect(r.classes.high_calcium_group.quotaChars).toBe(400);
    expect(r.dropped).toBe(2);
    expect(r.kept).toEqual([]);
  });
});

describe('applyRecallQuota — 非会晤 60 / 40（近期记忆并入 B 侧同一池）', () => {
  it('B 与近期记忆共用 60% 额度，而不是各拿一份', () => {
    // 预算 1000 ⇒ A=400，B+R 同池 600
    const frags = [
      frag(DG, 150), frag(DG, 150), frag(DG, 150), frag(DG, 150),  // B: 600 吃满
      frag(MEM, 150), frag(MEM, 150),                                // R: 同池已满 → 全裁
      frag(HC, 300),                                                 // A: 300 ≤ 400 保留
    ];
    const r = applyRecallQuota(frags, { scenario: 'normal', budget: 1000, cfg: CFG });
    expect(r.applied).toBe(true);
    expect(r.classes.block_summary.quotaChars).toBe(600);
    expect(r.classes.recent_memory.quotaChars).toBe(600);   // 同池：额度数字相同
    expect(r.classes.high_calcium_group.quotaChars).toBe(400);
    expect(r.classes.block_summary.keptChars).toBe(600);
    expect(r.classes.recent_memory.keptChars).toBe(0);
    expect(r.classes.high_calcium_group.keptChars).toBe(300);
    expect(r.dropped).toBe(2);
    expect(r.kept.length).toBe(5);
  });

  it('同池按**全局注入顺序**占用额度（不按类别先后）', () => {
    // A 也带一条供给，避免「A 零供给→额度释放」把池放大，掩盖同池语义
    // 注入顺序为 近期记忆 → 对话组：先到的近期记忆先占池（池 600）
    const frags = [frag(MEM, 300), frag(DG, 300), frag(DG, 200), frag(HC, 100)];
    const r = applyRecallQuota(frags, { scenario: 'normal', budget: 1000, cfg: CFG });
    expect(r.kept).toEqual([frags[0], frags[1], frags[3]]);
    expect(r.dropped).toBe(1);
    expect(r.classes.recent_memory.keptChars).toBe(300);
    expect(r.classes.block_summary.keptChars).toBe(300);
    expect(r.classes.high_calcium_group.keptChars).toBe(100);
  });
});

describe('applyRecallQuota — F5 泛词降权', () => {
  it('会晤泛词：A 降到 15%，余量按原比例回给 B 与近期记忆', () => {
    // budget=1000, generic ⇒ A=150，B=(0.4/0.6)*0.85=0.5667→566，R=(0.2/0.6)*0.85=0.2833→283
    const frags = [frag(HC, 140), frag(DG, 140), frag(MEM, 140)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: CFG, genericQuery: true });
    expect(r.genericQuery).toBe(true);
    expect(r.classes.high_calcium_group.quotaChars).toBe(150);
    expect(r.classes.block_summary.quotaChars).toBe(566);
    expect(r.classes.recent_memory.quotaChars).toBe(283);
    expect(r.dropped).toBe(0);
    // A 的额度被压到 150：A 侧第二条（100 字）放不下就该被裁。
    // B / R 各带一条供给，避免「A 之外零供给 → 额度释放」把 A 的额度放大，掩盖降权效果。
    const mixed = [frag(HC, 140), frag(HC, 100), frag(DG, 100), frag(MEM, 100)];
    const r2 = applyRecallQuota(mixed, { scenario: 'meeting', budget: 1000, cfg: CFG, genericQuery: true });
    expect(r2.classes.high_calcium_group.keptChars).toBe(140);
    expect(r2.classes.high_calcium_group.dropped).toBe(1);
    expect(r2.dropped).toBe(1);
    // 对照：非泛词时同输入不裁（A 额度回到 400）
    const r3 = applyRecallQuota(mixed, { scenario: 'meeting', budget: 1000, cfg: CFG, genericQuery: false });
    expect(r3.classes.high_calcium_group.quotaChars).toBe(400);
    expect(r3.dropped).toBe(0);
  });

  it('非会晤泛词：A=15%，B 侧独占余下 85%', () => {
    const r = applyRecallQuota([frag(HC, 140), frag(DG, 140)], {
      scenario: 'normal', budget: 1000, cfg: CFG, genericQuery: true,
    });
    expect(r.classes.high_calcium_group.quotaChars).toBe(150);
    expect(r.classes.block_summary.quotaChars).toBe(850);
  });
});

describe('applyRecallQuota — 零供给类的额度释放', () => {
  it('某类一条都没有时释放其额度（否则 A 无供给却平白锁死 40%）', () => {
    const frags = [frag(DG, 500), frag(MEM, 200)];   // A 零供给
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: CFG });
    expect(r.classes.high_calcium_group.quotaChars).toBe(0);
    expect(r.classes.block_summary.quotaChars).toBe(666);   // 0.4/0.6 × 1000
    expect(r.classes.recent_memory.quotaChars).toBe(333);   // 0.2/0.6 × 1000
    expect(r.dropped).toBe(0);
  });

  it('release_empty_class_quota=false 时按原比例锁额度（回退行为可配）', () => {
    const cfg = { ...CFG, release_empty_class_quota: false };
    const frags = [frag(DG, 500)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg });
    expect(r.classes.block_summary.quotaChars).toBe(400);
    expect(r.classes.high_calcium_group.quotaChars).toBe(400);
    expect(r.dropped).toBe(1);
  });

  it('非会晤：只有近期记忆供给时，整池归它', () => {
    const frags = [frag(MEM, 500), frag(MEM, 400)];
    const r = applyRecallQuota(frags, { scenario: 'normal', budget: 1000, cfg: CFG });
    expect(r.classes.recent_memory.quotaChars).toBe(1000);
    expect(r.dropped).toBe(0);
  });
});

describe('applyRecallQuota — 兜底（fail-open）', () => {
  it('enabled=false → 不裁剪（一键回退 2.3 之前的行为）', () => {
    const frags = [frag(HC, 100), frag(DG, 100), frag(MEM, 100), frag(HC, 900)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 200, cfg: { ...CFG, enabled: false } });
    expect(r.applied).toBe(false);
    expect(r.kept).toEqual(frags);
    expect(r.dropped).toBe(0);
  });

  it('预算非法（NaN / 0 / 负）→ 不裁剪', () => {
    const frags = [frag(HC, 100), frag(DG, 100)];
    for (const budget of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const r = applyRecallQuota(frags, { scenario: 'meeting', budget, cfg: CFG });
      expect(r.applied).toBe(false);
      expect(r.kept).toEqual(frags);
    }
  });

  it('比例全为 0（配置被改坏）→ 不裁剪', () => {
    const cfg: RecallQuotaConfig = {
      ...CFG,
      meeting: { high_calcium_group: 0, block_summary: 0, recent_memory: 0 },
    };
    const frags = [frag(HC, 100), frag(DG, 100)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg });
    expect(r.applied).toBe(false);
    expect(r.kept).toEqual(frags);
  });

  it('配置缺失 / 入参非数组 → 不裁剪且不抛', () => {
    const frags = [frag(HC, 100)];
    expect(applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: null }).applied).toBe(false);
    expect(applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: undefined }).applied).toBe(false);
    expect(applyRecallQuota(undefined as unknown as string[], { scenario: 'meeting', budget: 1000, cfg: CFG }).kept).toEqual([]);
  });

  it('全 OTHER → applied=true 但零裁剪（配额只管三类）', () => {
    const frags = ['【金库记忆·10-20】承诺', '【作品】《x》(小说)\n全文', '【反编造铁律】…'];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 200, cfg: CFG });
    expect(r.applied).toBe(true);
    expect(r.dropped).toBe(0);
    expect(r.kept).toEqual(frags);
    expect(r.other.total).toBe(3);
  });

  it('场景未知值按会晤处理（不因拼写错误走非会晤分支）', () => {
    const r = applyRecallQuota([frag(DG, 100)], {
      scenario: 'weird' as unknown as 'meeting', budget: 1000, cfg: CFG,
    });
    expect(r.scenario).toBe('meeting');
  });
});

describe('标签与 MemoryInjector 优先级的耦合（S4 评审锁定）', () => {
  it('启用配额时的组标签必须含「记忆」，否则组片段会被降到 0.60 并被注入层挤出', () => {
    // MemoryInjector 的记忆档判定是 `frag.includes('记忆') || preservedLabel.includes('记忆')`，
    // 缺「记忆」⇒ 优先级 0.85→0.60（低于金库 0.70）⇒ 配额在入口保住的份额被注入层吃掉。
    // 这条测试锁住"改标签必须连带考虑优先级"这个耦合，防止将来有人把标签改好看却丢优先级。
    const enabledTags = [
      TAG.dialogGroupMemory, TAG.highCalciumGroupMemory,
      TAG.dialogGroupMemoryBare, TAG.highCalciumGroupMemoryBare,
    ];
    for (const t of enabledTags) expect(t).toContain('记忆');
    // 关闭配额时 B 侧回退到 2.3 之前的 `X的记忆` —— 优先级同样是 0.85（形态与优先级都一致）
    expect(TAG.memory).toContain('记忆');
    // A 侧回退标签不含「记忆」是 2.3 之前的状态（优先级随正文抖动），记录在此备查
    expect(TAG.highCalciumGroup).not.toContain('记忆');
  });
});

describe('applyRecallQuota — 守恒与非法配置', () => {
  it('任何输入下 kept + dropped == 入参条数（零静默丢失）', () => {
    const cases: Array<[string, string[], Parameters<typeof applyRecallQuota>[1]]> = [
      ['会晤', [frag(HC, 300), frag(DG, 300), frag(MEM, 300), '【反编造铁律】…'], { scenario: 'meeting', budget: 1000, cfg: CFG }],
      ['会晤泛词', [frag(HC, 300), frag(DG, 300), frag(MEM, 300)], { scenario: 'meeting', budget: 1000, cfg: CFG, genericQuery: true }],
      ['非会晤', [frag(DG, 300), frag(MEM, 300), frag(HC, 300), '💭 无标签'], { scenario: 'normal', budget: 1000, cfg: CFG }],
      ['非会晤泛词', [frag(DG, 300), frag(MEM, 300)], { scenario: 'normal', budget: 1000, cfg: CFG, genericQuery: true }],
      ['非会晤零供给释放', [frag(MEM, 500), frag(MEM, 500)], { scenario: 'normal', budget: 1000, cfg: CFG }],
      ['会晤零供给释放', [frag(DG, 500), frag(DG, 500)], { scenario: 'meeting', budget: 1000, cfg: CFG }],
    ];
    for (const [name, frags, opts] of cases) {
      const r = applyRecallQuota(frags, opts);
      expect(r.kept.length + r.dropped, name).toBe(frags.length);
    }
  });

  it('各类统计自洽：保留条数/字符都在额度内，且合计等于 kept 的实际构成', () => {
    const frags = [frag(HC, 200), frag(HC, 200), frag(DG, 200), frag(DG, 200), frag(MEM, 200)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: CFG });
    let keptCharSum = 0;
    for (const k of ['high_calcium_group', 'block_summary', 'recent_memory'] as const) {
      const st = r.classes[k];
      const inputCount = frags.filter(f => classifyFragment(f) === k).length;
      expect(st.total, k).toBe(inputCount);                       // 分类没漏
      expect(st.kept + st.dropped, k).toBe(st.total);             // 条数守恒
      expect(st.keptChars, k).toBeLessThanOrEqual(st.quotaChars); // 未超额度
      keptCharSum += st.keptChars;
    }
    // kept 的实际字符 = 各配额类保留 + OTHER（OTHER 不受额度约束）
    const otherKeptChars = r.kept
      .filter(f => classifyFragment(f) === 'other')
      .reduce((s, f) => s + f.length, 0);
    expect(keptCharSum + otherKeptChars).toBe(r.kept.reduce((s, f) => s + f.length, 0));
    expect(r.other.chars).toBe(otherKeptChars);
  });

  it('额度吃满时 OTHER（铁律 / 长文 / 金库）原样保留', () => {
    // 三类各塞到远超额，铁律/长文/金库必须一条不少
    const guards = ['【反编造铁律】绝不能编造', '【对话原文·权威记录】\n' + '长'.repeat(400), '【金库记忆·10-20】承诺'];
    const frags = [...guards, frag(HC, 500), frag(DG, 500), frag(MEM, 500)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 400, cfg: CFG });
    expect(r.dropped).toBe(3);
    expect(r.kept.slice(0, 3)).toEqual(guards);
    expect(r.other.total).toBe(3);
  });

  it('比例非法（NaN / 负 / 非数值）→ 整体降级，不裁剪', () => {
    const frags = [frag(HC, 100), frag(DG, 100), frag(MEM, 100)];
    const bad: Array<Partial<RecallQuotaConfig['meeting']>> = [
      { recent_memory: Number.NaN },
      { block_summary: -0.4 },
      { high_calcium_group: 'abc' as unknown as number },
    ];
    for (const m of bad) {
      const cfg = { ...CFG, meeting: { ...CFG.meeting, ...m } };
      const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg });
      expect(r.applied).toBe(false);
      expect(r.kept).toEqual(frags);
    }
  });

  it('泛词 × 零供给释放组合下仍守恒（A 降档 + B/近期无供给时不乱分）', () => {
    const frags = [frag(HC, 200), frag(HC, 200), frag(HC, 200)];  // 仅 A 有供给
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg: CFG, genericQuery: true });
    // 仅 A 有供给 ⇒ 其份额释放为全额 1000（泛词降档只在 B/近期有供给时才需要让位）
    expect(r.classes.high_calcium_group.quotaChars).toBe(1000);
    expect(r.kept.length + r.dropped).toBe(3);
  });

  it('B/近期记忆比例被改成 0 且泛词时，不产生 NaN 额度', () => {
    const cfg: RecallQuotaConfig = {
      ...CFG,
      meeting: { high_calcium_group: 0.4, block_summary: 0, recent_memory: 0 },
    };
    const frags = [frag(HC, 200), frag(DG, 200)];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg, genericQuery: true });
    expect(Number.isFinite(r.classes.block_summary.quotaChars)).toBe(true);
    expect(r.kept.length + r.dropped).toBe(2);
  });
});

describe('applyRecallQuota — 输入不变性（不得改写调用方数组）', () => {
  it('裁剪只反映在返回值 kept，入参数组原样', () => {
    const cfg = { ...CFG, release_empty_class_quota: false };  // 锁住 B 的 400 额度
    const frags = [frag(DG, 300), frag(DG, 300), frag(DG, 300)];
    const before = [...frags];
    const r = applyRecallQuota(frags, { scenario: 'meeting', budget: 1000, cfg });
    expect(r.dropped).toBe(2);
    expect(frags).toEqual(before);
  });
});
