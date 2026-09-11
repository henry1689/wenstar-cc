import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ServerLock, requireUnlock, readLockInfo, isServiceRunning } from '../ServerLock.js';

describe('ServerLock', () => {
  let lockDir: string;
  let lockPath: string;

  beforeEach(() => {
    lockDir = join(tmpdir(), `serverlock-test-${randomUUID()}`);
    lockPath = join(lockDir, 'server.lock');
  });

  afterEach(() => {
    try { unlinkSync(lockPath); } catch {}
    try { unlinkSync(lockDir); } catch {}
  });

  it('应创建锁文件并写入正确信息', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe(hostname());
    expect(info.startedAt).toBeDefined();
    expect(info.path).toBe(lockPath);
  });

  it('应检测到残留锁并清理', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, host: 'test', startedAt: '2024-01-01', path: lockPath }));
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
  });

  it('release 应删除锁文件', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('requireUnlock 应允许锁持有者自身写入', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(() => requireUnlock(lock, '测试操作')).not.toThrow();
  });

  it('requireUnlock 在无锁时应放行', () => {
    expect(() => requireUnlock(null, '测试操作')).not.toThrow();
  });

  it('requireUnlock 应拒绝外部进程（模拟不同 PID）', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    // 篡改锁文件为「其他存活进程」的 PID
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    info.pid = 99999;
    writeFileSync(lockPath, JSON.stringify(info));
    const otherLock = new ServerLock(lockPath);
    expect(() => requireUnlock(otherLock, '测试操作')).toThrow(/服务正在运行/);
  });

  it('readLockInfo 应读取锁内容（无锁返回 null）', () => {
    mkdirSync(lockDir, { recursive: true });
    expect(readLockInfo(lockPath)).toBeNull();
    const lock = new ServerLock(lockPath);
    lock.acquire();
    const info = readLockInfo(lockPath);
    expect(info).not.toBeNull();
    expect(info?.pid).toBe(process.pid);
  });

  it('readLockInfo 对损坏 JSON 应返回 null（fail-safe）', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '{ 这不是合法 JSON');
    expect(readLockInfo(lockPath)).toBeNull();
  });

  it('isServiceRunning 应识别本进程持有的锁', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(isServiceRunning(lockPath)).toBe(true);
  });

  it('isServiceRunning 对残留锁（持有进程已死）返回 false', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, host: 'test', startedAt: '2024-01-01', path: lockPath }));
    expect(isServiceRunning(lockPath)).toBe(false);
  });

  it('isServiceRunning 无锁文件时返回 false', () => {
    expect(isServiceRunning(lockPath)).toBe(false);
  });

  it('isOwnedBySelf 应正确判定锁归属', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(lock.isOwnedBySelf()).toBe(true);
    // 篡改为其他 PID 后不再归属自己
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    info.pid = 99999;
    writeFileSync(lockPath, JSON.stringify(info));
    expect(lock.isOwnedBySelf()).toBe(false);
  });
});
