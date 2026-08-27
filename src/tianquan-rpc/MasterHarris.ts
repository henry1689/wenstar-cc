/**
 * MasterHarris.ts — 5层调度器: L1意图→L2路由→L3执行→L4快照→L5归档
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { TianquanRPCClient, createTianquanClient, type WorkflowResult, type LintReport, type ArchReport, type SQLAuditReport, type SnapshotResult, type HealthStatus } from './TianquanRPCClient.js';
import { GlobalBusClient } from './GlobalBusClient.js';

export enum TaskDomain { TIANQUAN = 'tianquan', YAOLING = 'yaoling', YAOGUANG = 'yaoguang' }
export enum RouteTag { CODE_REVIEW = 'code_review', ARCH_REFACTOR = 'arch_refactor', SQL_MANAGE = 'sql_manage', KNOWLEDGE_SORT = 'knowledge_sort', TEST_GOVERN = 'test_govern', CHANGE_REPORT = 'change_report', DEP_AUDIT = 'dep_audit', LOG_ANALYSIS = 'log_analysis', CONFIG_DRIFT = 'config_drift', RESOURCE_SCAN = 'resource_scan', SENSATION_PIPELINE = 'sensation_pipeline', SAFETY_GATE = 'safety_gate', BODY_ADJUST = 'body_adjust', PHYSICAL_CONTROL = 'physical_control', TIME_TICK = 'time_tick', SCENE_SIM = 'scene_sim', WORLD_SNAPSHOT = 'world_snapshot' }
export interface IntentClassification { domain: TaskDomain; routeTag: RouteTag; confidence: number; reason: string; }
export interface MasterTask { userMessage: string; description?: string; constraints?: Record<string, unknown>; projectRoot?: string; dbPath?: string; sqlText?: string; }
export interface DispatchResult { success: boolean; domain: TaskDomain; routeTag: RouteTag; result: WorkflowResult | null; elapsedMs: number; }

const ROUTE_TABLE: ReadonlyArray<{ tag: RouteTag; domain: TaskDomain; workflowId: string; active: boolean }> = [
  // ── 天权域 — 工程任务 ──
  { tag: RouteTag.CODE_REVIEW, domain: TaskDomain.TIANQUAN, workflowId: 'wf_code_review', active: true },
  { tag: RouteTag.ARCH_REFACTOR, domain: TaskDomain.TIANQUAN, workflowId: 'wf_arch_refactor', active: true },
  { tag: RouteTag.SQL_MANAGE, domain: TaskDomain.TIANQUAN, workflowId: 'wf_sql_governance', active: true },
  { tag: RouteTag.KNOWLEDGE_SORT, domain: TaskDomain.TIANQUAN, workflowId: 'wf_knowledge_organize', active: true },
  { tag: RouteTag.TEST_GOVERN, domain: TaskDomain.TIANQUAN, workflowId: 'wf_test_governance', active: true },
  { tag: RouteTag.CHANGE_REPORT, domain: TaskDomain.TIANQUAN, workflowId: 'wf_change_report', active: true },
  { tag: RouteTag.DEP_AUDIT, domain: TaskDomain.TIANQUAN, workflowId: 'wf_dependency_audit', active: true },
  { tag: RouteTag.LOG_ANALYSIS, domain: TaskDomain.TIANQUAN, workflowId: 'wf_log_analysis', active: true },
  { tag: RouteTag.CONFIG_DRIFT, domain: TaskDomain.TIANQUAN, workflowId: 'wf_config_drift', active: true },
  { tag: RouteTag.RESOURCE_SCAN, domain: TaskDomain.TIANQUAN, workflowId: 'wf_resource_scan', active: true },

  // ── 瑶灵域 — 躯体感知 (GlobalBus → :9100) ──
  { tag: RouteTag.SENSATION_PIPELINE, domain: TaskDomain.YAOLING, workflowId: 'wf_sensation_pipeline', active: true },
  { tag: RouteTag.SAFETY_GATE, domain: TaskDomain.YAOLING, workflowId: 'wf_safety_gate', active: true },
  { tag: RouteTag.BODY_ADJUST, domain: TaskDomain.YAOLING, workflowId: 'wf_body_adjust', active: false },
  { tag: RouteTag.PHYSICAL_CONTROL, domain: TaskDomain.YAOLING, workflowId: 'wf_physical_control', active: false },

  // ── 瑶光域 — 世界模型 (GlobalBus → :9100) ──
  { tag: RouteTag.TIME_TICK, domain: TaskDomain.YAOGUANG, workflowId: 'wf_objective_env_sample', active: true },
  { tag: RouteTag.SCENE_SIM, domain: TaskDomain.YAOGUANG, workflowId: 'wf_location_fingerprint', active: true },
  { tag: RouteTag.WORLD_SNAPSHOT, domain: TaskDomain.YAOGUANG, workflowId: 'wf_perception_filter', active: true },
];

/** V4.0 Phase 4: 意图分类 — 决定请求发往哪个域 (tianquan/yaoling/yaoguang)
 *  @note 与 PFC._inferIntent() 和 chat.ts classifyRole() 并行运行。
 *  Phase 4 建议: 三套合并为统一 IntentClassifier → {targetDomain, processingStrategy, confidence} */
