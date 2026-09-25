/**
 * SearchIndexBuilder — n-gram倒排索引构建器 (V11.0)
 * ==================================================
 * 对四层存储（砂金/金库/黑钻/知识库）的文本内容做中文2-3字n-gram切词，
 * 写入 search_index 表。提供增量索引和存量回填两个入口。
 *
 * n-gram仅作性能优化前置过滤器，不参与最终相关性排序。
 * 最终排序权完全交给 VectorReranker 的自有32D语义向量。
 *
 * 设计原则：
 *   - 零外部依赖，纯本地n-gram切词
 *   - 停用词过滤，减少噪声term
 *   - 批量写入（每100条commit一次），控制SQLite写入开销
 */

// ── 中文停用词（高频虚词，不参与索引） ──
const STOP_WORDS = new Set([
  '这个','那个','什么','怎么','这样','那样','可以','没有','知道','觉得',
  '因为','所以','但是','如果','虽然','而且','然后','最后','开始','已经',
  '不会','还是','就是','只是','可是','不是','是的','时候','东西','真的',
  '一直','到底','有什么用','是不是','我在','你也','我们','他们','自己',
  '这里','那里','一个','一种','一次','一下','一点','一些','什么','怎么',
  '为什么','怎么样','这么','那么','这是','那是','不过','还有','的话',
  '的时候','也没有','就行了','之类的','什么的','而已','就是','不是',
]);

/**
 * 将文本切分为2-3字中文n-gram集合
 */
