import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';

/**
 * [A1 / 2026-10-06] 亲属称谓必须**绑定到人**，不得扫全文
 * ==================================================
 * 业主实测并定性：「徐诗雨对自己不是很了解，更不了解她的家族」——
 *   不是人设问题，是**系统收集对话信息时不严谨导致的错误记录**。
 *   并且明确要求：「不要把对话亲密情趣互动的称呼作为正式档案记录，
 *   这个错误很严重，很容易把档案搞乱」。
 *
 * 原实现（`FamilyGraph.integrateFromEntity` 的 persons 循环内）：
 *   const kinshipWord = Object.keys(KINSHIP_MAP).find((kw) => rawInput.includes(kw));
 * ——在**整条消息**里找任意称谓词，却跑在 `for (const person of persons)` 循环里
 * ⇒「消息里出现『爸爸』二字，这条消息提到的**每个人**都拿到 relation_to_user=爸爸」，
 *   称谓与人对不上。情趣互动时用户说含「爸爸」的话，正式档案即被写入父亲关系。
 *
 * ⚠️ 这与 V35-A 修的「用『文本里有没有出现名字』判断这轮是谁说的」是**同族错误**：
 *   拿文本内容当事实判据。
 *
 * 本测试锁住收窄后的**两条合法来源**（都与人绑定）：
 *   ① person 自身的名字就是称谓词（占位节点）
 *   ② 名字命中**显式声明**抽取（`我${称谓}叫XXX`）
 * 以及最重要的一条：**没有绑定的称谓词不得产生任何正式关系**。
 */

const DB = join('D:/tmp', `__a1_kinship_test_${process.pid}.db`);

const gene = (name: string): any => ({
  name, type: 'person', allele: name, phenotype: 'neutral', knowledge_type: 'factual',
});

async function freshFg(): Promise<any> {
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  return fg;
}

const relOf = (fg: any, name: string): string => {
  const p = fg.getPersonProfile?.(name);
  return String(p?.relation_to_user ?? '');
};

describe('[A1] 称谓必须绑定到人 —— 不得扫全文', () => {
  beforeEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 清理失败不阻塞 */ } });
  afterEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 同上 */ } });

  it('🔴 核心：消息含「爸爸」但未绑定到任何人 ⇒ 不得写入任何正式关系', async () => {
    const fg = await freshFg();
    // 模拟情趣互动语境：用户说了含「爸爸」的话，消息里同时提到一个人名
    await fg.integrateFromEntity([gene('徐诗雨')], '叫爸爸，乖一点', '我');

    expect(
      relOf(fg, '徐诗雨'),
      '🔴 未绑定的称谓被当成了正式关系 —— 这正是「档案被搞乱」的路径',
    ).not.toContain('爸爸');
    expect(relOf(fg, '徐诗雨')).not.toContain('父亲');
  });

  it('✅ 显式声明（我爸爸叫徐东伟）⇒ 关系成立且只落在被绑定的那个人身上', async () => {
    const fg = await freshFg();
    await fg.integrateFromEntity([gene('徐东伟'), gene('徐诗雨')], '我爸爸叫徐东伟', '我');

    expect(relOf(fg, '徐东伟'), '显式声明的正常流程不得被误伤').toMatch(/爸爸|父亲/);
    expect(
      relOf(fg, '徐诗雨'),
      '🔴 同一条消息里的**其他人**也被写上了父亲关系 —— 称谓没绑定到人',
    ).not.toMatch(/爸爸|父亲/);
  });

  it('✅ 占位节点（人名本身就是称谓词）⇒ 关系逻辑仍成立', async () => {
    const fg = await freshFg();
    const r: any = await fg.integrateFromEntity([gene('爸爸')], '爸爸今天去医院了', '我');
    // 说明：占位节点「爸爸」建关系后会被**垃圾实体守卫**挡在库外（实测 getPersonProfile 返回 null），
    //   故这里断言**操作日志**而非最终档案 —— 断言的是「关系逻辑对被绑定的称谓是否成立」。
    expect(JSON.stringify(r.details), '人名自身即称谓 ⇒ 应建立父子关系')
      .toMatch(/爸爸.*(father_of|父亲)/);
  });

  it('🔴 无称谓词的消息不得产生任何关系（回归：不能被改宽）', async () => {
    const fg = await freshFg();
    await fg.integrateFromEntity([gene('张三')], '今天天气不错，张三在写代码', '我');
    expect(relOf(fg, '张三')).not.toMatch(/爸爸|母亲|姐姐|哥哥|爷爷/);
  });
});