export function classifyIntent(message: string): IntentClassification {
  const l = message.toLowerCase();
  if (/审查|review|代码检查|lint/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.CODE_REVIEW, confidence: 0.9, reason: '代码审查' };
  if (/重构|refactor|架构/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.ARCH_REFACTOR, confidence: 0.9, reason: '架构重构' };
  if (/sql|数据库|ddl|索引|migration/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.SQL_MANAGE, confidence: 0.9, reason: 'SQL治理' };
  if (/知识库|整理|归档|去重/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.KNOWLEDGE_SORT, confidence: 0.9, reason: '知识库整理' };
  if (/测试|test|用例|覆盖率|剥落|flaky/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.TEST_GOVERN, confidence: 0.85, reason: '测试治理' };
  if (/变更报告|change.?log|diff|git|提交记录/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.CHANGE_REPORT, confidence: 0.85, reason: '变更报告' };
  if (/依赖|dependency|过时|outdated|许可证|license|审计包|npm.*audit/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.DEP_AUDIT, confidence: 0.85, reason: '依赖审计' };
  if (/日志|log|错误频率|error.*frequency|异常检测|anomaly/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.LOG_ANALYSIS, confidence: 0.8, reason: '日志分析' };
  if (/配置|config|\.env|环境变量|漂移|drift|一致性/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.CONFIG_DRIFT, confidence: 0.8, reason: '配置漂移' };
  if (/资源|泄露|leak|句柄|handle.*leak|内存|memory.*scan|timer.*leak/.test(l)) return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.RESOURCE_SCAN, confidence: 0.8, reason: '资源扫描' };
  // ── 瑶灵域: 躯体感知 ──
  if (/身体|躯体|体感|知觉|心率|血压|内分泌|触觉|生理|器官|肌肉|疼痛|代谢|本能|欲望|依恋|亲密|心跳|激素/.test(l)) return { domain: TaskDomain.YAOLING, routeTag: RouteTag.SENSATION_PIPELINE, confidence: 0.7, reason: '躯体感知' };
  // ── 瑶光域: 世界模型 ──
  if (/环境|温度|光线|噪声|噪音|指纹|时空|场景|采集|采样|天气|季节|空间|周围|湿度|光照|位置/.test(l)) return { domain: TaskDomain.YAOGUANG, routeTag: RouteTag.TIME_TICK, confidence: 0.7, reason: '环境感知' };
  // ── 纯聊天: 不走任何工作流, 直接 M5 生成 ──
  return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.CODE_REVIEW, confidence: 0.3, reason: '默认工程路由' };
}

export class MasterHarris extends EventEmitter {
  private _tianquan: TianquanRPCClient | null = null;
  private _bus: GlobalBusClient | null = null;
  private _started = false;
  private _dispatchCount = 0;
  private _degradation = new DegradationManager();

