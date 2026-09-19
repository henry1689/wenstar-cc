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
// memories 身份列定义的单一事实源（本文件是全仓守卫，不重复列举该表的 6 个字面量）
import { MEMORY_IDENTITY_CRITICAL_COLUMNS } from '../m2/SQLiteAdapter.js';

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
        // 🔴 行号漂移修复(2026-09-19)：下面的空白探测会自增 line，但若最终**没有推进 cursor**
        //   就 break 出去，主循环会从 cursor 重扫同一段空白 ⇒ 换行被重复计数，行号越滚越偏。
        //   实测：28,014 条逻辑串中 7,633 条漂移（27%）；FamilyGraph.ts 报违规在 5995 行而文件
        //   仅 5965 行（越界 30），真语句在 5940；SQLiteAdapter.ts 报 1026 实为注释行、真语句 1022-1025。
        //   故探测前存快照，凡未推进游标的分支一律回滚。
        const lineMark = line;
        let j = cursor;
        while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        if (src[j] !== '+') { line = lineMark; break; }
        j++;
        while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        if (src[j] === '/' && src[j + 1] === '/') {
          while (j < src.length && src[j] !== '\n') j++;
          while (j < src.length && isWs(src[j])) { if (src[j] === '\n') line++; j++; }
        }
        const q2 = src[j];
        if (q2 !== '"' && q2 !== "'" && q2 !== '`') { line = lineMark; break; }
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
 * 跨表同概念列名登记守卫（C4）
 * ===================================
 * 事故（2026-09-11）: `entity_names`(conversations) 与 `fg_entity_names`(memories) 是**同一概念的两个列名**。
 * 共 4 处在 memories 上写了 entity_names → 运行时必抛 `no such column`，均被 try/catch 吞掉
 * → **静默降级**: SleepTimeConsolidator 归纳恒 0 / ProspectiveSimulator 前瞻匹配恒 0 /
 *   NoveltyDetector 恒走 fallback / KnowledgeAccessFacade 检索恒空。
 *
 * 为何静态 prepare 检查（上一个 describe）抓不到:
 *   坏列名在被插值的**独立字符串**里（如 `const likeClause = '... entity_names LIKE ?'`），
 *   该片段自身**没有表引用**（无 FROM/JOIN/INTO）→ 被 TABLE_REF 过滤掉。
 *
 * 本守卫用「file|列名 → 声明目标表」登记制，三重校验（fail-closed）:
 *   ① 发现但未登记 → 失败（新增使用点必须解释目标表）
 *   ② 登记但已消失 → 失败（防登记表腐化/文件改名后漏改）
 *   ③ 声明的目标表在该列上确实存在该列（拿 schema 预言机反向验证登记真实性）
 */
const ENTITY_NAME_COLUMN_REGISTRY = new Map<string, 'conversations' | 'memories'>([
  ['src/app/vault/MemoryAssessor.ts|entity_names', 'conversations'],
  ['src/engine/tianquan/temporal/KnowledgeAccessFacade.ts|fg_entity_names', 'memories'],
  ['src/engine/tianquan/temporal/NoveltyDetector.ts|fg_entity_names', 'memories'],
  ['src/engine/tianquan/temporal/ProspectiveSimulator.ts|fg_entity_names', 'memories'],
  ['src/engine/tianquan/temporal/SleepTimeConsolidator.ts|entity_names', 'conversations'],
  ['src/engine/tianquan/temporal/SleepTimeConsolidator.ts|fg_entity_names', 'memories'],
  ['src/m2/ConversationDB.ts|entity_names', 'conversations'],
  ['src/m2/MigrationManager.ts|fg_entity_names', 'memories'],
  ['src/m2/SQLiteAdapter.ts|entity_names', 'conversations'],
  ['src/m2/SQLiteAdapter.ts|fg_entity_names', 'memories'],
  // C2/C3 新增: EntityNameCodec 就是「两列名」的单一事实源（ENTITY_NAME_COLUMNS），
  // 它同时包含两个列名字面量，属登记制内的合法核心条目。
  ['src/m2/EntityNameCodec.ts|entity_names', 'conversations'],
  ['src/m2/EntityNameCodec.ts|fg_entity_names', 'memories'],
]);

