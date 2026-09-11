import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ServerLock, requireUnlock } from '../ServerLock.js';

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
    expect(info.host).toBe(require('os').hostname());
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
    // 同一进程的 ServerLock 实例应被允许
    expect(() => requireUnlock(lock, '测试操作')).not.toThrow();
  });

  it('requireUnlock 在无锁时应放行', () => {
    expect(() => requireUnlock(null, '测试操作')).not.toThrow();
  });

  it('requireUnlock 应拒绝外部进程（模拟不同 PID）', () => {
    mkdirSync(lockDir, { recursive: true });
    const lock = new ServerLock(lockPath);
    lock.acquire();
    // 修改锁文件为不同 PID
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    info.pid = 99999;
    writeFileSync(lockPath, JSON.stringify(info));
    // 其他进程的 ServerLock 实例应被拒绝
    const otherLock = new ServerLock(lockPath);
    expect(() => requireUnlock(otherLock, '测试操作')).toThrow(/服务正在运行/);
  });
});