  get isStarted() { return this._started; }
  get tianquanReady() { return this._tianquan?.isReady ?? false; }
  get busConnected() { return this._bus?.connected ?? false; }
  get busClient() { return this._bus; }
  get dispatchCount() { return this._dispatchCount; }

  async start(): Promise<void> {
    if (this._started) return;

    // 天权 RPC
    this._tianquan = createTianquanClient();
    try {
      await this._tianquan.start();
      const h = await this._tianquan.health();
      console.log(`[MasterHarris:L3] 天权内核已连接 — ${h.workflows_loaded.length} workflows, PID=${h.pid}`);
      this.emit('tianquan:connected', h);
    } catch (e) { console.error('[MasterHarris] 天权连接失败:', (e as Error).message); this.emit('tianquan:error', e); }

    // 全局总线
    this._bus = new GlobalBusClient({ debug: process.env.GLOBAL_BUS_DEBUG === 'true' });
    try {
      await this._bus.connect();
      console.log('[MasterHarris:L3] 全局总线已连接 — 瑶灵/瑶光可通信');
      this.emit('bus:connected');
    } catch (e) { console.warn('[MasterHarris] 总线未连接 (瑶灵/瑶光离线):', (e as Error).message); this._bus = null; }

    this._started = true;
    this._degradation.evaluate(this.busConnected, this.tianquanReady);
    const tianquanAct = ROUTE_TABLE.filter(r => r.active && r.domain === TaskDomain.TIANQUAN).map(r => r.tag).join(', ');
    const crossAct = ROUTE_TABLE.filter(r => r.active && r.domain !== TaskDomain.TIANQUAN).map(r => `${r.domain}/${r.tag}`).join(', ');
    console.log(`[MasterHarris] ✓ 调度器就绪 · 天权: ${tianquanAct} · 跨域: ${crossAct}`);
    if (this._degradation.activeScenarios.length > 0) {
      console.log(`[MasterHarris] ⚠️ 降级激活: ${this._degradation.activeScenarios.join(', ')}`);
    }
    // 🔴 2026-08-24 瑶光域守护: 定期探测 g 域，离线则自动重启（根治 TCP 假死导致跨域全失效）
    this.startYaoguangGuard();
  }

  // ── 🛡️ 瑶光域守护（每 90 秒探测，离线自动重启）────────────────
  private _yaoguangGuardStarted = false;
  private _yaoguangRestarting = false;
  startYaoguangGuard(): void {
    if (this._yaoguangGuardStarted) return;
    this._yaoguangGuardStarted = true;
    // 🆕 编码健康修复: 连续失败计数 — 防瞬时抖动触发重启（重启会 spawn 新进程→踢旧连接→堆积）
    let _failStreak = 0;
    const loop = async () => {
      if (this._bus?.connected) {
        try {
          // 轻量探测: wf_location_fingerprint 空参数（瑶光域秒回）
          // 🆕 编码健康修复: 超时 4s→8s（位置指纹计算可能慢，4s 误判率高）
          const r = await this.sendToYaoguangAndWait('wf_location_fingerprint', { task: '' }, 8000);
          if (!r) {
            _failStreak++;
            if (_failStreak >= 3) {
              console.warn('[YaoguangGuard] 瑶光域连续 ' + _failStreak + ' 次无响应，重启...');
              _failStreak = 0;
              await this._restartYaoguang();
            } else {
              console.warn('[YaoguangGuard] 瑶光域无响应 (' + _failStreak + '/3)，暂不重启');
            }
          } else {
            _failStreak = 0;
          }
        } catch (e) {
          console.warn('[YaoguangGuard] 探测异常:', (e as Error)?.message);
        }
      }
    };
    setInterval(loop, 90_000);
    setTimeout(loop, 15_000); // 启动后 15 秒首次探测
  }

