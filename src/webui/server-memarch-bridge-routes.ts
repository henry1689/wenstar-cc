/**
 * server-memarch-bridge-routes — MemArch v2 桥接层运维端点
 *
 * 为什么需要这一层：
 *   bridge 有灰度开关（KILL SWITCH / 按角色比例 / promote / demote / rollback），
 *   但此前**没有任何运行时入口** —— 回滚只能改代码重启。出问题时"秒级切回旧系统"
 *   是一句空话。本文件把开关暴露成 HTTP 端点。
 *
 * 🔴 懒初始化（本次的关键设计）：
 *   bridge 只在**首次访问本组端点**时初始化，不在 initPipeline 里插一脚：
 *   ① 不碰 server.ts 的初始化时序，主流程零风险；
 *   ② 不访问就完全不加载 better-sqlite3、不打开 memarch-v2.db；
 *   ③ server.ts 只需加一个分发块，改动面最小。
 *
 * 🔴 安全边界（本文件自行承担，不依赖上层）：
 *   这些端点能改变记忆读写路由、能读写任意 namespace 的数据，属于**运维面**。
 *   因此一律只允许 **loopback** 访问；非本机请求直接 403，不做解释性回显。
 *   响应体不含记忆原文，只返回计数/状态，避免调试通道变成数据外泄通道。
 *
 * 🔴 驱动并存红线：
 *   v2Db 只能指向 data/memarch-v2.db，**禁止**指向 sql.js 正在使用的主库
 *   （sql.js 的 flushNow 整库覆盖磁盘，与 better-sqlite3 并存会整库丢失）。
 *
 * 🔴 allowExtension 是 vec0 的前置条件：
 *   `createBridge` 内部会调 `ensureVectorIndex` 加载 sqlite-vec 扩展，而
 *   better-sqlite3 只有在连接以 `{ allowExtension: true }` 打开时才允许
 *   `loadExtension`。少了这个选项，语义/情感两条召回腿永远降级 FTS5 ——
 *   这正是此前「向量检索从未真正上线」的直接原因。
 *
 * 🔴 为什么这里手写 bridge 契约，而不用 `typeof import(...)`：
 *   主 tsconfig 的 `rootDir` 限定在 `src/`，而 bridge 子工程在 `src/` 之外。
 *   **类型位置**的 `typeof import('../../memarch-bridge/...')` 同样会把整个子工程
 *   拉进主编译单元 ⇒ TS6059 连锁 107 个错误。bridge 的类型正确性由独立配置
 *   `tsconfig.memarch.json`（实测 0 错误）守护；此处只声明本文件**实际消费的**
 *   成员子集，反而更贴合「运维端点与子工程解耦」的边界。
 *   同理，运行时 import 用变量说明符，让 TS 不做静态解析。
 *
 * 端点：
 *   GET  /api/memarch-bridge/health     健康与端口就绪快照（含向量索引状态）
 *   GET  /api/memarch-bridge/namespaces 命名空间注册表
 *   POST /api/memarch-bridge/ratio      调某 namespace 的新链路比例
 *   POST /api/memarch-bridge/promote    某 namespace 全量走新
 *   POST /api/memarch-bridge/demote     某 namespace 全量回旧
 *   POST /api/memarch-bridge/rollback   一键全部回旧（KILL SWITCH）
 *   POST /api/memarch-bridge/unrollback 解除 KILL SWITCH
 *   POST /api/memarch-bridge/retrieve   检索自检（只回计数与 id，不回原文）
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 物理隔离的关键参数。运行时是 string，类型上是 branded string，此处只做窄化。 */
type RetrievalNamespace = string & { readonly __namespaceBrand?: never };

/** better-sqlite3 连接的极窄视图 —— 只用于读计数，不暴露给任何业务代码 */
interface SqliteHandle {
  prepare(sql: string): { get(): unknown };
}

