/**
 * 回归守卫：src/** 每个 `INSERT ... INTO memories` 的列清单必须覆盖目标库的
 * 「NOT NULL 且无 DEFAULT」列集（2026-09-18）
 * ============================================================
 * 背景（真实事故，本次修复）：
 *   `SleepTimeConsolidator._promoteSandToGold()` 的手写
 *   `INSERT OR IGNORE INTO memories (id, raw_input, calcium_score, seq_pos, created_at,
 *    memory_kind, belong_entity_uuid)` 只列出 7 列，缺 memories 的 4 个 NOT NULL 无默认列
 *   （calcium_level / locus_path / leaf_zone / strength_updated_at）。
 *   `OR IGNORE` 把 NOT NULL 违约**静默吞掉** → 记忆从未落库；但紧随其后的
 *   `UPDATE conversations SET is_promoted = 1` 仍然执行 → 砂金被「吃掉」（不可恢复的静默丢数据）。
 *   修复：收口到唯一公共写入口 `SQLiteAdapter.writeMemory()`（列清单由适配器统一维护）。
 *
 * 与既有 D8 守卫（src/m2/__tests__/memory-write-columns.test.ts）的关键差异：
 *   - D8 只扫 SQLiteAdapter.ts 单文件、只查 6 个「身份/归属」列、只匹配 `INSERT OR REPLACE`。
 *   - 本次缺陷位于 **`INSERT OR IGNORE`**（吞违约而非报错），且缺的是 **NOT NULL** 列
 *     —— D8 的三个判定面全都覆盖不到，故另立本守卫。
 *
 * 本守卫的不变量（对 REPLACE / IGNORE / 普通 INSERT 一视同仁）：
 *   任一处 `INSERT ... INTO memories` 的显式列清单，必须**完整覆盖**它所面向的库中
 *   memories 表的全部「NOT NULL 且无 DEFAULT」列 —— 否则该列要么触发运行时错误，
 *   要么（OR IGNORE）被静默丢弃。
 *
 * 精度规则（对齐 sql-schema-consistency.test.ts 的「多库容忍」）：
 *   1. 多库容忍：`memories` 表名在**两个库**中各有一套 schema ——
 *        ① 主库 fusion_memory.db（DDL 源自 src/m2/schema.sql）
 *        ② vault 库 vault.db（DDL 内联于 src/app/memory-vault/MemoryVault.ts）
 *      写入点只要覆盖**其中一个**库的必需列集即通过（同形不同列，只查一库必然误报）。
 *   2. fail-closed：命中 marker 但解析不出显式列清单（如 INSERT…SELECT）→ 直接判违规，
 *      **绝不静默跳过**（静默跳过 = 守卫失效）。
 *   3. 只扫 src/**\/*.ts 的非测试源码（测试夹具里的示例 SQL 会污染信号）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInsertColumns } from '../m2/SQLiteAdapter.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src');

/* ───────────────────────────── schema 解析（确定性，零 DB 依赖） ───────────────────────────── */

/**
 * 从 DDL 文本中截取 `CREATE TABLE [IF NOT EXISTS] <table> ( ... )` 的圆括号主体。
 * 以「行首 + 可选缩进 + 右括号」为收尾（同时兼容 `\n);` 与 `\n        )\`);` 两种写法）。
 */
function extractCreateTableBody(text: string, table: string): string | null {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rel = text.slice(start).search(/\n\s*\)/);
  const stop = rel === -1 ? text.length : start + rel;
  return text.slice(start, stop);
}

/**
 * 按「顶层逗号」切分列定义 —— 圆括号内（如 CHECK(...) / DECIMAL(10,2)）的逗号不算分隔符。
 * 必须先剥掉行注释（注释里可能出现成对括号与逗号，会干扰深度计数）。
 */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * 解析出「NOT NULL 或 PRIMARY KEY」且「无 DEFAULT」的列名集合。
 * 这类列在 INSERT 语句里**必须显式提供**，否则：
 *   - 普通 INSERT / OR REPLACE → 运行时 NOT NULL 违约（或 REPLACE 抹成 NULL）；
 *   - INSERT OR IGNORE        → 违约被静默吞掉，整行丢弃（本次事故）。
 *
 * 注意：同一定义行可能含多列（如 vault DDL 的 `id TEXT PRIMARY KEY, type TEXT NOT NULL,`），
 * 故必须先按顶层逗号切分，不能「一行取首 token」。
 */