  private async _restartYaoguang(): Promise<void> {
    if (this._yaoguangRestarting) return;
    this._yaoguangRestarting = true;
    try {
      const { spawn, execSync } = await import('node:child_process');
      const py = process.env.TIANQUAN_PYTHON || 'python';
      const script = 'D:/wenstar/wenstar_os/domain_yaoguang/bus_receiver.py';
      // 🆕 编码健康修复: 重启前先杀旧 yaoguang 进程（否则堆积进程同域重连踢旧连接→恶性循环）
      //   wmic 匹配同脚本进程（区分瑶光/瑶灵），先杀干净再起新实例
      try {
        const killed = execSync(
          'wmic process where "name=\'python.exe\' and commandline like \'%domain_yaoguang/bus_receiver.py%\'" call terminate',
          { encoding: 'utf-8', windowsHide: true, timeout: 15000 }
        );
        console.log('[YaoguangGuard] 已终止旧瑶光进程');
      } catch (killErr) {
        console.warn('[YaoguangGuard] 终止旧进程失败(可能无旧进程):', (killErr as Error)?.message?.slice(0, 60));
      }
      await new Promise(res => setTimeout(res, 1500)); // 等待端口/连接清理
      const child = spawn(py, ['-u', script], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log('[YaoguangGuard] 已重启瑶光域: ' + py + ' ' + script);
    } catch (e) {
      console.warn('[YaoguangGuard] 重启失败:', (e as Error)?.message);
    } finally {
      this._yaoguangRestarting = false;
    }
  }

  async stop() {
    this._started = false;
    if (this._tianquan) { await this._tianquan.stop(); this._tianquan = null; }
    if (this._bus) { await this._bus.disconnect(); this._bus = null; }
  }

  async dispatch(task: MasterTask): Promise<DispatchResult> {
    const t0 = Date.now(); this._dispatchCount++;
    const intent = classifyIntent(task.userMessage);

    // 约束域覆盖: 用户显式指定 domain/routeTag 时优先
    const overrideDomain = task.constraints?.domain as string || '';
    const overrideTag = task.constraints?.route_tag as string || '';
    const finalDomain = (overrideDomain === 'yaoling' ? TaskDomain.YAOLING : overrideDomain === 'yaoguang' ? TaskDomain.YAOGUANG : intent.domain) as TaskDomain;
    const finalTag = (overrideTag as RouteTag) || intent.routeTag;

    // 查找匹配路由 (优先精确匹配 domain+tag)
    let route = ROUTE_TABLE.find(r => r.tag === finalTag && r.domain === finalDomain);
    // 降级: 只匹配 tag
    if (!route) route = ROUTE_TABLE.find(r => r.tag === finalTag && r.active);
    if (!route || !route.active) {
      return { success: false, domain: finalDomain, routeTag: finalTag, result: null, elapsedMs: Date.now() - t0 };
    }

    try {
      // ── 天权域: 本地 RPC ──
      if (route.domain === TaskDomain.TIANQUAN) {
        const result = await this._tianquan!.runWorkflow(route.workflowId, task.description || task.userMessage, {
          project_root: task.projectRoot || process.cwd(), ...(task.constraints || {}),
        });
        return { success: result.code === 0, domain: route.domain, routeTag: route.tag, result, elapsedMs: Date.now() - t0 };
      }

      // ── 跨域: GlobalBus TCP (降级检查) ──
      if (this._degradation.isDegraded('tcp_bus_disconnect')) throw new Error('总线离线, 跨域指令不可用 (降级已激活)');
      if (!this._bus?.connected) throw new Error('总线离线, 跨域指令不可用');
      const domainTag = route.domain === TaskDomain.YAOLING ? 'l' : 'g';
      const busResult = await this._bus.sendCommand(domainTag, 'run_workflow', {
        workflow_id: route.workflowId,
        task: task.description || task.userMessage,
        dna_root_id: task.constraints?.dna_root_id || '',
        location_fingerprint: task.constraints?.location_fingerprint || '0'.repeat(32),
        ...(task.constraints || {}),
      });
      // 包装为统一格式
      const wrapped: WorkflowResult = {
        code: 0, workflow_id: route.workflowId,
        data: busResult as Record<string, unknown>,
        trace: [], metrics: {}, stamps: 1, degraded: false, degradation_reason: null,
      };
      return { success: true, domain: route.domain, routeTag: route.tag, result: wrapped, elapsedMs: Date.now() - t0 };
    } catch {
      return { success: false, domain: intent.domain, routeTag: intent.routeTag, result: null, elapsedMs: Date.now() - t0 };
    }
  }

  /** 直接向瑶灵发指令 */
  async sendToYaoling(cmd: string, payload: Record<string, unknown>) { if (this._bus?.connected) return this._bus.sendCommand('l', cmd, payload); throw new Error('总线离线'); }
  /** 直接向瑶光发指令 */
  async sendToYaoguang(cmd: string, payload: Record<string, unknown>) { if (this._bus?.connected) return this._bus.sendCommand('g', cmd, payload); throw new Error('总线离线'); }
  /** 🗺️ 2026-08-24 高德接入: 向瑶光域发指令并等待 workflow_result（同步拿到处理结果）。
   *  总线 publish 只回 ack，瑶光域结果走异步 workflow_result 广播——按 workflow_id 匹配。
   *  超时返回 null（不阻塞主流程）。 */
  async sendToYaoguangAndWait(workflowId: string, payload: Record<string, unknown>, timeoutMs = 6000): Promise<Record<string, unknown> | null> {
    if (!this._bus?.connected) throw new Error('总线离线');
    const bus = this._bus;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { bus.off('message', onMsg); resolve(null); }, timeoutMs);
      const onMsg = (msg: any) => {
        const data = (msg && msg.data) || msg || {};
        if (data?.cmd === 'workflow_result' && String(data?.payload?.workflow) === workflowId) {
          clearTimeout(timer); bus.off('message', onMsg);
          resolve(data.payload ?? null);
        }
      };
      bus.on('message', onMsg);
      void bus.sendCommand('g', 'run_workflow', { workflow_id: workflowId, ...payload }).catch(() => { });
    });
  }

  /**
   * V3: collect40DSnapshot 透传 — M3 只取瑶光客观维（include_yaoling=false，快且轻）。
   * 经天权 RPC 中继（collect_40d_snapshot）拉取瑶光 40D medical 原始值，
   * 归一化由太虚 YaoguangNormalizer 完成。瑶光不可达/未就绪 → 返回 null（优雅降级）。
   */
  async collect40DSnapshot(
    constraints: Record<string, unknown> = {},
    opts: { include_yaoling?: boolean; timeout_ms?: number } = {},
  ): Promise<import('./TianquanRPCClient.js').Tribody40DResult | null> {
    if (!this._tianquan?.isReady) {
      console.warn('[MasterHarris] collect40DSnapshot 跳过 — 天权 RPC 未就绪');
      return null;
    }
    try {
      return await this._tianquan.collect40DSnapshot({
        constraints,
        include_yaoguang: true,
        include_yaoling: opts.include_yaoling ?? false,
        timeout_ms: opts.timeout_ms ?? 30_000,
      });
    } catch (e) {
      console.warn('[MasterHarris] collect40DSnapshot 失败:', (e as Error)?.message);
      return null;
    }
  }

  async health(): Promise<HealthStatus | null> { return this._tianquan?.isReady ? this._tianquan.health() : null; }
  async lintCheck(root: string): Promise<LintReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.lintCheck(root); }
  async archParse(root: string): Promise<ArchReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.archParse(root); }
  async sqlAudit(p: { sql_text?: string; file_path?: string }): Promise<SQLAuditReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.sqlAudit(p); }
  async generateSnapshot(root: string): Promise<SnapshotResult> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.generateSnapshot(root); }
  async getSpec(): Promise<string | null> { if (!this._tianquan?.isReady) return null; return (await this._tianquan.getSpec()).content; }

  getStatus(): Record<string, unknown> {
    return {
      started: this._started, tianquanReady: this.tianquanReady, busConnected: this.busConnected,
      tianquanPid: this._tianquan?.pid ?? null, dispatchCount: this._dispatchCount,
      activeTianquanRoutes: ROUTE_TABLE.filter(r => r.active && r.domain === TaskDomain.TIANQUAN).map(r => r.tag),
      activeCrossRoutes: ROUTE_TABLE.filter(r => r.active && r.domain !== TaskDomain.TIANQUAN).map(r => `${r.domain}/${r.workflowId}`),
      degradation: this._degradation.activeScenarios,
    };
  }
}

