/**
 * dialog-group-stage — 对话组管理（从 chat.ts 拆分）
 *
 * 职责：对话组关闭时的数据库写入逻辑
 * 包含：flushDialogGroup — 锚点/碎片/黑钻/图谱写入
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { computeCalcium } from '../../m2/math.js';
import { map24DTo40D, encodePerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';
// V13.0: 在线 DAG 建边（feature flag 控制，不阻塞闭组主流程）
let _dagEdgeBuilders: { entity: any; causal: any; repo: any } | null = null;
let _lastGroupCtx: any = null;  // V13: 上一个闭组上下文（供因果边构建）
const WS_DAG_ONLINE_EDGES = process.env.WS_DAG_ONLINE_EDGES === 'true';

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
    // 🔴 2026-09-09 会晤失忆修复(C): ANCHOR 特征轮补充 — 承诺/约定/引文/重要时间节点轮若非情感峰值轮，
    //   钙化分仅来自情感强度(低) → 易被召回挤出（实证: 6:05 引诗《蒹葭》钙化 0.70 排 55/257 取不到）。
    //   闭组时把这些特征轮并入 ANCHOR 摘要文本（最多补 2 轮），保证"重要的非情感轮"留下可召回内容。
    //   特征判定用通用承诺/约定/书面引用词集，零硬编码人名/诗名。
    const FEATURE_ROUND_RE = /答应|承诺|约定|约好|保证|一定|下次|寒假|暑假|开学|回来|盼着|记得|记住|重要|关键|写过|念过|背过|那首诗|那句话|答应过|白露|时节|一首诗/;
    const _featRounds: string[] = [];
    if (dg.rounds.length > 1) {
      for (let _fi = 0; _fi < dg.rounds.length; _fi++) {
        if (_fi === anchorIdx) continue;
        const _ftext = dg.rounds[_fi].q + dg.rounds[_fi].a;
        if (FEATURE_ROUND_RE.test(_ftext)) {
          _featRounds.push('【第' + (_fi + 1) + '轮】\n用户: ' + dg.rounds[_fi].q + '\n玉瑶: ' + dg.rounds[_fi].a);
          if (_featRounds.length >= 2) break;
        }
      }
    }
    let anchorText = '【核心】\n用户: ' + dg.rounds[anchorIdx].q + '\n玉瑶: ' + dg.rounds[anchorIdx].a;
    if (_featRounds.length > 0) {
      anchorText += '\n\n【重要补充】\n' + _featRounds.join('\n\n');
      console.log(`[DG·特征轮] 组 ${dg.id} 锚点补充 ${_featRounds.length} 个特征轮(承诺/约定/引文)`);
    }
    // H3: 锚点即本组情感峰值轮，钙化分直接采用 dg.maxCalcium（引擎级 [0,1] 分值），
    //     不再 *1.2 抬升到不可达的 [0,4.5] 旧标度。锚点的"重要性"由独立的 anchor_score 列 + dialog_group_id 标记，不靠虚高钙化分。
    const anchorCalcium = Math.round(dg.maxCalcium * 1000) / 1000;

    // 情感峰值向量
    const peakP = dg.perceptions[dg.maxCalciumRound] || dg.perceptions[0] || {};
    // V12.4 阶段B 根除24D: 锚点/碎片只写 40D（从 24D 派生，与 persistence-stage 一致）；24D 不再落库
    const vec40 = (p: any): string => {
      try { return encodePerceptionV40(map24DTo40D(p as any)); }
      catch { return 'null'; }
    };

    // V13: 解析实体 UUID（从 dg.entities 取第一个 person 名查 FamilyGraph）
    let entityUuid: string | null = null;
    if (dg.entities && dg.entities.length > 0) {
      try {
        const fg = ctx.m4?.getFamilyGraph?.();
        if (fg) {
          const personNames = dg.entities.filter((n: string) => n && n !== '我' && n !== '玉瑶');
          for (const name of personNames) {
            const uuid = fg.getUUIDByName?.(name);
            if (uuid) { entityUuid = uuid; break; }
          }
          if (!entityUuid && ctx.ctx?.characterName) {
            entityUuid = fg.getUUIDByName?.(ctx.ctx.characterName) ?? null;
          }
        }
        // V18: FG 解析失败时降级 — 从 conversations 表取该对话组已标注的实体 UUID
        //      🔧 S4-FIX: 改用 seq_pos 定位（conversations 每轮插入即带 belong_entity_uuid），
        //      不依赖 dialog_group_id 三段回填时序（回填在本函数尾部才执行，此前 dialog_group_id 恒为 NULL）
        if (!entityUuid) {
          const seqs = (dg.rounds || [])
            .map((r: any) => r.seqPos)
            .filter((s: any) => typeof s === 'number' && s > 0)
            .flatMap((s: number) => [s, s + 1]);
          if (seqs.length > 0) {
            const convRow = sql.queryAll?.(
              "SELECT belong_entity_uuid FROM conversations WHERE seq_pos IN (" + seqs.join(',') + ") AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' LIMIT 1"
            );
            if (convRow && (convRow as any[]).length > 0) {
              entityUuid = (convRow[0] as any)?.belong_entity_uuid ?? null;
            }
          }
        }
      } catch { /* UUID 解析不阻塞 */ }
    }

    // 写入核心锚点（高钙化分，带anchor_score标记）
    const anchorId = dg.id + '_ANCHOR';
    sql.writeRaw(
      "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_40d, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label, anchor_score, belong_entity_uuid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      anchorId, -(dg.rounds.length + 100), now, vec40(peakP), anchorCalcium,
      calciumLevel(anchorCalcium), dg.locusPath || 'general',
      'language_semantic_zone', anchorText, 0.5 + anchorCalcium * 0.3, now,
      decision.primary_emotion || '对话', dg.id, dg.rounds.length, dg.topic, anchorCalcium, entityUuid
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
        "INSERT OR IGNORE INTO memories (id, seq_pos, created_at, perception_40d, calcium_score, calcium_level, locus_path, leaf_zone, raw_input, effective_strength, strength_updated_at, primary_emotion, dialog_group_id, round_count, topic_label, belong_entity_uuid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        chunkId, -dg.rounds.length - i, now, vec40(roundP), chunkCalcium,
        calciumLevel(chunkCalcium), dg.locusPath || 'general',
        'language_semantic_zone', chunkText, 0.3 + chunkCalcium * 0.2, now,
        decision.primary_emotion || '对话', dg.id, dg.rounds.length, dg.topic, entityUuid
      );
    }

    // 情感轨迹标签
    const emotions = dg.perceptions.slice(0, 5).map((p: any) => {
      if (p.intimacy > 0.4) return '亲密';
      if (p.pleasure > 0.3) return '愉快';
      if (p.pleasure < -0.2) return '低落';
      return '中性';
    });
    const uniqueE = [...new Set(emotions)].slice(0, 3).join('→');
    console.log('[DG] 闭组: ' + dg.id + ' (' + dg.rounds.length + '轮, 锚点轮#' + anchorIdx + ', 情感:' + uniqueE + ')');

    // 黑钻晋升由 VaultManager 统一负责（金库→黑钻，以"被反复召回"为准）。
    // 闭组锚点已作为普通 memories 行写入，若日后被反复想起会自然经 VaultManager 晋升；
    // 此处不再另开一条闭组直出黑钻的路径，避免与 VaultManager 产生重复/语义分裂的黑钻。

    // 图谱实体同步 + 档案提取
    if (ctx.m4 && dg.entities.length > 0) {
      try {
        const fg = ctx.m4.getFamilyGraph();
        if (fg) {
          const userLines = dg.rounds.map((r: any) => r.q || '').join('\n');
          const assistantLines = dg.rounds.map((r: any) => r.a || '').join('\n');
          for (const name of dg.entities) {
            if (validatePersonName(name)) fg.integrateSocialRelation(name, 'acquaintance_of', '').catch(() => {});
            let selfText: string | undefined;
            if (name === '玉瑶') selfText = assistantLines;
            else if (name === '我') selfText = userLines;
            fg.extractProfileFromText(name, combined, selfText).catch(() => {});
          }
        }
      } catch (e: any) { console.error('[DialogGroup] error:', e?.message); }
    }

    // 闭组回填：用真实 seq_pos 关联 conversations 表
    //    原实现用 -(rounds+100)..-(rounds) 的负数范围做 BETWEEN，但 conversations 表
    //    seq_pos 全是正数（1-1654），负数范围永远匹配 0 行 — 回填功能从诞生起从未生效。
    //    修复：遍历每轮的真实 seqPos（用户消息）+ seqPos+1（助手回复），精确 UPDATE。
    try {
      const convDB = ctx.conversationDB;
      if (convDB && dg.rounds.length > 0) {
        let updated = 0;
        for (let i = 0; i < dg.rounds.length; i++) {
          const r = dg.rounds[i];
          convDB.writeRaw(
            "UPDATE conversations SET dialog_group_id = ?, dialog_round = ? WHERE (seq_pos = ? OR seq_pos = ?) AND dialog_group_id IS NULL",
            [dg.id, i + 1, r.seqPos, r.seqPos + 1],
          );
          updated += 2;
        }
        console.log('[三段回填] 对话组 ' + dg.id + ' 已关联 ' + dg.rounds.length + ' 轮 (' + updated + ' 条对话)');
      }
    } catch (_e) { console.warn('[三段回填] 失败:', _e); }
    // ═══════════════════════════════════════════════════
    // V13.0: 在线 DAG 建边（feature flag 控制，不阻塞闭组）
    // ═══════════════════════════════════════════════════
    if (WS_DAG_ONLINE_EDGES) {
      try {
        await _buildOnlineDAGEdges(ctx, dg, dna);
      } catch (_e) { /* DAG 建边失败不影响闭组主流程 */ }
    }
  } catch (err) {
    console.warn('[DG] 写入失败:', err);
  }
}