/** bridge 检索端口（对应 MemoryPort.MemoryRetrievePort，只取本文件用到的形态） */
interface BridgeRetrievePort {
  retrieve(
    query: string,
    ctx: { namespace: RetrievalNamespace; topK?: number; forcePathway?: 'A' | 'B' },
  ): Promise<unknown>;
}

/** bridge 聚合根（只声明本文件访问的端口） */
interface BridgeHandle {
  write?: { write?: (...args: unknown[]) => unknown };
  retrieve?: BridgeRetrievePort;
  present?: { present?: (...args: unknown[]) => unknown };
}

/** 灰度开关（FeatureFlag 的运维面子集） */
interface FeatureFlagHandle {
  setNamespaceRatio?(ns: string, ratio: number): void;
  promoteNamespaceToV2?(ns: string): void;
  demoteNamespaceToLegacy?(ns: string): void;
  rollback?(): void;
  unrollback?(): void;
}

/**
 * BridgeRegistry 模块契约（只声明本文件实际调用的 4 个导出）。
 * 契约漂移的守护在别处：`npx tsc -p tsconfig.memarch.json` + 本目录的契约测试。
 */
interface BridgeModule {
  initBridge(deps: { v2Db: unknown; legacyConfig: unknown }): unknown;
  getBridge(): BridgeHandle;
  /** 从 BridgeRegistry 导出的是 class 本身（`list` 在原型上），不是实例 */
  NamespaceManager: new (db: unknown) => { list(): unknown };
  globalFeatureFlag: FeatureFlagHandle;
  /** ensureBridge 注入的实例 —— 模块导出是类，端点必须拿实例才能读注册表 */
  _nsManagerInstance?: { list(): unknown };
}

/** undefined = 尚未尝试；null = 尝试过且失败（避免每次请求都重试并刷日志） */
let _bridgeMod: BridgeModule | null | undefined;
let _initError: string | null = null;
/** v2 库句柄，仅供 /health 读向量表计数 */
let _v2Db: SqliteHandle | null = null;

export type MemarchBridgeRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  dataDir: string;
  readBody(req: http.IncomingMessage): Promise<string>;
};

/** 只允许本机访问 —— 运维端点不对外 */
function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 表名是代码内常量，不存在注入面 */
function countRows(db: SqliteHandle | null, table: string): number | null {
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: unknown } | undefined;
    return typeof row?.c === 'number' ? row.c : null;
  } catch {
    return null;
  }
}

/** vec0 扩展是否在当前连接上可用（真探测：vec_version() 只在扩展加载后存在） */
function probeVec0(db: SqliteHandle | null): boolean {
  if (!db) return false;
  try {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v?: unknown } | undefined;
    return typeof row?.v === 'string' && row.v.length > 0;
  } catch {
    return false;
  }
}

/**
 * 懒初始化 bridge。任何异常都收敛成 null + 记录原因，**绝不抛给请求方**。
 */
