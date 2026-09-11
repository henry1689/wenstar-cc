/**
 * ServerLock — 生产数据库写保护机制
 * ===================================
 * 问题：服务运行时用外部工具（better-sqlite3）直接改库，
 *       会被服务进程内 sql.js 的内存态整库 flush 覆盖（详见经验 #19）。
 * 方案：启动时创建 server.lock（记录真实写库进程 PID），外部写入前检测。
 *
 * 判定语义：
 *   - 服务进程自身持有锁 → requireUnlock 放行（lock.pid === process.pid）
 *   - 外部脚本/测试进程 → 锁存在且 PID 不同 → 拒绝写入
 *   - 无锁（服务未运行） → 放行，向后兼容
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 锁文件内容 */
export interface ServerLockInfo {
  /** 持有锁的进程 PID（真实写库进程，非监督进程） */
  pid: number;
  host: string;
  startedAt: string;
  /** 锁文件自身路径（便于诊断） */
  path: string;
  /** 监督进程 PID（start.cjs），仅诊断用 */
  supervisorPid?: number;
}

/** PID 是否存活 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读取锁文件内容（不存在/损坏返回 null） */
export function readLockInfo(lockPath: string): ServerLockInfo | null {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as ServerLockInfo;
    if (typeof parsed?.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 服务是否正在运行（锁存在 且 持有进程存活）
 * 外部写入方应以此为拒绝依据。
 */
export function isServiceRunning(lockPath: string): boolean {
  const info = readLockInfo(lockPath);
  return info !== null && isPidAlive(info.pid);
}

/** 服务器锁管理 */
export class ServerLock {
  readonly lockPath: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  private _acquired = false;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
    this.pid = process.pid;
    this.host = os.hostname();
    this.startedAt = new Date().toISOString();
  }

  /** 获取锁；自动清理残留锁（持有进程已终止） */
  acquire(): void {
    if (this._acquired) return;

    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const prev = readLockInfo(this.lockPath);
    if (prev) {
      if (isPidAlive(prev.pid)) {
        throw new Error(
          `服务已在运行 (PID ${prev.pid}, host ${prev.host}, 启动于 ${prev.startedAt})`
        );
      }
      // 持有进程已死 → 残留锁，清理后重建
      console.warn(`[ServerLock] 检测到残留锁 (PID ${prev.pid} 已终止)，清理后重建`);
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        /* 忽略：并发删除等竞态 */
      }
    }

    const lockData: ServerLockInfo = {
      pid: this.pid,
      host: this.host,
      startedAt: this.startedAt,
      path: this.lockPath,
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2), 'utf8');
    this._acquired = true;
    console.log(`[ServerLock] 已创建锁文件: ${this.lockPath}`);

    // 进程退出/中断时自动释放（unlinkSync 为同步操作，可在 exit 钩子安全调用）
    process.on('exit', () => this.release());
    process.on('SIGINT', () => {
      this.release();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.release();
      process.exit(0);
    });
  }

  /** 释放锁（幂等） */
  release(): void {
    if (!this._acquired) return;
    this._acquired = false;
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
        console.log(`[ServerLock] 已释放锁文件: ${this.lockPath}`);
      }
    } catch (e) {
      console.warn('[ServerLock] 释放锁失败:', (e as Error).message);
    }
  }

  /** 是否持锁（本实例已获取 或 锁文件存在） */
  isLocked(): boolean {
    return this._acquired || fs.existsSync(this.lockPath);
  }

  /** 读取锁信息 */
  getInfo(): ServerLockInfo | null {
    return readLockInfo(this.lockPath);
  }

  /** 锁是否属于本进程 */
  isOwnedBySelf(): boolean {
    const info = this.getInfo();
    return info !== null && info.pid === process.pid;
  }
}

/**
 * 写操作前准入检查。
 *
 * @param lock      ServerLock 实例（null → 视为无锁环境，放行）
 * @param operation 操作描述（用于错误信息）
 * @throws 当服务正在运行且调用者不是持锁进程时抛出
 */
export function requireUnlock(lock: ServerLock | null, operation = '数据库写入'): void {
  if (!lock || !lock.isLocked()) return; // 无锁 → 放行（向后兼容）

  const info = lock.getInfo();
  if (!info) return; // 锁文件损坏/竞态消失 → 放行，不阻断业务

  if (info.pid === process.pid) return; // 持锁进程自身写入放行

  throw new Error(
    `[ServerLock] 拒绝 ${operation}：服务正在运行 (PID ${info.pid}, host ${info.host})。\n` +
      `锁文件: ${info.path}\n` +
      `启动时间: ${info.startedAt}\n` +
      `原因：服务进程内 sql.js 持有整库内存态，外部写入会被 flush 覆写。\n` +
      `请先停止服务，或通过服务自身的 HTTP API 写入。`
  );
}
