/**
 * SearchIndexBuilder — 中文 n-gram 分词器（2026-11-02 由索引构建器降级为纯分词工具）
 * ==================================================================================
 * 历史：本文件原为《统一语义搜索引擎 V11.0》（2026-07-27）的索引构建器，
 *   负责把四层存储的文本切成 2-3 字 n-gram 写入 search_index 倒排表。
 *
 * 🔴 2026-11-02 业主裁决「彻底拆除 n-gram」后的现状：
 *   · search_index 表的全部写入方与读取方已删除（B1–B3a），表由 v33 迁移 DROP；
 *   · 本文件只剩 **buildNgrams 切词能力** —— 被 v11 结构化召回的分片围栏复用
 *     （StructuredRecall.buildKeywordShards、meeting-recall、Backfill、
 *      MemoryRetriever、SurprisalGate、MMRDiversifier 六处）。
 *   · 这正是白皮书 §4.2.2 的原设计：「与 buildNgrams 相同的切分逻辑，**但不建索引**」。
 *
 * 保留的切词口径与历史逐字一致（停用词表 + 2/3-gram 滑窗），以保证已有检索行为不变。
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


// 🔴 2026-11-02 业主裁决「彻底拆除 n-gram」：本文件的索引构建能力
//   （RETIRED_SOURCE_TYPES / indexDocument / rebuildAllIndexes /
//    indexWorkChunks / backfillConversationIndex / isIndexEmpty）已全部删除。
//   n-gram 倒排索引表 search_index 由 v33 迁移整表下线；
//   本文件只保留**切词能力** buildNgrams，供 v11 结构化召回的分片围栏复用
//   （白皮书 §4.2.2：「与 buildNgrams 相同的切分逻辑，但不建索引」）。
