/**
 * DialogGroupAdapter — 对话块存储域适配器（2026-11-02 由 v11 结构化召回接管）
 * =====================================================================
 * 「对话块」= 一段自闭合的连贯场景（`dialog_groups` 表一行 + 其名下 conversations 聚合）。
 * 与 ConversationAdapter 的区别是**聚合粒度**：对话适配器返回单条消息，本适配器返回整块。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 2026-11-02 改造背景（业主裁决：彻底拆除 n-gram / V11 彻底完成 / 绝对不用旧方案兜底）
 *
 *   原实现：自写双通道 SQL ——
 *     通道① `search_index(source_type='conversation')` 取原文命中
 *     通道② `search_index(source_type='dialog_group')` 取摘要命中
 *   实测出的四个问题：
 *     ① 通道①是**死代码**：conversation 分区已于 2026-10-27 按 v11 §S1 判废停建，现在 0 行；
 *     ② 通道②维护 769,131 行 / 110.4 MB 索引，而它索引的摘要全文只有 0.48 MB —— **230 倍**；
 *     ③ 排序键 `COUNT(DISTINCT term)` 让每块都有的摘要模板套话（`标签`/`叙事`/`情感`
 *        各命中 2,585 块）拿到最高分，**区分度为零**；
 *     ④ 实测召回耗时 258.4 ms，而 v11 围栏+精排仅 27.4 ms（同一批 40 条真实查询，
 *        召回率均 40/40，质量相当）。
 *
 *   现实现：走 `recallByStructured(domain='dialog_group')` + `scoreAndRank`，
 *   与**记忆召回共用同一套** UUID 闸门、分片 LIKE 围栏与精排**引擎**
 *   （可用性判定 / 权重重归一 / 确定性排序仍只有一处实现，杜绝判据漂移）。
 *
 * 🔴 排序分量按 ADR-010 §12.2.3（业主确认 2026-10-18）单独声明：
 *   `score = convDensity×0.40 + summaryDensity×0.30 + bothChannels×0.15 + calcium×0.15`
 *   即本域传 `ADR_010_BLOCK_SCHEME`；其余三域不传，仍走 v11 通用四权重。
 *   **不是第二套排序函数** —— 分量是声明，引擎仍是 `scoreAndRank` 一处（不变量 #7）。
 *   为什么通用四权重在本域不够用：它只有一个 `hit` 分量，而摘要路给的是「分片数」、
 *   原文路给的是「行数」，两路量纲不同被直接相加 ⇒ 双通道强度无法分辨，
 *   法典的密度与共振三个分量全部无从计算。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 户籍过滤
 *   UUID 闸门由 `StructuredRecall` 内部 `buildSqlClause` 产出，**第一个拼进 SQL**
 *   （蓝皮书 §3.1 第 4 条：不得先查后过滤 —— 后者会把他人的行读进内存）。
 *   本适配器只负责把 `ctx.policy.visibleUuids` 传下去，不自行拼任何 UUID 条件。
 *
 * 🔴 deny-by-default
 *   白名单为空 ⇒ 直接返回空（与 recallByStructured 红线 14 同一语义）。
 *   ⚠️ 行为收紧说明：旧实现会尊重 `policy.enforce === false`（离线巡检全库搜），
 *      新实现一律走 UUID 闸门。离线巡检的主要目标是记忆/知识域，对话块不参与。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 语义向量
 *   组级 40D 快照列 `perception_40d_snapshot` 由 `BlockArchiveService` 后台写入；
 *   无快照的组该列为 NULL ⇒ `cosine` 为 undefined ⇒ scoreAndRank 按语义权重 0 重归一
 *   （《40D 量纲统一法令》第四条：无向量只能跳过，不得填 0 冒充）。
 */

import type { RetrievalAdapter } from '../adapter.js';
import type { RetrievalContext, SearchHit } from '../types.js';
import { ADR_010_BLOCK_SCHEME, recallByStructured, scoreAndRank } from '../StructuredRecall.js';
import { ENCLOSURE_DEFAULT_LIMIT } from '../Flags.js';

