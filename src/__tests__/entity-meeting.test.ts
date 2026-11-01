/**
 * V10.0 P1-3: 会晤触发测试（纯函数，不依赖服务器）
 * 测试 5 种触发模式
 */
import { describe, it, expect } from 'vitest';
import { EntityMeeting } from '../m4/household/EntityMeeting.js';

const NAMES = ['徐诗雨', '徐诗韵', '熊梓铭', '阿珍', '张小龙', '罗权斌'];

describe('EntityMeeting.detectUserIntent — 会晤触发', () => {
  it('模式1: @name 格式', () => {
    const r = EntityMeeting.detectUserIntent('@徐诗雨 你好', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式2: name: 格式', () => {
    const r = EntityMeeting.detectUserIntent('徐诗雨：你在吗', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式3: 纯名字（最短匹配）', () => {
    const r = EntityMeeting.detectUserIntent('诗雨', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式4: 间接呼唤（通过玉瑶）', () => {
    const r = EntityMeeting.detectUserIntent('瑶瑶，叫徐诗雨过来一下', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式5: 自然口语 — 我想找XX聊聊', () => {
    const r = EntityMeeting.detectUserIntent('我想找阿珍聊聊', NAMES);
    expect(r).toEqual(['阿珍']);
  });

  it('自然口语 — 我叫XX过来', () => {
    const r = EntityMeeting.detectUserIntent('叫张小龙来', NAMES);
    expect(r).toEqual(['张小龙']);
  });

  it('不触发: 日常聊天不含人名', () => {
    const r = EntityMeeting.detectUserIntent('今天天气不错', NAMES);
    expect(r).toBeNull();
  });

  it('不触发: 高频泛称词（V10.0 P1-5）', () => {
    // V10.0 P1-5: 泛称词从 sorted 中排除，整个匹配流程不应匹配
    const namesWithGeneric = [...NAMES, '老婆', '妹妹'];
    const r = EntityMeeting.detectUserIntent('老婆今天生日我们去哪吃饭', namesWithGeneric);
    expect(r).toBeNull();
  });

  it('全名匹配: 消息包含全名', () => {
    const r = EntityMeeting.detectUserIntent('徐诗雨', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式6: 你是XX吗 — 身份确认', () => {
    const r = EntityMeeting.detectUserIntent('你是徐诗雨吗', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

  it('模式7: 你是XX — 无问号', () => {
    const r = EntityMeeting.detectUserIntent('你是阿珍', NAMES);
    expect(r).toEqual(['阿珍']);
  });

  it('模式8: 短名 — "诗雨"匹配"徐诗雨"', () => {
    const r = EntityMeeting.detectUserIntent('你是诗雨吗', NAMES);
    expect(r).toEqual(['徐诗雨']);
  });

});

describe('EntityMeeting.detectSwitchIntent — 会中切换', () => {
  it('换人来', () => {
    const r = EntityMeeting.detectSwitchIntent('换熊梓铭来', NAMES);
    expect(r).toBe('熊梓铭');
  });

  it('让XX也来', () => {
    const r = EntityMeeting.detectSwitchIntent('让阿珍也来', NAMES);
    expect(r).toBe('阿珍');
  });

  it('我想和XX聊聊', () => {
    const r = EntityMeeting.detectSwitchIntent('我想和罗权斌聊聊', NAMES);
    expect(r).toBe('罗权斌');
  });

  it('XX在吗', () => {
    const r = EntityMeeting.detectSwitchIntent('徐诗韵在吗', NAMES);
    expect(r).toBe('徐诗韵');
  });

  it('退出信号不触发切换', () => {
    const r = EntityMeeting.detectSwitchIntent('散会', NAMES);
    expect(r).toBeNull();
  });
});

// ─── 结构修复回归：玉瑶（系统本体 category='S'）不可会晤 + exit 清除持久化 ───
describe('EntityMeeting — 本体隔离（category=S 不可会晤）', () => {
  /** 最小 FamilyGraph mock：getUUIDByName + getEntityByUUID */
  function makeFG(nodes: Array<{ name: string; uuid: string; category: string }>) {
    const byName = new Map(nodes.map(n => [n.name, n.uuid]));
    const byUuid = new Map(nodes.map(n => [n.uuid, n]));
    return {
      getUUIDByName: (name: string) => byName.get(name) ?? null,
      getEntityByUUID: (uuid: string) => byUuid.get(uuid) ?? null,
    } as any;
  }

  /**
   * 🔴 2026-10-31 第三层固化：`enter()/exit()/setStorage()` 已随旧状态机删除，
   *   本体隔离判据（原 `_resolveEntity` 的 `category === 'S'`）迁到静态方法
   *   `EntityMeeting.isMeetableEntity`，由 chat.ts 的 WAKE 路径在 dispatch 前调用。
   *   这里改为直接守该判据本身 —— 它才是红线，调用点位置不应成为测试耦合点。
   */
  it('玉瑶（category=S）不可会晤', () => {
    const fg = makeFG([
      { name: '玉瑶', uuid: 'TXS-000000001', category: 'S' },
      { name: '熊梓铭', uuid: 'TXS-000000003', category: 'G' },
    ]);
    expect(EntityMeeting.isMeetableEntity(fg, '玉瑶')).toBe(false);   // 系统本体是回答者，不是可会晤实体
  });

  it('真人（category=G）可会晤', () => {
    const fg = makeFG([
      { name: '熊梓铭', uuid: 'TXS-000000003', category: 'G' },
    ]);
    expect(EntityMeeting.isMeetableEntity(fg, '熊梓铭')).toBe(true);
  });

  it('FG 查不到的人名一律不可会晤（防伪造名字进入席位）', () => {
    const fg = makeFG([]);
    expect(EntityMeeting.isMeetableEntity(fg, '查无此人')).toBe(false);
  });

  it('FG 缺失 / 名称为空时拒绝（防未初始化时放行）', () => {
    expect(EntityMeeting.isMeetableEntity(null, '熊梓铭')).toBe(false);
    expect(EntityMeeting.isMeetableEntity(undefined, '熊梓铭')).toBe(false);
    expect(EntityMeeting.isMeetableEntity(makeFG([]), '')).toBe(false);
  });
});

describe('EntityMeeting.detectIntent — P1-1 意图分类门卫', () => {
  it('exit: 散会', () => {
    expect(EntityMeeting.detectIntent('散会', NAMES).kind).toBe('exit');
  });
  it('exit: 结束吧（口语结束语）', () => {
    expect(EntityMeeting.detectIntent('结束吧', NAMES).kind).toBe('exit');
  });
  it('exit: 不聊了', () => {
    expect(EntityMeeting.detectIntent('不聊了', NAMES).kind).toBe('exit');
  });
  it('exit: 切回玉瑶', () => {
    expect(EntityMeeting.detectIntent('切回玉瑶', NAMES).kind).toBe('exit');
  });
  it('exit: 拜拜', () => {
    expect(EntityMeeting.detectIntent('拜拜', NAMES).kind).toBe('exit');
  });
  it('addParticipant: 叫徐诗雨也来', () => {
    expect(EntityMeeting.detectIntent('叫徐诗雨也来', NAMES)).toEqual({ kind: 'addParticipant', targets: ['徐诗雨'] });
  });
  it('addParticipant: 让阿珍加入', () => {
    expect(EntityMeeting.detectIntent('让阿珍加入', NAMES)).toEqual({ kind: 'addParticipant', targets: ['阿珍'] });
  });
  it('switch: 换熊梓铭来', () => {
    expect(EntityMeeting.detectIntent('换熊梓铭来', NAMES)).toEqual({ kind: 'switch', targets: ['熊梓铭'] });
  });
  it('wake: 找徐诗雨聊聊', () => {
    expect(EntityMeeting.detectIntent('找徐诗雨聊聊', NAMES)).toEqual({ kind: 'wake', targets: ['徐诗雨'] });
  });
  it('wake: 我想和罗权斌聊', () => {
    expect(EntityMeeting.detectIntent('我想和罗权斌聊', NAMES)).toEqual({ kind: 'wake', targets: ['罗权斌'] });
  });
  it('normal: 今天天气不错', () => {
    expect(EntityMeeting.detectIntent('今天天气不错', NAMES).kind).toBe('normal');
  });
  it('normal: 泛称词不触发唤醒（老婆生日）', () => {
    expect(EntityMeeting.detectIntent('老婆今天生日快乐', NAMES).kind).toBe('normal');
  });
  it('normal: 疑问句不误判 exit（结束了吗）', () => {
    expect(EntityMeeting.detectIntent('结束了吗', NAMES).kind).toBe('normal');
  });
  it('normal: 疑问句不误判 exit（散会了没）', () => {
    expect(EntityMeeting.detectIntent('散会了没', NAMES).kind).toBe('normal');
  });
  it('exit: 结束会议', () => {
    expect(EntityMeeting.detectIntent('结束会议', NAMES).kind).toBe('exit');
  });
  it('addParticipant: 叫张小龙来（无会晤态唤醒路径）', () => {
    expect(EntityMeeting.detectIntent('叫张小龙来', NAMES)).toEqual({ kind: 'addParticipant', targets: ['张小龙'] });
  });
  // ── P2-2 新增：句尾结束词（问题3）──
  it('exit: 句尾结束词「就聊到这吧」', () => {
    expect(EntityMeeting.detectIntent('就聊到这吧', NAMES).kind).toBe('exit');
  });
  it('exit: 句尾结束词「下次再聊，拜拜」', () => {
    expect(EntityMeeting.detectIntent('下次再聊，拜拜', NAMES).kind).toBe('exit');
  });
  it('exit: 句尾结束词「今天先这样了」', () => {
    expect(EntityMeeting.detectIntent('今天先这样了', NAMES).kind).toBe('exit');
  });
  it('normal: 句尾含"再聊"但非结束（下次再聊那个问题）', () => {
    expect(EntityMeeting.detectIntent('下次再聊那个问题', NAMES).kind).toBe('normal');
  });
  // ── P2-2 新增：会晤中提名字不触发唤醒（问题2）──
  it('会晤中 normal: 提名字「熊梓铭不在家真好」', () => {
    expect(EntityMeeting.detectIntent('熊梓铭不在家真好', NAMES, true).kind).toBe('normal');
  });
  it('会晤中 normal: 对当前对象说话「徐诗雨你还是那么丰满」', () => {
    expect(EntityMeeting.detectIntent('徐诗雨你还是那么丰满', NAMES, true).kind).toBe('normal');
  });
  it('会晤中 wake 仍识别: 找熊梓铭聊聊（明确切换）', () => {
    expect(EntityMeeting.detectIntent('找熊梓铭聊聊', NAMES, true)).toEqual({ kind: 'wake', targets: ['熊梓铭'] });
  });
  it('玉瑶态 wake 不变: 熊梓铭不在家真好', () => {
    expect(EntityMeeting.detectIntent('熊梓铭不在家真好', NAMES, false).kind).toBe('wake');
  });
});
