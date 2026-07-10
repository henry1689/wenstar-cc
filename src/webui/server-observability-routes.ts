/**
 * server-observability-routes — 可观测性路由
 *
 * 从 server.ts 拆分，wenstar-cx 风格：单个对象参数，统一 return boolean
 * 包含：/events, /api/status, /api/health, /api/alignment,
 *       /api/inductions, /api/landscape, /api/mirror, /api/modules
 */
import http from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bionic } from '../adapter/bionic-adapter.js';
import { logger } from '../common/utils/logger.js';

export type ObservabilityRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage: any;
  familyGraph: any;
  conversationHistory: any[];
  maintenance: any;
  m6: any;
  m7: any;
  m8: any;
  clueTracker: any;
  topicTracker: any;
  alignmentGuard: any;
  inductionScheduler: any;
  masterProfile: any;
  getSelfModel: () => any;
  sseClients: Set<http.ServerResponse>;
  hookMonitor?: Map<string, {
    name: string;
    callCount: number;
    errorCount: number;
    totalDuration: number;
    lastHeartbeat: number;
    lastStatus: string;
    recentDurations: number[];
    lastError: string | null;
  }>;
  hookDefs?: Array<{ id: string; name: string; th: number }>;
  orchestrator?: {
    getMode?: () => string;
    getHeartStore?: () => {
      getState: () => any;
      getAuditLog: () => any[];
      getEmotionLabel: () => any;
      getDesireHints: () => string[];
      getEmergenceHint: () => string;
    } | null;
  } | null;
  /** 🏗️ 防复发第二层: 角色扮演状态 */
  getRoleplayStatus?: () => { active: boolean; role: string | null; class: string | null; turns: number };
  hybridSearch?: { getDiagnostics?: () => { ready: boolean; embedderStatus: string }; isReady?: () => boolean } | null;
  enableNewArch?: boolean;
};

type HookCard = {
  id: string;
  name: string;
  status: string;
  callCount: number;
  errorCount: number;
  avgDuration: number;
  lastHeartbeat: number;
  lastError: string | null;
  thresholdMs: number;
  elapsedMs: number;
  errorRate: number;
  recentAvg: number;
};

function buildHookCards(
  hookDefs: ObservabilityRouteDeps['hookDefs'],
  hookMonitor: ObservabilityRouteDeps['hookMonitor'],
  now: number,
): HookCard[] {
  if (!hookDefs || !hookMonitor) return [];
  return hookDefs.map((d) => {
    const m = hookMonitor.get(d.id) ?? {
      name: d.name,
      callCount: 0,
      errorCount: 0,
      totalDuration: 0,
      lastHeartbeat: 0,
      lastStatus: 'gray',
      recentDurations: [],
      lastError: null,
    };
    const elapsed = now - m.lastHeartbeat;
    let status = m.lastStatus;
    if (m.lastHeartbeat === 0) status = 'gray';
    else if (elapsed > d.th) status = 'red';
    else if (elapsed > d.th / 3) status = 'yellow';
    else if (m.errorCount > 0 && m.callCount > 0 && (m.errorCount / m.callCount) > 0.1) status = 'red';
    else if (m.errorCount > 0 && m.callCount > 0 && (m.errorCount / m.callCount) > 0.03) status = 'yellow';
    else status = 'green';
    const avgD = m.callCount > 0 ? Math.round(m.totalDuration / m.callCount) : 0;
    return {
      id: d.id,
      name: d.name,
      status,
      callCount: m.callCount,
      errorCount: m.errorCount,
      avgDuration: avgD,
      lastHeartbeat: m.lastHeartbeat,
      lastError: m.lastError,
      thresholdMs: d.th,
      elapsedMs: elapsed,
      errorRate: m.callCount > 0 ? Number(((m.errorCount / m.callCount) * 100).toFixed(1)) : 0,
      recentAvg: m.recentDurations.length > 0
        ? Math.round(m.recentDurations.reduce((a, b) => a + b, 0) / m.recentDurations.length)
        : 0,
    };
  });
}

function buildHookAlerts(cards: HookCard[], now: number) {
  const alerts: any[] = [];
  const recovered: any[] = [];
  for (const card of cards) {
    if (card.status === 'red' || card.status === 'yellow') {
      const type = card.status === 'red'
        ? (card.elapsedMs > card.thresholdMs ? '心跳失联' : '错误率过高')
        : (card.elapsedMs > card.thresholdMs / 3 ? '响应缓慢' : '偶发报错');
      alerts.push({
        id: card.id,
        name: card.name,
        status: card.status,
        type,
        time: new Date(now).toISOString(),
        desc: card.lastError || (card.status === 'red' ? `节点 ${card.id} 无心跳上报` : '调用异常'),
        callCount: card.callCount,
        errorCount: card.errorCount,
      });
    } else if (card.lastHeartbeat > 0) {
      recovered.push({ id: card.id, name: card.name, time: new Date(now).toISOString() });
    }
  }
  alerts.sort((a, b) => a.status === 'red' ? -1 : 1);
  return { alerts: alerts.slice(0, 20), recovered: recovered.slice(0, 10), serverTime: now };
}

function buildHookDispatch(cards: HookCard[], now: number) {
  const redCount = cards.filter((c) => c.status === 'red').length;
  const yellowCount = cards.filter((c) => c.status === 'yellow').length;
  const greenCount = cards.filter((c) => c.status === 'green').length;
  const healthy = cards.length > 0 && cards.filter((c) => c.status === 'green' || c.status === 'gray').length === cards.length;
  const score = Math.max(0, Math.round((greenCount / Math.max(cards.length, 1)) * 100) - yellowCount * 5 - redCount * 15);
  const decisions: any[] = [];
  if (redCount > 0) decisions.push({ type: 'warn', target: `${redCount} 个节点断连`, action: '建议人工介入检查', time: new Date(now).toISOString() });
  if (yellowCount > 2) decisions.push({ type: 'info', target: `${yellowCount} 个节点预警`, action: '自动切换备用观测通道', time: new Date(now).toISOString() });
  if (yellowCount <= 2 && yellowCount > 0) decisions.push({ type: 'info', target: `${yellowCount} 个节点轻度异常`, action: '持续观测，暂不干预', time: new Date(now).toISOString() });
  if (healthy) decisions.push({ type: 'ok', target: `全系统${cards.length}/${cards.length}点位`, action: '运行正常，无需干预', time: new Date(now).toISOString() });
  const signals = cards
    .filter((card) => card.status !== 'gray')
    .map((card) => ({
      from: card.id,
      to: '中枢',
      type: card.status === 'green' ? '心跳正常' : card.status === 'yellow' ? '⚠️ 异常预警' : '🚨 断连告警',
      time: new Date(now).toISOString(),
    }));
  return {
    healthy,
    mode: healthy ? 'stable' : redCount > 0 ? 'degraded' : 'watch',
    score,
    cards,
    decisions,
    signals,
    summary: { greenCount, yellowCount, redCount, grayCount: cards.filter((c) => c.status === 'gray').length },
    serverTime: now,
  };
}

