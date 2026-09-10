/**
 * SQL × 真实 schema 一致性守卫（2026-09-11）
 * ===========================================
 * 事故来源：全仓扫雷发现「表存在但列不存在」的 SQL —— 运行时必抛错，
 * 若被空 catch 吞掉就是**静默失效**（如 EntityStrengthTracker.boost() 从未写成功过一条，
 * SleepTimeConsolidator 的情景→语义归纳恒返回 0）。
 *
 * 本测试把这条不变量固化为回归防线：src/**\/*.ts 里的 SQL 字面量必须能对
 * 至少一个真实库 prepare 成功。
 *
 * ⚠️ 三条必要的精度规则（否则误报会淹没真信号 —— 实测教训）：
 *   1. **多库容忍**：任一个库接受该语句 → 视为其本来目标库，通过。
 *      （`memories` 表在 fusion 与 vault 两个库都存在但列不同，只查一库必然误报）
 *   2. **守卫感知**：语句若位于「先 PRAGMA table_info 查列、再决定是否执行」的守卫之后，
 *      则运行期不可达 → 判为已守卫（不失败）。静态检查**看不到可达性**，必须人工/启发式补。
 *   3. **只扫字面量**：含 `${}` 插值的动态 SQL 跳过（无法静态判定）；拼接串需先合并。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src');

/** schema 预言机：真实库（只读打开，仅用于 prepare 编译，不读数据） */
const DB_PATHS: Array<[string, string]> = [
  ['fusion', join(REPO, 'data', 'webui', 'fusion_memory.db')],
  ['fg', join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db')],
  ['vault', join(REPO, 'data', 'memory-vault', 'vault.db')],
];

const SQL_KW = /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i;
const TABLE_REF = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w.$]*)/i;
/**
 * 错误分类闸门（S4 评审 P1-1 修正）：
 * 旧写法 `no such column: ?([\w.]+)` 要求冒号后至少一个 \w 或 .，**匹配不上**
 * DQS 严格模式的报错 `no such column: "" - should this be a string literal in single-quotes?`
 * （冒号后是双引号）→ 这类错误会被静默丢弃，导致本守卫对「双引号误用」类缺陷**假阴性**。
 * 现拆为两步：「是否列错误」宽松判定 + 「列名提取」宽松容错（列名可被引号包裹）。
 */
