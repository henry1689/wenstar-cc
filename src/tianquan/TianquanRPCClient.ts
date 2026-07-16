/**
 * TianquanRPCClient.ts — 天权域 RPC 客户端
 * 太虚境(TS) ↔ 天权(Python) JSON-line RPC 桥
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export interface RPCReady { type: 'ready'; server: string; pid: number; workflows: string[]; }
export interface HealthStatus { status: string; server: string; pid: number; uptime_seconds: number; request_count: number; workflows_loaded: string[]; executors_registered: number; run_mode: string; timestamp: string; }
export interface WorkflowResult { code: number; workflow_id: string; data: Record<string, unknown>; trace: Array<Record<string, unknown>>; metrics: Record<string, number>; stamps: number; degraded: boolean; degradation_reason: string | null; }
export interface LintReport { code: number; passed: boolean; files_scanned: number; errors: number; warnings: number; violations: Array<{ file: string; line: number; rule: string; message: string }>; lint_duration_ms: number; }
export interface ArchReport { code: number; total_files: number; modules: number; cycles: number; avg_coupling: number; recommendations: string[]; }
export interface SQLAuditReport { code: number; tables: number; indexes: number; fks: number; naming_violations: string[]; missing_pk_tables: string[]; missing_index_warnings: string[]; redundant_indexes: string[]; recommendations: string[]; }
export interface SnapshotResult { code: number; snapshot_id: string; file_count: number; saved_to: string; timestamp: string; }
export interface SpecResult { code: number; spec_id: string; size_bytes: number; content: string; }
export interface WorkflowListResult { code: number; workflows: Record<string, { version: string; description: string; mode: string; domain: string; route_tag: string; phases: number; nodes: number; nodes_with_executor: number; node_ids: string[]; guard_rules: number; required_constraints: string[]; error?: string; }>; }

export interface TianquanRPCConfig { pythonPath: string; serverScript: string; timeout: number; reconnectDelay: number; maxReconnectAttempts: number; debug: boolean; }

export class TianquanRPCError extends Error {
  constructor(message: string, public readonly method: string, public readonly code?: number) { super(message); this.name = 'TianquanRPCError'; }
}
export class TianquanNotReadyError extends TianquanRPCError { constructor() { super('天权 RPC 服务未就绪', 'health'); } }

const DEFAULT_CONFIG: TianquanRPCConfig = { pythonPath: 'python', serverScript: '', timeout: 30_000, reconnectDelay: 3_000, maxReconnectAttempts: 5, debug: false };

export class TianquanRPCClient extends EventEmitter {
  private _config: TianquanRPCConfig;
  private _process: ChildProcess | null = null;
  private _reqCounter = 0;
  private _pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private _ready = false;
  private _readyInfo: RPCReady | null = null;
  private _reconnectAttempts = 0;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _shuttingDown = false;

  constructor(config: Partial<TianquanRPCConfig> & { serverScript: string }) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...config };
    if (!this._config.serverScript) throw new Error('serverScript is required');
  }

  async start(): Promise<void> {
    if (this._shuttingDown) return;
    return new Promise((resolve, reject) => {
      const { pythonPath, serverScript } = this._config;
      this._process = spawn(pythonPath, [serverScript], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RUN_MODE: 'prod', PYTHONUNBUFFERED: '1' } });
      const rl = createInterface({ input: this._process.stdout! });
      rl.on('line', (line: string) => {
        try { this._handleMessage(JSON.parse(line.trim())); } catch (e) { console.warn(`[TianquanRPC] 操作失败`, (e as Error)?.message || e); }
      });
      this._process.stderr?.on('data', (chunk: Buffer) => {
        if (this._config.debug) console.log(`[Python] ${chunk.toString().trim()}`);
      });
      this._process.on('exit', () => { this._ready = false; this._process = null; this._rejectAllPending(new Error('子进程退出')); if (!this._shuttingDown) this._scheduleReconnect(); });
      this._process.on('error', () => { this._ready = false; this._process = null; });
      this._process.on('error', reject);
      const timeout = setTimeout(() => reject(new Error('天权启动超时')), 15_000);
      this.on('ready', () => { clearTimeout(timeout); resolve(); });
    });
  }

  async stop(): Promise<void> {
    this._shuttingDown = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._rejectAllPending(new Error('客户端关闭'));
    const p = this._process;
    if (p) {
      this._process = null; // 先清引用, 防止 exit handler 二次清理
      p.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 3_000));
      try { if (!p.killed) p.kill('SIGKILL'); } catch { /* already dead */ }
    }
    this._ready = false;
  }

  get isReady() { return this._ready; }
  get readyInfo() { return this._readyInfo; }
  get pid() { return this._process?.pid ?? null; }

  async health(): Promise<HealthStatus> { return this._call('health', {}) as Promise<HealthStatus>; }
  async runWorkflow(workflowId: string, task: string, constraints: Record<string, unknown> = {}): Promise<WorkflowResult> { return this._call('run_workflow', { workflow_id: workflowId, task, constraints }) as Promise<WorkflowResult>; }
  async lintCheck(projectRoot: string): Promise<LintReport> { return this._call('lint_check', { project_root: projectRoot }) as Promise<LintReport>; }
  async archParse(projectRoot: string): Promise<ArchReport> { return this._call('arch_parse', { project_root: projectRoot }) as Promise<ArchReport>; }
  async sqlAudit(params: { sql_text?: string; file_path?: string }): Promise<SQLAuditReport> { return this._call('sql_audit', params) as Promise<SQLAuditReport>; }
  async generateSnapshot(projectRoot: string): Promise<SnapshotResult> { return this._call('generate_snapshot', { project_root: projectRoot }) as Promise<SnapshotResult>; }
  async getSpec(): Promise<SpecResult> { return this._call('get_spec', {}) as Promise<SpecResult>; }
  async listWorkflows(): Promise<WorkflowListResult> { return this._call('list_workflows', {}) as Promise<WorkflowListResult>; }

  private _handleMessage(data: Record<string, unknown>) {
    if (data.type === 'ready') { this._ready = true; this._readyInfo = data as unknown as RPCReady; this._reconnectAttempts = 0; this.emit('ready', this._readyInfo); return; }
    const reqId = data.id as string;
    if (reqId && this._pending.has(reqId)) { const { resolve, reject, timer } = this._pending.get(reqId)!; clearTimeout(timer); this._pending.delete(reqId); data.error ? reject(new TianquanRPCError(data.error as string, 'unknown')) : resolve(data.result); }
  }

  private async _call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this._ready) throw new TianquanNotReadyError();
    return new Promise((resolve, reject) => {
      this._reqCounter++;
      const reqId = `ts:${this._reqCounter}`;
      const timer = setTimeout(() => { this._pending.delete(reqId); reject(new TianquanRPCError(`RPC超时: ${method}`, method)); }, this._config.timeout);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this._process!.stdin!.write(JSON.stringify({ id: reqId, method, params }) + '\n'); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(new TianquanRPCError(`写入失败: ${(e as Error).message}`, method)); }
    });
  }

  private _rejectAllPending(reason: Error) { for (const [, { reject, timer }] of this._pending) { clearTimeout(timer); reject(reason); } this._pending.clear(); }
  private _scheduleReconnect() {
    if (this._shuttingDown || this._reconnectAttempts >= this._config.maxReconnectAttempts) { if (this._reconnectAttempts >= this._config.maxReconnectAttempts) this.emit('dead'); return; }
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(async () => { try { await this.start(); } catch (e) { console.warn(`[TianquanRPC] 操作失败`, (e as Error)?.message || e); } }, this._config.reconnectDelay);
  }
}

export function createTianquanClient(overrides?: Partial<TianquanRPCConfig>): TianquanRPCClient {
  return new TianquanRPCClient({
    pythonPath: process.env.TIANQUAN_PYTHON || 'python',
    serverScript: join(process.env.TIANQUAN_PYTHON_PATH || 'D:/wenstar/wenstar_os', 'domain_tianquan', 'tianquan_rpc_server.py'),
    debug: process.env.TIANQUAN_RPC_DEBUG === 'true',
    ...overrides,
  });
}
