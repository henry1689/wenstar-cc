/**
 * MasterHarris.ts — 5层调度器: L1意图→L2路由→L3执行→L4快照→L5归档
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { TianquanRPCClient, createTianquanClient, type WorkflowResult, type LintReport, type ArchReport, type SQLAuditReport, type SnapshotResult, type HealthStatus } from './TianquanRPCClient.js';

export enum TaskDomain { TIANQUAN = 'tianquan', YAOLING = 'yaoling', YAOGUANG = 'yaoguang' }
export enum RouteTag { CODE_REVIEW = 'code_review', ARCH_REFACTOR = 'arch_refactor', SQL_MANAGE = 'sql_manage', KNOWLEDGE_SORT = 'knowledge_sort', TEST_GOVERN = 'test_govern', CHANGE_REPORT = 'change_report', DEP_AUDIT = 'dep_audit', LOG_ANALYSIS = 'log_analysis', CONFIG_DRIFT = 'config_drift', RESOURCE_SCAN = 'resource_scan', SENSATION_PIPELINE = 'sensation_pipeline', SAFETY_GATE = 'safety_gate', BODY_ADJUST = 'body_adjust', PHYSICAL_CONTROL = 'physical_control', TIME_TICK = 'time_tick', SCENE_SIM = 'scene_sim', WORLD_SNAPSHOT = 'world_snapshot' }
export interface IntentClassification { domain: TaskDomain; routeTag: RouteTag; confidence: number; reason: string; }
export interface MasterTask { userMessage: string; description?: string; constraints?: Record<string, unknown>; projectRoot?: string; dbPath?: string; sqlText?: string; }
export interface DispatchResult { success: boolean; domain: TaskDomain; routeTag: RouteTag; result: WorkflowResult | null; elapsedMs: number; }

const ROUTE_TABLE: ReadonlyArray<{ tag: RouteTag; domain: TaskDomain; workflowId: string; active: boolean }> = [
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
];

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
  return { domain: TaskDomain.TIANQUAN, routeTag: RouteTag.CODE_REVIEW, confidence: 0.3, reason: '默认工程路由' };
}

export class MasterHarris extends EventEmitter {
  private _tianquan: TianquanRPCClient | null = null;
  private _started = false;
  private _dispatchCount = 0;

  get isStarted() { return this._started; }
  get tianquanReady() { return this._tianquan?.isReady ?? false; }
  get dispatchCount() { return this._dispatchCount; }

  async start(): Promise<void> {
    if (this._started) return;
    this._tianquan = createTianquanClient();
    try {
      await this._tianquan.start();
      const h = await this._tianquan.health();
      console.log(`[MasterHarris:L3] 天权内核已连接 — ${h.workflows_loaded.length} workflows, PID=${h.pid}`);
      this.emit('tianquan:connected', h);
    } catch (e) { console.error('[MasterHarris] 天权连接失败:', (e as Error).message); this.emit('tianquan:error', e); }
    this._started = true;
    const active = ROUTE_TABLE.filter(r => r.active).map(r => r.tag).join(', ');
    console.log(`[MasterHarris] ✓ 调度器就绪 · 激活: ${active}`);
  }

  async stop() { this._started = false; if (this._tianquan) { await this._tianquan.stop(); this._tianquan = null; } }

  async dispatch(task: MasterTask): Promise<DispatchResult> {
    const t0 = Date.now(); this._dispatchCount++;
    const intent = classifyIntent(task.userMessage);
    const route = ROUTE_TABLE.find(r => r.tag === intent.routeTag);
    if (!route || !route.active) {
      return { success: false, domain: intent.domain, routeTag: intent.routeTag, result: null, elapsedMs: Date.now() - t0 };
    }

    try {
      const result = await this._tianquan!.runWorkflow(route.workflowId, task.description || task.userMessage, {
        project_root: task.projectRoot || process.cwd(), ...(task.constraints || {}),
      });
      return { success: result.code === 0, domain: route.domain, routeTag: route.tag, result, elapsedMs: Date.now() - t0 };
    } catch {
      return { success: false, domain: intent.domain, routeTag: intent.routeTag, result: null, elapsedMs: Date.now() - t0 };
    }
  }

  async health(): Promise<HealthStatus | null> { return this._tianquan?.isReady ? this._tianquan.health() : null; }
  async lintCheck(root: string): Promise<LintReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.lintCheck(root); }
  async archParse(root: string): Promise<ArchReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.archParse(root); }
  async sqlAudit(p: { sql_text?: string; file_path?: string }): Promise<SQLAuditReport> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.sqlAudit(p); }
  async generateSnapshot(root: string): Promise<SnapshotResult> { if (!this._tianquan?.isReady) throw new Error('天权离线'); return this._tianquan.generateSnapshot(root); }
  async getSpec(): Promise<string | null> { if (!this._tianquan?.isReady) return null; return (await this._tianquan.getSpec()).content; }

  getStatus(): Record<string, unknown> {
    return { started: this._started, tianquanReady: this.tianquanReady, tianquanPid: this._tianquan?.pid ?? null, dispatchCount: this._dispatchCount, activeRoutes: ROUTE_TABLE.filter(r => r.active).map(r => r.tag) };
  }
}

let _instance: MasterHarris | null = null;
export function getMasterHarris(): MasterHarris { if (!_instance) _instance = new MasterHarris(); return _instance; }
export async function initMasterHarris(): Promise<MasterHarris> { const mh = getMasterHarris(); if (!mh.isStarted) await mh.start(); return mh; }