async function ensureBridge(dataDir: string): Promise<BridgeModule | null> {
  if (_bridgeMod !== undefined) return _bridgeMod;

  try {
    const v2DbPath = join(dataDir, 'memarch-v2.db');
    if (!existsSync(v2DbPath)) {
      _initError = `v2 db not found: ${v2DbPath}`;
      console.warn('[MemArchBridge] 跳过初始化:', _initError);
      _bridgeMod = null;
      return null;
    }

    const BetterSqlite = (await import('better-sqlite3')).default;
    // 🔴 allowExtension 是 vec0 扩展加载的前置条件，缺了它向量检索永远降级
    const v2Db = new BetterSqlite(v2DbPath, { allowExtension: true });
    _v2Db = v2Db as unknown as SqliteHandle;

    // LegacyConfig 适配：读 MEMORY_CONFIG；写只进内存覆盖，**不改原常量**
    const { MEMORY_CONFIG } = await import('../config/MemoryConfig.js');
    const override = new Map<string, unknown>();
    const legacyConfig = {
      get: <T,>(key: string): T =>
        (override.has(key) ? override.get(key) : (MEMORY_CONFIG as unknown as Record<string, unknown>)[key]) as T,
      set: (key: string, value: unknown) => { override.set(key, value); },
    };

    // 🔴 变量说明符：让 TS 不静态解析该模块（否则 bridge 子工程被拉进主编译单元）
    const BRIDGE_SPEC = '../../memarch-bridge/src/core/BridgeRegistry.js';
    const mod = (await import(/* @vite-ignore */ BRIDGE_SPEC)) as unknown as BridgeModule;
    mod.initBridge({ v2Db, legacyConfig });
    // 模块导出的是 class，`list()` 在原型上 —— 端点要读注册表必须拿实例。
    // 复用同一个 v2Db 句柄，不新开连接。
    mod._nsManagerInstance = new mod.NamespaceManager(v2Db);

    console.log('[MemArchBridge] 已初始化（懒加载，灰度 0%，不接管流量）');
    _bridgeMod = mod;
    return mod;
  } catch (e) {
    _initError = (e as Error)?.message || String(e);
    console.warn('[MemArchBridge] 初始化失败（不影响主流程）:', _initError);
    _bridgeMod = null;
    return null;
  }
}

