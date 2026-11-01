/**
 * backfill-criterion.test — S3-B6 回捞**命中判据集合**回归守卫
 * ============================================================
 * 为什么要有这个文件：
 *   同一个 bug 在 2026-10-28 出现了**两次**，两次都无测试保护 ——
 *     · §7.1 召回覆盖率：`ranked.slice(0, RERANK_TOP_K)` 冒充「候选集」
 *     · S3-B6 命中判据：`scoreAndRank(hits, nowMs).slice(0, topK)` 冒充「精排结果集」
 *   两次都是把**生产注入量截断**当成了**召回判据集合**。
 *   症状高度隐蔽：命中率只是「少几条」，不会报错、不会为 0，
 *   极易被误判成「新链路能力不足」而误去改召回算法甚至删数据。
 *
 * 🔴 本文件守的是**判据集合的边界**，不是召回算法本身。
 *
 * 【红线对应】
 *   红线 2：按 id 逐条核，非抽样
 *   红线 3：判据 = 出现在新链路的**精排结果集**里（全集，非 top-K）
 *   红线 14：无归属 ⇒ 无法形成白名单 ⇒ 不计命中，也不静默丢弃
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKFILL = resolve(HERE, '..', 'Backfill.ts');

const src = readFileSync(BACKFILL, 'utf-8');

/** 剥掉块注释与行注释，避免历史说明里的字面量误伤结构断言 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

const code = stripComments(src);

describe('S3-B6 命中判据集合（结构守卫）', () => {
  it('判据不得对精排结果做 top-K 截断', () => {
    expect(code).not.toMatch(/scoreAndRank\s*\([^)]*\)\s*\.slice\s*\(/);
    expect(code).not.toMatch(/const\s+ranked\s*=[^;]*\.slice\s*\(/);
  });

  it('判据必须是「存在于精排结果集」而非「排名 < topK」', () => {
    expect(src).toMatch(/ranked\.some\(\(h\)\s*=>\s*h\.id\s*===\s*id\)/);
    // 反面模式：按名次比较（一旦出现说明判据又被改回截断思路）
    expect(code).not.toMatch(/rankIdx\s*<\s*topK/);
    expect(code).not.toMatch(/ranked\.findIndex/);
  });

  it('topK 只允许用于围栏候选池大小，不参与判定', () => {
    expect(code).toMatch(/limit:\s*Math\.max\(topK\s*\*\s*10,\s*200\)/);
    // 判定语句所在的行不得出现 topK
    const judgeLine = code.split('\n').find((l) => /ranked\.some\(/.test(l)) ?? '';
    expect(judgeLine).not.toMatch(/\btopK\b/);
  });
});

describe('S3-B6 判据语义（红线对应）', () => {
  it('竣工判据仍是 hit === checked，未被放宽（红线：不伪造命中）', () => {
    expect(src).toMatch(/ok:\s*picked\.length\s*>\s*0\s*&&\s*checked\s*>\s*0\s*&&\s*hit\s*===\s*checked/);
  });

  it('无归属行计入 no_uuid_scope 并 continue，不落入命中分支（红线 14）', () => {
    const i = src.indexOf('report.no_uuid_scope++');
    expect(i).toBeGreaterThan(0);
    const block = src.slice(i, i + 120);
    expect(block).toMatch(/report\.no_uuid_scope\+\+[\s\S]{0,80}report\.checked\+\+[\s\S]{0,40}continue/);
    // no_uuid_scope 之后不得出现 hit++（否则无归属会被计成命中）
    expect(block).not.toMatch(/hit\+\+/);
  });

  it('判据仍走 recallByStructured 的 conversation 域', () => {
    expect(src).toMatch(/domain:\s*'conversation'/);
    expect(src).toMatch(/await\s+recallByStructured\(/);
  });

  it('红线 3 的判据定义在文件头有明文，代码与文档一致', () => {
    const head = src.slice(0, src.indexOf('import '));
    expect(head).toMatch(/判据集合\s*=\s*精排结果集/);
  });

  it('台账仍只读（红线 1）：本文件不得出现对台账的写路径', () => {
    expect(code).not.toMatch(/writeFileSync\s*\(\s*LEDGER_FILE/);
    expect(code).not.toMatch(/appendFileSync\s*\(\s*LEDGER_FILE/);
    expect(src).toMatch(/readFileSync\(LEDGER_FILE/);
  });
});
