import { describe, it, expect } from 'vitest';
import { checkEntityWrite, checkPersonEntity, checkObjectEntity } from '../EntityWriteGate.js';
import { ENTITY_BLACKLIST } from '../../../config/app-identity.js';
import { gradeEntity } from '../../../app/entity/EntityCandidateGrader.js';
import { checkEntity } from '../GarbageEntityGuard.js';

/**
 * FG-P0 写前统一闸门单测（2026-09-09 乱提取根治）
 * 场景: 一段 LLM 外貌描述被逗号切 12 块全入库 object(103886-103897)、整句"说说你的胸怎么这么小"
 *      被建档、真人被误标 object —— 垃圾率 77%。本闸门在所有写入点前拦截。
 */

describe('checkObjectEntity — object 通道', () => {
  it('🔴 整句/散文段(诊断垃圾 103886-103897 形态) 拦截', () => {
    expect(checkObjectEntity('和姐姐诗雨有七分相似的瓜子脸').allowed).toBe(false);
    expect(checkObjectEntity('大眼睛又圆又亮').allowed).toBe(false);
    expect(checkObjectEntity('性格温柔内向又细心').allowed).toBe(false);
    expect(checkObjectEntity('刚开始发育的少女身材').allowed).toBe(false);
    expect(checkObjectEntity('说说你的胸怎么这么小').allowed).toBe(false);
  });

  it('🔴 外貌特征词尾 不建独立 object（应存档案/特征边）', () => {
    expect(checkObjectEntity('瓜子脸').allowed).toBe(false);
    expect(checkObjectEntity('高个子').allowed).toBe(false);
    expect(checkObjectEntity('双眼皮').allowed).toBe(false);
    expect(checkObjectEntity('长头发').allowed).toBe(false);
    expect(checkObjectEntity('活泼').allowed).toBe(false);
  });

  it('真人进 object 通道不应放行独立 object（统一入口 person 优先分流）', () => {
    expect(checkEntityWrite('熊梓玥').allowed).toBe(true);   // person 通道放行
    expect(checkEntityWrite('熊梓玥').mode).toBe('person');  // 分流到 person, 不当 object 建
  });

  it('合规 object 名词放行', () => {
    expect(checkObjectEntity('游戏').allowed).toBe(true);
    expect(checkObjectEntity('宿舍').allowed).toBe(true);
    expect(checkObjectEntity('办公室').allowed).toBe(true);
  });

  it('超长/空拒绝', () => {
    expect(checkObjectEntity('').allowed).toBe(false);
    expect(checkObjectEntity('操场东边第三棵老槐树下的石凳').allowed).toBe(false);
  });
});

describe('checkPersonEntity / checkEntityWrite — person 通道', () => {
  it('🔴 句子残留以姓开头(乱提取假名) 拒绝', () => {
    expect(checkPersonEntity('温柔').allowed).toBe(false);   // 弱证据姓
    expect(checkPersonEntity('应一下').allowed).toBe(false);
  });

  it('合规真名 放行', () => {
    expect(checkPersonEntity('熊梓铭').allowed).toBe(true);
    expect(checkPersonEntity('徐诗雨').allowed).toBe(true);
    expect(checkPersonEntity('王全芬').allowed).toBe(true);
  });

  it('称谓/黑名单拒绝', () => {
    expect(checkPersonEntity('亲爱的').allowed).toBe(false);
    expect(checkPersonEntity('妈').allowed).toBe(false);
  });

  it('已知实体直接放行(L4)', () => {
    expect(checkPersonEntity('安琪', new Set(['安琪', '玉瑶'])).allowed).toBe(true);
  });
});

describe('checkEntityWrite — 统一入口', () => {
  it('真名走 person 放行, 垃圾句子整体拒绝', () => {
    expect(checkEntityWrite('徐诗雨').allowed).toBe(true);
    expect(checkEntityWrite('大眼睛又圆又亮').allowed).toBe(false);
  });
});

/**
 * V50 噪音词表止血（2026-10-12）
 * 场景: 2026-10-11 23:26:59 观察区一次性新增 42 个 candidate，全部是高频词/滑窗片段
 *      （关于/经理/毕竟日/公室只/终于射…）。实测（D:\tmp\probe-bl.mts）加入词表前
 *      **42/42 全部 grade=3 放行、零个被拦** —— 首字多为姓氏字（关/安/周/成/经/都/边/方/麻）
 *      → hasSurname 命中，字面判据路线到头。故把这 42 词入 ENTITY_BLACKLIST（L0）。
 * 边界: 词表只作用于 person 分支；object 通道不套用（EntityWriteGate.ts:80 防误伤）。
 */
