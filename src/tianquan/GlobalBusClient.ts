/**
 * GlobalBusClient.ts — 太虚境→GlobalBus TCP 客户端
 * ==================================================
 * 连接 global_bus_main.py:9100，发送跨域指令到瑶灵/瑶光。
 *
 * 协议: JSON-line over TCP
 *   认证: {"type":"auth","domain":"t"}
 *   订阅: {"type":"subscribe","channels":["global_alert","yaoling_state","yaoguang_snapshot"]}
 *   发送: {"type":"publish","channel":"global_alert","cmd":"run_workflow","payload":{...}}
 *   接收: {"type":"message","cmd":"...","payload":{...},"source":"l"}
 *
 * 使用:
 *   const bus = new GlobalBusClient();
 *   await bus.connect();
 *   const result = await bus.sendCommand('l', 'run_workflow', { workflow_id: 'wf_sensation_pipeline', task: '...' });
 */

import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

export interface BusMessage {
  type: string;
  cmd?: string;
  payload?: Record<string, unknown>;
  source?: string;
  msg_id?: string;
  req_id?: string;
}

export interface BusConfig {
  host: string;
  port: number;
  domain: string;
  channels: string[];
  timeout: number;
  debug: boolean;
}

const DEFAULT_CONFIG: BusConfig = {
  host: '127.0.0.1',
  port: 9100,
  domain: 't',
  channels: ['global_alert', 'yaoling_state', 'yaoguang_snapshot'],
  timeout: 30_000,
  debug: false,
};

export class GlobalBusClient extends EventEmitter {
  private _cfg: BusConfig;
  private _socket: Socket | null = null;
  private _connected = false;
  private _reqCounter = 0;
  private _pending: Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();

  constructor(cfg: Partial<BusConfig> = {}) { super(); this._cfg = { ...DEFAULT_CONFIG, ...cfg }; }

  get connected() { return this._connected; }

  private _reconnectAttempts = 0;
  private readonly MAX_RECONNECT = 5;
  private readonly RECONNECT_DELAY = 3000;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host: this._cfg.host, port: this._cfg.port }, async () => {
        this._socket = sock;
        // Auth
        await this._request({ type: 'auth', domain: this._cfg.domain });
        // Subscribe
        if (this._cfg.channels.length > 0) {
          await this._request({ type: 'subscribe', channels: this._cfg.channels });
        }
        this._connected = true;
    this._reconnectAttempts = 0;
        this._log(`已连接 ${this._cfg.host}:${this._cfg.port}`);
        this.emit('connected');
        resolve();
      });
      sock.setEncoding('utf-8');
      const rl = createInterface({ input: sock });
      rl.on('line', (line: string) => {
        try { this._handleMessage(JSON.parse(line.trim())); } catch { /* ignore parse errors */ }
      });
      sock.on('close', () => { this._connected = false; this._socket = null; this._log('断开'); this.emit('disconnected'); });
      sock.on('error', (e) => { this._log(`错误: ${e.message}`); reject(e); });
    });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._rejectAllPending(new Error('总线断开'));
    if (this._socket) { this._socket.destroy(); this._socket = null; }
  }

  /** 发送跨域指令并等待响应 */
  async sendCommand(targetDomain: string, cmd: string, payload: Record<string, unknown> = {}, timeout?: number): Promise<Record<string, unknown>> {
    if (!this._connected) throw new Error('总线未连接');
    return this._request({
      type: 'publish',
      channel: 'global_alert',
      cmd, payload,
      target: targetDomain,
    }, timeout);
  }

  /** 发布消息，不等待响应 */
  publish(targetDomain: string, cmd: string, payload: Record<string, unknown>): void {
    if (!this._connected || !this._socket) return;
    const msg = JSON.stringify({ type: 'publish', channel: 'global_alert', cmd, payload, target: targetDomain }) + '\n';
    this._socket.write(msg);
  }

  private _handleMessage(data: Record<string, unknown>): void {
    const type = data.type as string;
    // Sync response
    if (['auth_ok', 'subscribed', 'published', 'error'].includes(type)) {
      const reqId = data.req_id as string;
      if (reqId && this._pending.has(reqId)) {
        const { resolve, reject, timer } = this._pending.get(reqId)!;
        clearTimeout(timer); this._pending.delete(reqId);
        if (type === 'error') reject(new Error(data.reason as string || '总线错误'));
        else resolve(data);
      }
    }
    // Async push
    if (type === 'message') {
      this.emit('message', data as unknown as BusMessage);
    }
  }

  private async _request(data: Record<string, unknown>, timeout?: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this._reqCounter++;
      const reqId = `ts-bus:${this._reqCounter}`;
      data.req_id = reqId;
      const timer = setTimeout(() => { this._pending.delete(reqId); reject(new Error('总线超时')); }, timeout || this._cfg.timeout);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this._socket!.write(JSON.stringify(data) + '\n'); } catch (e) { clearTimeout(timer); this._pending.delete(reqId); reject(e); }
    });
  }

  private _rejectAllPending(reason: Error): void {
    for (const [, { reject, timer }] of this._pending) { clearTimeout(timer); reject(reason); }
    this._pending.clear();
  }

  private _log(msg: string): void { if (this._cfg.debug) console.log(`[GlobalBus:${this._cfg.domain}] ${msg}`); }
}