/** 单块取多少轮正文拼 hit.text（够判断相关性即可，不追求完整） */
const TEXT_ROUNDS = 6;
/** hit.text 截断长度（与 ConversationAdapter 的 150 对齐） */
const TEXT_MAX = 300;
/**
 * 候选池倍数 —— 精排结果多取若干，供 lifecycle 降权后重排裁回 limit。
 *
 * 为什么需要：archived 组只降权不排除（只增不减铁律），若直接按精排取满 limit
 * 再降权，降权后的 archived 仍占名额。多取几倍后统一按最终分重排，语义与旧实现一致。
 */
const POOL_FACTOR = 5;
/**
 * 🔴 Phase 2.3 (E2/T005): archived 组排序降权系数。
 * 归档组**不排除**（仍可关键词命中），但排序权重乘此系数使其低于 active/consolidating。
 * 取 0.5：够低以让同命中数的 active 组稳定排前，又不至于把 archived 挤到完全不可见。
 */
const ARCHIVED_DECAY = 0.5;

/** 块正文行 */
export interface DialogGroupTextRow {
  dialog_group_id: string;
  role: string;
  content: string;
}

/** 块元信息行（精排结果不含 lifecycle 等字段，按 top-K id 回表取） */
export interface DialogGroupMetaRow {
  dialog_group_id: string;
  lifecycle_state: string | null;
  narrative_tag: string | null;
  scene_anchor_hash: string | null;
  turn_count: number | null;
  block_close_reason: string | null;
  last_ts: string | null;
}

/** 数据源接口（兼容 SQLiteAdapter.queryAll，同时也是 StructuredRecallDb 的形状） */
export interface DialogGroupSqlSource {
  queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
}

export class DialogGroupAdapter implements RetrievalAdapter {
  readonly domain = 'dialog_group' as const;
  readonly routes = ['dialog_group'] as const;

  constructor(private sqlite: DialogGroupSqlSource) {}