function requiredColumnsFromDdl(ddlText: string, table: string): string[] {
  const body = extractCreateTableBody(ddlText, table);
  if (body === null) return [];
  const noComments = body.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const out: string[] = [];
  for (const seg of splitTopLevelCommas(noComments)) {
    const line = seg.trim();
    if (!line) continue;
    const colMatch = /^([A-Za-z_][\w]*)\s+/.exec(line);
    if (!colMatch) continue;                 // 表级约束行（如 PRIMARY KEY (a,b)）无前导列名，跳过
    const name = colMatch[1];
    // 排除以关键字开头的表级约束行
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(name)) continue;
    const isPk = /PRIMARY\s+KEY/i.test(line);
    const notNull = /NOT\s+NULL/i.test(line);
    const hasDefault = /\bDEFAULT\b/i.test(line);
    if ((notNull || isPk) && !hasDefault) out.push(name);
  }
  return out;
}

const MAIN_SCHEMA_SQL = readFileSync(join(SRC, 'm2', 'schema.sql'), 'utf-8');
const VAULT_SRC = readFileSync(join(SRC, 'app', 'memory-vault', 'MemoryVault.ts'), 'utf-8');

/** 已知的 memories 库 schema（多库容忍：命中任一即通过） */
const KNOWN_SCHEMAS: Array<{ name: string; required: string[] }> = [
  { name: 'main(fusion_memory.db) ← src/m2/schema.sql', required: requiredColumnsFromDdl(MAIN_SCHEMA_SQL, 'memories') },
  { name: 'vault(vault.db) ← MemoryVault.ts 内联 DDL', required: requiredColumnsFromDdl(VAULT_SRC, 'memories') },
];

/* ───────────────────────────── 扫描 src/**\/*.ts 中的 memories 写入点 ───────────────────────────── */

/**
 * 列清单提取（对 OR 语义中立）。
 *
 * 生产实现 `extractInsertColumns` 的 OR 子句只识别 `OR REPLACE`（不识别 `OR IGNORE`）——
 * 其文件本次不在改动范围内，故在守卫侧把 `OR IGNORE` 归一为 `OR REPLACE` 后再解析。
 * 归一化对「列清单」这一目标零影响：OR 子句只决定冲突处理策略，与列清单无关。
 * （这正是本守卫存在的意义之一：现有 D8 守卫只扫 OR REPLACE，从未覆盖 OR IGNORE 路径。）
 */
function columnsOf(rawSql: string): string[] {
  return extractInsertColumns(rawSql.replace(/^\s*INSERT\s+OR\s+IGNORE\b/i, 'INSERT OR REPLACE'));
}

