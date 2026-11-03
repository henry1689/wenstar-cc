/**
 * seqpos-allocation.test.ts — seq_pos 分配语义契约（2026-10-30，业主批准）
 * ============================================================
 * 被守的缺陷：
 *
 *   `memories.seq_pos` 有三个消费者：
 *     · user 对话行      （persistence-stage，用 reserveNextSeq() 的返回值）
 *     · assistant 对话行 （persistence-stage，用返回值 + 1）
 *     · evt 巩固行       （WorkingMemory，原实现复用了 user 的同一个号）
 *
 *   而 `reserveNextSeq()` 每轮只预留 2 个号 ⇒ **三个消费者抢两个号**，必然相撞。
 *   实测：`❌ writeMemory 失败 … UNIQUE constraint failed: memories.seq_pos` 与
 *        「用户轮未落库」一一对应 —— 用户说的话**整条没进库**。
 *
 * 修复：
 *   ① reserveNextSeq 每轮发 3 个**连续空号**（user / assistant / evt）；
 *   ② chat.ts 把 `seqPos + 2` 传给 WorkingMemory；
 *   ③ writeMemory 增加占用预检（撞号即改分配 MAX+1）—— 防御层，保证任何发号 Bug
 *      都不会演变成数据丢失。
 *
 * 本文件用桩 isSeqPosTaken 驱动分配器，不加载真实库、不写盘。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FusionStorageAdapter } from '../FusionStorageAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 构造一个只暴露 isSeqPosTaken 的桩存储，可指定「已占用」的号 */
function makeAllocator(start: number, taken: number[] = []) {
  const a = new FusionStorageAdapter('D:/tmp/__unused_seqpos_test.db') as unknown as {
    seqCounter: number;
    ensureReady: () => void;
    sqlite: { isSeqPosTaken: (p: number) => boolean };
    reserveNextSeq: () => number;
  };
  a.ensureReady = () => {};              // 不初始化真实库
  a.seqCounter = start;
  a.sqlite = { isSeqPosTaken: (p: number) => taken.includes(p) };
  return a;
}

describe('S1 每轮预留三个连续空号', () => {
  it('无占用时：首次返回 N+1，下次返回 N+4（游标推进 3）', () => {
    const a = makeAllocator(100);
    expect(a.reserveNextSeq()).toBe(101);
    expect(a.reserveNextSeq()).toBe(104);
  });

  it('三个号必须全部空闲才发（user/assistant/evt 各有独立号）', () => {
    const a = makeAllocator(100);
    const user = a.reserveNextSeq();
    expect(a.sqlite.isSeqPosTaken(user)).toBe(false);
    expect(a.sqlite.isSeqPosTaken(user + 1)).toBe(false);
    expect(a.sqlite.isSeqPosTaken(user + 2)).toBe(false);
  });
});

describe('S2 遇到已占用号必须跳过整段', () => {
  it('101 已占用 → 从 102 起发（不得发 101，也不得让 102/103 与它重叠）', () => {
    const a = makeAllocator(100, [101]);
    expect(a.reserveNextSeq()).toBe(102);
  });

  it('102 已占用 → 整段后移，user 号不得等于 100/101/102 中的任何一个', () => {
    const a = makeAllocator(100, [102]);
    const user = a.reserveNextSeq();
    expect([100, 101, 102]).not.toContain(user);
    expect([100, 101, 102]).not.toContain(user + 1);
    expect([100, 101, 102]).not.toContain(user + 2);
  });
});

describe('S3 接线与防御层（结构性断言，防被改回两号）', () => {
  const chatSrc = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');
  const adapterSrc = readFileSync(join(REPO, 'src', 'm2', 'SQLiteAdapter.ts'), 'utf8');
  const fusionSrc = readFileSync(join(REPO, 'src', 'm2', 'FusionStorageAdapter.ts'), 'utf8');

  it('WorkingMemory 必须收到 seqPos + 2（evt 行不得复用 user 的号）', () => {
    expect(chatSrc).toMatch(/workingMemory\.push\(dna,\s*p,\s*seqPos \+ 2/);
  });

  it('reserveNextSeq 必须校验连续三个号', () => {
    expect(fusionSrc).toMatch(/_free\(pos\) && _free\(pos \+ 1\) && _free\(pos \+ 2\)/);
    expect(fusionSrc).toMatch(/this\.seqCounter = pos \+ 2/);
  });

  it('writeMemory 必须有占用预检（撞号改分配，绝不丢写）', () => {
    expect(adapterSrc).toMatch(/writeMemory seq_pos=\$\{opts\.seqPos\} 已被占用/);
    expect(adapterSrc).toMatch(/opts\.seqPos = _next/);
  });
});