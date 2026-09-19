/**
 * 受控的「复制真实库」入口（测试用）—— 消除 torn read 引发的红绿不定
 *
 * ## 为什么需要
 * 测试在**生产服务运行中**复制 200MB+ 的库时，服务可能正在做 sql.js 全量导出
 * （`export → tmp → fsync → rename`）。裸 `copyFileSync(真库, tmp)` 会复制到
 * **半写文件**（torn read）⇒ 夹具打开失败或读到不一致状态 ⇒ 同一个测试
 * 时红时绿（实测：`candidate-zone.test.ts` 混跑红、单跑绿）。
 *
 * ## 契约（fail-closed，绝不静默）
 * 复制 → 校验（SQLite 魔数 + 页大小合法 + 文件长度为页大小整数倍）→ 失败重试 N 次
 * → **仍失败则抛错**。绝不返回"看起来能打开"的坏夹具，更不静默跳过
 * （静默跳过 = 假绿，是比测试红更危险的状态）。
 *
 * ## 用法
 * ```ts
 * const copied = await copyRealDbForTest(FG_SRC, { prefix: 'v27b12-candidate-' });
 * try { ...用 copied.path... } finally { cleanupSafeDbCopy(copied.dir); }
 * ```
 */
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** SQLite 文件头魔数（16 字节） */
const SQLITE_MAGIC = 'SQLite format 3\0';
/** 合法的页大小（2 的幂，512..65536） */
const MIN_PAGE = 512;
const MAX_PAGE = 65536;

export interface SafeDbCopyOptions {
  /** 临时目录前缀（便于失败时定位来源，默认 `safe-db-copy-`） */
  prefix?: string;
  /** 复制尝试次数（含首次），默认 5 */
  attempts?: number;
  /** 首次退避毫秒（线性递增：120, 240, 360…），默认 120 */
  backoffMs?: number;
}

export interface SafeDbCopyResult {
  /** 已通过校验的副本路径 */
  path: string;
  /** 临时目录（调用方负责清理，见 `cleanupSafeDbCopy`） */
  dir: string;
  /** 实际尝试次数（1 = 首次即通过） */
  attemptsUsed: number;
  /** 复制时源库字节数（写入夹具元信息，便于日志排查） */
  sourceBytes: number;
}

export interface SqliteFileVerdict {
  ok: boolean;
  /** 判定失败的原因（ok=true 时为空串） */
  reason: string;
  /** 解析出的页大小（头不可读时为 0） */
  pageSize: number;
  /** 文件字节数 */
  bytes: number;
}

/** 读文件头 18 字节（魔数 16B + 页大小 2B；不足则返回空 Buffer） */
function readHeader(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(18);
    const n = readSync(fd, buf, 0, 18, 0);
    return n === 18 ? buf : Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * 判定一个文件是否是「结构完好」的 SQLite 文件。
 *
 * 只看头 + 页对齐，**不加载 sql.js**（依赖极轻、可被任意测试复用）。
 * 能被它识别出的典型 torn read：文件被截断在页中间（`bytes % pageSize !== 0`），
 * 这正是"复制运行中全量导出的库"最常见的坏形态。
 */
export function verifySqliteFile(file: string): SqliteFileVerdict {
  let bytes = 0;
  try {
    bytes = statSync(file).size;
  } catch (e) {
    return { ok: false, reason: `无法 stat：${(e as Error).message}`, pageSize: 0, bytes: 0 };
  }
  const head = readHeader(file);
  if (head.length < 18) {
    return { ok: false, reason: `文件头不足 18 字节（无法读出魔数 + 页大小）—— 截断`, pageSize: 0, bytes };
  }
  // 只比前 16 字节（head 是 18 字节：16B 魔数 + 2B 页大小）
  if (head.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    return { ok: false, reason: 'SQLite 魔数不匹配（不是 SQLite 文件或已被覆写）', pageSize: 0, bytes };
  }
  const pageSize = head.readUInt16BE(16);
  const legal = pageSize >= MIN_PAGE && pageSize <= MAX_PAGE && (pageSize & (pageSize - 1)) === 0;
  if (!legal) {
    return { ok: false, reason: `非法页大小 ${pageSize}（应为 512..65536 的 2 的幂）`, pageSize, bytes };
  }
  if (bytes <= 0 || bytes % pageSize !== 0) {
    return {
      ok: false,
      reason: `文件长度 ${bytes} 不是页大小 ${pageSize} 的整数倍 ⇒ 疑似截断（torn read）`,
      pageSize,
      bytes,
    };
  }
  return { ok: true, reason: '', pageSize, bytes };
}

/** 同步退避（测试夹具场景，简单即可） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 复制真实库到临时目录，并**校验 = 可用**才返回。
 * @throws 源库不存在，或连续 `attempts` 次复制/校验均失败（明确判定失败，不静默跳过）
 */
export async function copyRealDbForTest(src: string, opts: SafeDbCopyOptions = {}): Promise<SafeDbCopyResult> {
  const { prefix = 'safe-db-copy-', attempts = 5, backoffMs = 120 } = opts;
  if (!existsSync(src)) {
    throw new Error(`[safe-db-copy] 源库不存在：${src}`);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dst = join(dir, 'copy.db');
  let lastReason = '(未尝试)';
  for (let i = 1; i <= attempts; i++) {
    try {
      copyFileSync(src, dst);
      const verdict = verifySqliteFile(dst);
      if (verdict.ok) {
        return { path: dst, dir, attemptsUsed: i, sourceBytes: statSync(src).size };
      }
      lastReason = verdict.reason;
    } catch (e) {
      lastReason = (e as Error).message;
    }
    if (i < attempts) await sleep(backoffMs * i);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  throw new Error(
    `[safe-db-copy] 连续 ${attempts} 次复制／校验失败（源库可能正被服务全量导出）—— ` +
      `判定为**失败**而非静默跳过。源：${src}；最后原因：${lastReason}`,
  );
}

/** 清理临时目录（幂等，失败不抛） */
export function cleanupSafeDbCopy(dir: string): void {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
