/**
 * T013 Phase 2 批C — ContextSlot 压栈弹栈回归测试
 *
 * 锁死 P039 缺陷②③ 的修复：
 *   ② 退出会晤**恢复**玉瑶现场，而非 `reset*()` 归零（玉瑶基线不丢失）
 *   ③ 普通会晤退出**复原进入前的角色**，不再无条件硬置 secretary
 *
 * 以及批C 的两条不变量：
 *   - 换人（SPEAK）**不压新栈**（同一会话内换人不该让现场栈膨胀）
 *   - `applySlot` 对**空槽拒绝写回**（写回空锚点比不恢复更糟 —— 会直接复现基线丢失）
 *
 * 本套件会**真实改动模块单例**（SceneAnchor/ContextMemory），故每个用例用 reset* 收尾，
 * 避免污染同进程内其它测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureSlot, applySlot } from '../contextBridge.js';
import { createSessionState, reduce, diffEffects, popSlot, pushSlot } from '../sessionReducer.js';
import { getAnchor, setAnchor, resetAnchor } from '../../SceneAnchor.js';
import { getSceneSnapshot, setSceneSnapshot, resetContext } from '../../ContextMemory.js';
import type { ContextSlot } from '../types.js';

const T0 = 1_700_000_000_000;
const A = { uuid: 'TXS-1', name: '徐诗雨', category: 'G' };
const B = { uuid: 'TXS-2', name: '熊梓铭', category: 'G' };


/** 把三份现场都置成「可辨识的玉瑶态」，用于验证恢复是否真的还原了它 */
function seedYuyaoScene(): void {
  setAnchor({ location: '书房', action: '喝茶', nudity: 0, intimacy: false, isActive: true, season: '秋', hour: 21 });
  setSceneSnapshot({
    physical: { nudityLevel: 0, position: '坐着', location: '书房', activity: '聊天' },
    atmosphere: { mood: '温存', tension: 0.2, distance: 0.5 },
    facts: { lastIntimatePeak: false, lastUserTopic: '今天心情', lastReplyTone: 'warm', mentionedEntities: ['鸿艺'] },
  });
}

/** 把现场改写成「被会晤内容污染」的样子 —— 模拟 M5Orchestrator 每轮 extractAnchor 覆盖 */
function polluteScene(): void {
  setAnchor({ location: '教室', action: '上课', nudity: 0, intimacy: false, isActive: true, season: '秋', hour: 10 });
  setSceneSnapshot({
    physical: { nudityLevel: 0, position: '站着', location: '教室', activity: '工作' },
    atmosphere: { mood: '紧张', tension: 0.8, distance: 0.9 },
    facts: { lastIntimatePeak: false, lastUserTopic: '考试', lastReplyTone: 'serious', mentionedEntities: ['老师'] },
  });
}

beforeEach(() => { resetAnchor(); resetContext(); });
afterEach(() => { resetAnchor(); resetContext(); });

describe('[批C] setAnchor — 恢复能力（此前只有归零）', () => {
  it('setAnchor 深写入，getAnchor 取到同样的值', () => {
    setAnchor({ location: '阳台', action: '吹风', nudity: 1, intimacy: true, isActive: true, season: '夏', hour: 22 });
    const a = getAnchor();
    expect(a.location).toBe('阳台');
    expect(a.nudity).toBe(1);
    expect(a.intimacy).toBe(true);
    expect(a.isActive).toBe(true);
  });

  it('传入对象随后被改动不影响单例（深拷贝）', () => {
    const src = { location: '厨房', action: '', nudity: 0, intimacy: false, isActive: true, season: '春', hour: 8 };
    setAnchor(src);
    src.location = '被篡改';
    expect(getAnchor().location).toBe('厨房');
  });

  it('字段缺失/非法值一律回退默认（不写 undefined 污染单例）', () => {
    setAnchor({} as never);
    const a = getAnchor();
    expect(a.location).toBe('');
    expect(a.nudity).toBe(0);
    expect(a.intimacy).toBe(false);
    expect(typeof a.season).toBe('string');
    expect(typeof a.hour).toBe('number');
  });
});