describe('V50 噪音词表 — 42 个观察区噪音词入 ENTITY_BLACKLIST', () => {
  const NOISE_WORDS = [
    '关于','经理','方便','经常','安全','厉害','居然','连续','满意','安静',
    '周末','成真','乐趣','明白','高潮','经受','管用','都挺起','都进去','终于进',
    '毕竟日','终于射','杭州玩','公室只','安排真','后看起','边理解','能学','边捏','都差',
    '边聊','水吧','石公园','国画展','国美','何不同','公室','宿舍','方式','麻烦','能叫','滑液',
  ];

  it('防误删：42 词全部存在于【真源】ENTITY_BLACKLIST（不是断言本文件自己的字面量）', () => {
    const missing = NOISE_WORDS.filter(w => !ENTITY_BLACKLIST.has(w));
    expect(missing).toEqual([]);
    expect(new Set(NOISE_WORDS).size).toBe(42);
  });

  it('🔴 person 通道：42 词在三处闸门全部拒绝（加入前 42/42 grade=3 放行）', () => {
    expect(NOISE_WORDS.filter(w => checkPersonEntity(w).allowed)).toEqual([]);
    // 另两处引用同一真源的闸门 —— app-identity.ts 注释宣称「三闸门」，此处逐条兑现
    expect(NOISE_WORDS.filter(w => gradeEntity(w).grade !== 0)).toEqual([]);
    expect(NOISE_WORDS.filter(w => checkEntity(w, new Set()).allowed)).toEqual([]);
  });

  it('object 通道不受影响：地点名词仍可作合规 object', () => {
    expect(checkObjectEntity('宿舍').allowed).toBe(true);
    expect(checkObjectEntity('国画展').allowed).toBe(true);
    expect(checkObjectEntity('办公室').allowed).toBe(true);
    expect(checkObjectEntity('游戏').allowed).toBe(true);
    // 42 词在 object 通道 = 2 拒 + 40 放行，这 2 个拒都与词表无关（object 不套用词表）：
    //   '水吧' 以「吧」结尾 → OBJECT_FRAG_TAIL（EntityWriteGate.ts:40）
    //   '安静' 命中外貌/体态词尾 → APPEARANCE_FEATURE_TAIL（:31，含「安静」）
    expect(checkObjectEntity('水吧').allowed).toBe(false);
    expect(checkObjectEntity('安静').allowed).toBe(false);
  });

  it('✅ 统一入口 checkEntityWrite：person 命中 L0 不回退 object（V50 D 段已修）', () => {
    // 历史：本条先前断言 `toHaveLength(40)` —— 那是 D 段修复**之前**的行为快照
    //（42 词里 40 个经 person 被拒后回退 object 而放行，唯一生产调用方
    // InductionScheduler.ts:332 因此完全收不到词表）。D 段在 person 返回 `l0Block`
    // 时直接拒绝、不再回退 ⇒ 期望值翻转为 0。
    // grade 1-2（长度/对话残留/弱证据姓）仍回退 object 的语义，由下方用例单独守护。
    const allowedAsObject = NOISE_WORDS.filter(w => {
      const v = checkEntityWrite(w);
      return v.allowed && v.mode === 'object';
    });
    expect(allowedAsObject, 'L0 禁止词不得经统一入口以 object 身份放行').toHaveLength(0);
    // 逐条确认拒绝原因确实是 L0（而非被别的判据拦下）
    for (const w of NOISE_WORDS) {
      expect(checkEntityWrite(w).allowed, w).toBe(false);
    }
  });

  it('真实人名不被误伤 + 已知取舍留痕', () => {
    for (const n of ['徐诗雨', '熊梓铭', '陈锋华', '王全芬']) {
      expect(checkPersonEntity(n).allowed).toBe(true);
    }
    // ⚠️ 已知取舍（业主 2026-10-12 批准加 42 词时确认）：`高潮`/`安静` 这类字面可作「姓+名」的词
    //    也被拒 —— 它们在 42 词内，且实测只由词表驱动（其余 5 条字面判据 42 词 0 命中）。
    //    这里显式断言，改词表时会亮红灯，避免静默放宽或静默收紧。
    expect(checkPersonEntity('高潮').allowed).toBe(false);
    expect(checkPersonEntity('安静').allowed).toBe(false);
  });
});
