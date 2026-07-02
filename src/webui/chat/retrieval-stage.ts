/**
 * retrieval-stage — 记忆检索（从 chat.ts 拆分）
 *
 * 职责：话题切换检测、情感记忆检索、黑钻检索
 * 包含：isTopicShift判断、多跳检索、黑钻FTS5+向量补充
 * 输出：emotionalMemories、memoryFragment推送、上下文标志位
 */
import type { ScoredMemory, SimilarityMode } from '../../m2/types/index.js';
import type { DNA } from '../../m1/types/dna.js';
import { rerank } from '../../m4/Reranker.js';
import { decompose, mergeDecomposedResults } from '../../m4/QueryDecomposer.js';

export interface RetrievalInput {
  ctx: any;
  message: string;
  dna: DNA;
  p: Record<string, number>;
  enrichedHistory: Array<{ content: string }>;
  memoryFragments: string[];
  _bdVecCache: Map<string, Array<{ row: any; score: number }>>;
}

export interface RetrievalOutput {
  isTopicShift: boolean;
  isFollowUp: boolean;
  hasContinuationMarkers: boolean;
  isCasualChat: boolean;
  isLimitedRetrieval: boolean;
  hasNewEntity: boolean;
  hasPersonEntity: boolean;
  emotionalMemories: ScoredMemory[];
  memoryGate: import('../../app/conversation/MemoryGate.js').MemoryGateOutput;
  memoryGateFillerUsed: boolean;
}

