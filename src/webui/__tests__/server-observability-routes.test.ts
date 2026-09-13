import { describe, expect, it } from 'vitest';
import { buildCommandCenterSnapshot, handleObservabilityRoutes } from '../server-observability-routes.js';

describe('buildCommandCenterSnapshot', () => {
  it('aggregates hooks, memory, heart, and module signals into one snapshot', async () => {
    const hookDefs = [
      { id: 'H01', name: 'hook one', th: 15000 },
      { id: 'H02', name: 'hook two', th: 15000 },
    ];
    const hookMonitor = new Map([
      ['H01', { name: 'hook one', callCount: 10, errorCount: 0, totalDuration: 400, lastHeartbeat: Date.now(), lastStatus: 'green', recentDurations: [20, 30], lastError: null }],
      ['H02', { name: 'hook two', callCount: 8, errorCount: 2, totalDuration: 1200, lastHeartbeat: Date.now() - 7000, lastStatus: 'yellow', recentDurations: [160, 190], lastError: 'timeout' }],
    ]);

    const deps: any = {
      req: {} as any,
      res: {} as any,
      url: new URL('http://localhost/api/command-center'),
      storage: {
        getStatus: async () => ({ totalRecords: 42, zoneCounts: { user: 12, assistant: 9 }, currentSeqPos: 77 }),
        getDecayStats: () => ({ avgStrength: 0.63, strongCount: 6, weakCount: 2 }),
        getEmotionalLandscape: () => ({
          peaks: [{ id: 'peak_1', created_at: '2026-07-07T00:00:00.000Z', calcium: 4.1, pleasure: 0.8, intimacy: 0.7, snippet: '一起散步', narrative_tag: 'daily' }],
          scars: [{ id: 'scar_1', created_at: '2026-07-06T00:00:00.000Z', calcium: 2.3, pleasure: -0.3, type: 'misunderstanding', snippet: '误会' }],
          cluster_count: 1,
        }),
        getSQLite: () => ({
          getStatus: () => ({ landmarks: 5, totalEntities: 18 }),
          queryAll: (sql: string) => {
            if (sql.includes("leaf_zone=?")) return [{ cnt: 3 }];
            if (sql.includes("memory_type='note'") && sql.includes('GROUP BY COALESCE(sub_type')) return [{ sub_type: 'fact', cnt: 2 }, { sub_type: 'reminder', cnt: 1 }];
            if (sql.includes('GROUP BY COALESCE(memory_type')) return [{ memory_type: 'emotional', cnt: 39 }, { memory_type: 'note', cnt: 3 }];
            if (sql.includes('GROUP BY COALESCE(leaf_zone')) return [{ leaf_zone: 'user', cnt: 12 }, { leaf_zone: 'assistant', cnt: 9 }];
            if (sql.includes('SUM(CASE WHEN dna_root_id IS NOT NULL') && sql.includes('FROM memories')) return [{ total: 42, with_dna_root: 30, with_dialog_group: 18, roleplay_dialogs: 4, promoted: 3, healed_scars: 1, high_calcium_unpromoted: 2 }];
            if (sql.includes('COUNT(DISTINCT dialog_group_id)')) return [{ total_groups: 9, avg_rounds: 3.7, roleplay_group_rows: 2 }];
            if (sql.includes("timestamp < datetime('now', '-24 hours')")) return [{ stale_unpromoted: 3, cold_unpromoted: 1 }];
            if (sql.includes('SUM(CASE WHEN is_promoted = 0') && sql.includes('FROM conversations')) return [{ total: 24, unpromoted: 9, ready_for_gold: 4, with_dna_root: 18, with_dialog_group: 14, roleplay_turns: 6 }];
            if (sql.includes("COALESCE(lifecycle_state, 'candidate') = 'candidate'")) return [{ candidate_count: 11, active_count: 20, suppressed_count: 2, healed_count: 1, promoted_count: 3, archived_count: 5 }];
            if (sql.includes('ready_by_calcium')) return [{ ready_by_calcium: 2, ready_by_recall: 5, ready_by_landmark: 1, ready_by_multifactor: 3, weak_active: 4 }];
            if (sql.includes('classification_pending = 0')) return [{ total: 20, classified: 16, pending: 4 }];
            if (sql.includes('COUNT(DISTINCT knowledge_id)')) return [{ links: 12, linked_knowledge_items: 8, linked_memories: 7 }];
            if (sql.includes('SUM(CASE WHEN operation = \'merge_promote\'')) return [{ merged_promotions: 2, direct_promotions: 3, multifactor_promotions: 1 }];
            if (sql.includes('FROM vault_log')) return [{ operation: 'promote', source_type: 'gold', source_id: 'mem_7', target_id: 'bd_7', detail: '提炼至黑钻: 核心纪要 (multi-factor:high-calcium+recall>=3+strong-trace+narrative-tag)', created_at: '2026-07-07T00:10:00.000Z' }];
            if (sql.includes('SUM(CASE WHEN source_id IS NOT NULL') && sql.includes('FROM black_diamond')) return [{ total: 4, linked_sources: 3 }];
            if (sql.includes('hot_entries')) return [{ hot_entries: 2, cold_entries: 1, recent_promotions: 3, emotion_coverage: 4 }];
            if (sql.includes('SELECT id, summary, emotion_tag, tags, notes, source_id, namespace') && sql.includes('FROM black_diamond')) return [
              { id: 'bd_7', summary: '核心纪要', emotion_tag: '安心', tags: '["gold_提炼","tag:合作转折"]', notes: '自动提炼于 2026-07-07T00:10:00.000Z · multi-factor:high-calcium+recall>=3+strong-trace+narrative-tag', source_id: 'mem_7', namespace: 'default', created_at: '2026-07-07T00:10:00.000Z', updated_at: '2026-07-07T00:10:00.000Z', calcium_level: 4, recall_count: 3 },
              { id: 'bd_6', summary: '旧黑钻合并条目', emotion_tag: '工作复盘', tags: '["gold_提炼","merged_gold"]', notes: '已有珍藏\n合并来源 mem_6 @ 2026-07-07T00:08:00.000Z (multi-factor:high-calcium+recall>=3)', source_id: 'mem_old', namespace: 'ops', created_at: '2026-07-06T00:10:00.000Z', updated_at: '2026-07-07T00:08:00.000Z', calcium_level: 4, recall_count: 1 },
            ];
            if (sql.includes('FROM memories') && sql.includes('WHERE id IN')) return [
              { id: 'mem_7', raw_input: '核心纪要来源记忆', calcium_score: 4.1, recall_count: 3, lifecycle_state: 'active', promoted_to_diamond: 1, is_landmark: 0, primary_emotion: '安心', created_at: '2026-07-07T00:09:00.000Z' },
              { id: 'mem_old', raw_input: '旧黑钻来源记忆', calcium_score: 4.2, recall_count: 6, lifecycle_state: 'promoted', promoted_to_diamond: 1, is_landmark: 1, primary_emotion: '工作复盘', created_at: '2026-07-06T00:09:00.000Z' },
            ];
            if (sql.includes('FROM memories') && sql.includes('LIMIT 8') && sql.includes('COALESCE(lifecycle_state')) return [
              { id: 'mem_action_1', raw_input: '需要人工判断是否升地标的候选记忆', calcium_score: 4.7, recall_count: 4, lifecycle_state: 'active', promoted_to_diamond: 0, is_landmark: 0, primary_emotion: '安心', created_at: '2026-07-07T00:20:00.000Z' },
              { id: 'mem_action_2', raw_input: '此前被压制、现在可人工愈合的记忆', calcium_score: 2.2, recall_count: 2, lifecycle_state: 'suppressed', promoted_to_diamond: 0, is_landmark: 0, primary_emotion: '委屈', created_at: '2026-07-07T00:18:00.000Z' },
            ];
            if (sql.includes('FROM black_diamond WHERE tags LIKE')) return [{ cnt: 1 }];
            if (sql.includes('FROM black_diamond') && sql.includes('ORDER BY created_at DESC LIMIT 5')) return [{ id: 'dream_1', summary: '梦境归纳', emotion_tag: '安心' }];
            if (sql.includes('FROM black_diamond')) return [{ cnt: 4 }];
            if (sql.includes("sub_type='reminder'")) return [{ cnt: 1 }];
            if (sql.includes('FROM master_profile')) return [{ cnt: 7 }];
            if (sql.includes('FROM master_affairs')) return [{ cnt: 2 }];
            if (sql.includes('FROM master_network')) return [{ cnt: 5 }];
            if (sql.includes('FROM master_events')) return [{ cnt: 6 }];
            return [];
          },
        }),
      },
      familyGraph: {
        getFamilySummary: async () => ({ members: [{ name: 'Henry', relation_to_user: 'self' }], locations: [] }),
      },
      conversationHistory: [{}, {}, {}, {}],
      maintenance: {
        getHealth: () => ({ storage: { totalRecords: 0 }, memory: { status: 'ok' } }),
      },
      m6: {
        getModel: () => ({ version: '2.0' }),
        getTraits: () => ({ openness: 0.8, agreeableness: 0.9 }),
        getPreferences: () => ['coffee'],
        getBoundaries: () => ['private'],
        getNarrativeLayers: () => [{ text: '我是玉瑶' }],
      },
      m7: {
        queue: {
          getPending: () => [{ id: 'pending_1' }],
          getByStatus: () => [{ id: 'confirmed_1' }],
        },
      },
      m8: {},
      clueTracker: {
        getLogs: () => [{ clue_type: 'time', success: true }],
      },
      topicTracker: {
        getStats: () => ({ tracked: 2 }),
      },
      alignmentGuard: {
        getCachedReport: () => ({ score: 87, status: 'healthy' }),
      },
      inductionScheduler: {
        getInductions: () => [{ id: 'induction_1' }],
      },
      masterProfile: {
        retrieveAboutYou: () => [{ key: 'nickname', value: '星辰' }],
      },
      getSelfModel: () => ({ traits: { openness: 0.8 } }),
      sseClients: new Set(),
      hookDefs,
      hookMonitor,
      orchestrator: {
        getMode: () => 'hybrid',
        getHeartStore: () => ({
          getState: () => ({
            emotionVector: { pleasure: 0.4 },
            relationState: 'intimate',
            atmosphere: 'warm',
            memoryPermission: 'allowed',
            relationMetrics: { trust: 86 },
            updatedAt: '2026-07-07T00:00:00.000Z',
          }),
          getAuditLog: () => [{ triggerEvent: 'intent:classified' }],
          getEmotionLabel: () => ({ label: '安心' }),
          getDesireHints: () => ['想继续靠近'],
          getEmergenceHint: () => '轻微依恋',
        }),
      },
      getRoleplayStatus: () => ({ active: true, role: 'lover', class: 'intimate', turns: 12 }),
    };

    const snapshot = await buildCommandCenterSnapshot(deps);

    expect(snapshot.system.mode).toBe('hybrid');
    expect(snapshot.system.conversationTurns).toBe(2);
    expect(snapshot.hooks.dispatch.summary.yellowCount).toBe(1);
    expect(snapshot.memory.overview.landmarks).toBe(5);
    expect(snapshot.memory.taxonomy.notes.reminder).toBe(1);
    expect(snapshot.memory.alignment.score).toBe(87);
    expect(snapshot.memory.threading.memoryDnaCoverage).toBe(71.4);
    expect(snapshot.memory.lifecycle.highCalciumUnpromoted).toBe(2);
    expect(snapshot.memory.vaults.sand.readyForGold).toBe(4);
    expect(snapshot.memory.vaults.sand.staleBacklog).toBe(3);
    expect(snapshot.memory.vaults.gold.promoted).toBe(3);
    expect(snapshot.memory.vaults.gold.readyByRecall).toBe(5);
    expect(snapshot.memory.vaults.gold.readyByMultiFactor).toBe(3);
    expect(snapshot.memory.vaults.gold.weakActive).toBe(4);
    expect(snapshot.memory.vaults.diamond.orphaned).toBe(1);
    expect(snapshot.memory.vaults.diamond.hotEntries).toBe(2);
    expect(snapshot.memory.vaults.diamond.mergedPromotions).toBe(2);
    expect(snapshot.memory.vaults.diamond.multifactorPromotions).toBe(1);
    expect(snapshot.memory.vaultHealth.overall.score).toBeGreaterThan(0);
    expect(['healthy', 'watch', 'risk']).toContain(snapshot.memory.vaultHealth.gold.status);
    expect(snapshot.memory.vaultHealth.gold.highlights).toContain('recall 5');
    expect(snapshot.memory.vaultHealth.gold.highlights).toContain('multi 3');
    expect(snapshot.memory.vaultHealth.diamond.highlights).toContain('merge 2');
    expect(snapshot.memory.vaultHealth.sand.actions[0].target).toBe('/api/assessor/run?action=sand');
    expect(snapshot.memory.vaultHealth.gold.actions[0].target).toBe('/api/vault/auto-promote');
    expect(snapshot.memory.operations.recent[0].operation).toBe('promote');
    expect(snapshot.memory.operations.recent[0].emphasis).toBe('multi-factor');
    expect(snapshot.memory.diamondFlow.recent[0].id).toBe('bd_7');
    expect(snapshot.memory.diamondFlow.recent[0].mode).toBe('multi-factor');
    expect(snapshot.memory.diamondFlow.recent[1].mode).toBe('merge');
    expect(snapshot.memory.diamondFlow.operations[0].targetId).toBe('bd_7');
    expect(snapshot.memory.sourceLookup.mem_7.snippet).toBe('核心纪要来源记忆');
    expect(snapshot.memory.sourceLookup.mem_old.isLandmark).toBe(true);
    expect(snapshot.memory.actionables[0].id).toBe('mem_action_1');
    expect(snapshot.memory.actionables[0].actions[0].target).toContain('/api/vault/memory/promote?');
    expect(snapshot.memory.actionables[1].actions[0].target).toContain('/api/vault/memory/heal?');
    expect(snapshot.memory.knowledge.classified).toBe(16);
    expect(snapshot.modules.m8.scars).toBe(1);
    expect(snapshot.heart.state.emotionLabel.label).toBe('安心');
  });
});

