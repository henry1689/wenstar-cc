/**
 * BridgeRegistry.ts — 桥接聚合根（主系统唯一入口）
 *
 * 【主系统用法】
 *   import { bridge } from '@wenstar/memarch-bridge';
 *
 *   // 入口处（chat.ts 主循环）：
 *   await NamespaceContext.run({ namespace: 'ns_yuyao', roleplayChar: '玉瑶', sessionId: 'xxx', subject: {...} }, async () => {
 *     // 写
 *     await bridge.write.write({ messageId: '...', role: 'user', content: '...' });
 *     // 门控
 *     const gate = bridge.gate.decideMode({ message: '...', namespace: 'ns_yuyao' });
 *     // 检索
 *     if (gate.needsMemorySearch) {
 *       const r = await bridge.retrieve.retrieve('...', { namespace: 'ns_yuyao' });
 *       // 呈现
 *       const p = bridge.present.present({ evidences: r.evidence, userQuery: '...', namespace: 'ns_yuyao' });
 *       // 用 p.utterance 回复
 *     }
 *   });
 */

import type Database from 'better-sqlite3';
import { globalFeatureFlag, type FeatureFlag } from './FeatureFlag.js';
import type { MemArchBridge } from './MemoryPort.js';
import { OldWriteAdapter } from '../adapters/OldWriteAdapter.js';
import { OldRetrievalAdapter } from '../adapters/OldRetrievalAdapter.js';
import { OldPresentationAdapter } from '../adapters/OldPresentationAdapter.js';
import { OldAssessorAdapter } from '../adapters/OldAssessorAdapter.js';
import { OldStorageAdapter } from '../adapters/OldStorageAdapter.js';
import { OldGateAdapter } from '../adapters/OldGateAdapter.js';
import { OldConfigAdapter, type LegacyConfig } from '../adapters/OldConfigAdapter.js';
import { NamespaceManager } from '../namespace/NamespaceManager.js';
import { ensureVectorIndex } from '../../../memarch-v2/storage/vector_index.js';

export interface BridgeDeps {
  /** 新 MemArch v2 的 SQLite db 句柄（已跑过 M1 DDL） */
  v2Db: Database.Database;
  /** 旧 MemoryConfig 实例 */
  legacyConfig: LegacyConfig;
  /** 旧 MemoryWriteGateway（可选，灰度期注入） */
  legacyWriteGateway?: ConstructorParameters<typeof OldWriteAdapter>[2];
  /** 旧 MemoryRetriever（可选） */
  legacyRetriever?: ConstructorParameters<typeof OldRetrievalAdapter>[2];
  /** 旧 MemoryAssessor（可选） */
  legacyAssessor?: ConstructorParameters<typeof OldAssessorAdapter>[2];
  /** 灰度开关（默认全局单例） */
  flag?: FeatureFlag;
}

export function createBridge(deps: BridgeDeps): MemArchBridge {
  const flag = deps.flag ?? globalFeatureFlag;

  // 🔴 vec0 扩展 + 向量表建置。失败只记录、不阻塞：语义/情感两条腿各自有
  //   FTS5 降级路径，把 bridge 初始化拖挂才是更坏的结果。
  //   注意 db 连接必须由调用方以 `{ allowExtension: true }` 打开。
  const vec = ensureVectorIndex(deps.v2Db);
  if (vec.ok) {
    console.log(`[bridge] vec0 ${vec.version} 已加载，向量表就绪`);
  } else {
    console.warn('[bridge] vec0 不可用，语义/情感腿将降级 FTS5:', vec.error);
  }

  // 🔴 后台预热 embedding 模型。冷启动加载要 ~0.8s，而 retrieve 的 embed 预算
  //   只有 120ms —— 不预热的话服务重启后头几次对话的语义腿必然降级。
  //   这里**不 await**：预热失败或慢都不该影响 bridge 初始化。
  void (async () => {
    try {
      const { getEmbeddingProvider } = await import('../../../memarch-v2/retrieval/embedding/EmbeddingProvider.js');
      await getEmbeddingProvider().embed('预热');
      console.log('[bridge] embedding 模型已预热');
    } catch (e) {
      console.warn('[bridge] embedding 预热失败（语义腿将按需懒加载）:', (e as Error)?.message || String(e));
    }
  })();

  const nsManager = new NamespaceManager(deps.v2Db);

  const write = new OldWriteAdapter(deps.v2Db, flag, deps.legacyWriteGateway);
  const retrieve = new OldRetrievalAdapter(deps.v2Db, flag, deps.legacyRetriever);
  const present = new OldPresentationAdapter(flag);
  const assess = new OldAssessorAdapter(deps.v2Db, flag, deps.legacyAssessor);
  const storage = new OldStorageAdapter(deps.v2Db, nsManager);
  const gate = new OldGateAdapter(flag);
  const config = new OldConfigAdapter(deps.legacyConfig);

  return {
    write, retrieve, present, assess, storage, gate, config,
    health(): { v2Ready: boolean; legacyReady: boolean; activePath: 'v2' | 'legacy' | 'mixed' } {
      const s = flag.snapshot();
      const onV2 = s.forceV2.size > 0 || s.globalRatio > 0;
      const onLegacy = !s.globalKillSwitch && (s.forceLegacy.size > 0 || s.globalRatio < 1);
      return {
        v2Ready: true,
        legacyReady: !!deps.legacyWriteGateway,
        activePath: onV2 && onLegacy ? 'mixed' : onV2 ? 'v2' : 'legacy',
      };
    },
  };
}

/** 全局单例（主系统启动时 initBridge 一次，后续 import { bridge } 直接用） */
let _bridge: MemArchBridge | null = null;

export function initBridge(deps: BridgeDeps): MemArchBridge {
  _bridge = createBridge(deps);
  return _bridge;
}

export function getBridge(): MemArchBridge {
  if (!_bridge) throw new Error('[bridge] 尚未 initBridge()。请在主系统启动入口先初始化。');
  return _bridge;
}

// 便捷导出
export { NamespaceContext } from '../namespace/NamespaceContext.js';
export { NamespaceManager } from '../namespace/NamespaceManager.js';
export { globalFeatureFlag } from './FeatureFlag.js';
