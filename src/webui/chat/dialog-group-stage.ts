/**
 * dialog-group-stage — 对话组管理（从 chat.ts 拆分）
 *
 * 职责：对话组关闭时的数据库写入逻辑
 * 包含：flushDialogGroup — 锚点/碎片/黑钻/图谱写入
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { computeCalcium } from '../../m2/math.js';

// H3: 单一钙化标度 [0,1] — 与 m2.computeCalcium / M3Config 阈值(0.3/0.6/0.8)完全一致的等级映射。
// 闭组写入必须与逐轮砂金写入(persistence-stage 用 decision.enhanced.calcium_score/level)同标度，
// 否则同一段内容在库里出现两套分数，检索排序错乱。
function calciumLevel(score: number): 0 | 1 | 2 | 3 {
  if (score < 0.3) return 0;
  if (score < 0.6) return 1;
  if (score < 0.8) return 2;
  return 3;
}

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
    // H3: 锚点即本组情感峰值轮，钙化分直接采用 dg.maxCalcium（引擎级 [0,1] 分值），
    //     不再 *1.2 抬升到不可达的 [0,4.5] 旧标度。锚点的"重要性"由独立的 anchor_score 列 + dialog_group_id 标记，不靠虚高钙化分。
    const anchorCalcium = Math.round(dg.maxCalcium * 1000) / 1000;

    // 情感峰值向量
    const peakP = dg.perceptions[dg.maxCalciumRound] || dg.perceptions[0] || {};
    // H3: 抽出 24 维序列化，锚点用峰值向量、碎片用各自轮次向量 — 保证每行的向量与钙化分同源
    const vec24 = (p: any): string => JSON.stringify([
      p.pleasure||0, p.arousal||0, p.dominance||0, p.aggression||0,
      p.sincerity||0, p.humor||0, p.factual||0, p.logical||0,
      p.certainty||0, p.abstract||0, p.temporal_focus||0, p.self_ref||0,
      p.intimacy||0, p.power_diff||0, p.dependency||0, p.moral_judgment||0,
      p.etiquette||0, p.belonging||0, p.sexual_attraction||0, p.sensory_craving||0,
      p.energy_merge||0, p.possessiveness||0, p.ecstasy||0, p.safety||0.5,
    ]);
    const pVec = vec24(peakP);

    // 写入核心锚点（高钙化分，带anchor_score标记）
    const anchorId = dg.id + '_ANCHOR';
    sql.writeRaw(
      "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_json, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label, anchor_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      anchorId, -(dg.rounds.length + 100), now, pVec, anchorCalcium,
      calciumLevel(anchorCalcium), dg.locusPath || 'general',
      'language_semantic_zone', anchorText, 0.5 + anchorCalcium * 0.3, now,
      decision.primary_emotion || '对话', dg.id, dg.rounds.length, dg.topic, anchorCalcium
    );

    // 写入细节碎片（其余轮次）
    // H3: 每条碎片按其所在轮次的真实感知向量计算钙化分（同标度 [0,1]），
    //     不再用 dg.maxCalcium*0.7 一刀切压到 0.5（旧公式使全部碎片钙化分恒为 0.5，失真）。
    for (let i = 0; i < dg.rounds.length; i++) {
      if (i === anchorIdx) continue;
      const r = dg.rounds[i];
      const chunkText = '【第' + (i + 1) + '轮】\n用户: ' + r.q + '\n玉瑶: ' + r.a;
      const chunkId = dg.id + '_CHUNK_' + String(i).padStart(3, '0');
      const roundP = dg.perceptions[i] || peakP;
      const chunkCalcium = Math.round(computeCalcium(roundP as any).score * 1000) / 1000;
      sql.writeRaw(
        "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_json, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        chunkId, -dg.rounds.length - i, now, vec24(roundP), chunkCalcium,
        calciumLevel(chunkCalcium), dg.locusPath || 'general',
        'language_semantic_zone', chunkText, 0.3 + chunkCalcium * 0.2, now,
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

    // 黑钻晋升由 VaultManager 统一负责（金库→黑钻，以"被反复召回"为准）。
    // 闭组锚点已作为普通 memories 行写入，若日后被反复想起会自然经 VaultManager 晋升；
    // 此处不再另开一条闭组直出黑钻的路径，避免与 VaultManager 产生重复/语义分裂的黑钻。

    // 图谱实体同步 + 档案提取（角色扮演时走真实FG，确保自学习不丢失）
    if (ctx.m4 && dg.entities.length > 0) {
      try {
        const fg = ctx.m4.getRealFamilyGraph?.() || ctx.m4.getFamilyGraph();
        if (fg) {
          // C2+C3: 分离说话人文本，供第一人称自述提取
          //  - 用户(张三)的话 => 用户第一人称"我"
          //  - 玉瑶/被扮演角色的话 => 助手第一人称"我"
          // 仅当实体确实是发言者本人时才传入自述文本，避免把用户的"我"误归到第三方。
          const userLines = dg.rounds.map((r: any) => r.q || '').join('\n');
          const assistantLines = dg.rounds.map((r: any) => r.a || '').join('\n');
          const rpChar = dg.rpChar || null;
          for (const name of dg.entities) {
            if (validatePersonName(name)) fg.integrateSocialRelation(name, 'acquaintance_of', '').catch(() => {});
            // 判定该实体的第一人称自述来源
            let selfText: string | undefined;
            if (rpChar && name === rpChar) selfText = assistantLines;   // 角色扮演：玉瑶所说即被扮演角色的自述
            else if (name === '玉瑶') selfText = assistantLines;         // 玉瑶本人
            else if (name === '我') selfText = userLines;                // 用户自身节点
            fg.extractProfileFromText(name, combined, selfText).catch(() => {});
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
