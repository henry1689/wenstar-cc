/**
 * dialog-group-stage — 对话组管理（从 chat.ts 拆分）
 *
 * 职责：对话组关闭时的数据库写入逻辑
 * 包含：flushDialogGroup — 锚点/碎片/黑钻/图谱写入
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { MemoryWriteGateway } from '../../m2/MemoryWriteGateway.js';
// ADR-010 P1-A: `computeCalcium` 的 import 随 CHUNK 碎片写入退役一并移除
//（它在本文件内的唯一用处是计算碎片钙分，见下方 tombstone 注释）
import { map24DTo40D, encodePerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';
import { getPeriod, getSeason, getLunarTerm } from '../../engine/temporal/global-types.js';
// 2026-09-13 ②-1补漏: 归属脏值净化唯一入口（第三层兜底 SQL 取值时不得采信字符串 'null'）
import { sanitizeBelongUuid } from '../../app/vault/belong-uuid.js';
// 🔴 ADR-010 P1-B: 块价值判定 + 判据单一定义处（FEATURE_ROUND_RE 由此收拢）
import { scoreBlock, FEATURE_ROUND_RE } from '../../app/memory/BlockValueScorer.js';
import type { Perception24D } from '../../m3/types/perception.js';
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

/**
 * P0-① 锚点归属解析 + 守卫（2026-09-12）
 *
 * 原实现在 flushDialogGroup 内联三层降级（dg.entities → characterName → conversations 按 seq_pos 反查），
 * **三层全失败即静默写 belong_entity_uuid = null** —— 与会话逐轮写入（persistence-stage 有强制三级兜底）
 * 规则不一致。实测代价：117 条无归属记忆在会晤场景被 fail-closed 拒（永远召不回），
 * 且服务重启时 _rebuildMemoryAnchors 无条件 DELETE 后只重建有归属的组 → 永久消失。
 *
 * 守链（对齐《UUID户籍管理法》第五条 会晤写入强制 / 第七条 无户口写入拒绝）：
 *   三层解析 → 会晤实体 UUID → 玉瑶 UUID → 仍为空返回 null，由调用方拒绝写入（宁拒不放）。
 */
export function resolveAnchorOwnership(
  dg: any,
  sql: any,
  fg: any,
  fallbacks: { meetingUuid?: string | null; yuyaoUuid?: string | null; characterName?: string | null } = {},
): { uuid: string | null; source: string } {
  let entityUuid: string | null = null;
  try {
    if (dg?.entities && dg.entities.length > 0) {
      const personNames = dg.entities.filter((n: string) => n && n !== '我' && n !== '玉瑶');
      for (const name of personNames) {
        const uuid = fg?.getUUIDByName?.(name);
        if (uuid) { entityUuid = uuid; break; }
      }
      if (!entityUuid && fallbacks.characterName) {
        entityUuid = fg?.getUUIDByName?.(fallbacks.characterName) ?? null;
      }
    }
    // V18: FG 解析失败时降级 — 从 conversations 表取该对话组已标注的实体 UUID
    //      🔧 S4-FIX: 改用 seq_pos 定位（conversations 每轮插入即带 belong_entity_uuid），
    //      不依赖 dialog_group_id 三段回填时序（回填在本函数尾部才执行，此前恒为 NULL）
    if (!entityUuid) {
      const seqs = (dg?.rounds || [])
        .map((r: any) => r?.seqPos)
        .filter((s: any) => typeof s === 'number' && s > 0)
        .flatMap((s: number) => [s, s + 1]);
      if (seqs.length > 0 && typeof sql?.queryAll === 'function') {
        // ②-1补漏(2026-09-13): SQL 层排除字符串 'null' 脏值（它是真值，能穿过 IS NOT NULL / != ''），
        //   并在取值处再过一次净化 —— 双保险，避免脏值被当作合法归属写进锚点。
        const convRow = sql.queryAll(
          "SELECT belong_entity_uuid FROM conversations WHERE seq_pos IN (" + seqs.join(',') + ") AND belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' AND belong_entity_uuid != 'null' LIMIT 1"
        );
        if (convRow && (convRow as any[]).length > 0) {
          entityUuid = sanitizeBelongUuid((convRow[0] as any)?.belong_entity_uuid) ?? null;
        }
      }
    }
  } catch { /* 解析失败不阻塞 — 交由下方守链处理 */ }

  if (entityUuid) return { uuid: entityUuid, source: 'resolved' };
  if (fallbacks.meetingUuid) return { uuid: fallbacks.meetingUuid, source: 'meeting' };
  if (fallbacks.yuyaoUuid) return { uuid: fallbacks.yuyaoUuid, source: 'yuyao' };
  return { uuid: null, source: 'none' };
}

