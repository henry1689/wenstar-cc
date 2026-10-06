import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scoreBlock,
  sceneRatioOf,
  commitmentSignalOf,
  emotionSignalOf,
  emotionCurveOf,
  degradedRatioOf,
  decayClassOf,
  sceneAnchorHashOf,
  extractSceneParens,
  FEATURE_ROUND_RE,
  SCENE_PAREN_MIN_LEN,
  type BlockRound,
} from '../BlockValueScorer.js';
import type { Perception24D } from '../../../m3/types/perception.js';

/**
 * [ADR-010 P1-B / 2026-10-06] 对话块价值判定 —— 确定性规则的守卫
 *
 * 本文件锁住三件事：
 *   ① **判据本身**（场景/承诺/情绪/退化/转折 各自的门槛与边界）
 *   ② **纯函数性** —— 同输入恒同输出。这不是形式主义：选确定性规则而非 LLM 打分的
 *      核心理由就是「不可复现的判据 × 不可逆的持久化决策 = 检索池随机漂移」，
 *      所以「可复现」必须被测试钉死，否则换成任何一种带随机/时间依赖的实现都不会被发现。
 *   ③ **判据收拢** —— FEATURE_ROUND_RE 只此一处定义（不变量 #7）。
 */

/** 读源码并剥注释 —— 源码守卫用（注释里出现标识符不算违规） */
const codeOf = (p: string): string =>
  readFileSync(join(process.cwd(), p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

/** 中性感知向量（24 维齐全，避免用 as any 绕过类型） */
function neutralP(): Perception24D {
  return {
    pleasure: 0, arousal: 0, dominance: 0, aggression: 0, sincerity: 0.5,
    humor: 0, factual: 0.5, logical: 0.5, certainty: 0.5, abstract: 0,
    temporal_focus: 0, self_ref: 0.5, intimacy: 0, power_diff: 0,
    dependency: 0, moral_judgment: 0, etiquette: 0.5, belonging: 0,
    sexual_attraction: 0, sensory_craving: 0, energy_merge: 0,
    possessiveness: 0, ecstasy: 0, safety: 0.5,
  };
}
const withDim = (k: keyof Perception24D, v: number): Perception24D => ({ ...neutralP(), [k]: v });

/** 一段足够长的场景描写（≥ SCENE_PAREN_MIN_LEN 字） */
const LONG_SCENE = '（她把外套搭在椅背上，走到窗边站了一会儿，外面的雨还没停，玻璃上全是水痕）';
/** 短语气括号（< SCENE_PAREN_MIN_LEN 字）—— 实测占比极高，不得因此得分 */
const SHORT_PAREN = '（笑了笑）';

const input = (over: Partial<Parameters<typeof scoreBlock>[0]> = {}) => ({
  rounds: [{ q: '我们下周去杭州吧', a: '好呀，那我把票看看' }] as BlockRound[],
  perceptions: [neutralP()],
  maxCalcium: 0.5,
  maxCalciumRound: 0,
  locusPath: 'life.daily',
  closeReason: 'idle_timeout',
  entityNames: [] as string[],
  ...over,
});

describe('[ADR-010 P1-B] 场景描写判据 —— 修正 D：只判「有没有括号」会让几乎所有块满分', () => {
  it('🔴 短语气括号（（笑了笑））不得计入场景描写', () => {
    const r: BlockRound[] = [{ q: '嗯', a: `好${SHORT_PAREN}` }];
    expect(extractSceneParens(r[0].a)).toEqual(['笑了笑']);
    expect(sceneRatioOf(r), `${SHORT_PAREN.length} 字 < 门槛 ${SCENE_PAREN_MIN_LEN}`).toBe(0);
  });

  it('🔴 长场景描写计入', () => {
    const r: BlockRound[] = [{ q: '怎么了', a: `没事${LONG_SCENE}` }];
    expect(sceneRatioOf(r)).toBe(1);
  });

  it('场景占比按「轮次」而非「括号个数」——一轮里写三个长括号仍只算一轮', () => {
    const r: BlockRound[] = [{ q: '嗯', a: `${LONG_SCENE}${LONG_SCENE}${LONG_SCENE}` }];
    expect(sceneRatioOf(r), '一轮里三个长括号仍只算一轮').toBe(1);
    expect(sceneRatioOf([...r, { q: '嗯', a: '好' }]), '两轮里一轮有场景 ⇒ 0.5').toBeCloseTo(0.5, 5);
  });

  it('全角（）与半角() 都识别', () => {
    const half = `x(${'字'.repeat(SCENE_PAREN_MIN_LEN)})`;
    expect(sceneRatioOf([{ q: 'a', a: half }])).toBe(1);
  });
});

describe('[ADR-010 P1-B] 承诺/约定判据', () => {
  it('命中承诺词得满分，且**不按命中次数累加**（一次承诺就是一次承诺）', () => {
    expect(commitmentSignalOf([{ q: '我答应你', a: '好' }])).toBe(3);
    expect(
      commitmentSignalOf([{ q: '我答应你，一定，保证，约定', a: '好，记得，记住' }]),
      '一次问答里命中多个词仍只算 3 分',
    ).toBe(3);
  });

  it('无承诺词得 0', () => {
    expect(commitmentSignalOf([{ q: '今天天气不错', a: '是呀' }])).toBe(0);
  });

  it('🔴 FEATURE_ROUND_RE 是唯一实现处 —— 本文件内不得再内联一份同义词表', () => {
    // 源码守卫：BlockValueScorer 是判据单一定义处，dialog-group-stage 必须引用它。
    // 复制一份词表就违反不变量 #7，且两份会随时间漂移（本仓反复踩过的「多套口径」）。
    const src = codeOf('src/webui/chat/dialog-group-stage.ts');
    expect(src, 'dialog-group-stage 不得再内联 FEATURE_ROUND_RE 的定义').not.toMatch(/FEATURE_ROUND_RE\s*=/);
    expect(src, 'dialog-group-stage 必须从 BlockValueScorer 引入该词表').toMatch(/FEATURE_ROUND_RE/);
  });
});

describe('[ADR-010 P1-B] 情绪起伏判据', () => {
  it('平坦的一段（全程中性）得 0 分', () => {
    expect(emotionSignalOf(emotionCurveOf([neutralP(), neutralP(), neutralP()]))).toBe(0);
  });

  it('极差 ≥0.5 视为明显起伏 → 满分 2', () => {
    const curve = [0.1, 0.7];
    expect(emotionSignalOf(curve)).toBe(2);
  });

  it('单轮块无起伏可言 → 0', () => {
    expect(emotionSignalOf([0.9])).toBe(0);
  });

  it('曲线用 computeCalcium 口径（与 memories 同标度），取值落在 [0,1]', () => {
    const c = emotionCurveOf([withDim('intimacy', 0.9), neutralP()]);
    expect(c).toHaveLength(2);
    for (const v of c) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
  });
});

describe('[ADR-010 P1-B] 退化判据 —— 复用 m2.isDegenerateContent，不重写', () => {
  it('问答两侧都退化才算退化轮（用户敷衍但角色认真回应仍是有效剧情）', () => {
    expect(degradedRatioOf([{ q: '嗯', a: '（她认真地讲了很长一段关于杭州行程的安排）' }])).toBe(0);
    expect(degradedRatioOf([{ q: '嗯', a: '好' }])).toBe(1);
  });

  it('退化占比达阈值 ⇒ degraded=true 且带负惩罚', () => {
    const s = scoreBlock(input({ rounds: [{ q: '嗯', a: '好' }, { q: '哦', a: '嗯' }, { q: '在', a: '好' }] }));
    expect(s.degraded).toBe(true);
    expect(s.signals.degradedPenalty).toBeLessThan(0);
  });

  it('🔴 退化惩罚不足以抹掉承诺的正分 —— 纯寒暄压平，但不误伤含承诺的短对话', () => {
    const s = scoreBlock(input({
      rounds: [{ q: '嗯', a: '好' }, { q: '哦', a: '嗯' }, { q: '我答应你，一定去', a: '好，我记得' }],
    }));
    expect(s.signals.commitment, '承诺分照给').toBe(3);
    expect(s.score, '承诺仍在总分里体现').toBeGreaterThan(0);
  });
});

describe('[ADR-010 P1-B] 衰减类别 —— 修正 C：按内容类别，不由钙分决定', () => {
  it('亲密维峰值 ≥0.45 ⇒ emotional', () => {
    expect(decayClassOf([neutralP(), withDim('intimacy', 0.6)], 'life.daily', [])).toBe('emotional');
    expect(decayClassOf([withDim('sexual_attraction', 0.5)], 'life.daily', [])).toBe('emotional');
  });

  it('有实体互动且真诚 ⇒ relational', () => {
    expect(decayClassOf([withDim('sincerity', 0.5)], 'life.daily', ['徐诗雨'])).toBe('relational');
  });

  it('工作域 ⇒ work；其余 ⇒ neutral', () => {
    expect(decayClassOf([neutralP()], 'work.project', [])).toBe('work');
    expect(decayClassOf([neutralP()], 'life.daily', [])).toBe('neutral');
  });

  it('🔴 用峰值而非均值 —— 一段里只要有一轮足够亲密，整块按情感留存', () => {
    const ps = [neutralP(), neutralP(), neutralP(), withDim('intimacy', 0.9)];
    expect(decayClassOf(ps, 'life.daily', [])).toBe('emotional');
  });

  it('🔴 类别与钙分**无关**：极高钙分的中性块仍是 neutral（解耦，不得重新耦合）', () => {
    const high = scoreBlock(input({ rounds: [{ q: '项目进度如何', a: '已完成三项' }], perceptions: [withDim('factual', 1)], locusPath: 'life.daily' }));
    expect(high.decayClass).toBe('neutral');
  });
});

describe('[ADR-010 P1-B] 场景指纹 —— 等值比对，不是相似度', () => {
  it('同一场景（同括号文本 + 同 locus + 同实体）⇒ 同指纹', () => {
    const r: BlockRound[] = [{ q: '怎么了', a: `没事${LONG_SCENE}` }];
    expect(sceneAnchorHashOf(r, 'life.daily', ['徐诗雨']))
      .toBe(sceneAnchorHashOf(r, 'life.daily', ['徐诗雨']));
  });

  it('实体集合顺序不影响指纹（已排序）', () => {
    const r: BlockRound[] = [{ q: 'a', a: `b${LONG_SCENE}` }];
    expect(sceneAnchorHashOf(r, 'life.daily', ['甲', '乙']))
      .toBe(sceneAnchorHashOf(r, 'life.daily', ['乙', '甲']));
  });

  it('不同场景 ⇒ 不同指纹；不同话题 ⇒ 不同指纹', () => {
    const a: BlockRound[] = [{ q: 'x', a: `y${LONG_SCENE}` }];
    const b: BlockRound[] = [{ q: 'x', a: 'y（她站在门口，手里拎着刚买回来的一袋橘子和两盒草莓，肩膀都湿了）' }];
    expect(sceneAnchorHashOf(a, 'life.daily', [])).not.toBe(sceneAnchorHashOf(b, 'life.daily', []));
    expect(sceneAnchorHashOf(a, 'life.daily', [])).not.toBe(sceneAnchorHashOf(a, 'work.project', []));
  });

  it('无场景描写的块：指纹仍稳定（由 locus + 实体决定），不返回空', () => {
    const h = sceneAnchorHashOf([{ q: '嗯', a: '好' }], 'life.daily', []);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('[ADR-010 P1-B] 主入口', () => {
  it('🔴 纯函数性：同输入连续两次必须完全一致（选确定性规则而非 LLM 的核心理由）', () => {
    const inp = input({
      rounds: [{ q: '我答应你下周三一定到', a: `嗯${LONG_SCENE}` }],
      perceptions: [withDim('intimacy', 0.7), neutralP()],
      closeReason: 'topic_switch',
      entityNames: ['徐诗雨'],
    });
    const a = scoreBlock(inp);
    const b = scoreBlock(inp);
    expect(a, '同输入恒同输出 —— 换成带随机/时间依赖的实现必须在此变红').toEqual(b);
  });

  it('分值恒落在 [0,10]', () => {
    const s = scoreBlock(input({
      rounds: [{ q: '我答应你，一定，保证，约定，记得，重要', a: `${LONG_SCENE}${LONG_SCENE}` }],
      perceptions: [neutralP(), withDim('intimacy', 1)],
      closeReason: 'topic_switch',
    }));
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(10);
  });

  it('空块返回全零（调用方应跳过写入）', () => {
    const s = scoreBlock(input({ rounds: [], perceptions: [] }));
    expect(s.score).toBe(0);
    expect(s.turnCount).toBe(0);
    expect(s.emotionCurve).toEqual([]);
  });

  it('话题转折（topic_switch）得 +2，闲置超时不得分', () => {
    expect(scoreBlock(input({ closeReason: 'topic_switch' })).signals.turningPoint).toBe(2);
    expect(scoreBlock(input({ closeReason: 'idle_timeout' })).signals.turningPoint).toBe(0);
  });
});

describe('[ADR-010 P1-B] 锚点 seq_pos 唯一性守卫', () => {
  it('🔴 锚点 seq_pos 不得再按「轮数」算 —— 同轮数的组会撞 UNIQUE 约束', () => {
    // 背景（生产取证 2026-10-06）：原实现 `seqPos: -(dg.rounds.length + 100)` 按轮数算值，
    //   memories.seq_pos 是 UNIQUE NOT NULL（schema.sql:7）⇒ 同轮数的第二个组起锚点写入静默失败。
    //   实测：当天闭合 4 个「1 轮组」全部算出 -101，只有第一个活下来（其余 3 个锚点丢失）；
    //   而这正是 ADR-010 §1.4 要救回的「峰值轮全文、保留场景」那份运行期锚点。
    //   已在生产库副本上用真实 flushDialogGroup 复现 `UNIQUE constraint failed: memories.seq_pos`。
    const src = codeOf('src/webui/chat/dialog-group-stage.ts');
    expect(
      src,
      '🔴 按轮数算 seq_pos 会让同轮数的组互相撞 —— 见上方背景',
    ).not.toMatch(/seqPos:\s*-\s*\(\s*dg\.rounds\.length/);
    expect(
      src,
      '锚点 seq_pos 应派生自该组首轮 seq_pos（组间唯一 ⇒ 负值亦唯一）',
    ).toMatch(/anchorSeqPos/);
  });
});