// ── V13.0 DAG 在线建边内部函数 ──

async function _buildOnlineDAGEdges(ctx: any, dg: any, dna: any): Promise<void> {
  const sqlite = ctx.storage?.getSQLite?.() as SQLiteAdapter | null;
  if (!sqlite) return;

  // 懒加载
  if (!_dagEdgeBuilders) {
    const { MemoryAssociationRepository } = await import('../../m4/graph/MemoryAssociationRepository.js');
    const { OnlineEntityEdgeBuilder } = await import('../../m4/graph/OnlineEntityEdgeBuilder.js');
    const { OnlineCausalEdgeBuilder } = await import('../../m4/graph/OnlineCausalEdgeBuilder.js');
    const repo = new MemoryAssociationRepository(sqlite);
    _dagEdgeBuilders = {
      entity: new OnlineEntityEdgeBuilder(repo),
      causal: new OnlineCausalEdgeBuilder(repo),
      repo,
    };
  }

  const ns = (dna as any)?.namespace ?? 'default';
  const euuid = (dna as any)?.belong_entity_uuid ?? '';
  const locusPath = (dna as any)?.locus_path ?? '';
  const groupId = dg.id ?? '';
  const groupGlobalUid = (dna as any)?.global_uid ?? (dna as any)?.dna_root_id ?? groupId;
  const nowMs = Date.now();
  const entityNames = (dna as any)?.entity_genes
    ?.filter((g: any) => g.type !== 'self')
    ?.map((g: any) => g.name) ?? [];

  const groupCtx = {
    namespace: ns,
    belongEntityUuid: euuid,
    groupId,
    groupGlobalUid,
    closedAtMs: nowMs,
    locusPath,
    entityNames,
  };

  // 合并对话组文本用于因果线索检测
  const combinedText = dg.rounds?.map((r: any) => r.q + ' ' + r.a).join(' ') ?? '';

  // 实体边: 同 entity 的对话组链
  const entityCreated = _dagEdgeBuilders.entity.buildForDialogGroup(groupCtx);

  // 因果边: 30分钟内同话题的连续对话组
  let causalCreated = 0;
  if (_lastGroupCtx && _lastGroupCtx.belongEntityUuid === euuid) {
    causalCreated = _dagEdgeBuilders.causal.buildForDialogGroup(groupCtx, _lastGroupCtx, combinedText);
  }
  // 保存当前上下文供下一个闭组使用
  _lastGroupCtx = groupCtx;

  if (entityCreated > 0 || causalCreated > 0) {
    console.log(`[DAG-Online] 对话组 ${groupId}: entity=${entityCreated} causal=${causalCreated}`);
  }
}
