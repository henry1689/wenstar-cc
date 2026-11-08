import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRoleSystemPrompt } from '../../../app/role/RoleProfiles.js';

/**
 * MEM-UNIFY-V1 批1 · 记忆表达法单一法源回归守卫
 * =================================================
 * 上位法：ADR-MEM-002 第五块（双模式义务）/ 第六块（结晶表达核心令）。
 * 判据：
 *   ① 法源模块必须具备三档 / 三重奏 / 憧憬自由 / 双模式义务 / 表达优先权；
 *   ② 运行时提示词文件不得再出现旧二元限制措辞（注释不算运行时文案，扫描前剥离）；
 *   ③ 核心调用点必须引用法源，不得另写第二套文案；
 *   ④ 静态正文黑名单必须已删除；
 *   ⑤ 会晤 recaller 不得含玉瑶身份。
 */

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** 剥离整行注释与块注释：历史注释允许保留旧措辞，运行时 prompt 才是扫描对象 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** 旧二元限制措辞（精确列表；只收记忆表达路径上真正会压制回忆的句子） */
const LEGACY_PHRASES = [
  '绝对禁止编造任何记忆中没有的细节',
  '禁止脑补、猜测、推测',
  '不要编造记忆中没有的细节',
  '记忆中没有的细节不要自己编造',
  '绝对不要编造任何回忆内容',
  '没写在知识库里的信息直接说不知道，绝对不能编造',
  '千万不要编造具体的时间、地点、人物或事件细节',
  '即使你的记忆、知识库或之前对话里提过，也不得使用',
  '原文中没有出现的人物、情节、数据、章节，一律不得提及或编造',
  '按原文顺序组织你的回答，原文没有的内容不得编造',
  '用自己的话概括，不得编造原文没有的内容',
  '不确定就说不记得',
  '不记得就说"不太记得了"',
  '宁可不答不可错答',
  '宁可说不知道，绝对不能自己编',
  '原文中没有的经历、人物、时间、地点、情节，一律不得提及或编造',
  '严格按原文顺序和内容复述，不得增删改、不得润色虚构',
  '你直接明确说没有/不知道/不记得就好',
  '就直接说真的不记得/没看过',
];

const EXPRESSION_FILES = [
  'src/m5/prompts/core-rules.ts',
  'src/engine/cortex/prompts/rules.ts',
  'src/app/role/RoleProfiles.ts',
  'src/app/conversation/MemoryGate.ts',
  'src/webui/chat.ts',
  'src/webui/chat/retrieval-stage.ts',
  'src/webui/chat/long-text-retrieval.ts',
  'src/m4/MemoryInjector.ts',
  'src/m4/retrieval/adapters/MeetingWallAdapter.ts',
  'src/app/knowledge/KnowledgeContextBuilder.ts',
];

describe('MEMORY-LAW-V1 · 单一法源能力断言', () => {
  const law = read('src/m5/prompts/memory-expression-law.ts');

  it('法源含三档 / 三重奏 / 憧憬自由 / 双模式义务 / 表达优先权', () => {
    expect(law).toContain('MEMORY-LAW-V1');
    expect(law).toContain('【记得】');
    expect(law).toContain('【印象】');
    expect(law).toContain('【线索】');
    expect(law).toContain('这叫回忆，不叫编造');
    expect(law).toContain('三重奏');
    expect(law).toContain('回味');
    expect(law).toContain('叠加');
    expect(law).toContain('憧憬');
    expect(law).toContain('主动义务');
    expect(law).toContain('深度应答义务');
    expect(law).toContain('宁可带标记地满，不可无标记地空');
    expect(law).toContain('不受要素集边界约束');
  });

  it('法源是纯常量/纯函数模块（无副作用、无外部依赖）', () => {
    expect(law).not.toMatch(/^import\s/m);
    expect(law).not.toMatch(/\bconsole\./);
  });
});

describe('MEMORY-LAW-V1 · 旧措辞静态扫描 0 命中', () => {
  for (const file of EXPRESSION_FILES) {
    it(`${file} 不含旧二元限制措辞`, () => {
      const src = stripComments(read(file));
      const hits = LEGACY_PHRASES.filter(p => src.includes(p));
      expect(hits, `${file} 仍含旧措辞: ${hits.join(' | ')}`).toEqual([]);
    });
  }
});

describe('MEMORY-LAW-V1 · 核心调用点必须引用法源', () => {
  it('core-rules 引用 MEMORY_LAW_CORE', () => {
    expect(read('src/m5/prompts/core-rules.ts')).toContain('MEMORY_LAW_CORE');
  });

  it('cortex/rules 引用 MEMORY_LAW_COMPACT', () => {
    expect(read('src/engine/cortex/prompts/rules.ts')).toContain('MEMORY_LAW_COMPACT');
  });

  it('RoleProfiles 引用 MEMORY_LAW_COMPACT 且 recaller 改为记忆陪伴者', () => {
    const src = read('src/app/role/RoleProfiles.ts');
    expect(src).toContain('MEMORY_LAW_COMPACT');
    expect(src).toContain('记忆陪伴者');
  });

  it('MemoryGate 使用三档解析与法源文案', () => {
    const src = read('src/app/conversation/MemoryGate.ts');
    expect(src).toContain('resolveMemoryTier');
    expect(src).toContain('MEMORY_LAW_TIERS');
  });

  it('chat.ts 引用 CORE / FOLLOWUP / FACTUAL_SLOT_LAW', () => {
    const src = read('src/webui/chat.ts');
    expect(src).toContain('MEMORY_LAW_CORE');
    expect(src).toContain('MEMORY_LAW_FOLLOWUP');
    expect(src).toContain('FACTUAL_SLOT_LAW');
  });

  it('长文/档案使用法源锚点规则', () => {
    const src = read('src/webui/chat/long-text-retrieval.ts');
    expect(src).toContain('buildDialogArchiveRule');
    expect(src).toContain('buildKnowledgeArchiveRule');
  });

  it('知识线索使用法源线索提示', () => {
    const src = read('src/app/knowledge/KnowledgeContextBuilder.ts');
    expect(src).toContain('buildCluePrompt');
    expect(src).toContain('buildClueRecall');
  });
});

describe('MEMORY-LAW-V1 · 静态正文黑名单已删除', () => {
  for (const file of [
    'src/m4/MemoryInjector.ts',
    'src/webui/chat/retrieval-stage.ts',
    'src/m4/retrieval/adapters/MeetingWallAdapter.ts',
  ]) {
    it(`${file} 不含 FABRICATION_PATTERNS`, () => {
      expect(read(file)).not.toContain('FABRICATION_PATTERNS');
    });
  }
});

describe('MEMORY-LAW-V1 · 会晤身份隔离', () => {
  it('会晤 recaller 角色 prompt 不含玉瑶', () => {
    const prompt = buildRoleSystemPrompt('recaller', 0, undefined, true);
    expect(prompt.includes('玉瑶')).toBe(false);
    expect(prompt).not.toContain('记忆助手');
  });
});
