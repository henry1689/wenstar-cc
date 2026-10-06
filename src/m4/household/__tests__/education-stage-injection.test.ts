import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../FamilyGraph.js';
import { buildEntityContext } from '../EntityContextBuilder.js';

/**
 * [A3 / 2026-10-06] 「学历」不得被当成「在读学段」注入
 * ====================================================
 * 原实现（EntityContextBuilder）：
 *   const _ed = String(basicInfo.education || '');            // ← 取的是「学历」
 *   if (… || _ed.includes('大学') || …) parts.push(`🎓 你是 **${_ed}**，日常是上课学习…`);
 * ⇒ 已毕业的成年人得到「🎓 你是 **大学**，日常是上课学习，不是上班族。」——
 *   语法不通（"你是大学"）且概念错位（学历 ≠ 在读）。
 * 业主 2026-10-06 实测：徐诗雨 2008 年生、已在高峰电业做跟单员，却被告知"你是大学，日常上课"。
 *
 * 修复后的语义：
 *   · 在校生判据 = 显式「在读/学生」；或无职业记录且年龄落在在校区间（6~22）
 *   · 学段文案由年龄/在读推出并补「生」字（大学→大学生），不复用学历字段
 *   · 已就业 ⇒ **不注入**（不注入好过注入一句错话）
 */

const DB = join('D:/tmp', `__a3_edu_test_${process.pid}.db`);

const NOW_YEAR = new Date().getFullYear();

/** 直接落一个节点，properties 由测试完全掌控 */
function seedPerson(fg: any, name: string, props: Record<string, unknown>): void {
  fg.run(
    'INSERT INTO nodes (id, type, name, aliases, properties, created_at, updated_at, uuid) VALUES (?,?,?,?,?,?,?,?)',
    [`t-${name}`, 'person', name, '[]', JSON.stringify(props), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', `TXS-T-${name}`],
  );
}

async function freshFg(): Promise<any> {
  try { if (existsSync(DB)) rmSync(DB); } catch { /* 忽略 */ }
  const fg: any = new FamilyGraph(DB);
  await fg.initialize();
  return fg;
}

const ctxOf = (fg: any, name: string): string => String(buildEntityContext(fg, { entityName: name } as any).systemText ?? '');

describe('[A3] 学历 ≠ 在读学段', () => {
  afterEach(() => { try { if (existsSync(DB)) rmSync(DB); } catch { /* 忽略 */ } });

  it('🔴 已就业的成年人：学历含「大学」也不得注入「你是 大学，日常上课」', async () => {
    const fg = await freshFg();
    seedPerson(fg, '测试已就业者', {
      name: '测试已就业者',
      dossier: {
        basicInfo: { gender: '女', birthYear: 2008, education: '大学' },
        socialIdentity: { currentOccupation: '跟单员' },
      },
    });
    const text = ctxOf(fg, '测试已就业者');
    expect(text, '🔴 「学历」被当成了「在读学段」—— 产出「你是 大学，日常是上课学习」')
      .not.toMatch(/你是 \*\*大学\*\*/);
    expect(text, '已就业者不应收到「日常上课」的在校生指令').not.toContain('日常是上课学习');
  });

  it('✅ 无职业且年龄落在在校区间 ⇒ 注入且用学段名（不是学历字段）', async () => {
    const fg = await freshFg();
    seedPerson(fg, '测试小学生', {
      name: '测试小学生',
      dossier: { basicInfo: { gender: '女', birthYear: NOW_YEAR - 8, education: '' } },
    });
    const text = ctxOf(fg, '测试小学生');
    expect(text, '小学生应收到在校生指令').toContain('日常是上课学习');
    expect(text, '学段应为「小学生」，不是空学历').toContain('小学生');
  });

  it('✅ 显式「在读高中」⇒ 注入「高中生」，不含「在读」前缀残留', async () => {
    const fg = await freshFg();
    seedPerson(fg, '测试在读生', {
      name: '测试在读生',
      dossier: { basicInfo: { gender: '男', birthYear: NOW_YEAR - 17, education: '在读高中' } },
    });
    const text = ctxOf(fg, '测试在读生');
    expect(text).toContain('日常是上课学习');
    expect(text, '不应把「在读高中」原样当学段砸进去').not.toMatch(/你是 \*\*在读高中\*\*/);
    expect(text).toContain('高中生');
  });

  it('✅ 显式「在读大学」⇒ 补「生」字（大学→大学生）', async () => {
    const fg = await freshFg();
    seedPerson(fg, '测试在读大学生', {
      name: '测试在读大学生',
      dossier: { basicInfo: { gender: '女', birthYear: NOW_YEAR - 20, education: '在读大学' } },
    });
    const text = ctxOf(fg, '测试在读大学生');
    expect(text).toContain('日常是上课学习');
    expect(text).toContain('大学生');
  });

  it('🔴 成年人且无任何在校信号 ⇒ 不注入（宁可不注入，也不注入错话）', async () => {
    const fg = await freshFg();
    seedPerson(fg, '测试成年人', {
      name: '测试成年人',
      dossier: { basicInfo: { gender: '男', birthYear: NOW_YEAR - 35 } },
    });
    expect(ctxOf(fg, '测试成年人')).not.toContain('日常是上课学习');
  });
});
