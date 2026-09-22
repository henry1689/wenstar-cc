/**
 * M4 延迟守卫（2026-09-22）：PAE 的 LLM 档案提取**不得内联阻塞对话主链**
 *
 * 实测（M4·timing 分段）：
 * ```
 * total= 1827ms | integrateFG=  569   ← 常态
 * total=20874ms | integrateFG=19774   ← 慢时（10–20 秒）
 * ```
 * 根因：`FamilyGraph.integrateFromEntity` 内 `await this.extractProfileFromText(...)`
 * —— PAE 的 LLM 提取（超时 30s；成功时单次 10–20s）被内联等待 ⇒ 整个回复栈在等一次**档案富化**。
 * 而 `src/webui/chat/dialog-group-stage.ts:260` 一直是 fire-and-forget（`.catch(()=>{})`，不 await）。
 *
 * 本守卫盯住两条硬约束：
 * 1. `FamilyGraph` 里**不得**出现 `await this.extractProfileFromText(`（内联阻塞）；
 * 2. 必须保留 fire-and-forget + catch（失败可见、不产生未捕获拒绝）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'FamilyGraph.ts'), 'utf-8');

describe('M4 延迟守卫（PAE 提取不得阻塞对话主链）', () => {
  it('不得内联 await PAE 档案提取（慢时 integrateFG 10–20s 的根因）', () => {
    const bad = SRC.match(/await\s+this\.extractProfileFromText\(/g) ?? [];
    expect(bad.length, `FamilyGraph 仍有 ${bad.length} 处内联 await extractProfileFromText`).toBe(0);
  });

  it('必须为 fire-and-forget 且带 catch（失败可见、无未捕获拒绝）', () => {
    const ff = SRC.match(/void\s+this\.extractProfileFromText\(/g) ?? [];
    expect(ff.length, '应至少 2 处（两个实体集成分支）').toBeGreaterThanOrEqual(2);
    expect(SRC, '必须带 catch 告警').toContain('PAE 档案提取失败(非阻塞');
  });
});
