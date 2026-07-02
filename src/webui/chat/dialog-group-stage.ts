/**
 * dialog-group-stage — 对话组管理（从 chat.ts 拆分）
 *
 * 职责：对话组关闭时的数据库写入逻辑
 * 包含：flushDialogGroup — 锚点/碎片/黑钻/图谱写入
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';

export async function flushDialogGroup(
  ctx: any,
  dg: any,
  dna: any,
  decision: any,
  message: string,
  reply: string,
  /** 外部依赖 — 当前是否在角色扮演中 */
  currentRoleplay: string | null,
  /** 外部依赖 — 人名验证函数 */
  validatePersonName: (name: string) => boolean,
): Promise<void> {
  try {
    const sql = ctx.storage.getSQLite() as SQLiteAdapter;
    if (!sql || typeof sql.writeRaw !== 'function') return;

    const combined = dg.rounds.map((r: any, i: number) =>
      '【第' + (i + 1) + '轮】\n用户: ' + r.q + '\n玉瑶: ' + r.a
    ).join('\n\n');
    const now = new Date().toISOString();

    // (P1) 核心锚点提取：情感峰值轮优先，含承诺/新实体轮次兜底
    let anchorIdx = dg.maxCalciumRound;
    if (anchorIdx === 0 || dg.rounds.length <= 1) {
      for (let i = dg.rounds.length - 1; i >= 0; i--) {
        const text = dg.rounds[i].q + dg.rounds[i].a;
        if (/答应|保证|承诺|记住|一定|下次|约好|记得|重要|关键/.test(text)) { anchorIdx = i; break; }
      }
    }
    // 锚点必须是完整Q+A
    const anchorText = '【核心】\n用户: ' + dg.rounds[anchorIdx].q + '\n玉瑶: ' + dg.rounds[anchorIdx].a;
    const anchorCalcium = Math.min(dg.maxCalcium * 1.2, 4.5);

    // 情感峰值向量
    const peakP = dg.perceptions[dg.maxCalciumRound] || dg.perceptions[0] || {};
    const pVec = JSON.stringify([
      peakP.pleasure||0, peakP.arousal||0, peakP.dominance||0, peakP.aggression||0,
      peakP.sincerity||0, peakP.humor||0, peakP.factual||0, peakP.logical||0,
      peakP.certainty||0, peakP.abstract||0, peakP.temporal_focus||0, peakP.self_ref||0,
      peakP.intimacy||0, peakP.power_diff||0, peakP.dependency||0, peakP.moral_judgment||0,
      peakP.etiquette||0, peakP.belonging||0, peakP.sexual_attraction||0, peakP.sensory_craving||0,
      peakP.energy_merge||0, peakP.possessiveness||0, peakP.ecstasy||0, peakP.safety||0.5,
    ]);

    // 写入核心锚点（高钙化分，带anchor_score标记）
    const anchorId = dg.id + '_ANCHOR';
    sql.writeRaw(
      "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_json, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label, anchor_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      anchorId, -(dg.rounds.length + 100), now, pVec, anchorCalcium,
      Math.max(Math.min(Math.floor(anchorCalcium * 2), 3), 1), dg.locusPath || 'general',
      'language_semantic_zone', anchorText, 0.5 + anchorCalcium * 0.3, now,
      decision.primary_emotion || '对话', dg.id, dg.rounds.length, dg.topic, anchorCalcium
    );

    // 写入细节碎片（其余轮次，原始钙化分x0.7）
    for (let i = 0; i < dg.rounds.length; i++) {
      if (i === anchorIdx) continue;
      const r = dg.rounds[i];
      const chunkText = '【第' + (i + 1) + '轮】\n用户: ' + r.q + '\n玉瑶: ' + r.a;
      const chunkId = dg.id + '_CHUNK_' + String(i).padStart(3, '0');
      sql.writeRaw(
        "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_json, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        chunkId, -dg.rounds.length - i, now, pVec, Math.max(dg.maxCalcium * 0.7, 0.5),
        Math.max(Math.min(Math.floor(dg.maxCalcium * 2), 3), 1), dg.locusPath || 'general',
        'language_semantic_zone', chunkText, 0.3 + dg.maxCalcium * 0.2, now,
        decision.primary_emotion || '对话', dg.id, dg.rounds.length, dg.topic
      );
    }

    // 🎭 角色扮演标记：回填 memory_type 和 sub_type
    if (dg.rpChar) {
      try {
        const rpName = dg.rpChar;
        sql.writeRaw("UPDATE memories SET memory_type='rp_dialog', sub_type=? WHERE dialog_group_id=?", [rpName, dg.id]);
        sql.writeRaw("UPDATE conversations SET roleplay_char=? WHERE dialog_group_id=?", [rpName, dg.id]);
      } catch (_e: any) { console.error('[DialogGroup] error:', (_e as any)?.message); }
    }

    // 情感轨迹标签
    const emotions = dg.perceptions.slice(0, 5).map((p: any) => {
      if (p.intimacy > 0.4) return '亲密';
      if (p.pleasure > 0.3) return '愉快';
      if (p.pleasure < -0.2) return '低落';
      return '中性';
    });
    const uniqueE = [...new Set(emotions)].slice(0, 3).join('→');
    console.log('[DG] 闭组: ' + dg.id + ' (' + dg.rounds.length + '轮, 锚点轮#' + anchorIdx + ', 情感:' + uniqueE + (dg.rpChar ? ', 角色扮演:' + dg.rpChar : '') + ')');

    // 黑钻晋升（以锚点钙化分为基准）
    if (anchorCalcium >= 4.5) {
      const bdId = dg.id + '_BD';
      const title = '共同回忆·' + (dg.topic || '').split('.').pop() || '对话';
      sql.writeRaw(
        "INSERT OR IGNORE INTO black_diamond (id, summary, emotion_tag, emotion_vector, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        bdId, '【' + title + '】' + combined.substring(0, 180), 'shared_memory', pVec, now, now
      );
      console.log('[DG] 黑钻共同回忆: ' + title);
    }

    // 图谱实体同步 + 档案提取（角色扮演时跳过，避免分支FG写入主FG）
    if (ctx.m4 && dg.entities.length > 0 && !currentRoleplay) {
      try {
        const fg = ctx.m4.getFamilyGraph();
        if (fg) {
          for (const name of dg.entities) {
            if (validatePersonName(name)) fg.integrateSocialRelation(name, 'acquaintance_of', '').catch(() => {});
            // v1.1: 闭组时自动提取人物档案
            fg.extractProfileFromText(name, combined).catch(() => {});
          }
        }
      } catch (e: any) { console.error('[DialogGroup] error:', e?.message); }
    }

    // 闭组回填：将对话组内所有原始对话关联上 dialog_group_id
    try {
      const convDB = ctx.conversationDB;
      const dnaRootId = (dna as any).dna_root_id;
      if (convDB && dg.rounds.length > 0 && dnaRootId) {
        const firstSeq = -(dg.rounds.length + 100);
        const lastSeq = -dg.rounds.length;
        convDB.writeRaw(
          "UPDATE conversations SET dialog_group_id = ?, dialog_round = CASE WHEN role='user' THEN seq_pos - ? + 1 ELSE seq_pos - ? + 1 END WHERE seq_pos BETWEEN ? AND ? AND dna_root_id = ? AND dialog_group_id IS NULL",
          [dg.id, lastSeq, lastSeq, lastSeq, firstSeq, dnaRootId]
        );
        console.log('[三段回填] 对话组 ' + dg.id + ' 已回填 ' + dg.rounds.length + ' 轮');
      }
    } catch (_e) { console.warn('[三段回填] 失败:', _e); }
  } catch (err) {
    console.warn('[DG] 写入失败:', err);
  }
}