describe('[批C] captureSlot — 采样（时序：进入会晤前，单例仍是玉瑶现场）', () => {
  it('采到当前现场三份内容', () => {
    seedYuyaoScene();
    const slot = captureSlot(null, { emotion: { pleasure: 0.6, arousal: 0.3, intimacy: 0.2 }, savedRole: 'lover', now: T0 });
    expect(slot.uuid).toBeNull();                       // null = 玉瑶
    expect(slot.sceneAnchor?.location).toBe('书房');
    expect(slot.contextMemory?.atmosphere.mood).toBe('温存');
    expect(slot.emotion).toEqual({ pleasure: 0.6, arousal: 0.3, intimacy: 0.2 });
    expect(slot.savedRole).toBe('lover');
    expect(slot.savedAt).toBe(T0);
  });

  it('情感缺省时归零，不从 atmosphere 派生（两套坐标不可互换）', () => {
    seedYuyaoScene();
    const slot = captureSlot(null, { now: T0 });
    expect(slot.emotion).toEqual({ pleasure: 0, arousal: 0, intimacy: 0 });
    expect(slot.contextMemory?.atmosphere.tension).toBe(0.2);   // 氛围仍在，只是没混进 emotion
  });

  it('非法情感值被拒绝，不污染槽', () => {
    const slot = captureSlot(null, { emotion: { pleasure: 'x' as never, arousal: Number.NaN, intimacy: 3 } , now: T0 });
    expect(slot.emotion.pleasure).toBe(0);              // 非数字 → 默认
    expect(Number.isNaN(slot.emotion.arousal)).toBe(false);
    expect(slot.emotion.intimacy).toBe(3);              // 合法数字照收（本层不夹逼，夹逼归感知层）
  });

  it('现场读取异常不抛（采样失败只影响影子状态）', () => {
    expect(() => captureSlot('TXS-1', { now: T0 })).not.toThrow();
  });
});

describe('[批C] applySlot — 恢复（空槽拒绝，防把现场抹成白板）', () => {
  it('玉瑶现场往返：污染后仍能完整恢复', () => {
    seedYuyaoScene();
    const slot = captureSlot(null, { savedRole: 'counselor', now: T0 });

    polluteScene();                                     // 模拟会晤期间 M5 覆盖单例
    expect(getAnchor().location).toBe('教室');            // 前置条件：确实被污染

    expect(applySlot(slot)).toBe(true);
    expect(getAnchor().location).toBe('书房');            // 恢复成功 —— 基线未丢失
    expect(getSceneSnapshot().atmosphere.mood).toBe('温存');
  });

  it('全空槽 → 拒绝写回（写回空锚点比不恢复更糟）', () => {
    seedYuyaoScene();
    const empty: ContextSlot = { uuid: null, emotion: { pleasure: 0, arousal: 0, intimacy: 0 }, sceneAnchor: null, contextMemory: null, savedAt: T0 };
    expect(applySlot(empty)).toBe(false);
    expect(getAnchor().location).toBe('书房');            // 现场未被抹成白板
  });

  it('null / 非对象 → 拒绝且不抛', () => {
    expect(applySlot(null)).toBe(false);
    expect(applySlot(undefined)).toBe(false);
    expect(applySlot({} as never)).toBe(false);
  });

  it('仅锚点 / 仅内存 各自可单独恢复', () => {
    seedYuyaoScene();
    const onlyAnchor: ContextSlot = { uuid: null, emotion: { pleasure: 0, arousal: 0, intimacy: 0 }, sceneAnchor: { location: '湖边', action: '', nudity: 0, intimacy: false, isActive: true, season: '春', hour: 15 }, contextMemory: null, savedAt: T0 };
    expect(applySlot(onlyAnchor)).toBe(true);
    expect(getAnchor().location).toBe('湖边');

    const onlyMemory: ContextSlot = { uuid: null, emotion: { pleasure: 0, arousal: 0, intimacy: 0 }, sceneAnchor: null, contextMemory: { physical: { nudityLevel: 0, position: '躺着', location: '卧室', activity: '聊天' }, atmosphere: { mood: '喜悦', tension: 0.1, distance: 0.4 }, facts: { lastIntimatePeak: false, lastUserTopic: '', lastReplyTone: 'warm', mentionedEntities: [] } }, savedAt: T0 };
    expect(applySlot(onlyMemory)).toBe(true);
    expect(getSceneSnapshot().physical.location).toBe('卧室');
  });
});