function buildHeartSnapshot(orchestrator: ObservabilityRouteDeps['orchestrator']) {
  const heartStore = orchestrator?.getHeartStore?.();
  if (!heartStore) {
    return {
      state: null,
      desireHints: [],
      emergenceHint: '',
      auditLog: [],
      mode: orchestrator?.getMode?.() ?? 'legacy',
    };
  }
  const state = heartStore.getState();
  return {
    state: {
      emotionVector: state.emotionVector,
      relationState: state.relationState,
      atmosphere: state.atmosphere,
      memoryPermission: state.memoryPermission,
      relationMetrics: state.relationMetrics,
      emotionLabel: heartStore.getEmotionLabel(),
      updatedAt: state.updatedAt,
    },
    desireHints: heartStore.getDesireHints(),
    emergenceHint: heartStore.getEmergenceHint(),
    auditLog: heartStore.getAuditLog().slice(-10),
    mode: orchestrator?.getMode?.() ?? 'legacy',
  };
}

function buildVaultHealth(input: {
  sand: {
    totalTurns: number;
    unpromotedTurns: number;
    readyForGold: number;
    promotionCoverage: number;
    staleBacklog: number;
    coldBacklog: number;
  };
  gold: {
    total: number;
    candidate: number;
    active: number;
    suppressed: number;
    healed: number;
    promoted: number;
    archived: number;
    readyForDiamond: number;
    readyByCalcium: number;
    readyByRecall: number;
    readyByLandmark: number;
    readyByMultiFactor: number;
    weakActive: number;
  };
  diamond: {
    total: number;
    linkedSources: number;
    orphaned: number;
    utilization: number;
    hotEntries: number;
    coldEntries: number;
    recentPromotions: number;
    directPromotions: number;
    mergedPromotions: number;
    multifactorPromotions: number;
    emotionCoverage: number;
  };
}) {
  const toStatus = (score: number): 'healthy' | 'watch' | 'risk' => {
    if (score >= 80) return 'healthy';
    if (score >= 55) return 'watch';
    return 'risk';
  };

  const sandScore = Math.max(
    0,
    100
      - Math.min(35, input.sand.readyForGold * 4)
      - Math.min(20, input.sand.staleBacklog * 3)
      - Math.min(15, input.sand.coldBacklog * 4)
      - Math.max(0, Math.round((55 - input.sand.promotionCoverage) * 0.6))
      - Math.min(20, Math.round((input.sand.unpromotedTurns / Math.max(input.sand.totalTurns, 1)) * 25)),
  );
  const goldScore = Math.max(
    0,
    100
      - Math.min(40, input.gold.readyForDiamond * 7)
      - Math.min(20, input.gold.suppressed * 3)
      - Math.min(18, input.gold.weakActive * 2)
      - Math.min(15, Math.max(0, input.gold.candidate - input.gold.active))
      + Math.min(8, input.gold.healed * 2),
  );
  const diamondScore = Math.max(
    0,
    100
      - Math.min(30, input.diamond.orphaned * 12)
      - Math.min(18, input.diamond.coldEntries * 3)
      - Math.max(0, Math.round((input.diamond.utilization - 85) * 1.5))
      - Math.max(0, Math.round((35 - input.diamond.utilization) * 0.8)),
      + Math.min(10, input.diamond.hotEntries * 2)
      + Math.min(6, input.diamond.emotionCoverage),
  );

  return {
    sand: {
      score: sandScore,
      status: toStatus(sandScore),
      reasons: [
        input.sand.readyForGold > 0 ? `${input.sand.readyForGold} 条砂金达到入金阈值` : null,
        input.sand.staleBacklog > 0 ? `${input.sand.staleBacklog} 条砂金滞留超过 24 小时` : null,
        input.sand.promotionCoverage < 60 ? `砂金晋升覆盖率仅 ${input.sand.promotionCoverage}%` : null,
      ].filter(Boolean),
      highlights: [
        `ready ${input.sand.readyForGold}`,
        `stale ${input.sand.staleBacklog}`,
        `coverage ${input.sand.promotionCoverage}%`,
      ],
      actions: [
        input.sand.readyForGold > 0
          ? { label: '运行砂金晋升', action: 'assessor:sand', target: '/api/assessor/run?action=sand', count: input.sand.readyForGold }
          : null,
      ].filter(Boolean),
    },
    gold: {
      score: goldScore,
      status: toStatus(goldScore),
      reasons: [
        input.gold.readyForDiamond > 0 ? `${input.gold.readyForDiamond} 条金库高钙记忆待晋升` : null,
        input.gold.readyByMultiFactor > 0 ? `${input.gold.readyByMultiFactor} 条记忆满足多因子晋升` : null,
        input.gold.suppressed > 0 ? `${input.gold.suppressed} 条记忆处于抑制态` : null,
        input.gold.weakActive > 0 ? `${input.gold.weakActive} 条活跃记忆已进入弱活性区` : null,
      ].filter(Boolean),
      highlights: [
        `ready ${input.gold.readyForDiamond}`,
        `recall ${input.gold.readyByRecall}`,
        `multi ${input.gold.readyByMultiFactor}`,
        `weak ${input.gold.weakActive}`,
      ],
      actions: [
        input.gold.readyForDiamond > 0
          ? { label: '执行黑钻晋升', action: 'vault:auto-promote', target: '/api/vault/auto-promote', count: input.gold.readyForDiamond }
          : null,
      ].filter(Boolean),
    },
    diamond: {
      score: diamondScore,
      status: toStatus(diamondScore),
      reasons: [
        input.diamond.orphaned > 0 ? `${input.diamond.orphaned} 颗黑钻缺少源记忆链接` : null,
        input.diamond.coldEntries > 0 ? `${input.diamond.coldEntries} 颗黑钻超过 30 天未被召回` : null,
        input.diamond.mergedPromotions > 0 ? `最近 7 天合钻 ${input.diamond.mergedPromotions} 次` : null,
        input.diamond.utilization > 85 ? `黑钻容量利用率 ${input.diamond.utilization}%` : null,
      ].filter(Boolean),
      highlights: [
        `hot ${input.diamond.hotEntries}`,
        `cold ${input.diamond.coldEntries}`,
        `merge ${input.diamond.mergedPromotions}`,
        `multi ${input.diamond.multifactorPromotions}`,
        `emotion ${input.diamond.emotionCoverage}`,
      ],
      actions: [],
    },
    overall: {
      score: Math.round((sandScore + goldScore + diamondScore) / 3),
      status: toStatus(Math.round((sandScore + goldScore + diamondScore) / 3)),
    },
  };
}