/**
 * P2 锚点说话人署名（2026-09-12）
 * 原实现硬编码 '玉瑶: '，会晤徐诗雨时锚点里也写"玉瑶说" → 召回后 LLM 看到错误署名。
 * 改为按归属实体解析真实姓名；无归属或户籍查不到 → 回退玉瑶（不抛错）。
 */
export function resolveAnchorSpeaker(fg: any, entityUuid: string | null): string {
  if (!entityUuid) return '玉瑶';
  try {
    const name = fg?.getEntityByUUID?.(entityUuid)?.name;
    return name || '玉瑶';
  } catch {
    return '玉瑶';
  }
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
    if (!sql) return;
    const gw = new MemoryWriteGateway(sql);

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
    // 🔴 ADR-010 P1-B: 词表已**收拢到单一定义处** —— BlockValueScorer.FEATURE_ROUND_RE（见文件头 import）。
    //   同一份词表现在同时服务「锚点特征轮补充」（此处）与「块价值判定」（BlockValueScorer）；
    //   复制一份即违反不变量 #7「禁止同一业务规则在多个地方重复实现」。
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

    // V13 / 🔴 2026-09-12 P0-①：归属解析收口到 resolveAnchorOwnership（含守链与拒绝语义）。
    //   原实现在三层解析全失败时静默写 belong_entity_uuid = null —— 实测产生 117 条无归属记忆，
    //   在会晤场景被 fail-closed 拒之门外（永远召不回），且重启时被 _rebuildMemoryAnchors
    //   的 DELETE 清掉而不重建（永久消失）。对齐《UUID户籍管理法》第五条/第七条：无户口不得写入。
    const _anchorFg = ctx.m4?.getFamilyGraph?.();
    const _own = resolveAnchorOwnership(dg, sql, _anchorFg, {
      characterName: ctx.ctx?.characterName ?? null,
      meetingUuid: ctx._entityMeeting?.getEntityUUID?.() ?? null,
      yuyaoUuid: _anchorFg?.getUUIDByName?.('玉瑶') ?? null,
    });
    const entityUuid = _own.uuid;
    if (!entityUuid) {
      // 宁拒不放：归属无法确定的对话组不写锚点（后续碎片/黑钻/图谱写入一并跳过，
      // 因为整组数据的归属同源 —— 写下去即制造新的无归属僵尸记忆）
      console.warn('[DG] 归属解析全失败且无兜底 — 拒绝写入本组（户籍管理法第七条 无户口写入拒绝）: 组=' + (dg && dg.id));
      return;
    }
    // P2: 署名改用归属实体真实姓名（原硬编码 '玉瑶: '，会晤徐诗雨时也写"玉瑶说"）
    const _speakerName = resolveAnchorSpeaker(_anchorFg, entityUuid);
    if (_speakerName !== '玉瑶') {
      anchorText = anchorText.split('\n玉瑶: ').join('\n' + _speakerName + ': ');
    }

    // 写入核心锚点（高钙化分，带anchor_score标记）—— 经 MemoryWriteGateway 值守卫
    const anchorDate = new Date(now);
    const anchorId = dg.id + '_ANCHOR';
    // 🔴 ADR-010 P1-B: 锚点 seq_pos 取**该组首轮真实 seq_pos 的负值**。
    //   原为 `-(dg.rounds.length + 100)` —— 按「轮数」算值 ⇒ **同轮数的组算出同一个数**，
    //   撞 memories.seq_pos 的 UNIQUE 约束（schema.sql:7「seq_pos INTEGER UNIQUE NOT NULL」）
    //   ⇒ 同轮数的第二个组起，锚点写入静默失败（gw.write 返回 false）。
    //   实测代价（2026-10-06 生产取证）：当天闭合 4 个「1 轮组」（DG_9340/9342/9348/9350），
    //   全部算出 -101，**只有第一个写进去**，其余三个的运行期锚点被丢弃；
    //   而这正是 ADR-010 §1.4 要救回的那份（情感峰值轮**全文、保留场景**，
    //   对比重启重建版的「每行截 150 字符」）。已在生产库副本上用真实 flushDialogGroup 复现
    //   `UNIQUE constraint failed: memories.seq_pos`。
    //   首轮 seq_pos 由 conversations 逐轮递增保证组间唯一 ⇒ 其负值亦唯一，且同组跨重启稳定
    //   （不依赖任何运行时计数器）。`|| 1` 仅兜底 seqPos 缺失/为 0 的退化输入，避免算出 0
    //   去撞真实 seq_pos。
    const anchorSeqPos = -Math.abs(Number(dg.rounds[0]?.seqPos) || 1);
    const anchorOk = gw.write({
      id: anchorId, seqPos: anchorSeqPos, createdAt: now,
      perceptionV40: vec40(peakP), calciumScore: anchorCalcium,
      calciumLevel: calciumLevel(anchorCalcium), locusPath: dg.locusPath || 'general',
      leafZone: 'language_semantic_zone', rawInput: anchorText,
      primaryEmotion: decision.primary_emotion || '对话', memoryType: 'dialog',
      memoryKind: ctx._entityMeeting ? 'roleplay' : 'episodic',
      dialogGroupId: dg.id,
      topicLabel: dg.topic, anchorScore: anchorCalcium,
      belongEntityUuid: entityUuid,
      entityGenes: (dna as any).entity_genes ?? null,
      timePeriod: getPeriod(anchorDate.getHours()),
      season: getSeason((anchorDate.getMonth() + 1)),
      lunarTerm: getLunarTerm(anchorDate),
    });
    if (anchorOk) sql.writeRaw('UPDATE memories SET round_count=? WHERE id=?', dg.rounds.length, anchorId);

    // ── 块级元数据落库（ADR-010 P1-B / 2026-10-06）─────────────────────────
    // `dialog_groups` 是块级元数据的**唯一载体**（MigrationManager v16 建表）。
    // P1-A 只是把表建好，本段是**第一个往里面写的代码** —— 至此「对话块」才真正被记录。
    //
    // 判定用 BlockValueScorer（**确定性规则，零 LLM**）：理由是①撞本仓「Harness 零 LLM
    // 监控」铁律；②不可复现的判据 × 不可逆的持久化决策 = 检索池随机漂移。
    //
    // 失败不阻塞闭组主流程（与上方锚点写入同策略），但**必须告警可追责**（P-13 精神：
    // 丢弃必须可见）—— 块元数据是 P1-C 检索的全部依据，静默失败会让块层看起来"存在但空白"。
    try {
      const _p24 = (dg.perceptions || []) as unknown as Perception24D[];
      const _score = scoreBlock({
        rounds: dg.rounds.map((r: any) => ({ q: String(r?.q ?? ''), a: String(r?.a ?? '') })),
        perceptions: _p24,
        maxCalcium: Number(dg.maxCalcium) || 0,
        maxCalciumRound: Number(dg.maxCalciumRound) || 0,
        locusPath: dg.locusPath || 'general',
        closeReason: String(ctx._dgCloseReason || 'unknown'),
        entityNames: (dg.entities || []).filter((n: string) => n && n !== '我' && n !== '玉瑶'),
      });
      const _firstTs = dg.rounds.length > 0 ? new Date(dg.rounds[0].time).toISOString() : now;
      const _lastTs = dg.rounds.length > 0 ? new Date(dg.rounds[dg.rounds.length - 1].time).toISOString() : now;
      sql.writeRaw(
        'INSERT OR REPLACE INTO dialog_groups (dialog_group_id, belong_entity_uuid, narrative_tag, ' +
        'primary_emotion, block_calcium_score, scene_anchor_hash, emotion_curve, block_close_reason, ' +
        'block_summary, lifecycle_state, is_landmark, turn_count, first_ts, last_ts, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)',
        [
          dg.id, entityUuid,
          // narrative_tag 列按 v16 设计承载「内容类别 → 推导衰减率」（ADR-010 §7 / 修正 C），
          // 取值即 BlockDecayClass；**不**伪造「家人」之类中文标签去迎合 memories 层 runDecay 的
          // 关键词匹配 —— dialog_groups 是独立表，块层衰减自成一处，混用会造成新的口径分叉。
          _score.decayClass,
          decision.primary_emotion || '对话',
          _score.score,
          _score.sceneAnchorHash,
          JSON.stringify(_score.emotionCurve),
          String(ctx._dgCloseReason || 'unknown'),
          'active', 0,
          _score.turnCount, _firstTs, _lastTs, now, now,
        ],
      );
      console.log(
        `[DG·块] ${dg.id} 钙分=${_score.score} 类别=${_score.decayClass} ` +
        `轮=${_score.turnCount} 场景占比=${_score.sceneRatio} 指纹=${_score.sceneAnchorHash}` +
        `${_score.degraded ? ' ⚠️退化块' : ''} 信号=${JSON.stringify(_score.signals)}`,
      );
    } catch (e) {
      // 只告警不抛出：块元数据写入失败不应让整组对话的记忆一并丢失
      console.error('[DG·块] ❌ dialog_groups 写入失败（块级元数据缺失，P1-C 检索将取不到本块）:', (e as Error)?.message);
    }

    // ── CHUNK 碎片写入已退役（ADR-010 P1-A / 2026-10-06）─────────────────────
    // 原实现在此写入 N-1 条 `*_CHUNK_nnn`（单轮 Q+A 合并文本）。
    // 退役依据（调用链追踪实测，全仓 grep `_CHUNK`）：
    //   ① **没有消费者** —— 该标识只出现于「写入」（此处）与「删除」
    //      （SQLiteAdapter._rebuildMemoryAnchors 的启动 DELETE），读取方为零；
    //      scripts/backfill-temporals.cjs 甚至用 `NOT LIKE '%_CHUNK%'` 显式排除它。
    //   ② **内容纯冗余** —— 同一轮的 q 与 a 已在 `conversations`（原文，保留场景描写）
    //      与 `mem_*` 逐条行（带 perception_40d）各存一份；CHUNK 只是把两者拼起来再存第三份。
    //   ③ **不可重建** —— conversations 无感知向量列，重建只能回填空向量 ⇒ 低质量副本。
    //   ④ **每次重启即被销毁** —— _rebuildMemoryAnchors 的 DELETE 覆盖 `%\_CHUNK%`
    //      且明说不重建（该函数注释自认「碎片每次重启被永久销毁」），实测全库存活仅 6 条。
    // 处置：**停写**（此处）。SQLiteAdapter 的启动 DELETE **保留** `%\_CHUNK%` 分支，
    //      但它自本次起只用于清除退役前残留（已无生产者），残留清空后可整条移除；
    //      存量残行随下一次启动清除。**ANCHOR 锚点写入不受影响**（它有真实消费者）。
    // 🔴 块级信息的新载体是 `dialog_groups` 表（MigrationManager v16），不再经由 memories 碎片。

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