describe('[批C] 完整进出会晤 — 压栈弹栈端到端', () => {
  /**
   * 🔴 2026-10-31 第三层固化：本文件原用 `projectMeetingState()`（批B 投影层）把
   *   「会晤快照」投影成 action 序列来驱动状态机。投影层已随第三层拆除删除
   *   （生产零消费者，`project.ts` 已删）—— 现在直接 dispatch 真实 action，
   *   语义等价且更贴近生产路径（chat.ts 就是直接 dispatch 的）。
   */
  it('WAKE 带 slot → LEAVE 产出 restoreSlot → 恢复后现场还原', () => {
    seedYuyaoScene();
    const slot = captureSlot(null, { savedRole: 'lover', now: T0 });

    let s = reduce(createSessionState(T0), { type: 'WAKE', targets: [A], now: T0, slot });
    expect(s.contextStack.some(c => c.uuid === null)).toBe(true);   // 玉瑶现场已入栈

    // 会晤期间现场被污染（模拟 M5 每轮覆盖）
    polluteScene();

    // 散会：清空参与者，玉瑶槽仍留在栈上，由 diffEffects 产出 restoreSlot
    const effects = diffEffects(s, reduce(s, { type: 'LEAVE', now: T0 }));
    s = reduce(s, { type: 'LEAVE', now: T0 });
    expect(s.participants).toHaveLength(0);
    expect(effects.some(e => e.type === 'restoreSlot')).toBe(true);

    // 弹栈恢复
    const { slot: restored } = popSlot(s.contextStack, null);
    expect(restored).not.toBeNull();
    expect(applySlot(restored)).toBe(true);
    expect(getAnchor().location).toBe('书房');            // 玉瑶基线回来了
    expect(restored!.savedRole).toBe('lover');            // 角色现场也在
  });

  it('🔴 换人（SPEAK）不压新栈 —— 现场栈不随切换次数膨胀', () => {
    let s = reduce(createSessionState(T0), { type: 'WAKE', targets: [A], now: T0, slot: captureSlot(null, { now: T0 }) });
    s = reduce(s, { type: 'JOIN', target: B, now: T0 });
    expect(s.contextStack.filter(c => c.uuid === null)).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      s = reduce(s, { type: 'SPEAK', target: i % 2 ? A.uuid : B.uuid, now: T0 });
    }
    // 集合在单人/多人间来回切，但玉瑶现场按 uuid 原位覆盖，栈深始终 1
    expect(s.contextStack.filter(c => c.uuid === null)).toHaveLength(1);
  });

  it('多轮进出不膨胀 —— 同一现场原位覆盖，栈深恒 ≤1', () => {
    let s = createSessionState(T0);
    for (let i = 0; i < 3; i++) {
      s = reduce(s, { type: 'WAKE', targets: [A], now: T0, slot: captureSlot(null, { now: T0 }) });
      s = reduce(s, { type: 'LEAVE', now: T0 });
    }
    expect(s.contextStack.filter(c => c.uuid === null).length).toBeLessThanOrEqual(1);
  });

  it('pushSlot 原位覆盖 —— 同一现场不会重复入栈', () => {
    const s1: ContextSlot = { uuid: null, emotion: { pleasure: 0, arousal: 0, intimacy: 0 }, sceneAnchor: null, contextMemory: null, savedAt: T0 };
    const s2 = { ...s1, savedAt: T0 + 1 };
    const stack = pushSlot(pushSlot([], s1), s2);
    expect(stack).toHaveLength(1);
    expect(stack[0].savedAt).toBe(T0 + 1);                 // 留的是最新一份
  });
});