function buildMemoryActionables(rows: any[]) {
  return rows.map((row: any) => {
    const lifecycle = String(row.lifecycle_state ?? 'candidate');
    const memoryId = String(row.id ?? '');
    const params = new URLSearchParams({ memoryId });
    const actions: Array<{ label: string; action: string; target: string }> = [];

    if (lifecycle === 'suppressed') {
      actions.push({
        label: '愈合',
        action: 'heal',
        target: `/api/vault/memory/heal?${new URLSearchParams({ memoryId, healedBy: 'operator' }).toString()}`,
      });
    } else {
      if (!(Number(row.is_landmark ?? 0) === 1)) {
        actions.push({
          label: '升地标',
          action: 'promote',
          target: `/api/vault/memory/promote?${new URLSearchParams({ memoryId, narrativeTag: 'operator_promoted' }).toString()}`,
        });
      }
      actions.push({
        label: '抑制',
        action: 'suppress',
        target: `/api/vault/memory/suppress?${new URLSearchParams({ memoryId, scarType: 'manual_review' }).toString()}`,
      });
    }

    if (lifecycle !== 'archived') {
      actions.push({
        label: '归档',
        action: 'archive',
        target: `/api/vault/memory/archive?${params.toString()}`,
      });
    }

    return {
      id: memoryId,
      snippet: String(row.raw_input || '').substring(0, 88),
      lifecycle,
      calcium: Number(Number(row.calcium_score ?? 0).toFixed(2)),
      recall: Number(row.recall_count ?? 0),
      promotedToDiamond: Number(row.promoted_to_diamond ?? 0) === 1,
      isLandmark: Number(row.is_landmark ?? 0) === 1,
      primaryEmotion: row.primary_emotion || null,
      createdAt: row.created_at || null,
      actions,
    };
  });
}

function buildSourceLookup(rows: any[]) {
  const lookup: Record<string, any> = {};
  for (const row of rows) {
    const memoryId = String(row.id ?? '');
    if (!memoryId) continue;
    lookup[memoryId] = {
      id: memoryId,
      snippet: String(row.raw_input || '').substring(0, 88),
      lifecycle: String(row.lifecycle_state ?? 'candidate'),
      calcium: Number(Number(row.calcium_score ?? 0).toFixed(2)),
      recall: Number(row.recall_count ?? 0),
      promotedToDiamond: Number(row.promoted_to_diamond ?? 0) === 1,
      isLandmark: Number(row.is_landmark ?? 0) === 1,
      primaryEmotion: row.primary_emotion || null,
      createdAt: row.created_at || null,
      readonly: true,
      actions: [],
    };
  }
  return lookup;
}

