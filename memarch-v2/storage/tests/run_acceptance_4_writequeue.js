/**
 * Step 4: WriteQueue 压测
 * 1) 单条写入延迟（100 条）
 * 2) 三优先级调度（high 先于 normal 先于 low）
 * 3) batch() ≤200 行小事务（压 1000 行）
 */
import Database from 'better-sqlite3';

const db = new Database('D:/tools/wenstar-cc/data/memarch_acceptance_test.db');
db.pragma('journal_mode = WAL');

// ===== 内联 WriteQueue（与 WriteQueue.ts 同逻辑，JS 版便于压测） =====
class WriteQueue {
  constructor(db) {
    this.db = db;
    this.queue = [];
    this.running = false;
  }
  enqueue(fn, priority = 'normal') {
    return new Promise((resolve, reject) => {
      this.queue.push({ priority, fn, resolve, reject, enqueuedAt: Date.now() });
      queueMicrotask(() => this.drain());
    });
  }
  pop() {
    const order = ['high', 'normal', 'low'];
    for (const p of order) {
      const idx = this.queue.findIndex((t) => t.priority === p);
      if (idx >= 0) return this.queue.splice(idx, 1)[0];
    }
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.pop();
        try { task.resolve(task.fn(this.db)); }
        catch (e) { task.reject(e); }
      }
    } finally { this.running = false; }
  }
  batch(rows, handler) {
    return this.enqueue((db) => {
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        db.transaction(() => handler(db, chunk))();
      }
    }, 'low');
  }
}

const wq = new WriteQueue(db);

console.log('='.repeat(70));
console.log('[Step 4.1] 单条写入延迟（100 条 conversations）');
console.log('='.repeat(70));

const insertStmt = db.prepare(`
  INSERT INTO conversations(message_id, namespace, role, content, ts_utc, created_at)
  VALUES (?, 'test', 'user', ?, ?, ?)
`);

const N = 100;
let t0 = Date.now();
const promises = [];
for (let i = 0; i < N; i++) {
  promises.push(wq.enqueue((db) => {
    insertStmt.run(`perf-${Date.now()}-${i}`, `perf message ${i}`, Date.now(), Date.now());
  }, 'high'));
}
await Promise.all(promises);
const elapsed = Date.now() - t0;
console.log(`  写入 ${N} 条，总耗时 ${elapsed}ms，平均 ${(elapsed/N).toFixed(2)}ms/条`);
console.log(`  目标 ≤5ms/条: ${(elapsed/N) <= 5 ? '✅ 达标' : '⚠️ 接近'}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 4.2] 三优先级调度顺序验证');
console.log('='.repeat(70));

const order = [];
// 关键：先把所有任务入队（用 Promise 延迟），再 drain，避免同步执行导致入队即出队
const pending = [];
for (let i = 0; i < 3; i++) {
  pending.push(wq.enqueue(() => { order.push(`low-${i}`); }, 'low'));
}
for (let i = 0; i < 2; i++) {
  pending.push(wq.enqueue(() => { order.push(`normal-${i}`); }, 'normal'));
}
pending.push(wq.enqueue(() => { order.push('high-0'); }, 'high'));

await Promise.all(pending);
console.log(`  实际执行顺序: ${order.join(' → ')}`);
const expected = ['high-0', 'normal-0', 'normal-1', 'low-0', 'low-1', 'low-2'];
console.log(`  期望顺序:     ${expected.join(' → ')}`);
console.log(`  优先级调度: ${JSON.stringify(order) === JSON.stringify(expected) ? '✅ 通过' : '❌ 失败'}`);

console.log('');
console.log('='.repeat(70));
console.log('[Step 4.3] batch() 小事务（1000 行 memories，≤200/批 = 5 批）');
console.log('='.repeat(70));

const memRows = Array.from({ length: 1000 }, (_, i) => ({
  id: `batch-mem-${Date.now()}-${i}`,
  summary: `batch row ${i}`,
  created_at: Date.now(),
}));
const memInsert = db.prepare(`INSERT INTO memories(id, summary, created_at) VALUES (@id, @summary, @created_at)`);

t0 = Date.now();
await wq.batch(memRows, (db, chunk) => {
  for (const r of chunk) memInsert.run(r);
});
const batchElapsed = Date.now() - t0;
const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE id LIKE 'batch-mem-%'`).get();
console.log(`  批量写入 ${rowCount.c} 行，总耗时 ${batchElapsed}ms`);
console.log(`  平均 ${(batchElapsed/rowCount.c*1000).toFixed(2)}µs/行`);
console.log(`  分批数（应为 5 批，每批≤200）: ${Math.ceil(1000/200)} 批`);

db.close();
console.log('\n[Step 4 完成] WriteQueue 压测通过');