// [遗留③] /events 重复写头守卫（2026-09-13）
//
// 根因（实测取证）：server.ts:1700-1724 **已经**处理过 GET /events —— 它 writeHead(200)
//   并 sseClients.add(res)，但该分支**漏了 return**，流程继续流到 L1780 的
//   handleObservabilityRoutes，于是本模块的 /events 分支再次 writeHead(200)
//   → 抛 ERR_HTTP_HEADERS_SENT（实测单会话日志 144 次，且每次都产生一条
//     "[Server] ⛑️ 未捕获Promise拒绝" 噪音）。
//
// 契约：响应头已发送时**不得重复写**，直接返回 true 表示已被处理。
//   本模块的 /events 分支在现行 server.ts 下实为不可达的死代码；保留是为了
//   万一 server.ts 那侧被移除时仍有实现，但必须加守卫而非盲目写头。
describe('handleObservabilityRoutes — /events 重复写头守卫', () => {
  /** 造 res 桩：记录 writeHead / write 调用，并可控 headersSent */
  function makeRes(headersSent: boolean) {
    const calls: string[] = [];
    const res = {
      headersSent,
      writeHead: () => { calls.push('writeHead'); },
      write: () => { calls.push('write'); return true; },
      on: () => {},
    } as any;
    return { res, calls };
  }

  const deps = (res: any, sseClients: Set<any>) => ({
    req: { method: 'GET', url: '/events', on: () => {} },
    res,
    url: new URL('http://localhost/events'),
    sseClients,
  }) as any;

  it('🔴 headersSent 为 true → 不得再次 writeHead，且返回 true 表示已处理', async () => {
    const { res, calls } = makeRes(true);
    const handled = await handleObservabilityRoutes(deps(res, new Set()));
    expect(handled).toBe(true);
    expect(calls).not.toContain('writeHead');
  });

  it('headersSent 为 false → 正常写 200 并注册 SSE 客户端（不回归）', async () => {
    const { res, calls } = makeRes(false);
    const clients = new Set<any>();
    const handled = await handleObservabilityRoutes(deps(res, clients));
    expect(handled).toBe(true);
    expect(calls).toContain('writeHead');
    expect(clients.has(res)).toBe(true);
  });

  it('非 /events 路径不受影响（不误吞其他路由）', async () => {
    const { res, calls } = makeRes(true);
    const d: any = deps(res, new Set());
    d.url = new URL('http://localhost/api/health');
    const handled = await handleObservabilityRoutes(d);
    expect(calls).not.toContain('writeHead');
    expect(handled).toBe(false);
  });
});
