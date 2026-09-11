/**
 * ServerLock — 生产数据库写保护机制
 * ===================================
 * 问题：服务运行时用外部工具（better-sqlite3 等）直接改库，
 *       会被服务进程内 sql.js 的内存态整库 flush 覆写（详见经验 #19）。
 * 方案：**由真正写库的进程自己**持有 server.lock，所有写入入口写前检查。
 *
 * 🔴 关键：锁必须由「真正执行 SQL 的进程」写入。
 *   进程树是 start.cjs(P0) → tsx CLI(P1) → node server.ts(P2)，写库的是 P2。
 *   若由 P0/P1 代写，P2 会判定「他人持锁」而被自己拒绝（服务无法启动）。
 *   因此 acquire() 只在 server 进程内调用（见 server.ts main()）。
 *
 * 判定语义（fail-open，锁是防护不是门禁）：
 *   - 无锁 / 锁文件损坏 / 残留锁（持有进程已死）→ 放行
 *   - 锁属于本进程 → 放行（服务自身写入）
 *   - 锁属于存活的他进程（同主机）→ 拒绝
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── 项目路径（src/app/locking/ → 上溯三级为项目根）──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 默认锁文件路径 */
export const DEFAULT_LOCK_PATH = path.join(PROJECT_ROOT, 'data', 'webui', 'server.lock');

/**
 * 受保护的生产库路径特征。
 *
 * ⚠️ 仅列出「已实际接入 assertWriteAllowed 检查」的库。
 *    `data/webui/knowledge/family_graph.db`（FamilyGraph 同样用 sql.js 整库覆写）
 *    尚未接入守卫，故不在此声明，避免「清单声称保护、代码不执行」。
 *    接入方式：在 FamilyGraph.initialize() 开头调用 assertWriteAllowed(this.dbPath, ...)。
 */
const PROTECTED_DB_PATTERNS = ['data/webui/fusion_memory.db'];

/**
 * 是否受保护的生产库。
 * 大小写不敏感（Windows 路径），测试用临时库返回 false → 不受守卫影响。
 */
export function isProtectedDbPath(dbPath: string): boolean {
  const n = String(dbPath).replace(/\\/g, '/').toLowerCase();
  return PROTECTED_DB_PATTERNS.some((p) => n.includes(p));
}

/** 锁文件内容 */
export interface ServerLockInfo {
  /** 持有锁的进程 PID（真正执行 SQL 的进程） */
  pid: number;
  host: string;
  startedAt: string;
  /** 锁文件自身路径（便于诊断） */
  path: string;
}