interface InsertSite {
  file: string;          // 相对 src 的路径
  line: number;          // 1-based 行号
  columns: string[];     // 显式列清单（解析失败为空数组）
  snippet: string;       // 用于报错的上下文
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !/\.(test|spec)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function collectInsertSites(): InsertSite[] {
  const marker = /INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+memories\b/gi;
  const sites: InsertSite[] = [];
  for (const file of walkTsFiles(SRC)) {
    const src = readFileSync(file, 'utf-8');
    let m: RegExpExecArray | null;
    marker.lastIndex = 0;
    while ((m = marker.exec(src)) !== null) {
      // 解析必须用**完整剩余源码**（截断会丢掉列清单的收尾括号 → 误判为「无列清单」）
      const rest = src.slice(m.index);
      sites.push({
        file: relative(SRC, file).replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        columns: columnsOf(rest),
        snippet: rest.replace(/\s+/g, ' ').slice(0, 130),
      });
    }
  }
  return sites;
}

/* ───────────────────────────── 断言 ───────────────────────────── */

/** 本次事故的 4 个缺失列 —— 作为 schema 解析正确性的锚点（若 schema 漂移，先在此暴露） */
const INCIDENT_COLUMNS = ['calcium_level', 'locus_path', 'leaf_zone', 'strength_updated_at'];

const SITES = collectInsertSites();

describe('[NOT NULL 守卫] memories 写入列清单覆盖度', () => {
  it('schema 解析器健康：主库 memories 的必需列集包含本次事故的 4 列', () => {
    const main = KNOWN_SCHEMAS.find((s) => s.name.startsWith('main'))!;
    expect(main.required.length).toBeGreaterThanOrEqual(8);
    for (const col of INCIDENT_COLUMNS) {
      expect(main.required, `主库 memories 必需列集缺少 ${col}（schema.sql 可能已漂移）`).toContain(col);
    }
  });

  it('vault 库 schema 解析成功（多库容忍的另一半）', () => {
    const vault = KNOWN_SCHEMAS.find((s) => s.name.startsWith('vault'))!;
    expect(vault.required).toContain('type');
    expect(vault.required).toContain('created_at');
  });

  it('扫描器有效：必须命中 SQLiteAdapter 自身的全部 memories 写入点（防扫描器失效导致空转通过）', () => {
    // 🔴 2026-09-19 批 5：原先写死 `SITES.length >= 6`。那个数字隐含了一个**脆弱前提**：
    //   “外部写入点也持有列清单字面量”。而收口工程（批 2/3）已把 5 个外部写入点改成
    //   `writeMemory({...})` 调用（不再有列清单字面量）⇒ 计数从 9 掉到 4，断言变红。
    //   但这不是扫描器失效（它仍能看到适配器内部三处）—— 用**计数**当“能力”判据本身就是错的。
    //   现改为两个能力断言：① 非空（粗筛）；② 适配器自身三个写入点必须全部被扫到。
    expect(SITES.length).toBeGreaterThanOrEqual(3);
    const adapterSites = SITES.filter((s) => s.file.endsWith('m2/SQLiteAdapter.ts'));
    expect(
      adapterSites.length,
      `SQLiteAdapter 自身应有至少 3 个 memories 写入点（write / writeMemory / 锚点重建器），実测 ${adapterSites.length}：` +
        JSON.stringify(adapterSites.map((s) => s.line)),
    ).toBeGreaterThanOrEqual(3);
  });

  it('每个写入点的列清单都完整覆盖至少一个已知库的「NOT NULL 无默认」列集', () => {
    const offenders: string[] = [];
    for (const site of SITES) {
      if (site.columns.length === 0) {
        offenders.push(
          `${site.file}:${site.line} 无显式列清单（INSERT…SELECT 类最危险，无法保证不丢列）:: ${site.snippet}`,
        );
        continue;
      }
      const cols = new Set(site.columns.map((c) => c.trim()));
      const coveredBy = KNOWN_SCHEMAS.find((s) => s.required.every((c) => cols.has(c)));
      if (!coveredBy) {
        // 报最接近（缺失最少）的库，便于定位
        const ranked = KNOWN_SCHEMAS
          .map((s) => ({ s, missing: s.required.filter((c) => !cols.has(c)) }))
          .sort((a, b) => a.missing.length - b.missing.length);
        const near = ranked[0];
        offenders.push(
          `${site.file}:${site.line} 缺 [${near.missing.join(', ')}]（对 ${near.s.name}）:: ${site.snippet}`,
        );
      }
    }
    expect(
      offenders,
      `以下 memories 写入点缺少「NOT NULL 无默认」列（OR IGNORE 下会静默丢整行）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('本次修复的直接回归锚点：晋升路径已改用公共写入口 writeMemory()', () => {
    const src = readFileSync(join(SRC, 'engine', 'tianquan', 'temporal', 'SleepTimeConsolidator.ts'), 'utf-8');
    expect(src, 'SleepTimeConsolidator 应通过 sqlite.writeMemory() 落库').toContain('sqlite.writeMemory(');
    // 旧的 7 列手写 INSERT（含 belong_entity_uuid 却被硬编码为 NULL）不得复现
    const legacy = /INSERT\s+OR\s+IGNORE\s+INTO\s+memories\s*\(\s*id,\s*raw_input,\s*calcium_score,\s*seq_pos,\s*created_at,\s*memory_kind,\s*belong_entity_uuid\s*\)/i;
    expect(legacy.test(src), '旧的 7 列手写 INSERT 不应存在于晋升路径').toBe(false);
  });
});

describe('[NOT NULL 守卫] 纯函数行为', () => {
  it('requiredColumnsFromDdl 正确识别 NOT NULL / PK 且排除有 DEFAULT 的列', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS demo (
      id TEXT PRIMARY KEY,
      seq_pos INTEGER UNIQUE NOT NULL,
      calcium_level INTEGER NOT NULL CHECK(calcium_level BETWEEN 0 AND 3),
      memory_kind TEXT DEFAULT 'episodic',
      perception_40d TEXT
    );`;
    const cols = requiredColumnsFromDdl(ddl, 'demo');
    expect(cols).toContain('id');            // PK
    expect(cols).toContain('seq_pos');       // NOT NULL
    expect(cols).toContain('calcium_level'); // NOT NULL + CHECK
    expect(cols).not.toContain('memory_kind');    // 有 DEFAULT
    expect(cols).not.toContain('perception_40d'); // 可空
  });

  it('columnsOf 对拼接式 SQL（" + 续行）与 OR IGNORE 均鲁棒', () => {
    const cols = columnsOf(
      'INSERT OR IGNORE INTO memories (id,seq_pos," +\n      "calcium_level,locus_path) " + "VALUES (?,\'a\')',
    );
    expect(cols).toEqual(['id', 'seq_pos', 'calcium_level', 'locus_path']);
  });
});
