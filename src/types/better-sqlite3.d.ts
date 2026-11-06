/**
 * better-sqlite3 最小类型声明
 *
 * 2026-11-06 存储底座迁移后补全：新增 reader / raw() / columns() / pluck() / iterate()
 * —— SqlJsCompat 兼容壳需要这些字段还原 sql.js 的 exec()/prepare() 语义。
 *
 * 采用 `export =` + 同名 namespace 合并（esModuleInterop 已开启）：
 *   import BetterSqlite3 from 'better-sqlite3';
 *   new BetterSqlite3(path)          // 值
 *   let db: BetterSqlite3.Database;  // 类型
 */
declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface Statement {
      /** true = 该语句会产生结果集（SELECT / 返回行的 PRAGMA） */
      reader: boolean;
      get(...params: any[]): any;
      all(...params: any[]): any[];
      run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
      raw(flag?: boolean): Statement;
      columns(): Array<{
        name: string;
        column: string | null;
        table: string | null;
        database: string | null;
        type: string | null;
      }>;
      pluck(flag?: boolean): Statement;
      bind(...params: any[]): Statement;
      iterate(...params: any[]): IterableIterator<any>;
    }

    interface Database {
      open: boolean;
      readonly inTransaction: boolean;
      pragma(sql: string): unknown;
      exec(sql: string): void;
      prepare(sql: string): Statement;
      transaction<T extends (...args: any[]) => any>(fn: T): T;
      close(): void;
    }

    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: (...messages: any[]) => void;
      nativeBinding?: string | undefined;
      /** 允许 loadExtension()（memarch-runtime / memarch 路由装载 sqlite-vec 时使用） */
      allowExtension?: boolean;
    }

    interface DatabaseConstructor {
      new (filename: string, options?: Options): Database;
      (filename: string, options?: Options): Database;
    }
  }

  const BetterSqlite3: BetterSqlite3.DatabaseConstructor;
  export = BetterSqlite3;
}