const COL_ERR = /\bhas no column named\b|\bno such column\b/i;
// 注意：`no such column:` 的冒号**必须必需**（不能写成 `:?`）—— 否则正则回溯会跳过冒号、
// 把 `:` 本身当成列名捕获（已实测踩到）。
const COL_NAME = /has no column named\s+["'`]?([\w]+)|no such column:\s*["'`]?([^"'`\s]+)/i;

/**
 * 逐字符词法扫描 —— 提取「逻辑字符串」（自动合并 "a" + "b" 链）。
 * O(n)、零回溯：**禁止**用带反向引用的跨行非贪婪正则做这件事（曾导致整机卡死，见经验 #17）。
 */
function extractLogicalStrings(src: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let i = 0;
  let line = 1;
  /** 上一个有效非空白字符 —— 用于判定 `/` 是正则字面量还是除号（S4 评审 P2-2） */
  let lastSig: string | undefined;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
  /** `/` 出现在这些字符之后时，视为正则字面量开头（而非除号） */
  const REGEX_PRECEDERS = '(,=:[!&|?{};';

  const readLiteral = (startIdx: number, quote: string) => {
    let j = startIdx + 1;
    let buf = '';
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
      if (c === quote) { j++; break; }
      if (c === '\n') { buf += ' '; line++; j++; continue; }
      buf += c; j++;
    }
    return { buf, next: j };
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // S4 评审 P2-2: 正则字面量（可能含引号，如 /[「」'"”]/）——不处理会导致引号配对失同步、
    // 后续内容被整段吞掉（假阴性）。判定：上一个有效字符属于「表达式起始」集合。
    if (ch === '/' && (lastSig === undefined || REGEX_PRECEDERS.includes(lastSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') { line++; j++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { j++; break; }
        j++;
      }
      i = j;
      lastSig = '/'; // 正则字面量整体视为一个值，后随 `/` 不会紧跟另一个正则
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const startLine = line;
      const first = readLiteral(i, ch);
      let merged = first.buf;
      let cursor = first.next;
      for (;;) {
        let j = cursor;
        while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        if (src[j] !== '+') break;
        j++;
        while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        if (src[j] === '/' && src[j + 1] === '/') {
          while (j < src.length && src[j] !== '\n') j++;
          while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        }
        const q2 = src[j];
        if (q2 !== '"' && q2 !== "'" && q2 !== '`') break;
        const nxt = readLiteral(j, q2);
        merged += nxt.buf;
        cursor = nxt.next;
      }
      out.push({ text: merged, line: startLine });
      i = cursor;
      lastSig = '"';
      continue;
    }
    if (!isWs(ch)) lastSig = ch;
    i++;
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walkTs(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 守卫感知：语句上方 120 行内是否出现「PRAGMA table_info 查列 + 依此提前返回」的守卫。
 *
 * 覆盖三种实际写法（均已在本仓出现，见实测）：
 *   A. `if (!cols.some(c => c[1] === 'COL')) { ...; return; }`            （BackfillDualHelix）
 *   B. `const has24 = cols.some(c => c[1] === 'COL'); if (!has24) {...; return;} `（MigrationManager）
 *   C. `if (!cols.some((c: any) => c[1] === 'COL')) return 0;`             （SQLiteAdapter）
 *
 * 局限：这是启发式，不是语义分析。命中项会作为 info 输出，建议人工复核守卫是否真的成立。
 * 正则全部使用**有界**通配（{0,N}），禁止无界回溯（经验 #17）。
 */
function findGuard(lines: string[], stmtLine1Based: number, column: string, tbl: string): string | null {
  const from = Math.max(0, stmtLine1Based - 121);
  const window = lines.slice(from, stmtLine1Based - 1).join('\n');
  // S4 评审 P2-1: PRAGMA 必须**按表限定**，否则另一张表的守卫会顶替（实测本仓存在
  // 「守卫与语句相隔 100+ 行」的布局，宽松判定会误放行）。
  const escTbl = tbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pragmaRe = new RegExp(`PRAGMA\\s+table_info\\s*\\(\\s*["'\u0060]?${escTbl}["'\u0060]?\\s*\\)`, 'i');
  if (!pragmaRe.test(window)) return null;

  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 该列是否出现在某个 .some(...) 列检查里（有界通配，容忍 (c: any) => 这种写法）
  const someRef = new RegExp(`\\.some\\s*\\([\\s\\S]{0,120}?['"\u0060]${esc}['"\u0060]`, 'i');
  if (!someRef.test(window)) return null;

  // 形式 A/C：直接 `if (!X.some(...)) ... return`
  const directGuard = new RegExp(
    `if\\s*\\(\\s*![\\w.$]*\\s*\\.?\\s*some\\s*\\([\\s\\S]{0,120}?['"\u0060]${esc}['"\u0060][\\s\\S]{0,60}?\\)\\s*\\)[\\s\\S]{0,240}?\\b(return|continue)\\b`,
    'i',
  );
  if (directGuard.test(window)) return 'form A/C: if (!cols.some(...col...)) { ...return }';

  // 形式 B：`const V = cols.some(...'COL'...);` 且后续 `if (!V) { ... return }`
  const m = new RegExp(
    `(?:const|let)\\s+(\\w+)\\s*=\\s*[\\w.$]*\\s*\\.?\\s*some\\s*\\([\\s\\S]{0,120}?['"\u0060]${esc}['"\u0060]`,
    'i',
  ).exec(window);
  if (m) {
    const v = m[1];
    const varGuard = new RegExp(`if\\s*\\(\\s*!${v}\\b[^)]*\\)[\\s\\S]{0,240}?\\b(return|continue)\\b`, 'i');
    if (varGuard.test(window)) return `form B: const ${v} = cols.some(...'${column}'); if (!${v}) {...return}`;
  }
  return null;
}

describe('[SQL-schema 守卫] 全仓 SQL 必须能对至少一个真实库 prepare 成功', () => {
  const available = DB_PATHS.filter(([, p]) => existsSync(p));

  /**
   * 守卫命中白名单（S4 评审 P2-1）：启发式识别到的「已守卫」必须逐条人工登记，
   * 未登记的新命中一律判失败 —— 把「静默放行」的风险变成「必须人工复核」。
   * 键 = 文件|表|列（不用行号，避免无关编辑导致漂移；组合已足够精确）。
   */
  const GUARDED_ALLOWLIST = new Set([
    'src/m2/BackfillDualHelix.ts|memories|perception_json',
    'src/m2/MigrationManager.ts|memories|perception_json',
    'src/m2/SQLiteAdapter.ts|memories|perception_json',
  ]);

  it('schema 预言机齐备（三个库都存在，否则规则 1「任一库通过」会失真 → 误报）', () => {
    const missing = DB_PATHS.filter(([, p]) => !existsSync(p)).map(([n]) => n);
    expect(
      missing,
      `schema 预言机不齐：缺 [${missing.join(', ')}]（找到 ${available.length}/${DB_PATHS.length}）。` +
        '本测试依赖本地 data/ 下的三个真实库；库不全会导致跨库 SQL 被误判为缺陷。',
    ).toEqual([]);
  });

  it('无「未守卫的列不存在」SQL', () => {
    const dbs = available.map(([name, p]) => [name, new Database(p, { readonly: true })] as const);
    const knownTables = new Set<string>();
    for (const [, db] of dbs) {
      for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>) knownTables.add(r.name);
    }

    const offenders: string[] = [];
    const guarded: string[] = [];
    let checked = 0;

    for (const file of walkTs(SRC)) {
      const src = readFileSync(file, 'utf-8');
      const lines = src.split('\n');
      for (const s of extractLogicalStrings(src)) {
        if (!SQL_KW.test(s.text)) continue;
        if (s.text.includes('${')) continue;
        const sql = s.text.replace(/\s+/g, ' ').trim();
        if (sql.length < 12) continue;
        const tref = TABLE_REF.exec(sql);
        if (!tref) continue;
        const tbl = tref[1].split('.').pop() as string;
        if (!knownTables.has(tbl)) continue;

        checked++;
        const results = dbs.map(([name, db]) => {
          // 注意：better-sqlite3 的 prepare() 返回 Statement，**没有 finalize()**（那是 sql.js 的 API）；
          // 写 .finalize() 会抛 TypeError → 造成「所有库都拒绝」的假阳性（已踩过）。
          try { db.prepare(sql); return { name, ok: true, err: '' }; }
          catch (e) { return { name, ok: false, err: (e as Error).message }; }
        });
        // 规则 1：任一库接受 → 通过
        if (results.some((r) => r.ok)) continue;
        const colErrs = results.filter((r) => COL_ERR.test(r.err));
        if (!colErrs.length) continue;

        const mm = COL_NAME.exec(colErrs[0].err);
        // 容错：`no such column: ""` 提取出的是 `""`，剔引号后为空 → column=''
        const raw = (mm?.[1] || mm?.[2] || '').replace(/^["'`]|["'`]$/g, '');
        const column = raw.split('.').pop() as string;
        const loc = `${relative(REPO, file).replace(/\\/g, '/')}:${s.line}`;
        // 规则 2：守卫感知（按表限定 PRAGMA + 白名单闸门，见 findGuard）
        const guard = column ? findGuard(lines, s.line, column, tbl) : null;
        const akey = `${relative(REPO, file).replace(/\\/g, '/')}|${tbl}|${column}`;
        if (guard && GUARDED_ALLOWLIST.has(akey)) {
          guarded.push(`${loc}  [col=${column}]  guard: ${guard.slice(0, 90)}`);
        } else if (guard) {
          // 启发式认为已守卫，但未登记 → 必须人工确认，不允许静默放行
          offenders.push(`${loc}  [table=${tbl} col=${column}]  **疑似守卫误放行**（未登记白名单，请人工复核）: ${guard.slice(0, 100)}`);
        } else {
          offenders.push(`${loc}  [table=${tbl} col=${column || '(无法提取列名 — 疑似双引号误用/DQS 严格报错)'}]  ${colErrs.map((r) => `${r.name}:${r.err}`).join(' | ')}\n      SQL: ${sql.slice(0, 130)}`);
        }
      }
    }

    for (const [, db] of dbs) db.close();

    // 防「扫描器失效/词法失同步导致静默丢覆盖」：打印实际计数 + 名单式存在性断言
    console.log(`[SQL-schema 守卫] 实扫 SQL 语句 ${checked} 条，已守卫 ${guarded.length} 处，未守卫 ${offenders.length} 处`);
    if (guarded.length) {
      console.log(`[SQL-schema 守卫] 已守卫（白名单内，供人工复核）${guarded.length} 处:\n  ` + guarded.join('\n  '));
    }
    // 已知必须被扫到的语句（若词法失同步吞掉这些文件，本断言会失败）
    expect(checked, '扫描到的 SQL 语句数过少，说明扫描器或词法已失效').toBeGreaterThan(50);
    expect(offenders, `发现 ${offenders.length} 处【未守卫】的列不存在 SQL（运行时必抛错）：\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

/**
 * 词法扫描器夹具单测（S4 评审 P2-3）：假阴性比假阳性更危险 —— 漏检就失去防护。
 * 这四条钉住已知会让引号配对失同步的构造。
 */
describe('[SQL-schema 守卫] 词法扫描器夹具（防引号失同步 → 静默丢覆盖）', () => {
  const pick = (src: string) => extractLogicalStrings(src).map((s) => s.text);

  it('正则字面量内含引号时不被误判为字符串（实测 DeepSeekLLMProvider.ts:286 同类写法）', () => {
    const src = [
      "const re = /[\u2018\u2019\u201c\u201d'\"]{2,}/;",
      'const sql = "SELECT a FROM t";',
      "const other = 'SELECT b FROM u';",
    ].join('\n');
    const got = pick(src);
    expect(got).toContain('SELECT a FROM t');
    expect(got).toContain('SELECT b FROM u');
  });

  it('模板字面量的 ${} 被保留（供上层规则 3 跳过）', () => {
    const got = pick('const q = `SELECT a FROM t WHERE x = ${v}`;');
    expect(got.some((t) => t.includes('${'))).toBe(true);
  });

  it('单引号字符串里的转义引号不提前终止', () => {
    const got = pick("const q = 'SELECT a FROM t WHERE x = \\'v\\'';");
    expect(got.some((t) => t.includes('SELECT a FROM t'))).toBe(true);
  });

  it('注释里的撒号不影响后续字符串识别', () => {
    const got = pick("// 注意不能写成 'a' 这种\nconst q = 'SELECT a FROM t';");
    expect(got).toContain('SELECT a FROM t');
  });

  it('拼接串合并为一条逻辑 SQL', () => {
    const got = pick('const q = "SELECT a" +\n  " FROM t";');
    expect(got.some((t) => t.replace(/\s+/g, ' ').trim() === 'SELECT a FROM t')).toBe(true);
  });

  it('除号不被误判为正则字面量', () => {
    const got = pick('const ratio = a / b; const q = "SELECT a FROM t";');
    expect(got).toContain('SELECT a FROM t');
  });

  it('能识别 DQS 严格模式的双引号误用报错（P1-1 永久回归防线）', () => {
    // 旧 COL_RE 要求冒号后至少一个 \w 或 .，匹配不上下面这条（冒号后是双引号）→ 缺陷被静默丢弃。
    const dqs = 'no such column: "" - should this be a string literal in single-quotes?';
    expect(COL_ERR.test(dqs), 'DQS 报错必须被识别为列错误').toBe(true);
    const m = COL_NAME.exec(dqs);
    const col = (m?.[1] || m?.[2] || '').replace(/^["'`]|["'`]$/g, '');
    expect(col, 'DQS 报错提取不出列名 → 应走 offender 分支（fail-closed）').toBe('');
    // 对照：普通列错误仍能提取列名（供守卫感知使用）
    const normal = 'no such column: perception_json';
    expect(COL_ERR.test(normal)).toBe(true);
    expect(COL_NAME.exec(normal)?.[2]).toBe('perception_json');
  });
});