/**
 * [D8-全表] INSERT OR REPLACE 列清单守卫（2026-09-11 推广）
 * ==========================================================
 * 原 D8 守卫只扫 `memories`（见 memory-write-columns.test.ts）。
 * 但同一张病在别的表上重演了：`FamilyGraph` 的 FG→黑钻同步用
 *   INSERT OR REPLACE INTO black_diamond (id, summary, ..., status)
 * —— **列清单缺 belong_entity_uuid**，而 id 是确定性值 → 每次 webui 启动
 * 都重写同一行、把回填好的归属抹成 NULL（实测 32 条关系镜像丢失，黑钻标注率 91.2%→76.5%）。
 *
 * 本守卫把「关键列」概念推广到**所有表**：每张有归属/身份语义的表登记自己不可缺失的列；
 * 扫描 src/** 全部 `INSERT OR REPLACE INTO <表>`，列清单缺登记列 → 失败（fail-closed）。
 */
const REPLACE_CRITICAL_COLUMNS: Record<string, readonly string[]> = {
  // 表名 → 该表被 INSERT OR REPLACE 时**必须携带**的列（未列出 = 会被静默抹成 NULL）
  memories: ['dna_root_id', 'entity_genes', 'fg_entity_names', 'global_uid', 'belong_entity_uuid', 'location_fingerprint'],
  black_diamond: ['belong_entity_uuid'],
  conversations: ['belong_entity_uuid', 'entity_names'],
};

/**
 * 已文档化的例外（均为人工核实过的合法情形，不是“放行”）：
 *  ① MemoryVault 的 `memories` 属**独立库** data/memory-vault/vault.db（另一套 schema）
 *  ② 对话组锚点重建：id = `<dialogGroupId>_ANCHOR` 独立命名空间，REPLACE 只重写自身行，
 *     不抹其他记忆 —— 与 memory-write-columns.test.ts 的锚点例外同源，用指纹（非文件粒度）
 *     以免把同文件的 writeMemory 一并豁免（那是必须被守的点）。
 */
const REPLACE_GUARD_EXEMPT_FILE = 'src/app/memory-vault/MemoryVault.ts';
/** 锚点重建的列指纹：`source_type` 是锚点写入独有的列（write()/writeMemory() 均无）
 *  注：不能用参数值 'user.misc.default' 作指纹 —— 它是**参数**，不在 SQL 字面量里。 */
const REPLACE_GUARD_ANCHOR_MARKER = 'source_type';

