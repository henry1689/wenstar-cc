/**
 * 知识入库契约一致性 + 失败可见性守卫（🔴 2026-09-23，B 阶段）
 *
 * 背景（实测）：
 *  1) 契约不一致：`CABINET_MAP` 把 `text` 映射到 docs 文件夹（视为可入库），
 *     但 `SourceTypePolicy.FILE_SOURCE_TYPES` 里只有 `txt` 没有 `text`
 *     ⇒ 传 `text` 的知识被 `KnowledgeEngine.add()` 直接 throw（实测历史拦截 78 次）。
 *  2) 失败被静默吞掉：`spec_loader` 每章节 catch 后无计数、无日志
 *     ⇒ 实测日志出现 59 次 `[SpecLoader] ✓ tianquan: 0/8 章节入库`（全部被拒仍报成功）。
 *
 * 本测试锁定：
 *  - `text` 与 `CABINET_MAP` 的映射保持契约一致（可入库）；
 *  - `spec` 仍按既有产品决策归入 GARBAGE（**不擅自改变产品语义**，仅锁定现状以防误改）；
 *  - spec_loader 不得再出现「无计数、无日志」的静默吞掉。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FILE_SOURCE_TYPES,
  GARBAGE_SOURCE_TYPES,
  isAllowedForAdd,
} from '../SourceTypePolicy.js';

describe('知识入库契约一致性（SourceTypePolicy）', () => {
  it('text 与 CABINET_MAP 映射一致：应允许入库（否则契约自相矛盾）', () => {
    expect(FILE_SOURCE_TYPES.has('text')).toBe(true);
    expect(isAllowedForAdd('text')).toBe(true);
  });

  it('txt/md 等文件类型仍可入库（不得回归）', () => {
    for (const t of ['md', 'txt', 'pdf', 'json']) {
      expect(isAllowedForAdd(t)).toBe(true);
    }
  });

  it('spec 维持既有产品决策（GARBAGE 永久排除）——锁定现状，改变须先经用户裁决', () => {
    expect(GARBAGE_SOURCE_TYPES.has('spec')).toBe(true);
    expect(isAllowedForAdd('spec')).toBe(false);
  });
});

describe('spec_loader 失败可见性', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/tianquan-rpc/spec_loader.ts'), 'utf-8');

  it('不得存在无计数、无日志的静默吞掉', () => {
    expect(SRC).not.toMatch(/skip individual failures/);
  });

  it('必须有失败计数与告警（首个原因 + 汇总）', () => {
    expect(SRC).toMatch(/let failed = 0/);
    expect(SRC).toMatch(/firstError/);
    expect(SRC).toMatch(/章节入库失败/);
  });
});
