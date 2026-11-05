/**
 * memarch-runtime — 主对话流程到 MemArch v2 的运行时桥
 *
 * 为什么需要这个文件：
 *   桥接层（memarch-bridge）此前只被运维端点懒加载使用，**主对话流程一次都没
 *   调过它** —— 生产环境实际是「旧链路写入 + 旧链路检索 + 旧链路呈现」，v2 全程
 *   空转。要拆旧链路，第一步必须是让 v2 真正接管主流程。
 *
 * 设计取舍：
 *   · 单例 + 懒初始化：首次调用才加载 bridge（避免拖慢启动），失败后不重试；
 *   · 🔴 子工程模块一律用**变量说明符**动态 import —— 主 tsconfig 的 rootDir
 *     限定在 src/，静态引用 memarch-bridge 会把整个子工程拉进主编译单元
 *     （TS6059 连锁 100+ 错误）。类型正确性由 tsconfig.memarch.json 守护。
 *   · namespace 解析：v2 的隔离边界是 `ns_<entity>`，而主流程手里只有实体 uuid
 *     （`_activeEntityUuids`）。这里用 namespace_registry 的 role_uuid 做映射，
 *     解析不到时回落到本体的 ns_yuyao —— **不静默落到 default**，否则隔离形同虚设。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 本体（玉瑶）的命名空间 —— 无匹配实体时的归属，不是"随便一个默认" */
export const DEFAULT_NAMESPACE = 'ns_yuyao';

export interface MemarchEvidence {
  memory_id: string;
  text: string;
  score: number;
  source_namespace?: string;
  strength?: number;
  timestamp?: number;
  recall_sources?: string[];
}

interface RetrieveResultLike {
  evidence: MemarchEvidence[];
}

interface BridgeLike {
  retrieve: {
    retrieve(
      q: string,
      ctx: { namespace: string; topK?: number },
    ): Promise<RetrieveResultLike>;
  };
}

interface SqliteLike {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

let _bridge: BridgeLike | null = null;
let _db: SqliteLike | null = null;
let _nsByUuid: Map<string, string> | null = null;
let _initPromise: Promise<boolean> | null = null;
let _initError: string | null = null;

export function isMemarchReady(): boolean {
  return _bridge !== null;
}

export function memarchInitError(): string | null {
  return _initError;
}

/**
 * 初始化 bridge。幂等；失败后保持失败状态（不反复重试刷日志），返回 false。
 */
export async function initMemarchRuntime(dataDir: string): Promise<boolean> {
  if (_bridge) return true;
  if (_initError) return false;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const v2DbPath = join(dataDir, 'memarch-v2.db');
      if (!existsSync(v2DbPath)) {
        _initError = `v2 db not found: ${v2DbPath}`;
        console.warn('[MemArchRuntime] 初始化跳过:', _initError);
        return false;
      }

      const BetterSqlite = (await import('better-sqlite3')).default;
      const v2Db = new BetterSqlite(v2DbPath, { allowExtension: true });
      _db = v2Db as unknown as SqliteLike;

      const { MEMORY_CONFIG } = await import('../config/MemoryConfig.js');
      const override = new Map<string, unknown>();
      const legacyConfig = {
        get: <T,>(key: string): T =>
          (override.has(key) ? override.get(key) : (MEMORY_CONFIG as unknown as Record<string, unknown>)[key]) as T,
        set: (key: string, value: unknown) => { override.set(key, value); },
      };

      // 🔴 变量说明符：避免 TS 静态解析，否则子工程被拉进主编译单元
      const BRIDGE_SPEC = '../../memarch-bridge/src/core/BridgeRegistry.js';
      const mod = (await import(/* @vite-ignore */ BRIDGE_SPEC)) as unknown as {
        initBridge(deps: { v2Db: unknown; legacyConfig: unknown }): unknown;
        getBridge(): BridgeLike;
      };
      mod.initBridge({ v2Db, legacyConfig });
      _bridge = mod.getBridge();

      // uuid → namespace 映射（registry 只有 7 个角色，解析不到的走 DEFAULT_NAMESPACE）
      _nsByUuid = new Map();
      try {
        const rows = (v2Db as unknown as SqliteLike)
          .prepare('SELECT namespace, role_uuid FROM namespace_registry WHERE role_uuid IS NOT NULL')
          .all() as Array<{ namespace: string; role_uuid: string }>;
        for (const r of rows) if (r.role_uuid) _nsByUuid.set(r.role_uuid, r.namespace);
      } catch (e) {
        console.warn('[MemArchRuntime] namespace_registry 读取失败，隔离映射退化为单本体:', (e as Error)?.message);
      }

      console.log(`[MemArchRuntime] 已初始化（registry ${_nsByUuid.size} 个角色映射）`);
      return true;
    } catch (e) {
      _initError = (e as Error)?.message || String(e);
      console.warn('[MemArchRuntime] 初始化失败（主流程将回退旧链路）:', _initError);
      return false;
    }
  })();

  return _initPromise;
}

/**
 * 把一组实体 uuid 解析成 v2 的命名空间。
 *
 * 规则：按传入顺序取**第一个能在 registry 里命中的** uuid（调用方已按相关性排序），
 * 全部未命中时回落到本体 ns_yuyao。绝不能返回 'default' —— 那个 ns 在 v2 里
 * 没有任何数据，等于召回空。
 */
export function resolveNamespace(entityUuids: readonly string[] | undefined): string {
  if (!entityUuids || entityUuids.length === 0) return DEFAULT_NAMESPACE;
  if (!_nsByUuid) return DEFAULT_NAMESPACE;
  for (const u of entityUuids) {
    const ns = _nsByUuid.get(u);
    if (ns) return ns;
  }
  return DEFAULT_NAMESPACE;
}

/**
 * 走 v2 检索。未初始化或异常时抛错 —— 调用方负责降级，这里不吞异常，
 * 否则「v2 静默返回空」会被误读成「确实没有相关记忆」。
 */
export async function memarchRetrieve(
  query: string,
  namespace: string,
  topK?: number,
): Promise<MemarchEvidence[]> {
  if (!_bridge) {
    const ok = await initMemarchRuntime(process.env.WENSTAR_DATA_DIR || join(process.cwd(), 'data'));
    if (!ok || !_bridge) throw new Error(`[MemArchRuntime] bridge 未就绪: ${_initError ?? 'unknown'}`);
  }
  const r = await _bridge.retrieve.retrieve(query, topK ? { namespace, topK } : { namespace });
  return r.evidence || [];
}

/** 测试用：重置单例 */
export function _resetMemarchRuntimeForTest(): void {
  _bridge = null; _db = null; _nsByUuid = null; _initPromise = null; _initError = null;
}
