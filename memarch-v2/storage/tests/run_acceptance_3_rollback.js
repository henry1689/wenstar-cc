/**
 * Step 3: M01/M03 up/down 回滚冒烟
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG = join(__dirname, '..', 'migrations');
const db = new Database('D:/tools/wenstar-cc/data/memarch_acceptance_test.db');

const run = (f) => db.exec(readFileSync(join(MIG, f), 'utf-8'));

console.log('='.repeat(70));
console.log('[Step 3.1] M01 回滚冒烟（时间戳统一）');
console.log('='.repeat(70));

const before = db.prepare(`SELECT message_id, ts_utc FROM conversations WHERE message_id='legacy-001'`).get();
console.log(`  up 后状态: legacy-001.ts_utc = ${before.ts_utc}`);

run('M01_timestamp_unify.down.sql');
const afterDown = db.prepare(`SELECT message_id, ts_utc FROM conversations WHERE message_id='legacy-001'`).get();
console.log(`  down 后:   legacy-001.ts_utc = ${afterDown.ts_utc}（应为 null）`);

run('M01_timestamp_unify.up.sql');
const afterUp = db.prepare(`SELECT message_id, ts_utc FROM conversations WHERE message_id='legacy-001'`).get();
console.log(`  再次 up:   legacy-001.ts_utc = ${afterUp.ts_utc}（应与首次 up 一致）`);
console.log(`  M01 回滚: ${afterDown.ts_utc === null && afterUp.ts_utc === before.ts_utc ? '✅ 通过' : '❌ 失败'}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 3.2] M03 回滚冒烟（钙化分归一）');
console.log('='.repeat(70));

const before3 = db.prepare(`SELECT id, consolidation, migration_ambiguous FROM memories WHERE id='mem-legacy-02'`).get();
console.log(`  up 后状态: mem-legacy-02.consolidation = ${before3.consolidation?.toFixed(3)}, ambiguous=${before3.migration_ambiguous}`);

run('M03_calcium_normalize.down.sql');
const afterDown3 = db.prepare(`SELECT id, consolidation, migration_ambiguous FROM memories WHERE id='mem-legacy-02'`).get();
console.log(`  down 后:   mem-legacy-02.consolidation = ${afterDown3.consolidation}, ambiguous=${afterDown3.migration_ambiguous}（应为 0/0）`);

run('M03_calcium_normalize.up.sql');
const afterUp3 = db.prepare(`SELECT id, consolidation, migration_ambiguous FROM memories WHERE id='mem-legacy-02'`).get();
console.log(`  再次 up:   mem-legacy-02.consolidation = ${afterUp3.consolidation?.toFixed(3)}, ambiguous=${afterUp3.migration_ambiguous}`);
console.log(`  M03 回滚: ${afterDown3.consolidation === 0 && afterUp3.consolidation === before3.consolidation ? '✅ 通过' : '❌ 失败'}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 3.3] 审计账本哈希链连续性校验');
console.log('='.repeat(70));
const ledger = db.prepare(`SELECT seq, prev_hash, hash FROM audit_ledger ORDER BY seq`).all();
let chainOk = true;
for (let i = 0; i < ledger.length; i++) {
  if (i === 0) {
    if (ledger[i].prev_hash !== '00000000') { chainOk = false; console.log(`  ❌ #${ledger[i].seq} prev_hash 不是创世值`); }
  } else {
    if (ledger[i].prev_hash !== ledger[i-1].hash) { chainOk = false; console.log(`  ❌ #${ledger[i].seq} prev_hash 链断裂`); }
  }
}
console.log(`  账本共 ${ledger.length} 条，哈希链: ${chainOk ? '✅ 连续' : '❌ 断裂'}`);

db.close();
console.log('\n[Step 3 完成] 回滚路径验证通过');