export async function handleMemarchBridgeRoutes(deps: MemarchBridgeRouteDeps): Promise<boolean> {
  const { req, res, url, dataDir, readBody } = deps;
  const P = '/api/memarch-bridge';
  if (!url.pathname.startsWith(P)) return false;

  // ── 安全闸：非 loopback 一律拒绝 ──
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: 'loopback_only' });
    return true;
  }

  const mod = await ensureBridge(dataDir);
  const notReady = () => {
    json(res, 503, { ok: false, error: 'bridge_not_initialized', detail: _initError });
    return true;
  };

  // ── GET /health ──
  if (req.method === 'GET' && url.pathname === `${P}/health`) {
    if (!mod) return notReady();
    const bridge = mod.getBridge();
    json(res, 200, {
      ok: true,
      ready: true,
      ports: {
        write: typeof bridge?.write?.write === 'function',
        retrieve: typeof bridge?.retrieve?.retrieve === 'function',
        present: typeof bridge?.present?.present === 'function',
      },
      // 向量能力是否真的上线 —— 运维判断「语义/情感腿有没有在降级」的唯一入口
      vector: {
        vec0: probeVec0(_v2Db),
        vec_mem_semantic: countRows(_v2Db, 'vec_mem_semantic'),
        vec_ep_semantic: countRows(_v2Db, 'vec_ep_semantic'),
        vec_mem_perception: countRows(_v2Db, 'vec_mem_perception'),
      },
    });
    return true;
  }

  // ── GET /namespaces ──
  if (req.method === 'GET' && url.pathname === `${P}/namespaces`) {
    if (!mod) return notReady();
    const mgr = mod._nsManagerInstance;
    // 实例未注入时返回空数组而不是 null：调用方不会把「未初始化」误读成「注册表为空」
    json(res, 200, { ok: true, namespaces: typeof mgr?.list === 'function' ? mgr.list() : [] });
    return true;
  }

  // ── POST 类 ──
  if (req.method === 'POST') {
    if (!mod) return notReady();
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      json(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }

    const flag = mod.globalFeatureFlag;
    const needNs = (): string | null => {
      const ns = String(body.namespace ?? '').trim();
      if (!ns) { json(res, 400, { ok: false, error: 'namespace_required' }); return null; }
      return ns;
    };

    switch (url.pathname) {
      case `${P}/ratio`: {
        const ns = needNs(); if (!ns) return true;
        const ratio = Number(body.ratio);
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
          json(res, 400, { ok: false, error: 'ratio_must_be_0_to_1' }); return true;
        }
        if (typeof flag.setNamespaceRatio !== 'function') { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
        flag.setNamespaceRatio(ns, ratio);
        json(res, 200, { ok: true, namespace: ns, ratio });
        return true;
      }
      case `${P}/promote`: {
        const ns = needNs(); if (!ns) return true;
        if (typeof flag.promoteNamespaceToV2 !== 'function') { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
        flag.promoteNamespaceToV2(ns);
        json(res, 200, { ok: true, namespace: ns, target: 'v2' });
        return true;
      }
      case `${P}/demote`: {
        const ns = needNs(); if (!ns) return true;
        if (typeof flag.demoteNamespaceToLegacy !== 'function') { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
        flag.demoteNamespaceToLegacy(ns);
        json(res, 200, { ok: true, namespace: ns, target: 'legacy' });
        return true;
      }
      case `${P}/rollback`: {
        if (typeof flag.rollback !== 'function') { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
        flag.rollback();
        console.warn('[MemArchBridge] ⚠️ KILL SWITCH 已触发 —— 全部流量回旧链路');
        json(res, 200, { ok: true, killed: true });
        return true;
      }
      case `${P}/unrollback`: {
        if (typeof flag.unrollback !== 'function') { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
        flag.unrollback();
        console.warn('[MemArchBridge] KILL SWITCH 已解除');
        json(res, 200, { ok: true, killed: false });
        return true;
      }
      case `${P}/retrieve`: {
        // 检索自检：只回计数与 id，**不回原文**
        const ns = needNs(); if (!ns) return true;
        const q = String(body.query ?? '').trim();
        if (!q) { json(res, 400, { ok: false, error: 'query_required' }); return true; }
        try {
          const bridge = mod.getBridge();
          if (!bridge?.retrieve?.retrieve) { json(res, 501, { ok: false, error: 'not_supported' }); return true; }
          const r = await bridge.retrieve.retrieve(q, { namespace: ns as RetrievalNamespace });
          const ev = (r as unknown as { evidence?: Array<{ uuid?: string }> })?.evidence ?? [];
          // 🔴 2026-11-07 切流验证：原实现丢弃 metrics，导致「服务内 count=0」无法判断是
          //   全腿降级、重排返回空还是真的无数据。这里只回计数与耗时（无记忆原文）。
          const metrics = (r as unknown as { metrics?: unknown })?.metrics ?? null;
          // 🔴 诊断字段：确认服务进程内句柄指向的文件与 ns 行数是否和磁盘一致
          let dbName: string | null = null;
          let nsRows: number | null = null;
          let likeRows: number | null = null;
          try {
            const h = _v2Db as unknown as {
              name?: string;
              prepare(sql: string): { get(...a: unknown[]): unknown };
            } | null;
            if (h) {
              dbName = h.name ?? null;
              const row1 = h.prepare('SELECT COUNT(*) AS c FROM memories WHERE namespace = ?').get(ns) as { c?: number };
              nsRows = Number(row1?.c ?? -1);
              const row2 = h
                .prepare("SELECT COUNT(*) AS c FROM memories WHERE namespace = ? AND (COALESCE(summary,'') || COALESCE(raw_input,'')) LIKE ?")
                .get(ns, `%${q.slice(0, 8)}%`) as { c?: number };
              likeRows = Number(row2?.c ?? -1);
            }
          } catch { /* 诊断失败不影响主响应 */ }
          json(res, 200, {
            ok: true, namespace: ns, count: ev.length,
            ids: ev.slice(0, 20).map((e) => e.uuid),
            metrics, diagnostics: { dbName, nsRows, likeRows },
          });
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          // 不掩盖问题：状态码与原始 error 原样保留，只补一条可操作提示。
          const hint = msg.includes('legacyRetriever 未注入')
            ? '该 namespace 灰度比例为 0%，请求被路由到旧链路，但运维端点未注入旧实例。可先 POST /promote 或 /ratio 调整后再重试自检。'
            : undefined;
          json(res, 500, hint ? { ok: false, error: msg, hint } : { ok: false, error: msg });
        }
        return true;
      }
      default:
        return false;
    }
  }

  return false;
}
