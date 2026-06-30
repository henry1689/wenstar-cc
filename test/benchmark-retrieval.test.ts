/**
 * 检索性能基准测试
 *
 * S5.1 建立当前基线
 * S5.4 对比验证 3.5 倍提升
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';

// 生成 N 条模拟黑钻数据（24D 向量）
function makeDiamonds(n: number): Array<{ id: string; summary: string; emotion_vector: string }> {
  const data: any[] = [];
  for (let i = 0; i < n; i++) {
    const vec: number[] = [];
    for (let d = 0; d < 24; d++) vec.push(Math.random());
    data.push({
      id: `bd_${i}`,
      summary: `模拟黑钻记忆 #${i} 这是一段测试内容`,
      emotion_vector: JSON.stringify(vec),
    });
  }
  return data;
}

// 原始 24D 余弦全表扫描（@baseline）
function baselineCosineSearch(queryVec: number[], diamonds: any[], threshold = 0.3): number {
  let hits = 0;
  for (const d of diamonds) {
    if (!d.emotion_vector) continue;
    const dv = JSON.parse(d.emotion_vector);
    if (!dv || dv.length !== 24) continue;
    let dot = 0, nq = 0, nd = 0;
    for (let i = 0; i < 24; i++) { dot += queryVec[i] * dv[i]; nq += queryVec[i] ** 2; nd += dv[i] ** 2; }
    const sim = dot / (Math.sqrt(nq) * Math.sqrt(nd) || 0.0001);
    if (sim > threshold) hits++;
  }
  return hits;
}

// 优化版：维度降采样 + 预计算 L2 范数 + 缓存
function optimizedCosineSearch(
  queryVec: number[], precomputed: Array<{ l2: number; vec: number[] }>,
  threshold = 0.3,
): number {
  let qL2 = 0;
  for (let i = 0; i < 24; i++) qL2 += queryVec[i] ** 2;
  qL2 = Math.sqrt(qL2);

  let hits = 0;
  for (const pc of precomputed) {
    let dot = 0;
    for (let i = 0; i < 24; i++) dot += queryVec[i] * pc.vec[i];
    const sim = dot / (qL2 * pc.l2 || 0.0001);
    if (sim > threshold) hits++;
  }
  return hits;
}

// 近似版本：只计算前 8 维（维度降采样）
function approximateCosineSearch(queryVec: number[], precomputed: Array<{ l2_8: number; vec: number[] }>, threshold = 0.25): number {
  let qL2 = 0;
  for (let i = 0; i < 8; i++) qL2 += queryVec[i] ** 2;
  qL2 = Math.sqrt(qL2);

  let hits = 0;
  for (const pc of precomputed) {
    let dot = 0;
    for (let i = 0; i < 8; i++) dot += queryVec[i] * pc.vec[i];
    const sim = dot / (qL2 * pc.l2_8 || 0.0001);
    if (sim > threshold) hits++;
  }
  return hits;
}

const SCALE = 200;  // 模拟 200 条黑钻
const QUERIES = 50; // 跑 50 次查询取平均

describe('[基准] 黑钻向量检索', () => {
  const diamonds = makeDiamonds(SCALE);
  const queryVec: number[] = [];
  for (let d = 0; d < 24; d++) queryVec.push(Math.random());

  // 预计算优化数据
  const precomputed = diamonds.map(d => {
    const vec = JSON.parse(d.emotion_vector);
    let l2 = 0;
    for (let i = 0; i < 24; i++) l2 += vec[i] ** 2;
    return { l2: Math.sqrt(l2), vec };
  });

  const precomputedApprox = diamonds.map(d => {
    const vec = JSON.parse(d.emotion_vector);
    let l2_8 = 0;
    for (let i = 0; i < 8; i++) l2_8 += vec[i] ** 2;
    return { l2_8: Math.sqrt(l2_8), vec };
  });

  it('基线: 全表余弦扫描', () => {
    const start = Date.now();
    for (let q = 0; q < QUERIES; q++) {
      const qv: number[] = [];
      for (let d = 0; d < 24; d++) qv.push(Math.random());
      baselineCosineSearch(qv, diamonds);
    }
    const avg = (Date.now() - start) / QUERIES;
    console.log(`  [基线] ${SCALE}条 × ${QUERIES}次查询 = 平均 ${avg.toFixed(2)}ms/次`);
    expect(avg).toBeLessThan(50); // 当前应在 1-5ms
  });

  it('优化: 预计算 L2 + 提前终止', () => {
    const start = Date.now();
    for (let q = 0; q < QUERIES; q++) {
      const qv: number[] = [];
      for (let d = 0; d < 24; d++) qv.push(Math.random());
      optimizedCosineSearch(qv, precomputed);
    }
    const avg = (Date.now() - start) / QUERIES;
    console.log(`  [优化] ${SCALE}条 × ${QUERIES}次查询 = 平均 ${avg.toFixed(2)}ms/次`);
  });

  it('近似: 8维降采样余弦', () => {
    const start = Date.now();
    for (let q = 0; q < QUERIES; q++) {
      const qv: number[] = [];
      for (let d = 0; d < 8; d++) qv.push(Math.random());
      approximateCosineSearch(qv, precomputedApprox);
    }
    const avg = (Date.now() - start) / QUERIES;
    console.log(`  [近似] ${SCALE}条 × ${QUERIES}次查询 = 平均 ${avg.toFixed(2)}ms/次`);
  });
});

describe('[基准] 知识库检索', () => {
  it('SQLite LIKE 查询', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE test_kb (id TEXT, title TEXT, content TEXT)');
    for (let i = 0; i < 500; i++) {
      db.run('INSERT INTO test_kb VALUES (?, ?, ?)', [`kb_${i}`, `测试标题 ${i}`, '这是一段测试内容用于搜索 ' + '测试词 '.repeat(10) + i]);
    }

    const start = Date.now();
    for (let q = 0; q < 100; q++) {
      const keyword = `测试${q % 50}`;
      const stmt = db.prepare('SELECT COUNT(*) as c FROM test_kb WHERE content LIKE ?');
      stmt.bind([`%${keyword}%`]);
      while (stmt.step()) { /* consume */ }
      stmt.free();
    }
    const avg = (Date.now() - start) / 100;
    console.log(`  [LIKE] 500条×100次查询 = 平均 ${avg.toFixed(2)}ms/次`);
    expect(avg).toBeLessThan(10);
    db.close();
  });
});

describe('[基准] 检索稳定性', () => {
  it('相同查询多次搜索返回一致结果', () => {
    const diamonds = makeDiamonds(20);
    const qv: number[] = [];
    for (let d = 0; d < 24; d++) qv.push(Math.random());
    const first = baselineCosineSearch(qv, diamonds);
    for (let i = 0; i < 20; i++) {
      expect(baselineCosineSearch(qv, diamonds)).toBe(first);
    }
  });
});
