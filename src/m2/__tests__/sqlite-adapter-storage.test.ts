/**
 * 存储底座迁移回归测试 — 方案甲（2026-09-24）
 * ==========================================================
 * 背景：sql.js 的 `db.export()` 要把**整个内存库序列化成字节**再写盘，
 *   实测 273.8MB / 次 20~53 秒，且**同步执行在主线程** ⇒ 事件循环常驻冻结：
 *     [M4·timing] total=52744 integrateFG=51140
 *     [SQLiteAdapter] 异步落盘 273.8MB 用时 52691ms（日志自称「未阻塞」，实为阻塞）
 *     [ChatStream] done ... tokens=0        ← 全程推不出一个 token
 *   前端 60s 拿不到任何字 ⇒ 用户看到「卡死不回复」。
 *
 * 换用 better-sqlite3（已是 dependencies 生产依赖、同步语义与 sql.js 一致）
 * 后：写库直接落到文件（页级增量），**全量导出这件事不再存在**。
 *
 * ⚠️ 守卫式设计：源码迁移**分两步**（先拿令牌再改代码），故本文件在
 *   「迁移前」也必须能编译且能跑过 —— 否则 S3 的 tsc 门控会陷入回流死锁。
 *   与迁移强相关的断言用运行时守卫，迁移落地后自动激活。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** 剥行注释后再断言（注释里的「原实现曾用 export()」等说明文字会误伤正则） */
const readCode = (p: string) =>
  read(p).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const ADAPTER = 'src/m2/SQLiteAdapter.ts';
const FG = 'src/m4/household/FamilyGraph.ts';
const CONV = 'src/m2/ConversationDB.ts';

const adapterSrc = read(ADAPTER);
/**
 * 迁移守卫：必须匹配**真实 import 语句**，不能只 grep 'better-sqlite3' ——
 * 实测 SQLiteAdapter 的注释里本来就提到 better-sqlite3（L2096/L2209 讨论
 * 「backfill 用 better-sqlite3 写盘却被 sql.js 内存态覆盖」），裸匹配会
 * 在迁移**之前**就误判为已迁移，导致断言全红、S5 失败。
 */
// 🔴 2026-11-06 迁移落地后的实现形态：SQLiteAdapter 经 SqlJsCompat 接入 better-sqlite3，
//   不再直接 import 原生包 —— 故判据改为「适配器引用 SqlJsCompat」+「兼容层 import better-sqlite3」。
const COMPAT = 'src/m2/SqlJsCompat.ts';
const compatSrc = existsSync(resolve(ROOT, COMPAT)) ? read(COMPAT) : '';
const migrated =
  /from\s*['"]\.\/SqlJsCompat\.js['"]/.test(adapterSrc) &&
  /from\s*['"]better-sqlite3['"]/.test(compatSrc);
const mi = migrated ? it : it.skip; // 迁移落地后自动激活

describe('[方案甲] 与迁移无关的恒真不变量（两个阶段都跑）', () => {
  it('🔴 SQLiteAdapter 必须仍是唯一持久写入通道（对外 API 不得削减）', () => {
    const src = adapterSrc;
    // 🔴 2026-11-06 迁移后：save/scheduleFlush 随整库导出机制一并删除（写即落盘），
    //   对外写入/查询契约不变，关闭走 close()。
    for (const api of ['writeRaw', 'queryAll', 'close', 'getDb']) {
      expect(src, `SQLiteAdapter 必须保留 ${api}`).toContain(api);
    }
  });

  it('🔴 三个库各自的职责边界未被合并（主库/FG/会话库仍是三个实例）', () => {
    // 换底座是「换引擎」，不是「并库」—— 并库会破坏 FG 户籍单一数据源铁律
    expect(read(FG)).toMatch(/family_graph\.db|fgPath|_fgDbPath|dbPath/);
    expect(read(CONV)).toMatch(/conversation|convPath|this\.dbPath/);
  });

  it('🟢 注释必须说明为何不能再用全量导出（防止有人改回去）', () => {
    const src = adapterSrc;
    expect(src).toMatch(/export\(\)|全量导出|全量序列化/);
  });
});

describe('[方案甲] 迁移后必须成立（迁移落地后自动激活）', () => {
  mi('🔴 SQLiteAdapter 已换 better-sqlite3（经 SqlJsCompat，不再 initSqlJs）', () => {
    expect(readCode(ADAPTER)).not.toMatch(/initSqlJs/);
    expect(adapterSrc).toMatch(/from\s*['"]\.\/SqlJsCompat\.js['"]/);
    expect(compatSrc).toMatch(/from\s*['"]better-sqlite3['"]/);
  });

  mi('🔴 主库已无 `db.export()` —— 全量导出彻底移除', () => {
    const code = readCode(ADAPTER);
    expect(code).not.toMatch(/\(\s*this\.db\s+as any\s*\)\.export\(/);
    expect(code).not.toMatch(/(?<!\/\/.*)\bthis\.db\.export\(\)/);
  });

  mi('🔴 落盘机制已删除（flushNow/scheduleFlush 不再触发全量写）', () => {
    const code = readCode(ADAPTER);
    // 防抖/批阈值常量随机制消失；若仍存在，说明导出逻辑还在
    expect(code).not.toMatch(/writeFileSync\([^)]*export\(\)/);
    expect(code).not.toMatch(/\bdb\.export\(\)/);
  });

  mi('🔴 会话库已无 export 落盘', () => {
    const code = readCode(CONV);
    expect(code).not.toMatch(/writeFileSync\([^)]*export\(\)/);
  });

  mi('🔴 FG 库已无 export 落盘', () => {
    const code = readCode(FG);
    expect(code).not.toMatch(/writeFileSync\([^)]*export\(\)/);
    expect(code).not.toMatch(/\bthis\.db\.export\(\)/);
  });

  mi('🔴 仍暴露 rawDb 兼容层（indexDocument/unifiedSearch 等 6 个消费方依赖）', () => {
    // 共享工具函数签名是 db: any，只调 db.exec / db.run —— 外壳必须继续提供
    expect(adapterSrc).toMatch(/get rawDb|rawDb\s*[:=]/);
  });
});

describe('[方案甲] 性质断言：换底座不改变数据语义', () => {
  it('🔴 不得引入新的数据库文件（换引擎不是换库）', () => {
    // 同一个 .db 文件直接复用，零数据迁移
    const src = adapterSrc;
    expect(src).toMatch(/fusion_memory\.db|dbName|\.db['"]/);
    // 不得出现「新建第二份库」的迹象
    expect(src).not.toMatch(/fusion_memory_2|new.*migration\.db/);
  });

  it('🟢 不得为绕过阻塞而引入「关掉持久化」的开关', () => {
    for (const f of [ADAPTER, FG, CONV]) {
      const code = readCode(f);
      expect(code, `${f} 不得引入禁用持久化的开关`).not.toMatch(/DISABLE_?PERSIST|NO_?FLUSH\s*=\s*true|PERSISTENCE_?OFF/);
    }
  });
});
