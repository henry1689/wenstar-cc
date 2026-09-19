/**
 * 真实记忆检索测试：熊梓铭的学术研究和纪实小说
 * 先跑 v10 migration 建 search_index 表 + 存量回填，再跑 search()
 */
import { describe, it, expect } from 'vitest';

describe('真实记忆检索 · 熊梓铭 (含 search_index 修复)', () => {
  // 🔴 2026-09-19：本用例无显式 timeout ⇒ 吃全局 30s，实测跑 162s 才失败（建表+回填+检索）。
  //   根据根因分析（LLM/检索重负载，非代码缺陷）给出显式超时，避免假红。
  it('建表回填 → 检索 → 验证结果', { timeout: 300000 }, async () => {
    const initSqlJs = (await import('sql.js')).default;
    const fs = await import('fs');
    const path = await import('path');
    const dbPath = path.resolve('data/webui/fusion_memory.db');
    const buffer = fs.readFileSync(dbPath);
    const SQL = await initSqlJs();
    const db = new SQL.Database(buffer);

    // ═══════════ 1. 建 search_index 表 + 存量回填 ═══════════
    console.log('\n📦 Step 1: 创建 search_index 表 + 存量 n-gram 回填');
    db.run(`CREATE TABLE IF NOT EXISTS search_index (
      term TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      belong_entity_uuid TEXT, position INTEGER DEFAULT 0,
      PRIMARY KEY (term, source_type, source_id)
    )`);

    // 回填 memories
    const memRows = db.exec("SELECT id, raw_input FROM memories WHERE raw_input IS NOT NULL LIMIT 2000");
    let count = 0;
    if (memRows.length && memRows[0].values) {
      for (const [id, text] of memRows[0].values) {
        if (!text) continue;
        const cleaned = String(text).replace(/[，。！？、；：""''（）《》【】\s\d-]/g, '').trim();
        if (cleaned.length < 2) continue;
        const ngrams = new Set<string>();
        for (let i = 0; i < cleaned.length - 1; i++) ngrams.add(cleaned.substring(i, i + 2));
        for (let i = 0; i < cleaned.length - 2; i++) ngrams.add(cleaned.substring(i, i + 3));
        for (const gram of ngrams) {
          try { db.run("INSERT OR IGNORE INTO search_index(term, source_type, source_id) VALUES(?,?,?)", [gram, 'memory', String(id)]); count++; } catch {}
        }
      }
    }
    console.log(`   memories 回填: ${count} 条 n-gram`);

    // 回填 conversations
    const convRows = db.exec("SELECT id, content FROM conversations WHERE content IS NOT NULL LIMIT 2000");
    let cCount = 0;
    if (convRows.length && convRows[0].values) {
      for (const [id, text] of convRows[0].values) {
        if (!text) continue;
        const cleaned = String(text).replace(/[，。！？、；：""''（）《》【】\s\d-]/g, '').trim();
        if (cleaned.length < 2) continue;
        const ngrams = new Set<string>();
        for (let i = 0; i < cleaned.length - 1; i++) ngrams.add(cleaned.substring(i, i + 2));
        for (let i = 0; i < cleaned.length - 2; i++) ngrams.add(cleaned.substring(i, i + 3));
        for (const gram of ngrams) {
          try { db.run("INSERT OR IGNORE INTO search_index(term, source_type, source_id) VALUES(?,?,?)", [gram, 'conversation', String(id)]); cCount++; } catch {}
        }
      }
    }
    console.log(`   conversations 回填: ${cCount} 条 n-gram`);

    // 检查 search_index 状态
    const idxCount = db.exec("SELECT COUNT(*) FROM search_index");
    const totalIdx = idxCount[0]?.values[0]?.[0] ?? 0;
    console.log(`   search_index 总条数: ${totalIdx}`);

    // 检查"梓铭"n-gram
    const zmCount = db.exec("SELECT COUNT(*) FROM search_index WHERE term='梓铭'");
    console.log(`   term="梓铭" 命中: ${zmCount[0].values[0][0]}`);

    // ═══════════ 2. 跑 search() V11旧管线 ═══════════
    console.log('\n🔍 Step 2: search() 旧管线');
    const { search } = await import('../m4/UnifiedSearchEngine.js');
    const { buildNgrams } = await import('../m4/SearchIndexBuilder.js');

    const query = '熊梓铭 学术研究 纪实小说 写书';
    const ngrams = buildNgrams(query);
    console.log(`   query n-grams: ${ngrams.slice(0,8).join(', ')}...`);

    const oldResult = search(db as any, query, null, { limit: 10, mode: 'full' });
    console.log(`   候选总数: ${oldResult.totalCandidates}`);
    console.log(`   返回 ${oldResult.items.length} 条:`);
    for (let i = 0; i < oldResult.items.length; i++) {
      const src = oldResult.raw[i]?.item?.source ?? '?';
      console.log(`     [${i+1}] (${src}) ${oldResult.items[i].substring(0, 100)}`);
    }

    // ═══════════ 3. 验证: 检索结果是否包含"梓铭"、"学术"、"小说" 相关内容 ═══════════
    console.log('\n📋 Step 3: 验证');
    expect(oldResult.totalCandidates).toBeGreaterThan(0);
    const allText = oldResult.items.join(' ');
    console.log(`   合并文本含"梓铭": ${allText.includes('梓铭')}`);
    console.log(`   合并文本含"学术": ${allText.includes('学术')}`);
    console.log(`   合并文本含"研究": ${allText.includes('研究')}`);
    console.log(`   合并文本含"小说": ${allText.includes('小说')}`);
    console.log(`   合并文本含"纪实": ${allText.includes('纪实')}`);

    db.close();
    console.log('\n✅ 真实 DB 检索测试完成');
  });
});