/**
 * PID 是否存活。
 *
 * 🔴 Windows 语义：libuv 用 OpenProcess 探测，进程存在但无权限（跨完整性级别/
 *    其他用户/受保护进程）返回 EPERM 而非 ESRCH。EPERM 必须视为**存活**，
 *    否则会把运行中的服务误判为已死 → 放行外部写入 → 整库覆写。
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 读取锁文件内容（不存在/损坏返回 null） */
export function readLockInfo(lockPath: string): ServerLockInfo | null {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as ServerLockInfo;
    if (typeof parsed?.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 锁是否代表「另一台主机上的运行实例」。
 * 跨主机（复制数据目录/共享盘）时本机 PID 判定无意义 → 视为陈旧。
 */
function isForeignHost(info: ServerLockInfo): boolean {
  return typeof info.host === 'string' && info.host !== os.hostname();
}

/**
 * 服务是否正在运行（本机、锁存在、持有进程存活）。
 * 外部写入方应以此为拒绝依据。
 */
export function isServiceRunning(lockPath: string): boolean {
  const info = readLockInfo(lockPath);
  if (!info) return false;
  if (isForeignHost(info)) return false; // 他机锁 → 本机视为陈旧
  return isPidAlive(info.pid);
}

/** 服务器锁管理（仅在真正写库的进程内 acquire） */
export class ServerLock {
  readonly lockPath: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  private _acquired = false;
  private _onExit: (() => void) | null = null;

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
    if (prev && !isForeignHost(prev) && isPidAlive(prev.pid)) {
      throw new Error(
        `服务已在运行 (PID ${prev.pid}, host ${prev.host}, 启动于 ${prev.startedAt})`
      );
    }
    if (prev) {
      // 残留锁 / 他机锁 → 清理后重建
      console.warn(
        `[ServerLock] 清理陈旧锁 (PID ${prev.pid}, host ${prev.host}, 启动于 ${prev.startedAt})`
      );
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
    // 原子写 + 并发启动防护：写临时文件后 rename，再回读校验归属。
    // 两个实例若在「检查存活」→「rename」窗口内交错，后写者会胜出；
    // 回读可让败方立即发现锁已属于他人（否则双方都会 _acquired=true）。
    const tmpPath = `${this.lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(lockData, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.lockPath);

    const check = readLockInfo(this.lockPath);
    if (!check || check.pid !== this.pid) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* rename 后已不存在 */
      }
      throw new Error(
        `锁被并发实例抢占 (当前持有者 PID ${check?.pid ?? 'unknown'}, host ${check?.host ?? 'unknown'})`
      );
    }

    this._acquired = true;
    console.log(`[ServerLock] 已持有锁 (PID ${this.pid}): ${this.lockPath}`);

    // 仅注册 exit：signal 处理交给服务层（避免抢占服务的优雅关停/落盘流程）
    this._onExit = () => this.release();
    process.on('exit', this._onExit);
  }

  /** 释放锁（幂等） */
  release(): void {
    if (!this._acquired) return;
    this._acquired = false;
    if (this._onExit) {
      process.off('exit', this._onExit);
      this._onExit = null;
    }
    try {
      // 仅当锁仍属于自己时才删除（防误删后继实例的锁）
      const info = readLockInfo(this.lockPath);
      if (info && info.pid === this.pid) {
        fs.unlinkSync(this.lockPath);
        console.log(`[ServerLock] 已释放锁 (PID ${this.pid})`);
      }
    } catch (e) {
      console.warn('[ServerLock] 释放锁失败:', (e as Error).message);
    }
  }

  /** 本实例是否已持锁 */
  isLocked(): boolean {
    return this._acquired;
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
 * @throws 当本机存在存活的他进程持锁时抛出
 */
export function requireUnlock(lock: ServerLock | null, operation = '数据库写入'): void {
  if (!lock) return; // 无锁对象 → 放行（向后兼容）

  const info = lock.getInfo();
  if (!info) return; // 无锁文件/损坏 → 放行，不阻断业务
  if (isForeignHost(info)) return; // 他机锁 → 放行
  if (!isPidAlive(info.pid)) return; // 残留锁（持有进程已崩溃）→ 放行
  if (info.pid === process.pid) return; // 持锁进程自身写入放行

  throw new Error(
    `[ServerLock] 拒绝 ${operation}：服务正在运行 (PID ${info.pid}, host ${info.host})。\n` +
      `锁文件: ${info.path}\n` +
      `启动时间: ${info.startedAt}\n` +
      `原因：服务进程内 sql.js 持有整库内存态，外部写入会被 flush 覆写。\n` +
      `请先停止服务，或通过服务自身的 HTTP API 写入。\n` +
      `应急放行: 设置环境变量 TIANQUAN_SKIP_SERVER_LOCK=1`
  );
}

/**
 * 写入入口守卫（供 SQLiteAdapter / FamilyGraph 等调用）。
 *
 * 放行条件：应急开关 / 非生产库 / 其余交由 requireUnlock 判定。
 *
 * @param dbPath    目标数据库路径
 * @param operation 操作描述（用于诊断）
 * @param lockPath  锁文件路径（默认生产锁；单测可传临时路径）
 */
export function assertWriteAllowed(
  dbPath: string,
  operation = '数据库写入',
  lockPath: string = DEFAULT_LOCK_PATH
): void {
  if (process.env.TIANQUAN_SKIP_SERVER_LOCK === '1') return; // 应急绕过
  if (!isProtectedDbPath(dbPath)) return; // 非生产库 → 不管
  requireUnlock(new ServerLock(lockPath), operation);
}