export async function buildCommandCenterSnapshot(
  deps: ObservabilityRouteDeps,
): Promise<Record<string, any>> {
  const {
    storage, familyGraph, conversationHistory, maintenance,
    m6, m7, clueTracker, topicTracker, alignmentGuard,
    inductionScheduler, masterProfile, getSelfModel, getRoleplayStatus,
    hookDefs, hookMonitor, orchestrator,
  } = deps;
  const now = Date.now();
  const sqlite = storage.getSQLite();
  const storageStatus = await storage.getStatus().catch(() => null);
  const familySummary = await familyGraph.getFamilySummary().catch(() => ({ members: [], locations: [] }));
  const health = maintenance.getHealth();
  if (storageStatus) health.storage.totalRecords = storageStatus.totalRecords;
  const decayStats = storage.getDecayStats();
  const sqliteStatus = sqlite.getStatus();
  const landscape = storage.getEmotionalLandscape();
  const hookCards = buildHookCards(hookDefs, hookMonitor, now);
  const hookAlerts = buildHookAlerts(hookCards, now);
  const hookDispatch = buildHookDispatch(hookCards, now);
  const heart = buildHeartSnapshot(orchestrator);

  let alignmentSummary: { score: number; status: string } | null = null;
  try {
    const report = alignmentGuard.getCachedReport();
    if (report) alignmentSummary = { score: report.score, status: report.status };
  } catch {}

  let persistence = { userCount: 0, assistantCount: 0, ratio: '0' };
  try {
    const userRows = sqlite.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['user']);
    const assistantRows = sqlite.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['assistant']);
    const userCount = Number((userRows[0] as any)?.cnt ?? 0);
    const assistantCount = Number((assistantRows[0] as any)?.cnt ?? 0);
    persistence = { userCount, assistantCount, ratio: assistantCount > 0 ? (userCount / assistantCount).toFixed(2) : '0' };
  } catch {}

  let roleplay: { active: boolean; role: string | null; class: string | null; turns: number } = {
    active: false,
    role: null,
    class: null,
    turns: 0,
  };
  try {
    if (getRoleplayStatus) roleplay = getRoleplayStatus();
  } catch {}

  const noteRows = sqlite.queryAll(
    `SELECT COALESCE(sub_type, 'unknown') as sub_type, COUNT(*) as cnt
     FROM memories
     WHERE memory_type='note' AND (is_valid IS NULL OR is_valid=1)
     GROUP BY COALESCE(sub_type, 'unknown')`,
  ) as any[];
  const noteBreakdown = Object.fromEntries(noteRows.map((row: any) => [row.sub_type, Number(row.cnt ?? 0)]));
  const typeRows = sqlite.queryAll(
    `SELECT COALESCE(memory_type, 'emotional') as memory_type, COUNT(*) as cnt
     FROM memories
     GROUP BY COALESCE(memory_type, 'emotional')`,
  ) as any[];
  const memoryTypes = Object.fromEntries(typeRows.map((row: any) => [row.memory_type, Number(row.cnt ?? 0)]));
  const leafRows = sqlite.queryAll(
    `SELECT COALESCE(leaf_zone, 'unknown') as leaf_zone, COUNT(*) as cnt
     FROM memories
     GROUP BY COALESCE(leaf_zone, 'unknown')
     ORDER BY cnt DESC
     LIMIT 8`,
  ) as any[];
  const diamondRows = sqlite.queryAll('SELECT COUNT(*) as cnt FROM black_diamond') as any[];
  const reminderRows = sqlite.queryAll(
    `SELECT COUNT(*) as cnt
     FROM memories
     WHERE memory_type='note' AND sub_type='reminder' AND reminded=0 AND (is_valid IS NULL OR is_valid=1)`,
  ) as any[];
  const memoryLinkageRows = sqlite.queryAll(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN dna_root_id IS NOT NULL AND dna_root_id != '' THEN 1 ELSE 0 END) as with_dna_root,
       SUM(CASE WHEN dialog_group_id IS NOT NULL AND dialog_group_id != '' THEN 1 ELSE 0 END) as with_dialog_group,
       SUM(CASE WHEN memory_type = 'rp_dialog' THEN 1 ELSE 0 END) as roleplay_dialogs,
       SUM(CASE WHEN promoted_to_diamond = 1 THEN 1 ELSE 0 END) as promoted,
       SUM(CASE WHEN scar_type IS NOT NULL AND scar_healed = 1 THEN 1 ELSE 0 END) as healed_scars,
       SUM(CASE WHEN calcium_score >= 4.5 AND (promoted_to_diamond IS NULL OR promoted_to_diamond = 0) THEN 1 ELSE 0 END) as high_calcium_unpromoted
     FROM memories`,
  ) as any[];
  const groupRows = sqlite.queryAll(
    `SELECT
       COUNT(DISTINCT dialog_group_id) as total_groups,
       AVG(round_count) as avg_rounds,
       SUM(CASE WHEN memory_type = 'rp_dialog' THEN 1 ELSE 0 END) as roleplay_group_rows
     FROM (
       SELECT DISTINCT dialog_group_id, round_count, memory_type
       FROM memories
       WHERE dialog_group_id IS NOT NULL AND dialog_group_id != ''
     )`,
  ) as any[];
  const convRows = sqlite.queryAll(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN is_promoted = 0 THEN 1 ELSE 0 END) as unpromoted,
       SUM(CASE WHEN is_promoted = 0 AND calcium_score >= 1.0 THEN 1 ELSE 0 END) as ready_for_gold,
       SUM(CASE WHEN dna_root_id IS NOT NULL AND dna_root_id != '' THEN 1 ELSE 0 END) as with_dna_root,
       SUM(CASE WHEN dialog_group_id IS NOT NULL AND dialog_group_id != '' THEN 1 ELSE 0 END) as with_dialog_group,
       SUM(CASE WHEN roleplay_char IS NOT NULL AND roleplay_char != '' THEN 1 ELSE 0 END) as roleplay_turns
     FROM conversations`,
  ) as any[];
  const sandBacklogRows = sqlite.queryAll(
    `SELECT
       SUM(CASE WHEN is_promoted = 0 AND timestamp < datetime('now', '-24 hours') THEN 1 ELSE 0 END) as stale_unpromoted,
       SUM(CASE WHEN is_promoted = 0 AND timestamp < datetime('now', '-72 hours') THEN 1 ELSE 0 END) as cold_unpromoted
     FROM conversations`,
  ) as any[];
  const lifecycleRows = sqlite.queryAll(
    `SELECT
       SUM(CASE WHEN COALESCE(lifecycle_state, 'candidate') = 'candidate' THEN 1 ELSE 0 END) as candidate_count,
       SUM(CASE WHEN lifecycle_state = 'active' THEN 1 ELSE 0 END) as active_count,
       SUM(CASE WHEN lifecycle_state = 'suppressed' THEN 1 ELSE 0 END) as suppressed_count,
       SUM(CASE WHEN lifecycle_state = 'healed' THEN 1 ELSE 0 END) as healed_count,
       SUM(CASE WHEN lifecycle_state = 'promoted' THEN 1 ELSE 0 END) as promoted_count,
       SUM(CASE WHEN lifecycle_state = 'archived' THEN 1 ELSE 0 END) as archived_count
     FROM memories`,
  ) as any[];
  const goldReadinessRows = sqlite.queryAll(
    `SELECT
       SUM(CASE
         WHEN COALESCE(promoted_to_diamond, 0) = 0
          AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
          AND calcium_score >= 4.5
         THEN 1 ELSE 0 END) as ready_by_calcium,
       SUM(CASE
         WHEN COALESCE(promoted_to_diamond, 0) = 0
          AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
          AND recall_count >= 5
         THEN 1 ELSE 0 END) as ready_by_recall,
       SUM(CASE
         WHEN COALESCE(promoted_to_diamond, 0) = 0
          AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
          AND is_landmark = 1
          AND calcium_score >= 3.5
         THEN 1 ELSE 0 END) as ready_by_landmark,
       SUM(CASE
         WHEN COALESCE(promoted_to_diamond, 0) = 0
          AND COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
          AND NOT (is_landmark = 1 AND calcium_score >= 3.5)
          AND calcium_score < 4.5
          AND recall_count < 5
          AND (
            (CASE WHEN is_landmark = 1 THEN 2 ELSE 0 END) +
            (CASE WHEN calcium_score >= 4.0 THEN 3 WHEN calcium_score >= 3.5 THEN 2 ELSE 0 END) +
            (CASE WHEN recall_count >= 4 THEN 2 WHEN recall_count >= 3 THEN 1 ELSE 0 END) +
            (CASE WHEN COALESCE(effective_strength, 0) >= 0.72 THEN 2 WHEN COALESCE(effective_strength, 0) >= 0.58 THEN 1 ELSE 0 END) +
            (CASE WHEN scar_type IS NOT NULL AND scar_type != '' THEN 1 ELSE 0 END) +
            (CASE WHEN narrative_tag IS NOT NULL AND narrative_tag != '' THEN 1 ELSE 0 END)
          ) >= 5
          AND (
            (CASE WHEN is_landmark = 1 THEN 1 ELSE 0 END) +
            (CASE WHEN calcium_score >= 3.5 THEN 1 ELSE 0 END) +
            (CASE WHEN recall_count >= 3 THEN 1 ELSE 0 END) +
            (CASE WHEN COALESCE(effective_strength, 0) >= 0.58 THEN 1 ELSE 0 END) +
            (CASE WHEN scar_type IS NOT NULL AND scar_type != '' THEN 1 ELSE 0 END) +
            (CASE WHEN narrative_tag IS NOT NULL AND narrative_tag != '' THEN 1 ELSE 0 END)
          ) >= 2
         THEN 1 ELSE 0 END) as ready_by_multifactor,
       SUM(CASE
         WHEN COALESCE(promoted_to_diamond, 0) = 0
          AND lifecycle_state = 'active'
          AND COALESCE(effective_strength, 0) < 0.25
         THEN 1 ELSE 0 END) as weak_active
     FROM memories`,
  ) as any[];
  const knowledgeRows = sqlite.queryAll(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN classification_pending = 0 THEN 1 ELSE 0 END) as classified,
       SUM(CASE WHEN classification_pending = 1 THEN 1 ELSE 0 END) as pending
     FROM knowledge_base`,
  ) as any[];
  const knowledgeLinkRows = sqlite.queryAll(
    `SELECT
       COUNT(*) as links,
       COUNT(DISTINCT knowledge_id) as linked_knowledge_items,
       COUNT(DISTINCT memory_id) as linked_memories
     FROM knowledge_memories`,
  ) as any[];
  const vaultLogRows = sqlite.queryAll(
    `SELECT operation, source_type, source_id, target_id, detail, created_at
     FROM vault_log
     ORDER BY created_at DESC
     LIMIT 8`,
  ) as any[];
  const diamondSourceRows = sqlite.queryAll(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN source_id IS NOT NULL AND source_id != '' THEN 1 ELSE 0 END) as linked_sources
     FROM black_diamond`,
  ) as any[];
  const diamondActivityRows = sqlite.queryAll(
    `SELECT
       SUM(CASE WHEN recall_count >= 3 THEN 1 ELSE 0 END) as hot_entries,
       SUM(CASE WHEN recall_count = 0 AND created_at < datetime('now', '-30 days') THEN 1 ELSE 0 END) as cold_entries,
       SUM(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as recent_promotions,
       COUNT(DISTINCT COALESCE(emotion_tag, 'unknown')) as emotion_coverage
     FROM black_diamond`,
  ) as any[];
  const recentDiamondRows = sqlite.queryAll(
    `SELECT id, summary, emotion_tag, tags, notes, source_id, namespace, created_at, updated_at, calcium_level, recall_count
     FROM black_diamond
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 6`,
  ) as any[];
  const vaultPromotionRows = sqlite.queryAll(
    `SELECT
       SUM(CASE WHEN operation = 'merge_promote' AND created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as merged_promotions,
       SUM(CASE WHEN operation = 'promote' AND created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as direct_promotions,
       SUM(CASE WHEN operation = 'promote' AND detail LIKE '%multi-factor:%' AND created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as multifactor_promotions
     FROM vault_log`,
  ) as any[];
  const actionableMemoryRows = sqlite.queryAll(
    `SELECT id, raw_input, calcium_score, recall_count, lifecycle_state,
            promoted_to_diamond, is_landmark, primary_emotion, created_at
     FROM memories
     WHERE (
       (COALESCE(lifecycle_state, 'candidate') IN ('candidate', 'active', 'healed')
        AND COALESCE(promoted_to_diamond, 0) = 0
        AND calcium_score >= 3.5)
       OR lifecycle_state = 'suppressed'
     )
     ORDER BY CASE WHEN lifecycle_state = 'suppressed' THEN 0 ELSE 1 END,
              calcium_score DESC,
              recall_count DESC,
              created_at DESC
     LIMIT 8`,
  ) as any[];
  const sourceLookupIds = Array.from(new Set(
    [
      ...recentDiamondRows.map((row: any) => row.source_id),
      ...vaultLogRows
        .filter((row: any) => row.operation === 'promote' || row.operation === 'merge_promote')
        .map((row: any) => row.source_id),
    ]
      .filter((id: any) => typeof id === 'string' && id.trim().length > 0)
      .map((id: string) => id.trim()),
  ));
  const sourceLookupRows = sourceLookupIds.length > 0
    ? sqlite.queryAll(
      `SELECT id, raw_input, calcium_score, recall_count, lifecycle_state,
              promoted_to_diamond, is_landmark, primary_emotion, created_at
       FROM memories
       WHERE id IN (${sourceLookupIds.map(() => '?').join(',')})
       ORDER BY created_at DESC`,
      sourceLookupIds,
    ) as any[]
    : [];

  const memoryLinkage = memoryLinkageRows[0] as any ?? {};
  const groupStats = groupRows[0] as any ?? {};
  const conversationStats = convRows[0] as any ?? {};
  const sandBacklog = sandBacklogRows[0] as any ?? {};
  const lifecycleStats = lifecycleRows[0] as any ?? {};
  const goldReadiness = goldReadinessRows[0] as any ?? {};
  const knowledgeStats = knowledgeRows[0] as any ?? {};
  const knowledgeLinks = knowledgeLinkRows[0] as any ?? {};
  const diamondSources = diamondSourceRows[0] as any ?? {};
  const diamondActivity = diamondActivityRows[0] as any ?? {};
  const vaultPromotionStats = vaultPromotionRows[0] as any ?? {};

  const percent = (part: number, total: number): number => {
    if (!total) return 0;
    return Number(((part / total) * 100).toFixed(1));
  };

  const vaults = {
    sand: {
      totalTurns: Number(conversationStats.total ?? 0),
      unpromotedTurns: Number(conversationStats.unpromoted ?? 0),
      readyForGold: Number(conversationStats.ready_for_gold ?? 0),
      staleBacklog: Number(sandBacklog.stale_unpromoted ?? 0),
      coldBacklog: Number(sandBacklog.cold_unpromoted ?? 0),
      promotionCoverage: percent(
        Number(conversationStats.total ?? 0) - Number(conversationStats.unpromoted ?? 0),
        Number(conversationStats.total ?? 0),
      ),
    },
    gold: {
      total: Number(memoryLinkage.total ?? 0),
      candidate: Number(lifecycleStats.candidate_count ?? 0),
      active: Number(lifecycleStats.active_count ?? 0),
      suppressed: Number(lifecycleStats.suppressed_count ?? 0),
      healed: Number(lifecycleStats.healed_count ?? 0),
      promoted: Number(lifecycleStats.promoted_count ?? 0),
      archived: Number(lifecycleStats.archived_count ?? 0),
      readyForDiamond: Number(memoryLinkage.high_calcium_unpromoted ?? 0),
      readyByCalcium: Number(goldReadiness.ready_by_calcium ?? 0),
      readyByRecall: Number(goldReadiness.ready_by_recall ?? 0),
      readyByLandmark: Number(goldReadiness.ready_by_landmark ?? 0),
      readyByMultiFactor: Number(goldReadiness.ready_by_multifactor ?? 0),
      weakActive: Number(goldReadiness.weak_active ?? 0),
    },
    diamond: {
      total: Number((diamondRows[0] as any)?.cnt ?? 0),
      linkedSources: Number(diamondSources.linked_sources ?? 0),
      orphaned: Math.max(0, Number(diamondSources.total ?? 0) - Number(diamondSources.linked_sources ?? 0)),
      utilization: percent(Number(diamondSources.total ?? 0), 200),
      hotEntries: Number(diamondActivity.hot_entries ?? 0),
      coldEntries: Number(diamondActivity.cold_entries ?? 0),
      recentPromotions: Number(diamondActivity.recent_promotions ?? 0),
      directPromotions: Number(vaultPromotionStats.direct_promotions ?? 0),
      mergedPromotions: Number(vaultPromotionStats.merged_promotions ?? 0),
      multifactorPromotions: Number(vaultPromotionStats.multifactor_promotions ?? 0),
      emotionCoverage: Number(diamondActivity.emotion_coverage ?? 0),
    },
  };
  const vaultHealth = buildVaultHealth(vaults);

  const m6Model = m6?.getModel?.();
  const m6Traits = m6?.getTraits?.() ?? getSelfModel().traits;
  const m6Prefs = m6?.getPreferences?.() ?? [];
  const m6Bounds = m6?.getBoundaries?.() ?? [];
  const m6Layers = m6?.getNarrativeLayers?.() ?? [];
  const m7Pending = m7?.queue?.getPending?.() ?? [];
  const m7All = m7?.queue?.getByStatus?.('confirmed') ?? [];
  const m7Logs = clueTracker?.getLogs?.() ?? [];
  const inductions = inductionScheduler?.getInductions?.() ?? [];
  const dreamDiamondCount = sqlite.queryAll("SELECT COUNT(*) as cnt FROM black_diamond WHERE tags LIKE '%dream_%'") as any[];
  const recentDreamRows = sqlite.queryAll(
    "SELECT id, summary, emotion_tag FROM black_diamond WHERE tags LIKE '%dream_%' ORDER BY created_at DESC LIMIT 5",
  ) as any[];

  let mirrorCounts = { profile: 0, affairs: 0, network: 0, events: 0, aboutYou: 0 };
  try {
    mirrorCounts = {
      profile: sqlite.queryAll('SELECT COUNT(*) as cnt FROM master_profile')[0]?.cnt ?? 0,
      affairs: sqlite.queryAll("SELECT COUNT(*) as cnt FROM master_affairs WHERE status != 'abandoned'")[0]?.cnt ?? 0,
      network: sqlite.queryAll('SELECT COUNT(*) as cnt FROM master_network')[0]?.cnt ?? 0,
      events: sqlite.queryAll('SELECT COUNT(*) as cnt FROM master_events')[0]?.cnt ?? 0,
      aboutYou: masterProfile.retrieveAboutYou(10).length,
    };
  } catch {}

  return {
    generatedAt: new Date(now).toISOString(),
    system: {
      status: 'running',
      version: '0.1.0',
      mode: orchestrator?.getMode?.() ?? 'legacy',
      conversationTurns: Math.floor(conversationHistory.length / 2),
      storage: storageStatus ? {
        totalRecords: storageStatus.totalRecords,
        zoneCounts: storageStatus.zoneCounts,
        seqPos: storageStatus.currentSeqPos,
      } : null,
      family: {
        total: familySummary.members.length,
        members: familySummary.members.map((m: any) => ({ name: m.name, relation: m.relation_to_user })),
      },
      roleplay,
    },
    hooks: {
      cards: hookCards,
      alerts: hookAlerts,
      dispatch: hookDispatch,
    },
    memory: {
      overview: {
        totalRecords: storageStatus?.totalRecords ?? 0,
        landmarks: sqliteStatus.landmarks,
        entities: sqliteStatus.totalEntities,
        scars: landscape.scars.length,
        diamonds: Number((diamondRows[0] as any)?.cnt ?? 0),
        pendingReminders: Number((reminderRows[0] as any)?.cnt ?? 0),
        avgStrength: decayStats.avgStrength,
        strongCount: decayStats.strongCount,
        weakCount: decayStats.weakCount,
      },
      taxonomy: {
        memoryTypes,
        notes: noteBreakdown,
        topLeafZones: leafRows.map((row: any) => ({ zone: row.leaf_zone, count: Number(row.cnt ?? 0) })),
      },
      alignment: alignmentSummary,
      persistence,
      designSignals: {
        inductions: inductions.length,
        m7Pending: m7Pending.length,
        m7Confirmed: m7All.length,
        clueLogs: m7Logs.length,
        researchTopics: topicTracker?.getStats?.() ?? {},
        dreamEntries: Number((dreamDiamondCount[0] as any)?.cnt ?? 0),
      },
      threading: {
        dialogGroups: Number(groupStats.total_groups ?? 0),
        avgRoundsPerGroup: Number(Number(groupStats.avg_rounds ?? 0).toFixed(1)),
        roleplayGroups: Number(groupStats.roleplay_group_rows ?? 0),
        memoryDnaCoverage: percent(Number(memoryLinkage.with_dna_root ?? 0), Number(memoryLinkage.total ?? 0)),
        memoryGroupCoverage: percent(Number(memoryLinkage.with_dialog_group ?? 0), Number(memoryLinkage.total ?? 0)),
        conversationDnaCoverage: percent(Number(conversationStats.with_dna_root ?? 0), Number(conversationStats.total ?? 0)),
        conversationGroupCoverage: percent(Number(conversationStats.with_dialog_group ?? 0), Number(conversationStats.total ?? 0)),
        roleplayTurns: Number(conversationStats.roleplay_turns ?? 0),
      },
      lifecycle: {
        promotedToDiamond: Number(memoryLinkage.promoted ?? 0),
        healedScars: Number(memoryLinkage.healed_scars ?? 0),
        unhealedScars: landscape.scars.length,
        roleplayDialogs: Number(memoryLinkage.roleplay_dialogs ?? 0),
        highCalciumUnpromoted: Number(memoryLinkage.high_calcium_unpromoted ?? 0),
      },
      vaults,
      vaultHealth,
      operations: {
        recent: vaultLogRows.map((row: any) => ({
          operation: row.operation || 'unknown',
          sourceType: row.source_type || null,
          sourceId: row.source_id || null,
          targetId: row.target_id || null,
          detail: row.detail || '',
          createdAt: row.created_at || null,
          emphasis:
            row.operation === 'merge_promote'
              ? 'merge'
              : String(row.detail || '').includes('multi-factor:')
                ? 'multi-factor'
                : row.operation === 'promote'
                  ? 'direct'
                  : 'neutral',
        })),
      },
      diamondFlow: {
        recent: recentDiamondRows.map((row: any) => {
          const notes = String(row.notes || '');
          const tags = typeof row.tags === 'string'
            ? (() => { try { return JSON.parse(row.tags); } catch { return []; } })()
            : (row.tags || []);
          const merged = notes.includes('合并来源');
          const multifactor = notes.includes('multi-factor:');
          return {
            id: row.id || null,
            summary: (row.summary || '').substring(0, 120),
            emotionTag: row.emotion_tag || '未分类',
            sourceId: row.source_id || null,
            namespace: row.namespace || 'default',
            calciumLevel: Number(row.calcium_level ?? 0),
            recallCount: Number(row.recall_count ?? 0),
            updatedAt: row.updated_at || row.created_at || null,
            tags: Array.isArray(tags) ? tags.slice(0, 5) : [],
            mode: merged ? 'merge' : multifactor ? 'multi-factor' : 'direct',
          };
        }),
        operations: vaultLogRows
          .filter((row: any) => row.operation === 'promote' || row.operation === 'merge_promote')
          .slice(0, 6)
          .map((row: any) => ({
            operation: row.operation || 'unknown',
            sourceId: row.source_id || null,
            targetId: row.target_id || null,
            detail: row.detail || '',
            createdAt: row.created_at || null,
            mode:
              row.operation === 'merge_promote'
                ? 'merge'
                : String(row.detail || '').includes('multi-factor:')
                  ? 'multi-factor'
                  : 'direct',
          })),
      },
      sourceLookup: buildSourceLookup(sourceLookupRows),
      actionables: buildMemoryActionables(actionableMemoryRows),
      knowledge: {
        total: Number(knowledgeStats.total ?? 0),
        classified: Number(knowledgeStats.classified ?? 0),
        pending: Number(knowledgeStats.pending ?? 0),
        linkedKnowledgeItems: Number(knowledgeLinks.linked_knowledge_items ?? 0),
        linkedMemories: Number(knowledgeLinks.linked_memories ?? 0),
        totalLinks: Number(knowledgeLinks.links ?? 0),
      },
    },
    modules: {
      m6: {
        version: m6Model?.version ?? '1.0',
        traitCount: Object.keys(m6Traits ?? {}).length,
        preferenceCount: m6Prefs.length,
        boundaryCount: m6Bounds.length,
        narrativeLayers: m6Layers.slice(0, 5),
      },
      m7: {
        totalPending: m7Pending.length,
        totalConfirmed: m7All.length,
        totalLogs: m7Logs.length,
        recentLogs: m7Logs.slice(-5),
      },
      m8: {
        landmarks: sqliteStatus.landmarks,
        scars: landscape.scars.length,
        peaks: landscape.peaks.slice(0, 5),
        recentDreams: recentDreamRows.map((row: any) => ({
          id: row.id,
          summary: (row.summary || '').substring(0, 80),
          emotion: row.emotion_tag || '未分类',
        })),
      },
      mirror: mirrorCounts,
    },
    heart,
  };
}

