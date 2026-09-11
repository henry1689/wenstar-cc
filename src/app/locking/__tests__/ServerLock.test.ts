import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ServerLock,
  requireUnlock,
  readLockInfo,
  isServiceRunning,
  isProtectedDbPath,
  assertWriteAllowed,
} from '../ServerLock.js';

/** 生产库路径样本（仅字符串判定，不需要文件真实存在） */
const PROD_DB = 'D:/tools/wenstar-cc/data/webui/fusion_memory.db';

/** 启动一个存活若干毫秒的子进程，返回其 pid */
function spawnLiveProcess(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){},15000)'], {
    stdio: 'ignore',
  });
  return {
    pid: child.pid as number,
    kill: () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    },
  };
}

/** 等待子进程真正起来（pid 可被 kill(0) 探测到） */
async function waitForPid(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`子进程 ${pid} 未在 ${timeoutMs}ms 内就绪`);
}

describe('ServerLock', () => {
  let lockDir: string;
  let lockPath: string;

  beforeEach(() => {
    lockDir = join(tmpdir(), `serverlock-test-${randomUUID()}`);
    lockPath = join(lockDir, 'server.lock');
  });

  afterEach(() => {
    delete process.env.TIANQUAN_SKIP_SERVER_LOCK;
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

  it('requireUnlock 对残留锁（持有进程已崩溃）应放行', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, host: 'test', startedAt: '2024-01-01', path: lockPath }));
    expect(() => requireUnlock(new ServerLock(lockPath), '测试操作')).not.toThrow();
  });

  it('requireUnlock 应拒绝存活的外部进程', async () => {
    mkdirSync(lockDir, { recursive: true });
    const other = spawnLiveProcess();
    try {
      await waitForPid(other.pid);
      writeFileSync(lockPath, JSON.stringify({ pid: other.pid, host: hostname(), startedAt: 'now', path: lockPath }));
      expect(() => requireUnlock(new ServerLock(lockPath), '测试操作')).toThrow(/服务正在运行/);
    } finally {
      other.kill();
    }
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
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    info.pid = 99999;
    writeFileSync(lockPath, JSON.stringify(info));
    expect(lock.isOwnedBySelf()).toBe(false);
  });
});

describe('isProtectedDbPath', () => {
  it('应识别生产库路径（含 Windows 反斜杠/大小写变体）', () => {
    expect(isProtectedDbPath(PROD_DB)).toBe(true);
    expect(isProtectedDbPath('D:\\tools\\wenstar-cc\\data\\webui\\fusion_memory.db')).toBe(true);
    expect(isProtectedDbPath('D:/tools/wenstar-cc/Data/WebUI/Fusion_Memory.db')).toBe(true);
  });

  it('未接入守卫的库不应被声明为受保护（避免清单与代码不一致）', () => {
    // FamilyGraph 同样用 sql.js 整库覆写，但尚未接入 assertWriteAllowed → 不在清单
    expect(isProtectedDbPath('D:/tools/wenstar-cc/data/webui/knowledge/family_graph.db')).toBe(false);
  });

  it('测试/临时库路径不应受保护', () => {
    expect(isProtectedDbPath('/tmp/xxx/serverlock-test/fusion_memory.db')).toBe(false);
    expect(isProtectedDbPath('D:/tmp/backup/fusion_memory.db')).toBe(false);
    expect(isProtectedDbPath('C:/Users/x/AppData/Local/Temp/a/b.db')).toBe(false);
  });
});

describe('assertWriteAllowed（写入入口守卫）', () => {
  let lockDir: string;
  let lockPath: string;

  beforeEach(() => {
    lockDir = join(tmpdir(), `serverlock-guard-${randomUUID()}`);
    lockPath = join(lockDir, 'server.lock');
    mkdirSync(lockDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.TIANQUAN_SKIP_SERVER_LOCK;
    try { unlinkSync(lockPath); } catch {}
    try { unlinkSync(lockDir); } catch {}
  });

  it('非生产库一律放行（测试/临时库不受守卫影响）', () => {
    const tmpDb = join(tmpdir(), 'x', 'fusion_tmp.db');
    expect(() => assertWriteAllowed(tmpDb, 'op', lockPath)).not.toThrow();
  });

  it('生产库 + 无锁 → 放行', () => {
    expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).not.toThrow();
  });

  it('生产库 + 残留锁 → 放行（不阻断业务）', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, host: 'x', startedAt: 'old', path: lockPath }));
    expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).not.toThrow();
  });

  it('生产库 + 自身持锁 → 放行（服务自身写入）', () => {
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).not.toThrow();
    lock.release();
  });

  it('生产库 + 他人持锁 → 拒绝（核心保护）', async () => {
    const other = spawnLiveProcess();
    try {
      await waitForPid(other.pid);
      writeFileSync(lockPath, JSON.stringify({ pid: other.pid, host: hostname(), startedAt: 'now', path: lockPath }));
      expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).toThrow(/服务正在运行/);
    } finally {
      other.kill();
    }
  });

  it('应急开关 TIANQUAN_SKIP_SERVER_LOCK=1 → 放行', async () => {
    const other = spawnLiveProcess();
    try {
      await waitForPid(other.pid);
      writeFileSync(lockPath, JSON.stringify({ pid: other.pid, host: hostname(), startedAt: 'now', path: lockPath }));
      process.env.TIANQUAN_SKIP_SERVER_LOCK = '1';
      expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).not.toThrow();
    } finally {
      other.kill();
    }
  });

  it('他机锁（host 不匹配）→ 本机视为陈旧，放行', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999, host: 'some-other-host', startedAt: 'old', path: lockPath })
    );
    expect(() => assertWriteAllowed(PROD_DB, 'op', lockPath)).not.toThrow();
  });

  it('release 后不应误删后继实例的锁', () => {
    const lock = new ServerLock(lockPath);
    lock.acquire();
    // 模拟锁被后代实例接管（PID 变为他人）
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    info.pid = 99999;
    writeFileSync(lockPath, JSON.stringify(info));
    lock.release();
    // 锁仍应存在（未误删）
    expect(existsSync(lockPath)).toBe(true);
  });

  it('acquire 应清理他机陈旧锁并重建', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 12345, host: 'other-host', startedAt: 'old', path: lockPath })
    );
    const lock = new ServerLock(lockPath);
    lock.acquire();
    expect(lock.isOwnedBySelf()).toBe(true);
    lock.release();
  });
});