export async function runRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { ctx, message, dna, p, enrichedHistory, memoryFragments, _bdVecCache } = input;

  // 时间导航：检测用户是否在问"昨天/上周说了什么"
  const _tmMatch = message.match(/(昨天|前天|上周|上个月|前几天|最近|刚才)/);
  if (_tmMatch && (message.indexOf('说') >= 0 || message.indexOf('聊') >= 0 || message.indexOf('提') >= 0)) {
    try {
      const _tmNow = new Date();
      const _tmStart = new Date();
      const _tmEnd = new Date();
      const _tmUnit = _tmMatch[1];
      if (_tmUnit === '昨天') { _tmStart.setDate(_tmNow.getDate() - 1); }
      else if (_tmUnit === '前天') { _tmStart.setDate(_tmNow.getDate() - 2); _tmEnd.setDate(_tmNow.getDate() - 1); }
      else if (_tmUnit === '上周') { _tmStart.setDate(_tmNow.getDate() - 7); }
      else if (_tmUnit === '上个月') { _tmStart.setMonth(_tmNow.getMonth() - 1); }
      else if (_tmUnit === '前几天') { _tmStart.setDate(_tmNow.getDate() - 3); }
      else if (_tmUnit === '刚才') { _tmStart.setHours(_tmNow.getHours() - 1); }
      const _tmRows = ctx.conversationDB?.findByTimeRange(_tmStart.toISOString(), _tmEnd.toISOString(), 8);
      if (_tmRows && _tmRows.length > 0) {
        const _tmTexts = _tmRows.map(function(r: any) { return r.content; }).filter(Boolean).join(' | ').substring(0, 300);
        memoryFragments.push('【时间检索】' + _tmUnit + '的对话：' + _tmTexts);
        console.log('[TimeNav] ' + _tmUnit + ' 检索到 ' + _tmRows.length + ' 条');
      }
    } catch (err) {
      console.warn('[TimeNav] 检索失败:', err);
    }
  }

  let emotionalMemories: ScoredMemory[] = [];

  // 上下文连续性检测 —— 优先保持当前话题，记忆只在话题切换时注入

  const recentContext = enrichedHistory.slice(-3).map((t: { content: string }) => t.content).join('').slice(-200);

  const isFollowUp = /[那这]个|然后|还有|后来|可是|但是|而且|再|又|还|呢|吧|吗/.test(message) && message.length < 30;

  const hasNewEntity = dna.entity_genes.some(g => g.name && !recentContext.includes(g.name));

  const hasPersonEntity = dna.entity_genes.some((g: any) => g.type === 'person' && g.name !== '我' && g.name.length > 1);

  const hasContinuationMarkers = /嗯|对|好|行|是|是的|没错|就是|[那这]样/.test(message) && message.length < 20;

  // 日常闲聊检测 — 短消息/日常问候 → 不触发记忆检索
  const isCasualChat = /^(在干嘛|忙什么|吃了吗|睡了|晚安|早安|早上好|晚上好|刚起来|下班|到家|今天天气|好开心|好累|心情|感觉|今天.*不错|今天.*好|嗯|好|行|对|是|好的|知道了|没事|算了|哈哈|嘿嘿|哎|唉)$/i.test(message.trim())
    || (message.length < 10 && /今天|天气|吃|睡|累|困|忙|下班|到家|早安|晚安/.test(message));
  let memoryGate: import('../../app/conversation/MemoryGate.js').MemoryGateOutput = { mode: 'casual', needsMemorySearch: false, needsKnowledgeSearch: false, fillerPhrase: '', hallucinationGuard: '', strictMode: false };
  let memoryGateFillerUsed = false;

  // 🔴 P0-2: 跟进追问有实体时开启定向检索（跳过知识库全量搜索）
  const isTopicShift = hasNewEntity || isFollowUp || (!isFollowUp && !hasContinuationMarkers && !isCasualChat);
  const isLimitedRetrieval = isFollowUp && !hasNewEntity;

  try {
    if (isTopicShift) {
      const currentEntityNames = dna.entity_genes.map(g => g.name).filter(Boolean);

      // P0-2: 定向检索模式（isLimitedRetrieval）— 跳过分解和实体扩展，只查当前实体
      if (isLimitedRetrieval) {
        const limMode: SimilarityMode = p.intimacy > 0.4 ? 'intimacy_search' : 'balanced';
        let limMemories = ctx.storage.findByEmotionalSimilarity({
          current_perception: p, similarity_mode: limMode,
          entities: currentEntityNames, limit: 5,
        });
        limMemories = rerank(limMemories, message);
        // P0-2: 情感阈值过滤
        emotionalMemories = limMemories.filter((m: any) =>
          (m.scores.emotional > 0.5 || m.composite > 0.25)
          && m.record.id !== dna.branch_id
          && (m.record.effective_strength || 0) >= 0.15
          && (m.record.calcium_level || 0) >= 1
        ).slice(0, 3);
        if (emotionalMemories.length > 0) {
          memoryFragments.push('【用户曾提到】"' + emotionalMemories[0].record.raw_input?.substring(0, 60) + '"');
        }
      } else {
        // P1-3: 多跳检索（1度→不足3条升2度）
        let relatedEntities: Array<{ name: string; relation: string; strength: number }> = [];
        if (currentEntityNames.length > 0) {
          let anyType = ctx.storage;
          let hop1 = (anyType as any).findRelatedEntitiesN(currentEntityNames, 1, 0.3) || [];
          if (hop1.length < 3) {
            let hop2 = (anyType as any).findRelatedEntitiesN(currentEntityNames, 2, 0.3) || [];
            relatedEntities = [...hop1, ...hop2];
          } else {
            relatedEntities = hop1;
          }

          // P1-3b: 从 FamilyGraph 补充人物关系
          try {
            const _fg = ctx.m4?.getFamilyGraph();
            if (_fg) {
              const _familyNames = _fg.getAllPersonNames();
              const _matchedPerson = currentEntityNames.find((n: string) => _familyNames.includes(n));
              if (_matchedPerson) {
                const _profile = _fg.getPersonProfile(_matchedPerson);
                if (_profile?.relation_to_user) {
                  relatedEntities.push({
                    name: _matchedPerson,
                    relation: 'known_person',
                    strength: 0.5,
                  });
                }
              }
            }
          } catch (_fgErr) { /* 图谱扩展不阻塞 */ }
        }

        const uniqueExpanded = [...new Set([...currentEntityNames, ...relatedEntities.map(r => r.name)])];
        const decomposed = decompose(message);
        const allQueryTexts = [message, ...decomposed.subQueries.filter((q: string) => q !== message)];
        const allResultSets: ScoredMemory[][] = [];

        const mode: SimilarityMode =
          p.pleasure < -0.2 ? 'mood_congruent' :
          p.intimacy > 0.4 ? 'intimacy_search' :
          p.arousal > 0.6 ? 'by_calcium' : 'balanced';

        for (const q of allQueryTexts) {
          let memories = ctx.storage.findByEmotionalSimilarity({
            current_perception: p, similarity_mode: mode,
            entities: uniqueExpanded, limit: 8,
          });
          memories = rerank(memories, q);

          const _hasPerson = dna.entity_genes.some((g: any) => g.type === 'person' && g.name !== '我');
          const _emoThreshold = _hasPerson ? 0.25 : 0.5;
          const _compThreshold = _hasPerson ? 0.15 : 0.25;
          const valid = memories.filter((m: any) =>
            (m.scores.emotional > _emoThreshold || m.composite > _compThreshold) && m.record.id !== dna.branch_id
          );
          if (valid.length > 0) allResultSets.push(valid);
        }

        emotionalMemories = mergeDecomposedResults(allResultSets, 5);

        if (relatedEntities.length > 0) {
          const relationMemories = ctx.storage.findMemoriesByEntityNames(relatedEntities.map((r: any) => r.name), 2);
          for (const rm of relationMemories) {
            if (!emotionalMemories.some((e: any) => e.record.id === rm.id) && rm.id !== dna.branch_id) {
              emotionalMemories.push({
                record: rm, scores: { emotional: 0.5, topic: 0, entity: 0.8, calcium: rm.calcium_score },
                composite: 0.5 * rm.effective_strength,
              });
            }
          }
        }
      } // ← else闭合

      const recentHistoryRaw = enrichedHistory.slice(-4).map((t: any) => t.content).join('');
      let freshMemories = emotionalMemories.filter((m: any) => !recentHistoryRaw.includes(m.record.id));
      if (freshMemories.length < 2 && !hasContinuationMarkers) {
        const fallback = ctx.storage.findByEmotionalSimilarity({ current_perception: p, similarity_mode: 'balanced', limit: 2 });
        freshMemories = fallback.filter((m: any) =>
          (m.scores.emotional > 0.3 || m.scores.calcium > 0.3) && m.record.id !== dna.branch_id && !recentHistoryRaw.includes(m.record.id)
        );
      }
      const finalMemories = freshMemories.length > 0 ? freshMemories : emotionalMemories.slice(0, 1);
      if (finalMemories.length > 0 && !hasContinuationMarkers) {
        const top = finalMemories[0];
        const userSaid = top.record.raw_input.substring(0, 60);
        memoryFragments.push('【用户曾提到】"' + userSaid + '"——这是用户以前说的，不记得就说"不太记得了"');
      }
    }
  } catch (err) { console.warn('[EmotionContagion] 检索失败:', err); }

  // ── 黑钻库检索：提炼过的珍藏记忆优先注入 ──
  try {
    if (isTopicShift && message.trim().length > 1) {
      const _sqlite = ctx.storage.getSQLite();
      if (_sqlite && typeof _sqlite.queryAll === 'function') {
        const _kw = message.replace(/[？！！。、，：；s]/g, '').trim();
        if (_kw.length > 1) {
          let _rows: Array<{ id: string; summary: string; emotion_tag: string; tags: string }> = [];
          try {
            const _ftsR = _sqlite.queryAll('SELECT rowid FROM black_diamond_fts WHERE black_diamond_fts MATCH ? LIMIT 2', [_kw.replace(/[^\w一-鿿]/g, '')]);
            if (_ftsR.length > 0) {
              const _ids = _ftsR.map((r: any) => r.rowid).join(',');
              _rows = _sqlite.queryAll('SELECT id, summary, emotion_tag, tags FROM black_diamond WHERE rowid IN (' + _ids + ') ORDER BY created_at DESC LIMIT 2');
            }
          } catch (e: any) { console.error('[Retrieval] error:', e?.message); }
          if (_rows.length === 0) {
            _rows = _sqlite.queryAll(
              'SELECT id, summary, emotion_tag, tags FROM black_diamond WHERE summary LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT 2',
              ['%' + _kw + '%', '%' + _kw + '%']
            );
          }
          for (const _r of _rows) {
            const _tag = _r.emotion_tag ? '【' + _r.emotion_tag + '】' : '';
            memoryFragments.push('【珍藏记忆】' + _tag + (_r.summary || '').substring(0, 120));
            try {
              _sqlite.writeRaw('UPDATE black_diamond SET recall_count = recall_count + 1, updated_at = ? WHERE id = ?',
                [new Date().toISOString(), _r.id]);
            } catch (e: any) { console.error('[Retrieval] error:', e?.message); }
          }
          if (_rows.length > 0) console.log('[BlackDiamond] 命中 ' + _rows.length + ' 条珍藏记忆');

          // SP3-3: 黑钻向量补充检索（带每轮缓存）
          if (_rows.length < 3) {
            try {
              const _cacheKey = '_bd_vec_' + (message.length > 50 ? message.substring(0, 20) : message.substring(0, 10));
              let scored: Array<{ row: any; score: number }> = [];
              if (_bdVecCache.has(_cacheKey)) {
                scored = _bdVecCache.get(_cacheKey)!;
              } else {
                const allDiamonds = _sqlite.queryAll("SELECT id, summary, emotion_tag, emotion_vector, l2_norm FROM black_diamond");
                const queryVec = [p.pleasure, p.arousal, p.dominance, p.aggression, p.sincerity, p.humor, p.factual, p.logical, p.certainty, p.abstract, p.temporal_focus, p.self_ref, p.intimacy, p.power_diff, p.dependency, p.moral_judgment, p.etiquette, p.belonging, p.sexual_attraction, p.sensory_craving, p.energy_merge, p.possessiveness, p.ecstasy, p.safety];
                let qL2 = 0;
                for (let _di = 0; _di < 24; _di++) qL2 += queryVec[_di] ** 2;
                qL2 = Math.sqrt(qL2);
                for (const _d of allDiamonds as any[]) {
                  if (!_d.emotion_vector) continue;
                  try {
                    const dv = JSON.parse(_d.emotion_vector as string);
                    if (!dv || dv.length !== 24) continue;
                    let dot = 0;
                    const dL2 = (_d.l2_norm as number) || Math.sqrt(dv.reduce((s: number, v: number) => s + v * v, 0));
                    for (let _di = 0; _di < 24; _di++) dot += queryVec[_di] * dv[_di];
                    const sim = dot / (qL2 * dL2 || 0.0001);
                    if (sim > 0.3) scored.push({ row: _d, score: sim });
                  } catch { /* 跳过解析失败 */ }
                }
                scored.sort((a, b) => b.score - a.score);
                _bdVecCache.set(_cacheKey, scored);
                if (_bdVecCache.size > 500) {
                  const firstKey = _bdVecCache.keys().next().value;
                  if (firstKey) _bdVecCache.delete(firstKey);
                }
              }
              const vecResults = scored.slice(0, 3 - _rows.length);
              for (const _vr of vecResults) {
                const _tag = _vr.row.emotion_tag ? "【" + _vr.row.emotion_tag + "】" : "";
                const exists = _rows.some((_ex: any) => _ex.id === _vr.row.id);
                if (!exists && (_vr.row.summary || "")) {
                  memoryFragments.push("【珍藏记忆】" + _tag + (_vr.row.summary || "").substring(0, 120));
                }
              }
              if (vecResults.length > 0) console.log("[BlackDiamond] 向量补充 " + vecResults.length + " 条");
            } catch (_ve) { console.warn('[RetrievalErr] 黑钻向量补充失败:', (_ve as Error).message); }
          }
        }
      }
    }
  } catch (err) { console.warn('[BlackDiamond] 检索失败:', err); }

  return {
    isTopicShift,
    isFollowUp,
    hasContinuationMarkers,
    isCasualChat,
    isLimitedRetrieval,
    hasNewEntity,
    hasPersonEntity,
    emotionalMemories,
    memoryGate,
    memoryGateFillerUsed,
  };
}