export function buildNgrams(text: string): string[] {
  if (!text || text.length < 2) return [];

  // 清理：去标点、去空格、保留中文+英文+数字
  const cleaned = text
    .replace(/[，。！？、；：""''（）《》【】\s\d -/:-@[-`{-~]/g, '')
    .trim();

  if (cleaned.length < 2) return [];

  const ngrams = new Set<string>();

  // 2-gram
  for (let i = 0; i < cleaned.length - 1; i++) {
    const gram = cleaned.substring(i, i + 2);
    if (!STOP_WORDS.has(gram)) ngrams.add(gram);
  }

  // 3-gram
  for (let i = 0; i < cleaned.length - 2; i++) {
    const gram = cleaned.substring(i, i + 3);
    if (!STOP_WORDS.has(gram)) ngrams.add(gram);
  }

  return [...ngrams];
}

/**
 * 索引单条文档 — 写入 search_index 表。
 * 幂等：INSERT OR REPLACE，同文档重复索引覆盖。
 *
 * @param db     sql.js Database 实例（需有 run 方法）
 * @param sourceType 'conversation' | 'memory' | 'black_diamond' | 'knowledge_base'
 * @param sourceId  对应表的主键
 * @param text      要索引的文本内容
 * @param entityUuid 实体归属UUID（可选）
 */
export function indexDocument(
  db: any,
  sourceType: string,
  sourceId: string,
  text: string,
  entityUuid?: string,
): number {
  if (!db || !text) return 0;

  const ngrams = buildNgrams(text);
  if (ngrams.length === 0) return 0;

  let count = 0;
  for (let pos = 0; pos < ngrams.length; pos++) {
    try {
      db.run(
        `INSERT OR REPLACE INTO search_index (term, source_type, source_id, belong_entity_uuid, position)
         VALUES (?, ?, ?, ?, ?)`,
        [ngrams[pos], sourceType, sourceId, entityUuid || null, pos],
      );
      count++;
    } catch {
      // 重复term跳过
    }
  }
  return count;
}

/**
 * 存量回填 — 扫描全部四层存储，构建完整n-gram索引。
 * 仅在 search_index 为空时执行（避免重复回填）。
 *
 * @returns 索引的文档总数
 */
export function rebuildAllIndexes(db: any): { total: number; bySource: Record<string, number> } {
  if (!db) return { total: 0, bySource: {} };

  const bySource: Record<string, number> = { conversation: 0, memory: 0, black_diamond: 0, knowledge_base: 0, work: 0 };

  // ═══ 1. 砂金库 — conversations ═══
  // 🔴 V34(2026-09-25): 撤除 `is_compacted = 0` 过滤。
  //   原过滤使**被归档的对话连全文搜索索引都进不去** —— 砂金库作为「回忆兜底层」的职责
  //   在索引侧也被切断：用户问几天前聊过的具体事，倒排索引里根本没有那些 term。
  //   归档只是内存窗口标记，原文只增不删，索引必须覆盖全量。
  try {
    const convs = db.exec(
      "SELECT id, content, belong_entity_uuid FROM conversations WHERE content IS NOT NULL ORDER BY id"
    );
    if (convs.length && convs[0].values) {
      for (const [id, content, entityUuid] of convs[0].values) {
        const n = indexDocument(db, 'conversation', String(id), String(content), entityUuid ? String(entityUuid) : undefined);
        if (n > 0) bySource.conversation++;
      }
    }
    console.log(`[SearchIndex] 砂金库索引: ${bySource.conversation} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 砂金库索引失败:', (e as Error).message);
  }

  // ═══ 2. 金库 — memories ═══
  try {
    const mems = db.exec(
      "SELECT id, raw_input, belong_entity_uuid FROM memories WHERE raw_input IS NOT NULL ORDER BY id"
    );
    if (mems.length && mems[0].values) {
      for (const [id, rawInput, entityUuid] of mems[0].values) {
        const n = indexDocument(db, 'memory', String(id), String(rawInput), entityUuid ? String(entityUuid) : undefined);
        if (n > 0) bySource.memory++;
      }
    }
    console.log(`[SearchIndex] 金库索引: ${bySource.memory} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 金库索引失败:', (e as Error).message);
  }

  // ═══ 3. 黑钻 — black_diamond ═══
  try {
    const bds = db.exec(
      "SELECT id, summary, belong_entity_uuid FROM black_diamond WHERE summary IS NOT NULL ORDER BY id"
    );
    if (bds.length && bds[0].values) {
      for (const [id, summary, entityUuid] of bds[0].values) {
        const n = indexDocument(db, 'black_diamond', String(id), String(summary), entityUuid ? String(entityUuid) : undefined);
        if (n > 0) bySource.black_diamond++;
      }
    }
    console.log(`[SearchIndex] 黑钻索引: ${bySource.black_diamond} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 黑钻索引失败:', (e as Error).message);
  }

  // ═══ 4. 知识库 — knowledge_base ═══
  try {
    const kbs = db.exec(
      "SELECT id, content, belong_entity_uuid FROM knowledge_base WHERE content IS NOT NULL ORDER BY id"
    );
    if (kbs.length && kbs[0].values) {
      for (const [id, content, entityUuid] of kbs[0].values) {
        // 只索引标题和内容
        const text = String(content);
        const n = indexDocument(db, 'knowledge_base', String(id), text.substring(0, 5000), entityUuid ? String(entityUuid) : undefined);
        if (n > 0) bySource.knowledge_base++;
      }
    }
    console.log(`[SearchIndex] 知识库索引: ${bySource.knowledge_base} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 知识库索引失败:', (e as Error).message);
  }

  // ═══ 5. 作品 — works（长文召回元数据桥，全文切块索引） ═══
  try {
    const works = db.exec(
      "SELECT work_id, full_text, belong_entity_uuid FROM works WHERE full_text IS NOT NULL ORDER BY created_at DESC"
    );
    if (works.length && works[0].values) {
      for (const [workId, fullText, entityUuid] of works[0].values) {
        const n = indexWorkChunks(db, String(workId), String(fullText), entityUuid ? String(entityUuid) : undefined);
        if (n > 0) bySource.work = (bySource.work || 0) + 1;
      }
    }
    console.log(`[SearchIndex] 作品索引: ${bySource.work || 0} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 作品索引失败:', (e as Error).message);
  }

  const total = Object.values(bySource).reduce((a, b) => a + b, 0);
  return { total, bySource };
}

/**
 * 作品全文切块索引（V22 长文召回）。
 * 长文（小说/文章 3000+ 字）整体 buildNgrams 会产生海量 term，且 n-gram 检索上限 100 条/term
 * 会稀释关键命中。按 800 字切块，逐块索引——让"星落之城"这类内容词在任一块都能命中。
 *
 * @param db        sql.js Database 实例
 * @param workId    作品主键（works.work_id）
 * @param fullText  作品全文
 * @param entityUuid 作品归属UUID（可选）
 * @returns 索引的文档块数
 */
export function indexWorkChunks(
  db: any,
  workId: string,
  fullText: string,
  entityUuid?: string,
): number {
  if (!db || !fullText) return 0;
  const CHUNK_SIZE = 800;
  let count = 0;
  for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
    const chunk = fullText.substring(i, i + CHUNK_SIZE);
    const n = indexDocument(db, 'work', workId, chunk, entityUuid);
    count += n > 0 ? 1 : 0;
  }
  return count;
}

/**
 * 🔴 V34(2026-09-25) 砂金库索引**增量回填** —— 补齐 rebuildAllIndexes 覆盖不到的那部分对话。
 *
 * 背景：`rebuildAllIndexes` 仅在 `search_index` 为空时执行（防重复回填），因此
 * 「执行之后才写入的对话」以及「当时因 is_compacted=0 被排除、V34 才恢复可见的归档对话」
 * 会长期缺席索引。实测：5936 条对话中仅 5214 条进了索引（缺 12%）。
 * 砂金库召回的主路径已改为倒排索引（查询驱动）⇒ 索引缺一条，那条就永远捞不回来。
 *
 * 本函数是**幂等增量**：只索引 `search_index` 里还没有的对话，可重复调用。
 * 刻意**不带** `is_compacted = 0` 过滤 —— 归档只是内存窗口标记，原文只增不删，索引须覆盖全量。
 *
 * @param db         sql.js Database 实例（需有 exec / run 方法）
 * @param batchLimit 单次最多回填条数（0 = 不限；大批量建议分批，避免长事务阻塞）
 * @returns 实际索引的对话条数
 */
export function backfillConversationIndex(db: any, batchLimit = 0): number {
  if (!db) return 0;
  let indexed = 0;
  try {
    // source_id 以**文本**比较（写入时为 String(id)），这样能吃到 idx_si_source(source_type, source_id)
    const limitClause = Number.isFinite(batchLimit) && batchLimit > 0 ? ` LIMIT ${Math.floor(batchLimit)}` : '';
    const rows = db.exec(
      `SELECT c.id, c.content, c.belong_entity_uuid FROM conversations c
       WHERE c.content IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM search_index s
           WHERE s.source_type = 'conversation' AND s.source_id = CAST(c.id AS TEXT)
         )
       ORDER BY c.id${limitClause}`,
    );
    if (!rows.length || !rows[0].values) return 0;
    for (const [id, content, entityUuid] of rows[0].values) {
      const n = indexDocument(db, 'conversation', String(id), String(content), entityUuid ? String(entityUuid) : undefined);
      if (n > 0) indexed++;
    }
    console.log(`[SearchIndex] 砂金库增量回填: ${indexed} 条`);
  } catch (e) {
    console.warn('[SearchIndex] 砂金库增量回填失败:', (e as Error).message);
  }
  return indexed;
}

/**
 * 检查 search_index 是否为空
 */
export function isIndexEmpty(db: any): boolean {
  try {
    const r = db.exec('SELECT COUNT(*) as cnt FROM search_index');
    return !r.length || !r[0].values.length || r[0].values[0][0] === 0;
  } catch {
    return true;
  }
}

export default { buildNgrams, indexDocument, indexWorkChunks, rebuildAllIndexes, backfillConversationIndex, isIndexEmpty };