describe('[D8-全表] INSERT OR REPLACE 列清单不得缺失已登记的关键列', () => {
  it('扫描 src/** 全部 REPLACE 写入点，列清单必须包含该表登记的关键列', () => {
    const offenders: string[] = [];
    let scanned = 0;
    let exempted = 0;
    for (const file of walkTs(SRC)) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      const src = readFileSync(file, 'utf-8');
      for (const lit of extractLogicalStrings(src)) {
        const m = /INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z_][\w$]*)\s*\(([^)]*)\)/i.exec(lit.text);
        if (!m) continue;
        const table = m[1];
        const critical = REPLACE_CRITICAL_COLUMNS[table];
        if (!critical) continue; // 未登记的表不做要求（但可在此登记以纳入守卫）
        const cols = m[2].split(',').map((c) => c.trim());
        if (rel === REPLACE_GUARD_EXEMPT_FILE || cols.includes(REPLACE_GUARD_ANCHOR_MARKER)) { exempted++; continue; }
        scanned++;
        const missing = critical.filter((c) => !cols.includes(c));
        if (missing.length) {
          offenders.push(
            `${rel}:${lit.line}  INSERT OR REPLACE INTO ${table} 缺 [${missing.join(', ')}]\n` +
              `      → REPLACE = DELETE+INSERT，未列出的列会被静默置 NULL（该表有确定性 id 时每次重写都抹一次）`,
          );
        }
      }
    }
    console.log(
      `[D8-全表] 受检 REPLACE 写入点 = ${scanned} 个（另豁免 ${exempted} 个），覆盖表: ${Object.keys(REPLACE_CRITICAL_COLUMNS).join(', ')}`,
    );
    expect(scanned, '未扫描到任何受登记的 REPLACE 写入点，守卫可能失效').toBeGreaterThan(0);
    expect(offenders, `以下 REPLACE 写入点列清单不完整（会静默抹字段）：\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('[C4] 跨表同概念列名（entity_names / fg_entity_names）使用点必须登记', () => {
  const COLS = ['entity_names', 'fg_entity_names'];
  const discovered = new Map<string, number[]>();
  for (const file of walkTs(SRC)) {
    const rel = relative(REPO, file).replace(/\\/g, '/');
    for (const lit of extractLogicalStrings(readFileSync(file, 'utf-8'))) {
      for (const col of COLS) {
        if (new RegExp(`\\b${col}\\b`).test(lit.text)) {
          const key = `${rel}|${col}`;
          if (!discovered.has(key)) discovered.set(key, []);
          discovered.get(key)!.push(lit.line);
        }
      }
    }
  }

  it('无「未登记」的列名使用点', () => {
    const fresh = [...discovered.keys()].filter((k) => !ENTITY_NAME_COLUMN_REGISTRY.has(k));
    expect(
      fresh,
      `以下文件出现了 entity_names / fg_entity_names 但未登记目标表。\n` +
        `请确认其 SQL 实际打向哪张表（memories 只有 fg_entity_names！）并加入 ENTITY_NAME_COLUMN_REGISTRY:\n  ${fresh.join('\n  ')}`,
    ).toEqual([]);
  });

  it('无「已登记但已消失」的条目（防登记表腐化）', () => {
    const stale = [...ENTITY_NAME_COLUMN_REGISTRY.keys()].filter((k) => !discovered.has(k));
    expect(stale, `登记表腐化：以下条目在源码中已不再出现，请移除或修正:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('登记声明的目标表确实含该列（反向验证登记真实性）', () => {
    const dbs = DB_PATHS.filter(([, p]) => existsSync(p)).map(([n, p]) => [n, new Database(p, { readonly: true })] as const);
    const bad: string[] = [];
    for (const [key, table] of ENTITY_NAME_COLUMN_REGISTRY) {
      const col = key.split('|')[1];
      const has = dbs.some(([, db]) => {
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        return cols.includes(col);
      });
      if (!has) bad.push(`${key} → 声明的表 ${table} 并没有 ${col} 列`);
    }
    for (const [, db] of dbs) db.close();
    expect(bad, `登记表声明与实际 schema 不符:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
/**
 * 词法扫描器夹具单测（S4 评审 P2-3）：假阴性比假阳性更危险 —— 漏检就失去防护。
 * 这六条钉住已知会让引号配对失同步的构造。
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

/**
 * [D8v2-表级全覆盖] 所有写入形态的关键列守卫（2026-09-19）
 * ========================================================
 * 事故来源：`black_diamond.dna_root_id` 全库 0/390 覆盖。
 *
 * 根因不是「谁忘了写一列」，而是 [D8-全表] 守卫的**扫描范围只有一半**：
 * 它的正则 `/INSERT\s+OR\s+REPLACE\s+INTO/` 只认 REPLACE 形态，而全仓普通
 * `INSERT INTO` 有 49 处、覆盖 30 张表 —— 这半边写入路径的列清单不受任何守卫约束。
 * dna_root_id 的四条写入路径全部落在盲区里：
 *
 *   ├ VaultManager.addBlackDiamond      `INSERT INTO`       → 不在扫描范围 ✗
 *   ├ BlackDiamondGate.manualAdd        `INSERT INTO`       → 不在扫描范围 ✗
 *   ├ FamilyGraph.syncToBlackDiamond ①  `INSERT OR REPLACE` → 扫到，但该列未登记 ✗
 *   └ FamilyGraph.syncToBlackDiamond ②  `INSERT OR REPLACE` → 扫到，但该列未登记 ✗
 *   ⇒ 四条全缺 ⇒ 0% 是必然，不是巧合。
 *
 * 活体标本（打补丁之弊）：`FamilyGraph.ts:5390` 注释记载 2026-09-11 刚在此处修过
 * **belong_entity_uuid**（「webui 每次启动使 32 条关系镜像丢失归属，黑钻标注率
 * 91.2% → 76.5%」）—— 而**同一行的 dna_root_id 继续缺**。因为守卫只保护登记过的列：
 * 没登记的列，在守卫眼里不存在。
 *
 * 本守卫把范围从「语句类型」升级为「表 + 全部写入形态」：INSERT / INSERT OR REPLACE /
 * INSERT OR IGNORE 三者后果等价（目标列为 NULL），且普通 INSERT **更隐蔽** —— 它从不
 * 重写已有行，字段只是「从来没被写进去过」，因此永远不会被观察到「被抹掉」。
 *
 * 🔴 2026-09-19 批 3：**已转 fail-closed**（REPORT_ONLY = false）。存量违规经批 1/2/3
 *    由 28 处 → **0 处**（真缺陷全部收口到单一写入口；余下 3 类非缺陷已按显式路径豁免）。
 *    自此本用例从「只报不管」转为回归防线：新增违规即测试失败。
 *
 * 🔴 2026-09-19 v2 判据修订（存量复核结论）
 * ---------------------------------------
 * v1 的 28 处清单里，**17 处是判据误报**，只有 11 处是真实缺陷。误报集中三类：
 *   ① 跨库同名表（MemoryVault 的 memories 打向 vault.db，登记的 6 个 fusion 列在该库不存在）
 *   ② 两阶段写入器（entities / nodes 的身份列由户籍回填链路补齐，写入点只能建占位行）
 *   ③ 派生索引回填（MigrationManager 的 n-gram 重建，归属由源表承载 + 权威写入方补齐）
 * 误报的代价不是「多报几条」——它会**诱导对两阶段写入器做破坏性补列**（在无户籍信息时
 * 编造 uuid / 给索引行硬塞归属），因此判据必须按写入路径形态拆分豁免（见 SITE_EXEMPTIONS
 * 与 DEFERRED_COLUMNS），且豁免登记必须有**反向断言**兜底。
 */

/** 报告模式开关：true = 只报告不失败（存量摸底期）；false = fail-closed（存量清零后切换）
 *  🔴 2026-09-19 批 3：已置 **false** —— 存量违规经批 1/2/3 后由 28 处 → 0 处，
 *  且每类豁免均有反向断言兜底（见下方《[D8v2-判据] 豁免登记表必须有真实依据》）。
 *  自此本用例从「只报不管」转为回归防线：**新增违规即测试失败**。
 *  剩余 3 类非缺陷均已按显式路径豁免登记（schema-fingerprint / 延迟分配列 / derived-index），
 *  不在 offenders 之内。 */
const REPORT_ONLY = false;

/**
 * 表 → 该表**所有写入形态**都必须携带的关键列（未列出 ⇒ 静默为 NULL）。
 *
 * 登记判据：该列承载**身份 / 归属 / 溯源**语义，且在系统中有真实消费方（被读）。
 * 无消费方的列不登记 —— 避免登记表膨胀成形式主义。
 * 不登记的表：entity_relations（无任何身份列）、master_* / hwg_* / temporal_events /
 * decay_log / hallucination_log / retrieval_log（独立子系统）、black_diamond_terms /
 * knowledge_chunks / memory_entities（纯关联表）。
 */
const TABLE_CRITICAL_COLUMNS: Record<string, readonly string[]> = {
  // 核心记忆表：复用 m2 侧的身份列定义（单一事实源，不重复列举 6 个字面量）
  memories: [...MEMORY_IDENTITY_CRITICAL_COLUMNS],
  // 黑钻库：dna_root_id = 金库→黑钻的溯源锚点（本轮事故主角）
  black_diamond: ['belong_entity_uuid', 'dna_root_id'],
  // 砂金库：dna_root_id = 对话链溯源锚点；message_id = 业务幂等键
  conversations: ['belong_entity_uuid', 'entity_names', 'dna_root_id', 'message_id'],
  // 知识库：V3.2 户籍卷宗归档
  knowledge_base: ['belong_entity_uuid'],
  // 三库操作日志：V13 归属标注
  vault_log: ['belong_entity_uuid'],
  // 实体表：V5.0 TXS-ID 户籍标识（无它无法参与户籍体系）
  entities: ['uuid'],
  // 统一语义搜索索引：V11.0 实体归属
  search_index: ['belong_entity_uuid'],
  // FG 节点表（family_graph.db）：节点身份
  nodes: ['uuid'],
};

/**
 * 按**写入路径**豁免（v2：粒度细到路径形态，三类形态各用各的判据）。
 *
 * 判据（kind 互斥，命中即豁免 `columns`）：
 *   column-present      列清单中出现 `marker` 特征列 ⇒ 该写入路径豁免
 *   schema-fingerprint  列清单中出现 `marker` 列 ⇒ 证实本写入打向**另一套 schema 的同名表**
 *                       ⇒ 整表豁免（用列指纹自证库身份，不靠文件路径猜）
 *   derived-index       语句文本（空白归一化后）含 `marker` ⇒ 派生/索引回填路径 ⇒ 豁免
 *
 * `columns: '*'` = 豁免该表全部登记列；否则只豁免列举的列。
 * 一律用**指纹**而非文件级豁免，以免同文件里的其它写入路径被顺带放行。
 */
const SITE_EXEMPTIONS: ReadonlyArray<{
  kind: 'column-present' | 'schema-fingerprint' | 'derived-index';
  table: string;
  columns: readonly string[] | '*';
  marker: string;
  reason: string;
}> = [
  {
    kind: 'column-present',
    table: 'black_diamond',
    columns: ['dna_root_id'],
    marker: 'entry_channel',
    reason:
      'FG 同步路径（FamilyGraph.syncToBlackDiamond）的 source_id 恒为 null，dna_root_id ' +
      '本就无从获取，NULL 是正确值；该路径列清单显式含 entry_channel。而 ' +
      "VaultManager.addBlackDiamond 走 DEFAULT 'auto'、列清单不含该列 ⇒ 指纹天然区分，" +
      '不会被误豁免（它才是真正丢了值的路径）。',
  },
  {
    kind: 'schema-fingerprint',
    table: 'memories',
    columns: '*',
    marker: 'perception_json',
    reason:
      'MemoryVault 写的是**独立库** data/memory-vault/vault.db，该表由 MemoryVault.ts 自建，' +
      'schema 为 11 列（id,type,created_at,perception_json,calcium_score,calcium_level,raw_input,' +
      'locus_path,strength,recall_count,last_recalled_at），本守卫登记的 6 个 fusion 列在该库' +
      '**不存在**，结构上不可能携带。指纹 perception_json：fusion.memories 已在 V12.4 迁移中 ' +
      'DROP COLUMN，只有 vault 库的 memories 保留它（全仓已 grep 确认唯一命中）。' +
      '同仓 [D8-全表] 守卫已用 REPLACE_GUARD_EXEMPT_FILE 豁免同一行 —— 此前两个守卫对同一点判定相反，本条即对齐。',
  },
  {
    kind: 'derived-index',
    table: 'search_index',
    columns: '*',
    marker: 'INSERT OR IGNORE INTO search_index(term, source_type, source_id)',
    reason:
      'MigrationManager v10 的 n-gram 存量回填（term 粒度，一行一个三元组，INSERT OR IGNORE ' +
      '不覆盖已有行）。索引行的归属由**源表**承载，并由权威写入方 SearchIndexBuilder.indexDocument ' +
      '（INSERT OR REPLACE ... belong_entity_uuid, position）补齐；实测 search_index 中 ' +
      "source_type='memory' 的 337,021 行归属缺失数为 0。注意本指纹**不含**权威写入方" +
      '（它是 REPLACE + 带空格写法），故 Statement 侧仍受守卫约束。',
  },
];

/**
 * 延迟分配列（两阶段写入）—— 列值由独立的分配/回填链路补齐，不是写入点的职责。
 * ================================================================================
 * 登记判据（三条必须同时成立，缺一不得登记）：
 *   ① 列语义是「身份编号」，值域由分配器决定（TXS-xxxx），写入点无法就地产生合法值；
 *   ② 全仓存在真实的 UPDATE 回填写入点 —— 由文件末尾《延迟分配列回填方存在性》用例
 *      **反向断言**，回填写入点一旦消失该用例立即失败（防登记表腐化，与
 *      ENTITY_NAME_COLUMN_REGISTRY 的「登记但已消失 → 失败」同源防线）；
 *   ③ 该列的不为空率由回填链路负责，而非各写入点。
 *
 * ⚠️ 这不是「放行」：它把校验点从「每个 INSERT 的列清单」迁移到「回填链路是否存活」。
 * ⚠️ 已知残余风险（不隐藏）：person 类实体若始终未进入户籍回填链路，其 entities.uuid 会
 *    长期为 NULL（实测 919 个 person 中 378 个为 NULL）。该问题属**回填链路覆盖率**，
 *    不由写入点列清单解决，需另行专项跟踪，不得以此豁免掩盖。
 */
const DEFERRED_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  /** 格式 `<相对路径>|<SQL 片段>`；片段必须能在源码中直接 grep 到（反向断言用） */
  backfillWriters: readonly string[];
  reason: string;
}> = [
  {
    table: 'entities',
    column: 'uuid',
    backfillWriters: [
      'src/m2/SQLiteAdapter.ts|UPDATE entities SET uuid = ?',
      'src/m2/FusionStorageAdapter.ts|UPDATE entities SET uuid = ?',
    ],
    reason:
      'TXS-ID 由户籍链路分配，写入点只能先建占位行（INSERT (name,type)）再由 UPDATE 回填。' +
      '实测 entities 1314 行中 uuid 非空 541 条**全为 person**，object 370 / emotion 12 / ' +
      'event 10 / place 2 / self 1 全部为 NULL —— 非 person 类型本就不分配 uuid，' +
      '把 uuid 当所有实体 INSERT 的必填列是判据错误。回填方：SQLiteAdapter.ensureEntity ' +
      "（同函数内 UPDATE ... AND uuid IS NULL）与 FusionStorageAdapter.setFamilyGraph " +
      "（启动期全量回填 WHERE type='person'）。2026-09-11 豁免文档已横向核验" +
      '「全仓 INSERT INTO entities (name,type) 是既定惯例」。',
  },
  {
    table: 'nodes',
    column: 'uuid',
    backfillWriters: [
      'src/m4/household/FamilyGraph.ts|UPDATE nodes SET uuid = ?',
      'src/m4/household/FamilyGraph.ts|UPDATE nodes SET uuid = ?, legacy_ids = ?',
    ],
    reason:
      'FG 户籍编号同为两阶段：migrateToV3() 为存量 person 节点补号、V5 迁移重编号，均为 UPDATE ' +
      '回填；带 uuid 的 INSERT 路径（addNode / ensureMe 等 14-15 列写法）不受影响。' +
      '实测 family_graph.nodes 中 447 个 person 节点 uuid 100% 非空 ⇒ 回填链路存活。',
  },
];

describe('[D8v2-表级全覆盖] 所有写入形态的列清单必须携带该表登记的关键列', () => {
  it('扫描 INSERT / OR REPLACE / OR IGNORE 全部写入形态', () => {
    const offenders: string[] = [];
    const exempted: string[] = [];
    const deferred: string[] = [];
    /** 实际被扫到的「已登记关键列」表名 —— 用于检出**零命中的死登记项**（见末尾断言） */
    const hitTables = new Set<string>();
    let scanned = 0;
    let skipped = 0;

    for (const file of walkTs(SRC)) {
      const rel = relative(REPO, file).replace(/\\/g, '/');
      const src = readFileSync(file, 'utf-8');
      for (const lit of extractLogicalStrings(src)) {
        // 规则 3：含 ${} 插值的动态 SQL 无法静态判定列清单，跳过
        if (lit.text.includes('${')) continue;
        // 放宽后的写入点识别：INSERT / INSERT OR REPLACE / INSERT OR IGNORE 全形态
        const w = /INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+([A-Za-z_][\w$]*)\s*\(([^)]*)\)/i.exec(
          lit.text,
        );
        if (!w) continue;
        const table = w[1];
        const critical = TABLE_CRITICAL_COLUMNS[table];
        if (!critical) {
          skipped++;
          continue;
        }
        // 拼接式 SQL 会产生 `" +\n "col` 这类 token → 剥引号与加号（与既有守卫同源处理）
        const cols = w[2]
          .split(',')
          .map((c) => c.replace(/["'`+]/g, '').trim())
          .filter(Boolean);
        scanned++;
        hitTables.add(table);
        /** 语句文本（空白归一化）—— derived-index 指纹在此上匹配 */
        const norm = lit.text.replace(/\s+/g, ' ');

        const missing: string[] = [];
        for (const col of critical) {
          if (cols.includes(col)) continue;
          // 延迟分配列：值由回填链路负责，写入点不承担（回填方存在性由反向断言兜底）
          if (DEFERRED_COLUMNS.some((d) => d.table === table && d.column === col)) {
            deferred.push(`${rel}:${lit.line}  ${table}.${col}`);
            continue;
          }
          const ex = SITE_EXEMPTIONS.find(
            (e) =>
              e.table === table &&
              (e.columns === '*' || e.columns.includes(col)) &&
              (e.kind === 'derived-index' ? norm.includes(e.marker) : cols.includes(e.marker)),
          );
          if (ex) {
            exempted.push(`${rel}:${lit.line}  ${table} 缺 [${col}]（${ex.kind} 豁免：${ex.marker}）`);
            continue;
          }
          missing.push(col);
        }
        if (missing.length) {
          offenders.push(`${rel}:${lit.line}  ${table} 缺 [${missing.join(', ')}]`);
        }
      }
    }

    console.log(
      `[D8v2] 受检写入点 = ${scanned} 个（未登记表跳过 ${skipped} 个），覆盖表: ${Object.keys(TABLE_CRITICAL_COLUMNS).join(', ')}`,
    );
    if (exempted.length) {
      console.log(`[D8v2] 路径豁免 ${exempted.length} 处:\n  ` + exempted.join('\n  '));
    }
    if (deferred.length) {
      console.log(
        `[D8v2] 延迟分配列（由回填链路负责，非写入点职责）${deferred.length} 处:\n  ` +
          [...new Set(deferred.map((d) => d.replace(/:\d+/, '')))].join('\n  '),
      );
    }
    console.log(
      `[D8v2] 存量违规 ${offenders.length} 处${REPORT_ONLY ? '（⚠️ 报告模式，本轮不失败）' : ''}:\n  ` +
        (offenders.join('\n  ') || '(无)'),
    );

    // 防「扫描器失效 → 空转通过」：与既有守卫同源的防线
    expect(scanned, '未扫描到任何受登记表的写入点，守卫可能失效').toBeGreaterThan(0);

    // 🔴 2026-09-19 批 4：**单表零命中**检测。
    //   动机（实测事故）：把 conversations 的列清单收口成 `cols.join(', ')` 运行时拼接后，
    //   本扫描器（文本扫描，且显式跳过含 ${} 的语句）就再也看不到它 —— 登记项静默失效，
    //   而全局的 scanned>0 断言拦不住“只剩其它表有命中”的情况。
    //   现要求：每个登记表要么被本扫描器命中，要么在 RUNTIME_JOINED_TABLES 里显式登记
    //   并注明由哪个语义测试覆盖（登记 ≠ 有效防线，必须写清楚）。
    const RUNTIME_JOINED_TABLES = new Set(['conversations']);
    const deadRegistrations = Object.keys(TABLE_CRITICAL_COLUMNS).filter(
      (t) => !hitTables.has(t) && !RUNTIME_JOINED_TABLES.has(t),
    );
    expect(
      deadRegistrations,
      '以下登记表在本次扫描中**零命中** ⇒ 其列清单已不受本守卫保护（很可能被改成了模板/拼接 SQL）。' +
        '若属于“运行时拼接”的合法情形，请加入 RUNTIME_JOINED_TABLES 并注明由哪个语义测试覆盖：\n  ' +
        deadRegistrations.join('\n  '),
    ).toEqual([]);

    if (!REPORT_ONLY) {
      expect(
        offenders,
        `以下写入点缺少登记的关键列（该列将恒为 NULL）:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
    }
  });
});

/**
 * [D8v2-判据] 豁免登记表必须有真实依据
 * =========================================
 * 豁免是守卫的**放行口**，一旦登记腐化就会变成静默漏洞（这正是 v1 判据误报与「登记表无人校验」
 * 的教训）。本组用例对三类豁免做**反向断言**：登记的每一个依据都必须能在源码/真实 schema 里被证实。
 */
describe('[D8v2-判据] 豁免登记表必须有真实依据（防登记腐化 → 静默放行）', () => {
  it('延迟分配列的每一处回填写入点都真实存在于源码', () => {
    const bad: string[] = [];
    for (const d of DEFERRED_COLUMNS) {
      if (!d.backfillWriters.length) {
        bad.push(`${d.table}.${d.column}: 未登记任何回填写入点 ⇒ 该列无人回填，豁免不成立`);
        continue;
      }
      for (const w of d.backfillWriters) {
        const ci = w.indexOf('|');
        const relPath = w.slice(0, ci);
        const frag = w.slice(ci + 1);
        const abs = join(REPO, relPath);
        if (!existsSync(abs)) {
          bad.push(`${d.table}.${d.column}: 回填文件不存在 ${relPath}`);
          continue;
        }
        if (!readFileSync(abs, 'utf-8').includes(frag)) {
          bad.push(`${d.table}.${d.column}: ${relPath} 中已找不到回填片段 \`${frag}\``);
        }
      }
    }
    expect(
      bad,
      '延迟分配列的登记已腐化（回填写入点消失 ⇒ 该列从此无人回填，豁免退化为放行口）:\n  ' + bad.join('\n  '),
    ).toEqual([]);
  });

  it('schema-fingerprint 豁免的指纹列确实只在「另一套 schema」的库里出现', () => {
    const dbs = DB_PATHS.filter(([, p]) => existsSync(p)).map(
      ([n, p]) => [n, new Database(p, { readonly: true })] as const,
    );
    const bad: string[] = [];
    for (const e of SITE_EXEMPTIONS) {
      if (e.kind !== 'schema-fingerprint') continue;
      const critical = TABLE_CRITICAL_COLUMNS[e.table] ?? [];
      const hits = dbs.filter(([, db]) => {
        const cols = (db.prepare(`PRAGMA table_info(${e.table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
        // 佐证成立的条件：该库的这张表【有指纹列】且【缺至少一个登记列】⇒ 确属另一套 schema
        return cols.includes(e.marker) && critical.some((c) => !cols.includes(c));
      });
      if (!hits.length) {
        bad.push(
          `${e.table} 的 schema-fingerprint 豁免（指纹 ${e.marker}）在现有库中已无佐证：` +
            '没有任何库同时满足「含指纹列」且「缺登记列」。' +
            '若另一套 schema 已被合并/移除，请删除本条豁免而非留作放行口。',
        );
      }
    }
    for (const [, db] of dbs) db.close();
    expect(bad, bad.join('\n  ')).toEqual([]);
  });

  it('derived-index 豁免的语句指纹必须真能命中（否则是空豁免）', () => {
    const hits: string[] = [];
    for (const e of SITE_EXEMPTIONS) {
      if (e.kind !== 'derived-index') continue;
      let n = 0;
      for (const file of walkTs(SRC)) {
        for (const lit of extractLogicalStrings(readFileSync(file, 'utf-8'))) {
          if (lit.text.replace(/\s+/g, ' ').includes(e.marker)) n++;
        }
      }
      hits.push(`${e.table}: 指纹命中 ${n} 处`);
      if (n === 0) hits.push(`  ✗ ${e.table} 的 derived-index 指纹 \`${e.marker}\` 已无命中 → 请删除该豁免`);
    }
    console.log('[D8v2-判据] derived-index 指纹命中核验:\n  ' + hits.join('\n  '));
    expect(
      hits.filter((h) => h.trim().startsWith('✗')).length,
      '存在空豁免（指纹已无命中）—— 空豁免会掩盖未来的真实缺陷，必须删除:\n  ' + hits.join('\n  '),
    ).toBe(0);
  });
});