let _instance: MasterHarris | null = null;
export function getMasterHarris(): MasterHarris { if (!_instance) _instance = new MasterHarris(); return _instance; }
// ════════════════════════════════════════════════════════
// L5: 分层降级矩阵 (蓝皮书 §11.1, 8种故障×8种策略)
// ════════════════════════════════════════════════════════

export enum DegradationLevel { NONE = 'none', SOFT = 'soft', HARD = 'hard', FATAL = 'fatal' }

export interface DegradationEvent {
  scenario: string;
  level: DegradationLevel;
  strategy: string;
  timestamp: string;
  active: boolean;
}

export class DegradationManager {
  private _events: DegradationEvent[] = [];
  private _active: Set<string> = new Set();

  /** 标记降级场景激活 */
  activate(scenario: string): void { this._active.add(scenario); }

  /** 查询是否处于某降级状态 */
  isDegraded(scenario: string): boolean { return this._active.has(scenario); }

  /** 获取当前所有激活的降级场景 */
  get activeScenarios(): string[] { return [...this._active]; }

  /** 8种降级场景定义 (蓝皮书 §11.1) */
  static readonly SCENARIOS: ReadonlyArray<{ scenario: string; level: DegradationLevel; strategy: string }> = [
    { scenario: 'yaoling_offline',     level: DegradationLevel.SOFT,  strategy: '屏蔽跨域瑶灵指令, 返回友好提示, 不阻塞工程/对话' },
    { scenario: 'yaoguang_offline',    level: DegradationLevel.SOFT,  strategy: '屏蔽跨域瑶光指令, G2时空校验全PASS告警' },
    { scenario: 'tianquan_rpc_crash',  level: DegradationLevel.HARD,  strategy: '自动重启子进程 + 3次任务重试 + 兜底LLM应答' },
    { scenario: 'tcp_bus_disconnect',  level: DegradationLevel.HARD,  strategy: '自动隔离双外设, 太虚+天权完整保留, 告警通知' },
    { scenario: 'hnsw_corrupted',      level: DegradationLevel.HARD,  strategy: '降级为关键词LIKE搜索, 禁用HNSW, 通知运营' },
    { scenario: 'bptree_corrupted',    level: DegradationLevel.HARD,  strategy: '自动切换纯语义检索 (禁用时序索引), 通知运营' },
    { scenario: 'single_urchin_corrupt', level: DegradationLevel.SOFT, strategy: '同维度历史均值替代 + 隔离标记 + 不阻塞全链' },
    { scenario: 'full_dual_helix_loss', level: DegradationLevel.FATAL, strategy: '纯LLM无记忆应答 (最强底线), 停止所有存储写入' },
  ];

  /** 评估当前系统状态并激活对应降级 */
  evaluate(busConnected: boolean, tianquanReady: boolean): DegradationEvent[] {
    const events: DegradationEvent[] = [];

    if (!busConnected) {
      this.activate('tcp_bus_disconnect');
      this.activate('yaoling_offline');
      this.activate('yaoguang_offline');
    }

    if (!tianquanReady) {
      this.activate('tianquan_rpc_crash');
    }

    for (const s of DegradationManager.SCENARIOS) {
      if (this._active.has(s.scenario)) {
        events.push({ ...s, timestamp: new Date().toISOString(), active: true });
      }
    }

    return events;
  }
}

export async function initMasterHarris(): Promise<MasterHarris> { const mh = getMasterHarris(); if (!mh.isStarted) await mh.start(); return mh; }