  async search(ctx: RetrievalContext): Promise<SearchHit[]> {
    const query = (ctx.query || '').trim();
    if (query.length < 2) return [];

    try {
      const limit = Number(ctx.limit) > 0 ? Math.floor(Number(ctx.limit)) : 3;
      const uuids = Array.from(ctx.policy?.visibleUuids ?? []).filter(Boolean);
      // deny-by-default：无白名单不检索（与 recallByStructured 红线 14 同语义）
      if (uuids.length === 0) return [];

      // 切词口径复用 v11 唯一实现（buildNgrams 同源），本适配器不自行滑窗
      const { buildKeywordShards } = await import('../StructuredRecall.js');

      // ── ①a 摘要通道（v11 围栏 + 精排，与记忆召回同一套实现）──
      //   🔴 业主 2026-11-02 明示：**原文通道才是主路，摘要通道是临时的、后续会被拆除**。
      //      本路因此按「可整体摘除」的形状接入，拆除时的爆炸半径锁死在三处：
      //        ① 下方这一段（①a）；
      //        ② `channels.summary` 字段与 ADR 方案里的 `summaryDensity` / `bothChannels`
      //           两个分量 —— 它们都走**可用性判定**，摘要恒为 0 时权重自动置 0 并重归一，
      //           方案退化为 `convDensity + calcium`，**引擎一行都不用改**；
      //        ③ 组装时的【摘要】前缀与 `payload.summary`。
      //      DOMAIN_SPECS.dialog_group 的 `textCol='block_summary'` / `extraWhere` 也属该链。
      //      除这三处外无任何代码依赖摘要通道 ⇒ 拆除是删代码，不是改判据。
      const summaryHits = await recallByStructured(
        this.sqlite,
        {
          domain: 'dialog_group',
          entityUuids: uuids,
          keywords: [query],
          limit: ENCLOSURE_DEFAULT_LIMIT,
        },
        ctx.perception40d ?? undefined,
      );

      // ── ①b 原文通道（**主路**，ADR-010 §12.2.2 的候选集另一半）──
      //   🔴 本路是长期主路（业主 2026-11-02：「原文通道才是主要的」）。它直接对
      //      conversations 按组聚合，**不经过** `block_summary` 的 `extraWhere` ——
      //      摘要路把 textCol 定死为 block_summary 且强制非空，只有本路能覆盖：
      //      ① 摘要没写到的会话段（改造前段级命中仅 20.8%）；
      //      ② 无摘要的组（改造前 479 组 / 15.7% 整组进不了候选池）。
      //   两路候选最后合并成一个 Map，排序统一走 ADR 方案，**不存在两套判据**。
      // 双通道候选查询的失败信号 —— ADR-010 §13.4 兜底的触发条件。
      // 🔴 只记**原文通道**的异常：摘要围栏的 SQL 出错时 `recallByStructured` 内部
      //    fail-closed 收成 `[]` 并 console.warn，本层看不到（要根治需让它暴露失败信号）。
      //    残余场景：摘要围栏内部失败 + 原文通道正常返回空 ⇒ 仍返回空。
      //    两路同时报错（数据库级故障的典型形态）则必然进兜底。
      let channelError: unknown = null;

      let rawRows: Array<{
        gid: string; hit_rows: number; u_hit: number | null; a_hit: number | null;
      }> = [];
      try {
        const shard = buildKeywordShards('content', [query]);
        if (shard.sql) {
          const uuidPhs = uuids.map(() => '?').join(',');
          // 按角色分计命中行数：ADR convDensity 的分子是「轮数」，而轮数只能从角色行推得。
          //
          // 🔴 `is_summary=1` 的行（对话块摘要归并进 conversations 后的形态）**只参与召回、
          //    不参与计数** —— 摘要行本身不是一轮对话，若计入 a_hit，每组会凭空多出 1 个
          //    「命中轮」，convDensity = max(u_hit,a_hit)/turn_count 直接失真。
          //    召回与计数在**同一条 SQL** 里用 CASE 分开，仍是一条通道（业主：
          //    「最终只保留原文通道一个」），不拆第二路、不 UNION。
          // ⚠️ 批1 时生产库 213 行 is_summary=1 的 dialog_group_id 全为 NULL，
          //    本条件恒真、排除无对象 ⇒ 迁移前零行为变化；批2 写入后才真正生效。
          //    摘要行的**命中识别**（供 channels.summary 用）留到批4 接线时一并加，
          //    本批不放用不上的列。
          rawRows = this.sqlite.queryAll<{
            gid: string; hit_rows: number; u_hit: number | null; a_hit: number | null;
          }>(
            `SELECT c.dialog_group_id AS gid,
                    COUNT(CASE WHEN COALESCE(c.is_summary, 0) = 0 THEN 1 END) AS hit_rows,
                    SUM(CASE WHEN COALESCE(c.is_summary, 0) = 0 AND c.role = 'user'
                             THEN 1 ELSE 0 END) AS u_hit,
                    SUM(CASE WHEN COALESCE(c.is_summary, 0) = 0 AND c.role = 'assistant'
                             THEN 1 ELSE 0 END) AS a_hit
               FROM conversations c
              WHERE c.dialog_group_id IS NOT NULL
                AND (c.is_test IS NULL OR c.is_test = 0)
                AND c.belong_entity_uuid IN (${uuidPhs})${shard.sql}
              GROUP BY c.dialog_group_id
              ORDER BY hit_rows DESC
              LIMIT ?`,
            [...uuids, ...shard.params, ENCLOSURE_DEFAULT_LIMIT],
          ) || [];
        }
      } catch (e) {
        // 原文通道不可用 ⇒ 先退回纯摘要路，不阻塞检索；两路皆空时下面走 §13.4 单表兜底
        channelError = e;
        console.warn('[DialogGroupAdapter] 原文通道不可用，仅用摘要通道:', (e as Error)?.message);
      }

      // ── ①c 候选合并（摘要命中 ∪ 原文命中，ADR-010 §12.2）──
      const merged = new Map<string, (typeof summaryHits)[number]>();
      for (const h of summaryHits) {
        merged.set(String(h.id), {
          ...h,
          channels: { summary: h.hitShards, content: 0, turnCount: 0 },
        });
      }

      for (const r of rawRows) {
        const gid = String(r.gid || '');
        if (!gid) continue;
        const hitRows = Number(r.hit_rows) || 0;
        // 命中轮数 = max(命中 user 行, 命中 assistant 行)。
        // 一轮恰有一条 user 一条 assistant（dialog-group-stage 的 turn_count 就按 u===a 守卫算），
        // 完全命中时两者同等于 turn_count ⇒ 密度恰好为 1，而不是被「行数 / 轮数」的量纲差顶到封顶。
        //
        // 为什么不是 `COUNT(*)`：行数 ≈ 2×轮数，用行数作分子会让密度在命中一半时就饱和到 1，
        //        区分度归零（这正是改造前的问题）。
        // 为什么不是 `COUNT(DISTINCT dialog_round)`：该列是 `DEFAULT 0` 且**无回填迁移**，
        //        只有新闭组才写值 ⇒ 存量全 0，密度会塌成 1/turn_count。
        // ⚠️ 已知低估边界：user 命中轮与 assistant 命中轮**不相交**时（如 u=3, a=3 却是 6 个不同
        //    轮），真值 6 而取 3，最多低估 50%。`max` 是真实命中轮数的**保真下界**
        //    （max ≤ 真值 ≤ u+a，且恒不超 turn_count），不会产生封顶失真。
        // ⚠️ `turn_count` 走 u≠a 退回 `rounds.length` 分支时（dialog-group-stage.ts），
        //    分母可能大于库内真实行数 ⇒ 即使全覆盖密度也到不了 1（实测 6/9=0.67）。
        const hitTurns = Math.max(Number(r.u_hit) || 0, Number(r.a_hit) || 0);
        const exist = merged.get(gid);
        if (exist) {
          const ch = exist.channels
            ?? (exist.channels = { summary: 0, content: 0, turnCount: 0 });
          ch.content = hitTurns;
          // 观测口径：两通道命中量之和（沿用改造前的累加行为）。
          // 🔴 它**不参与** ADR 精排 —— 摘要给的是分片数、原文给的是行数，量纲不同，
          //    相加只作 payload.hitShards 的可读观测，判据一律走 channels 分量。
          exist.hitShards += hitRows;
        } else {
          merged.set(gid, {
            id: gid,
            domain: 'dialog_group',
            text: '',                  // 有摘要的组在 ①d 回表补齐后才出现【摘要】前缀
            calciumScore: 0,
            createdAt: '',
            hitShards: hitRows,
            semanticSource: 'none',
            channels: { summary: 0, content: hitTurns, turnCount: 0 },
          } as (typeof summaryHits)[number]);
        }
      }

      // ── ①c' 兜底（ADR-010 §13.4）：候选查询抛错 ⇒ 单表取块，不整路返回空 ──
      //   法典原文：「双通道候选 SQL 抛错 ⇒ 降级为 `dialog_groups` 单表按 `last_ts DESC`
      //   取块，而不是整路返回空（返回空 = 该组永远召不回且对调用方完全静默）」。
      //   🔴 只在**报错**时兜底：两路都正常返回 0 条是「确实没命中」，此时返回空才是正确
      //      行为 —— 无差别塞最近的块会给调用方灌噪声。
      //   兜底候选同样过 UUID 闸门（deny-by-default 已在入口保证 uuids 非空），
      //   随后走同一套回表与精排（无通道数据 ⇒ 密度/共振分量失效并重归一，实质按钙分
      //   排序、`last_ts` 做同分 tiebreak）—— 不另开第二个排序点。
      if (merged.size === 0 && channelError) {
        try {
          const uuidPhs = uuids.map(() => '?').join(',');
          const fb = this.sqlite.queryAll<{ dialog_group_id: string }>(
            `SELECT dialog_group_id FROM dialog_groups
              WHERE belong_entity_uuid IN (${uuidPhs})
              ORDER BY last_ts DESC
              LIMIT ?`,
            [...uuids, limit],
          ) || [];
          for (const r of fb) {
            const gid = String(r.dialog_group_id || '');
            if (!gid || merged.has(gid)) continue;
            merged.set(gid, {
              id: gid,
              domain: 'dialog_group',
              text: '',
              calciumScore: 0,
              createdAt: '',
              hitShards: 0,
              semanticSource: 'none',
              channels: { summary: 0, content: 0, turnCount: 0 },
            } as (typeof summaryHits)[number]);
          }
          console.warn(
            `[DialogGroupAdapter] 双通道候选查询失败，已降级 dialog_groups 单表按 last_ts DESC 取 ${fb.length} 块（ADR-010 §13.4）:`,
            (channelError as Error)?.message,
          );
        } catch (e) {
          // 兜底自身也失败才允许返回空 —— 此时确属数据库不可用
          console.error('[DialogGroupAdapter] §13.4 单表兜底也失败:', (e as Error)?.message);
        }
      }

      // ── ①d 回表：全部候选的钙分 / 时间戳 / turn_count / 摘要 ──
      //   🔴 覆盖**全部**候选，不是只有原文独有候选：`turn_count` 是 ADR convDensity 的分母，
      //      摘要路候选同样要靠它才算得出密度；`block_summary` 则让「原文命中、摘要没命中」
      //      的组也带上【摘要】前置（ADR-010 §12.2.4），改造前这类组正文只有原文。
      //      钙分与时间戳缺失会让对应分量恒为 0。
      const preIds = [...merged.keys()];
      if (preIds.length > 0) {
        try {
          // 分批查：两路各取 500 ⇒ 合并后最多 1000 个占位符，分批避开 IN 参数上限
          const CHUNK = 400;
          for (let i = 0; i < preIds.length; i += CHUNK) {
            const part = preIds.slice(i, i + CHUNK);
            const ph = part.map(() => '?').join(',');
            const rows = this.sqlite.queryAll<{
              dialog_group_id: string; block_calcium_score: number | null;
              last_ts: string | null; created_at: string | null;
              turn_count: number | null; block_summary: string | null;
              belong_entity_uuid: string | null;
            }>(
              `SELECT dialog_group_id, block_calcium_score, last_ts, created_at,
                      turn_count, block_summary, belong_entity_uuid
                 FROM dialog_groups WHERE dialog_group_id IN (${ph})`,
              part,
            ) || [];
            for (const r of rows) {
              const h = merged.get(String(r.dialog_group_id));
              if (!h) continue;
              const ch = h.channels
                ?? (h.channels = { summary: 0, content: 0, turnCount: 0 });
              ch.turnCount = Number(r.turn_count) || 0;
              if (!h.calciumScore) h.calciumScore = Number(r.block_calcium_score) || 0;
              // last_ts 为空时回退 created_at：否则原文路候选 hitObj.createdAt 恒为 ''，
              // 时间分量与同分 tiebreak 都会失效
              if (!h.createdAt) h.createdAt = String(r.last_ts || r.created_at || '');
              // 原文路独有候选不带归属，不补则 hitObj.entityUuid 恒为 null（上层按实体过滤会漏）
              if (!h.belongEntityUuid) h.belongEntityUuid = r.belong_entity_uuid || null;
              if (!h.text) h.text = String(r.block_summary || '');
            }
          }
        } catch (e) {
          // 回表失败 ⇒ 分量按 0 参与（密度/钙分拿不到就重归一），不阻塞检索
          console.warn('[DialogGroupAdapter] 块元数据回表失败（分量按 0 参与精排）:', (e as Error)?.message);
        }
      }

      const hits = [...merged.values()];
      if (hits.length === 0) return [];

      // 精排：ADR-010 §12.2.3 四分量。第 3 参显式传 undefined —— 传了 scheme 后
      // 权重全由方案声明，此处不套用 v11 通用四权重（避免读代码的人误判生效来源）。
      const ranked = scoreAndRank(hits, Date.now(), undefined, ADR_010_BLOCK_SCHEME);
      const pool = ranked.slice(0, Math.max(limit, Math.floor(limit * POOL_FACTOR)));
      if (pool.length === 0) return [];

      // ── ② 回表：块元信息（lifecycle / tag / hash / turns / reason / last_ts）──
      const ids = pool.map((h) => h.id);
      const idPhs = ids.map(() => '?').join(',');
      const metas = this.sqlite.queryAll<DialogGroupMetaRow>(
        `SELECT dialog_group_id, lifecycle_state, narrative_tag, scene_anchor_hash,
                turn_count, block_close_reason, last_ts
         FROM dialog_groups WHERE dialog_group_id IN (${idPhs})`,
        ids,
      );
      const metaMap = new Map(metas.map((m) => [String(m.dialog_group_id), m]));

      // ── ③ 块正文：只为已选中的块取，查询量有界 ──
      const texts = this.sqlite.queryAll<DialogGroupTextRow>(
        `SELECT dialog_group_id, role, content FROM conversations
         WHERE dialog_group_id IN (${idPhs}) AND (is_test IS NULL OR is_test = 0)
         ORDER BY timestamp ASC`,
        ids,
      );
      const textMap = new Map<string, string[]>();
      for (const t of texts) {
        const k = String(t.dialog_group_id);
        const arr = textMap.get(k) || [];
        if (arr.length < TEXT_ROUNDS) arr.push(`${t.role === 'user' ? '用户' : ''}${t.content || ''}`);
        textMap.set(k, arr);
      }

      // ── ④ lifecycle 降权 + 组装 ──
      //   注入形态与原实现逐字一致：摘要前置到正文，模型先看到「这段对话讲什么」，
      //   再看原文细节。
      const scored = pool.map((h) => {
        const dgId = String(h.id);
        const meta = metaMap.get(dgId);
        const summary = String(h.text || '').trim();
        const bodyRaw = (textMap.get(dgId) || []).join(' ').replace(/\s+/g, ' ').trim();
        const body = (summary ? `【摘要】${summary} ${bodyRaw}` : bodyRaw).substring(0, TEXT_MAX);

        // archived 组不排除（只增不减），仅排序降权
        const decay = String(meta?.lifecycle_state || 'active') === 'archived' ? ARCHIVED_DECAY : 1;
        const rawScore = h.score * decay;
        const score = Number.isFinite(rawScore) ? Math.round(rawScore * 1000) / 1000 : 0;

        const hitObj: SearchHit = {
          id: dgId,
          domain: 'dialog_group' as const,
          text: body,
          score,
          route: 'dialog_group' as const,
          entityUuid: h.belongEntityUuid ?? null,
          calciumScore: h.calciumScore,
          createdAt: String(meta?.last_ts || h.createdAt || ''),
          payload: {
            narrativeTag: meta?.narrative_tag ?? null,
            sceneAnchorHash: meta?.scene_anchor_hash ?? null,
            turnCount: Number(meta?.turn_count) || 0,
            blockCloseReason: meta?.block_close_reason ?? null,
            lifecycleState: meta?.lifecycle_state ?? null,
            summary: summary || null,
            // v11 精排明细（可解释性；旧实现透传的是 matchedRows/summaryMatchedRows）
            hitShards: h.hitShards,
            cosine: typeof h.cosine === 'number' ? h.cosine : null,
            semanticSource: h.semanticSource,
          },
          backref: { table: 'dialog_groups', id: dgId },
        };
        return { hit: hitObj, score, ts: Date.parse(String(meta?.last_ts || '')) || 0 };
      });

      // 🔴 唯一排序点：按最终分降序，同分按时间降序保证确定性
      scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
      return scored.slice(0, limit).map((s) => s.hit);
    } catch (e) {
      // 单域异常不得阻塞其他检索路（与其余适配器同策略；runAdapter 另有兜底 catch）
      console.error('[DialogGroupAdapter]', (e as Error)?.message);
      return [];
    }
  }
}
