/**
 * SqlJsCompat — sql.js API 兼容壳（底层 better-sqlite3）
 * =====================================================================
 * 背景（2026-11-06 存储底座迁移；业主批准「一次性做完、彻底治本」）：
 *   sql.js 把整库载入 WASM 内存，落盘靠 `db.export()` 把**整个内存库序列化**后覆盖磁盘文件。
 *   实测 126.5MB/次、1854~5155ms，同步占死主线程 ⇒ MemArch v2 的 8 条召回腿在 300ms
 *   预算内全部撞线，`withTimeout` 静默返回 []（切流恒返 0 的直接根因）；另有一轮对话触发
 *   19 次整库重写（224MB×19≈4.16GB），以及 229MB→3.9MB 的数据丢失事故。
 *
 *   本文件把「写盘 = 整库导出」这件事从系统里彻底移除：better-sqlite3 直接页级写文件，
 *   不存在导出这一步。
 *
 * 设计原则（换引擎，不换 API）：
 *   · 业务侧 651 处 `writeRaw/queryAll` 与 5 个 `rawDb` 外部消费者只用到
 *     `run / exec / prepare / getRowsModified / close` ⇒ 兼容壳只映射这几个方法，
 *     调用方零改动（这也是本次迁移风险可控的关键）。
 *   · **刻意不提供 export()**：任何漏删的整库导出调用都会在编译期报错，
 *     逼着把旧链路清理干净，而不是留一个能悄悄退回去的入口。
 *
 * 语义差异（已实测）：
 *   · better-sqlite3 的 `exec()` 返回 Database 对象而非结果集 ⇒ 本壳用
 *     `prepare().raw().all()` 重塑回 sql.js 的 `[{ columns, values }]` 形态。
 *   · 多语句脚本（schema DDL / 批量 PRAGMA）无法 prepare ⇒ 回落 `raw.exec()` 并返回 []，
 *     与 sql.js 对「无结果集语句」的表现一致。
 *   · better-sqlite3 支持数组绑定 `stmt.run([1, 2])`，与 sql.js 的 params 数组语义一致。
 *   · `getRowsModified()` 由最近一次 run/exec 的 changes 计数维护（sql.js 同名 API）。
 *
 * 落盘策略：WAL + synchronous=NORMAL。
 *   理由：启动回填 / 衰减维护是「逐行 run、无事务」的批量循环（万级）——回滚日志模式下
 *   每条都要 fsync，会把秒级任务拖成分钟级；WAL + NORMAL 无 fsync，批量写快一个量级。
 *   代价：运行中冷拷贝单个 .db 可能缺最后一段（-wal 尚未 checkpoint）⇒ close() 前强制
 *   `wal_checkpoint(TRUNCATE)`；停服后备份仍是单文件完整。
 */

import BetterSqlite3 from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';

/** sql.js `db.exec()` 的结果形态：每个有结果集的语句一项 */
export interface SqlJsExecResult {
  columns: string[];
  values: unknown[][];
}

/** sql.js `db.prepare()` 返回的语句壳（bind → step → getAsObject → free） */
export interface SqlJsStatementCompat {
  bind(params?: unknown[] | Record<string, unknown>): void;
  step(): boolean;
  getAsObject(): Record<string, unknown> | undefined;
  free(): void;
}

export interface SqlJsCompatOptions {
  /** 只读打开（用于磁盘校验 / 外部只读巡检；不做任何 PRAGMA 写与 checkpoint） */
  readonly?: boolean;
  /** 文件必须存在（默认否：与 sql.js「无文件则新建」保持一致） */
  fileMustExist?: boolean;
}

/** better-sqlite3 对「一条 prepare 塞多条语句」的固定报错文案 */
const MULTI_STATEMENT_RE = /more than one statement/i;

export class SqlJsCompat {
  /** 底层原生连接（仅诊断/高级场景直接使用；业务代码请走兼容 API） */
  readonly raw: BetterSqlite3.Database;
  private readonly _readonly: boolean;
  private _lastChanges = 0;

  constructor(dbPath: string, options: SqlJsCompatOptions = {}) {
    this._readonly = options.readonly === true;

    // 🔴 WAL 文件生命周期守卫：主库已被删除、但残留 -wal/-shm（外部删库/测试清理只删主文件）时，
    //   SQLite 打开「新建空库」可能把旧 WAL 重放进去 ⇒ 旧行"复活"、触发 UNIQUE 冲突。
    //   孤儿 WAL 脱离主库本身不可恢复，删除是唯一安全处置。
    if (!this._readonly && !existsSync(dbPath)) {
      for (const suffix of ['-wal', '-shm']) {
        try { unlinkSync(dbPath + suffix); } catch { /* 不存在 */ }
      }
    }

    this.raw = new BetterSqlite3(dbPath, {
      readonly: this._readonly,
      fileMustExist: options.fileMustExist === true,
    });

    if (!this._readonly) {
      // WAL：批量写无 fsync 开销（见文件头「落盘策略」）
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      // 多进程并发时短暂写锁不直接报 SQLITE_BUSY
      this.raw.pragma('busy_timeout = 5000');
      // 每 1000 页（≈4MB）自动 checkpoint，避免 -wal 无界增长
      this.raw.pragma('wal_autocheckpoint = 1000');
      // 🔴 语义对齐（实测差异）：better-sqlite3 **默认开启** foreign_keys，而 sql.js
      //   （以及 SQLite 原生默认）是**关闭**的。本仓 DDL/写入均按无外键约束设计 —
      //   开启后实测出现 `FOREIGN KEY constraint failed`（节点先于引用记录写入的场景）。
      //   迁移要求行为完全等价，故显式关闭。
      this.raw.pragma('foreign_keys = OFF');
    }
  }

