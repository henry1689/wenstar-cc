// FG 人物写入准入：显式介绍线索判据的回归测试
// ============================================================
// 背景（2026-11-07 业主指出）：观察区近 30 天新增 1820 个 category='G' 的人名垃圾，
//   根因是 integrateFromEntity 对每个 person 实体无条件建节点（注释原文「所有人名都入库」），
//   而 M1 滑窗切出的字面串（全芬倒 / 阿珍叫 / 东坑差 / 水乳交）与真实姓名在字面上不可分。
// 修复：未入库的人名必须带「显式介绍」线索（叫/朋友/老师/称谓…）才建节点。
// 本测试锁住该判据：真实介绍放行、滑窗碎片拦截。
import { describe, it, expect } from 'vitest';
import { hasExplicitPersonIntro } from '../FamilyGraph.js';

describe('hasExplicitPersonIntro — FG 人名准入', () => {
  it('显式介绍放行', () => {
    expect(hasExplicitPersonIntro('我朋友小明，在深圳上班', '小明')).toBe(true);
    expect(hasExplicitPersonIntro('她叫诗雨', '诗雨')).toBe(true);
    expect(hasExplicitPersonIntro('介绍一下，这是王医生', '王医生')).toBe(true);
    expect(hasExplicitPersonIntro('张老师今天没来', '张老师')).toBe(true);
    expect(hasExplicitPersonIntro('这是我同事罗珍思', '罗珍思')).toBe(true);
  });

  it('滑窗碎片拦截（无任何介绍线索）', () => {
    expect(hasExplicitPersonIntro('全芬倒在地上', '全芬倒')).toBe(false);
    expect(hasExplicitPersonIntro('东坑那边很远', '东坑')).toBe(false);
    expect(hasExplicitPersonIntro('水乳交融的夜晚', '水乳交')).toBe(false);
    expect(hasExplicitPersonIntro('阿珍继继续聊了下去', '阿珍继')).toBe(false);
  });

  it('名字不在文本中 → 拒绝', () => {
    expect(hasExplicitPersonIntro('今天天气不错', '诗雨')).toBe(false);
  });

  it('线索必须落在名字附近窗口内（±10 字）', () => {
    const far = '朋友'.repeat(1) + '，'.repeat(30) + '全芬倒在地上';
    expect(hasExplicitPersonIntro(far, '全芬倒')).toBe(false);
  });
});