export async function handleObservabilityRoutes(
  deps: ObservabilityRouteDeps,
): Promise<boolean> {
  const {
    req, res, url,
    storage, familyGraph, conversationHistory, maintenance,
    m6, m7, m8, clueTracker, topicTracker, alignmentGuard,
    inductionScheduler, masterProfile, getSelfModel, sseClients,
    orchestrator, hybridSearch, enableNewArch,
  } = deps;

  // ── SSE 实时推送 ──
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {"status":"ok"}\n\n');
    sseClients.add(res);
    req.on('close', function() { sseClients.delete(res); });
    return true;
  }

  // ── 系统状态 ──
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const storageStatus = await storage.getStatus().catch(() => null);
    const familySummary = await familyGraph.getFamilySummary().catch(() => ({ members: [], locations: [] }));
    const hybrid = hybridSearch?.getDiagnostics?.() ?? {
      ready: hybridSearch?.isReady?.() ?? false,
      embedderStatus: 'unknown',
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'running', version: '0.1.0',
      conversation_turns: Math.floor(conversationHistory.length / 2),
      runtime: {
        enable_new_arch: !!enableNewArch,
        orchestrator_mode: orchestrator?.getMode?.() ?? null,
        hybrid_search: hybrid,
      },
      storage: storageStatus ? {
        total_records: storageStatus.totalRecords,
        zone_counts: storageStatus.zoneCounts,
        seq_pos: storageStatus.currentSeqPos,
      } : null,
      family: { members: familySummary.members.map((m: any) => ({ name: m.name, relation: m.relation_to_user })), total: familySummary.members.length },
    }));
    return true;
  }

  // ── 健康检查（含持久化健康度 + 文件健康度监控，改造③+⑥）──
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const health = maintenance.getHealth();
    const storageStatus = await storage.getStatus().catch(() => null);
    if (storageStatus) health.storage.totalRecords = storageStatus.totalRecords;
    const decayStats = storage.getDecayStats();
    const m8st = storage.getSQLite().getStatus();
    let alignmentSummary: { score: number; status: string } | null = null;
    try {
      const _ar = alignmentGuard.getCachedReport();
      if (_ar) alignmentSummary = { score: _ar.score, status: _ar.status };
    } catch (e: any) { console.error('[Observability] error:', e?.message); }
    let _pSimple: any = { userCount: 0, assistantCount: 0, ratio: '0' };
    let _chatAlert: string | null = null;
    try {
      const _mdb = storage.getSQLite();
      const _uc = _mdb.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['user']);
      const _ac = _mdb.queryAll('SELECT COUNT(*) as cnt FROM memories WHERE leaf_zone=?', ['assistant']);
      const uc = Number((_uc[0] as any)?.cnt ?? 0);
      const ac = Number((_ac[0] as any)?.cnt ?? 0);
      _pSimple = { userCount: uc, assistantCount: ac, ratio: ac > 0 ? (uc / ac).toFixed(2) : '0' };
      const _oFile = fileURLToPath(import.meta.url);
      const _chatPath = join(dirname(dirname(_oFile)), 'webui', 'chat.ts');
      if (existsSync(_chatPath) && statSync(_chatPath).size > 100 * 1024) {
        _chatAlert = 'chat.ts 超过100KB';
      }
    } catch (_pe) { /* stats not critical */ }
    // 🏗️ 防复发第二层: 角色扮演健康状态
    let _rpStatus: any = { active: false };
    try {
      if (deps.getRoleplayStatus) {
        const _rps = deps.getRoleplayStatus();
        _rpStatus = { active: _rps.active, role: _rps.role, class: _rps.class, turns: _rps.turns };
      }
    } catch (_rpe) { /* roleplay status not critical */ }
    const hybrid = hybridSearch?.getDiagnostics?.() ?? {
      ready: hybridSearch?.isReady?.() ?? false,
      embedderStatus: 'unknown',
    };
    let bionicStatus = bionic.getHealthSnapshot();
    if (bionicStatus.reachable === null) {
      const reachable = await bionic.health().catch(() => false);
      bionicStatus = {
        reachable,
        cached: true,
        lastCheckedAt: Date.now(),
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...health,
      alignment: alignmentSummary,
      memory: { ...health.memory, decay: decayStats, landmarks: m8st.landmarks, entities: m8st.totalEntities },
      persistence: _pSimple,
      chatFileAlert: _chatAlert,
      roleplay: _rpStatus,
      runtime: {
        enableNewArch: !!enableNewArch,
        orchestratorMode: orchestrator?.getMode?.() ?? null,
        hybridSearch: hybrid,
        bionic: bionicStatus,
      },
    }));
    return true;
  }

  // ── 向量对齐巡检 ──
  if (req.method === 'GET' && url.pathname === '/api/alignment') {
    try {
      alignmentGuard.registerDependencies({
        getSqlite: () => storage.getSQLite() as any,
        getMemoriesCount: () => { try { const sql = storage.getSQLite(); const r = sql.queryAll('SELECT COUNT(*) as c FROM memories'); return (r[0] as any)?.c || 0; } catch { return 0; } },
        getConversationHistoryLen: () => conversationHistory.length,
      });
      const repair = req.url?.includes('repair=true') || req.url?.includes('auto=true');
      let result = alignmentGuard.fullCheck();
      if (repair && result.status !== 'healthy') {
        const fixed = alignmentGuard.autoRepair();
        result = alignmentGuard.fullCheck();
        result.recommendations.unshift('🛠️ 自动修复: ca_level=' + fixed.caLevelFixed + ', strength=' + fixed.strengthFixed);
      }
      const verbose = !!req.url?.includes('verbose=true');
      const payload: any = { ...result };
      if (verbose) { payload.auditLog = alignmentGuard.getAuditLogs(20); payload.turnCounter = alignmentGuard.getTurnCounter(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
    }
    return true;
  }

  // ── 归纳历史 ──
  if (req.method === 'GET' && url.pathname === '/api/inductions') {
    const inductions = inductionScheduler?.getInductions() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ total: inductions.length, inductions }));
    return true;
  }

  // ── 情感地形图 ──
  if (req.method === 'GET' && url.pathname === '/api/landscape') {
    const landscape = storage.getEmotionalLandscape();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(landscape));
    return true;
  }

  // ── 主人镜像 ──
  if (req.method === 'GET' && url.pathname === '/api/mirror') {
    const result: Record<string, any> = {};
    try {
      result.profile = storage.getSQLite().queryAll('SELECT category, content, confidence FROM master_profile ORDER BY confidence DESC LIMIT 20');
      result.affairs = storage.getSQLite().queryAll("SELECT title, category, status FROM master_affairs WHERE status != 'abandoned' ORDER BY updated_at DESC LIMIT 10");
      result.network = storage.getSQLite().queryAll('SELECT person_name, relation_type, organization FROM master_network ORDER BY importance DESC LIMIT 10');
      result.events = storage.getSQLite().queryAll('SELECT title, event_type, date FROM master_events ORDER BY created_at DESC LIMIT 10');
      result.about_you = masterProfile.retrieveAboutYou(10);
    } catch (err) { result.error = (err as Error).message; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── M6-M8 模块数据 ──
  if (req.method === 'GET' && url.pathname === '/api/modules') {
    const m6Model = m6?.getModel();
    const m6Traits = m6?.getTraits() ?? getSelfModel().traits;
    const m6Prefs = m6?.getPreferences() ?? [];
    const m6Bounds = m6?.getBoundaries() ?? [];
    const m6Layers = m6?.getNarrativeLayers() ?? [];
    const m7Pending = m7?.queue?.getPending() ?? [];
    const m7All = m7?.queue?.getByStatus?.('confirmed') ?? [];
    const m7Logs = clueTracker?.getLogs() ?? [];
    const dreamDiamondCount = storage.getSQLite().queryAll("SELECT COUNT(*) as c FROM black_diamond WHERE tags LIKE '%dream_%'") as any[];
    const dreamTags = storage.getSQLite().queryAll("SELECT id, summary, emotion_tag FROM black_diamond WHERE tags LIKE '%dream_%' ORDER BY created_at DESC LIMIT 5") as any[];
    const landscape = storage.getEmotionalLandscape();
    const m8Status = storage.getSQLite().getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      m6: { traits: m6Traits, preferences: m6Prefs.slice(0, 10), boundaries: m6Bounds.slice(0, 10), narrative_layers: m6Layers.slice(0, 5), version: m6Model?.version ?? '1.0' },
      m7: { pending_dreams: m7Pending.slice(0, 10), total_pending: m7Pending.length, total_confirmed: m7All.length, interaction_logs: m7Logs.slice(-10), total_logs: m7Logs.length, research_stats: topicTracker?.getStats?.() ?? {}, dream_analysis: { total_dream_entries: dreamDiamondCount?.[0]?.c ?? 0, recent_entries: (dreamTags ?? []).map((r: any) => ({ id: r.id, summary: (r.summary || '').substring(0, 80), emotion: r.emotion_tag || '未分类' })) } },
      m8: { total_entries: m8Status.landmarks, total_scars: landscape.scars.length, healed_scars: 0, unhealed_scars: landscape.scars.length, recent_entries: landscape.peaks.slice(0, 5).map((p: any) => ({ id: p.id, sensory_anchor: p.snippet?.substring(0, 20) ?? '', created_at: p.created_at, narrative_tag: p.narrative_tag ?? '日常', calcium: p.calcium })) },
    }));
    return true;
  }

  // ── Command Center 聚合快照 ──
  if (req.method === 'GET' && url.pathname === '/api/command-center') {
    try {
      const payload = await buildCommandCenterSnapshot(deps);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
    }
    return true;
  }

  // ── 日志端点 ──
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const limit = parseInt(url.searchParams?.get?.('limit') ?? '50') ?? 50;
    const level = url.searchParams?.get?.('level');
    const entries = level ? logger.filter(level as any, limit) : logger.recent(limit);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ count: entries.length, entries }));
    return true;
  }

  return false;
}
