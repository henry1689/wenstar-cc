import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P0-3b 回归守卫（2026-10-07）：**禁止按正文推断归属**。
 *
 * 被守的是什么：`SQLiteAdapter.initialize()` 的启动回填里曾有四段按「正文提及的人名」
 * 认领 `belong_entity_uuid` 的 SQL：
 *   ① conversations 全文匹配   content LIKE '%名字%'
 *   ② conversations 自称检测   content LIKE '%我是名字%' / '%名字来了%' …
 *   ③ memories 从会话传导      content LIKE '%' || substr(raw_input,1,30) || '%'
 *   ④ roleplay 直接匹配        raw_input LIKE '%' || e.name || '%'
 *
 * 为什么必须守：《P0 记忆体系止血任务书 V3》§3.1 **分类禁止**（其实测：166 条里 142 条根本不提
 * 人名；全表 **29.2%** 的已归属记忆正文提到的是别人）。P0-3 的回滚演练实测了危害 ——
 * 清洗刚把 24 条置 NULL，**服务一重启就被这条回填认领了 22 条**，用结构列对照后发现 **2 条认错**
 * （「熊勇 vs 同事/玉瑶」「徐诗雨 vs 徐诗韵」姐妹串档），误认率 9.1%。
 * ⇒ 只要它回来，V3 §3.1 的「关联不上保持 NULL」就再次不可达。
 *
 * 断言策略：扫源码而非跑行为 —— 因为要防的正是"日后有人顺手加回这段 SQL"，
 * 而它在启动期才执行，行为测试（需起整库）成本高得多。
 * 🔴 **先剥注释再扫**：SQLiteAdapter 的注释里刻意保留了被删模式的原文供追溯，
 *    不剥注释会误报（这正是本守卫唯一的坑）。
 */

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'SQLiteAdapter.ts');
const RAW = readFileSync(SRC_PATH, 'utf8');

/** 剥离块注释与行注释后剩下可执行代码 */
const CODE = RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
  .replace(/(^|[^:])\/\/.*$/gm, '$1');// // ...（避开 http:// 之类，本文件无但留个安全边）

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: '① conversations 全文匹配（content LIKE %名字%）', re: /content\s+LIKE\s+'%\$\{_n\}%'/ },
  { name: '② conversations 自称检测（我是/我叫 名字）', re: /(我是|我叫|我就是)\$\{_n\}/ },
  { name: '② conversations 自称检测（名字来了/在呢）', re: /\$\{_n\}(来了|在呢)/ },
  { name: '③ memories 从会话传导（raw_input 前 30 字匹配）', re: /substr\(\s*memories\.raw_input\s*,\s*1\s*,\s*30\s*\)/ },
  { name: '④ roleplay 直接匹配（raw_input LIKE e.name）', re: /memories\.raw_input\s+LIKE\s+'%'\s*\|\|\s*e\.name/ },
];

describe('P0-3b · 禁止按正文推断归属（源码守卫）', () => {
  it('注释剥离本身有效（回归：防止守卫因剥注释失败而变空转）', () => {
    expect(CODE.length).toBeGreaterThan(RAW.length * 0.5);   // 剥完还剩大半
    expect(CODE).not.toContain('回归守卫：__tests__/no-text-inferred-belong');  // 该串在注释里
  });

  for (const f of FORBIDDEN) {
    it(`🔴 不得出现：${f.name}`, () => {
      const m = CODE.match(f.re);
      expect(m, `发现被禁模式 ${JSON.stringify(m?.[0])} —— V3 §3.1 分类禁止按正文推断归属`).toBeNull();
    });
  }

  it('⑤ 结构关联回填必须保留（black_diamond 走 source_id → memories.id，纯结构）', () => {
    expect(CODE).toMatch(/UPDATE black_diamond SET belong_entity_uuid\s*=\s*\(\s*SELECT m\.belong_entity_uuid FROM memories m/);
  });

  it('fg_entity_names 幂等派生必须保留（从 entity_genes 确定性派生，不碰文本）', () => {
    expect(CODE).toContain('fg_entity_names');
    expect(CODE).toMatch(/SELECT id, entity_genes FROM memories/);
  });

  it('SKIP_BACKFILL 总闸仍然存在（本批刻意不动它，只精确摘除四处文本判据）', () => {
    expect(CODE).toContain("SKIP_BACKFILL !== 'true'");
  });
});