  isReadonly(): boolean {
    return this._readonly;
  }

  /**
   * 执行一条（或一批）无结果集的 SQL。
   * · 带 params：prepare + run（支持数组/具名对象绑定），并记录 changes。
   * · 不带 params：交给 raw.exec()，可一次执行多条语句（schema DDL 走这里）。
   */
  run(sql: string, params?: unknown[] | Record<string, unknown>): void {
    if (params === undefined || params === null) {
      this.raw.exec(sql);
      this._lastChanges = this._queryChanges();
      return;
    }
    const stmt = this.raw.prepare(sql);
    const info = stmt.run(params as never);
    this._lastChanges = Number(info?.changes ?? 0) || 0;
  }

  /** 执行查询，返回 sql.js 兼容的 `[{ columns, values }]` */
  exec(sql: string): SqlJsExecResult[] {
    let stmt: {
      reader?: boolean;
      run(): unknown;
      all(...p: unknown[]): unknown[];
      raw(): { all(): unknown[][] };
      columns(): Array<{ name: string }>;
    };
    try {
      stmt = this.raw.prepare(sql) as unknown as typeof stmt;
    } catch (err) {
      if (MULTI_STATEMENT_RE.test(String((err as Error)?.message ?? ''))) {
        // 多语句脚本：无结果集契约，执行后返回 []
        this.raw.exec(sql);
        this._lastChanges = this._queryChanges();
        return [];
      }
      throw err;
    }

    if (stmt.reader !== true) {
      stmt.run();
      this._lastChanges = this._queryChanges();
      return [];
    }

    const values = stmt.raw().all();
    if (values.length === 0) return [];
    const columns = stmt.columns().map((c) => String(c.name));
    return [{ columns, values }];
  }

  /**
   * sql.js 语句壳：bind → step → getAsObject → free。
   * 首次 step() 时一次性取回结果（sql.js 本就整库在内存，行数上限由查询 LIMIT 控制）。
   */
  prepare(sql: string): SqlJsStatementCompat {
    const stmt = this.raw.prepare(sql) as unknown as {
      reader?: boolean;
      run(...p: unknown[]): unknown;
      all(...p: unknown[]): Record<string, unknown>[];
    };
    let bound: unknown[] | Record<string, unknown> | undefined;
    let rows: Record<string, unknown>[] | null = null;
    let cursor = 0;

    const materialize = (): void => {
      if (rows !== null) return;
      if (stmt.reader !== true) {
        if (bound === undefined) stmt.run();
        else stmt.run(bound);
        rows = [];
        return;
      }
      rows = bound === undefined ? stmt.all() : stmt.all(bound);
    };

    return {
      bind(params?: unknown[] | Record<string, unknown>): void {
        bound = params === null || params === undefined ? undefined : params;
        rows = null;
        cursor = 0;
      },
      step(): boolean {
        materialize();
        if (cursor < (rows as Record<string, unknown>[]).length) {
          cursor += 1;
          return true;
        }
        return false;
      },
      getAsObject(): Record<string, unknown> | undefined {
        if (rows === null || cursor === 0) return undefined;
        return rows[cursor - 1];
      },
      free(): void {
        rows = null;
        cursor = 0;
      },
    };
  }

  /** sql.js 同名 API：最近一次写入影响的行数 */
  getRowsModified(): number {
    return this._lastChanges;
  }

  /**
   * 关闭连接。可写库在关闭前强制 checkpoint(TRUNCATE)，让 .db 成为完整单文件
   * （否则最新写入可能只存在于 -wal 中，冷拷贝备份会缺最后一段）。
   */
  close(): void {
    if (!this._readonly) {
      try {
        this.raw.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* 有其它连接持有读锁时 checkpoint 可能失败：数据仍在 WAL，下次打开自动恢复 */
      }
    }
    try {
      this.raw.close();
    } catch {
      /* 已关闭 / 连接异常：保持与 sql.js close() 相同的容错语义 */
    }
  }

  private _queryChanges(): number {
    try {
      const row = this.raw.prepare('SELECT changes() AS c').get() as { c?: number } | undefined;
      return Number(row?.c ?? 0) || 0;
    } catch {
      return 0;
    }
  }
}
