/**
 * index.ts — 多路检索底座 barrel / 工厂（Foundation V1.0）
 * =======================================================
 * createDefaultRegistry：按依赖注入默认注册的存储域适配器。
 *
 * 当前默认注册（S3 首批）：
 *   knowledge / black_diamond / work / vault / note
 *   —— 这些是 retrieval-stage 现有 4 个 ad-hoc 块（KB直连/金库/砂金高钙化/黑钻 recall）
 *      的收编对象，S4 接线后由底座统一调度。
 *
 * S6 追加注册：memory / conversation / family_graph（MemoryAdapter 复合 6 路，
 *   为保住 V13 主链原样，S6 才接入注册表）。
 */

import { AdapterRegistry } from './adapter.js';
import type { KnowledgeSource } from './adapters/KnowledgeAdapter.js';
import { BlackDiamondAdapter } from './adapters/BlackDiamondAdapter.js';
import { VaultAdapter } from './adapters/VaultAdapter.js';
import { NoteAdapter } from './adapters/NoteAdapter.js';
import { ConversationAdapter } from './adapters/ConversationAdapter.js';
import { FamilyGraphAdapter, type FamilyGraphSource } from './adapters/FamilyGraphAdapter.js';
import { MemoryAdapter, type MemoryRetrieverSource } from './adapters/MemoryAdapter.js';
// 🔴 ADR-010 P1-C1: 对话块域（块 = 一段连贯场景，多轮聚合）
import { DialogGroupAdapter } from './adapters/DialogGroupAdapter.js';
import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';

/** 数据源依赖（与 SQLiteAdapter 兼容的最小形状） */
export interface FoundationDeps {
  /** SQLiteAdapter（queryAll 兼容，用于 black_diamond/works/vault_log/memories 域） */
  sqlite?: {
    queryAll<T = unknown>(sql: string, params?: unknown[]): T[];
  };
  /** 知识库数据源（ctx.knowledgeBase） */
  knowledgeBase?: KnowledgeSource;
  /** S6 扩展：FG 数据源（SearchOrchestrator 阶段用） */
  familyGraph?: FamilyGraphSource;
  /** S6 扩展：记忆召回数据源（SearchOrchestrator 阶段用） */
  memoryRetriever?: MemoryRetrieverSource;
}

/**
 * 创建默认适配器注册表（S3 首批 5 域：knowledge/black_diamond/work/vault/note）。
 * deps 缺省时跳过对应域（注册表保持空，兼容未接线环境）。
 *
 * 🔴 不注册 conversation/memory/family_graph——这三域已由 V13/V11 主链 +
 *   EntityContextBuilder/时间导航覆盖，接入会重复注入。需用 createExtendedRegistry 显式启用。
 */
export function createDefaultRegistry(deps: FoundationDeps): AdapterRegistry {
  const reg = new AdapterRegistry();

  // 🔴 S2-E1 收编: 去掉 knowledge/work 适配器 — 两域已由其他主链覆盖:
  //   - knowledge: KnowledgeContextBuilder.weightedSearch（户主/会晤主源，Level 1-3 分级）
  //   - work: V13 retrieveMultiRank work 路（works 表 LIKE 召回）
  //   保留 black_diamond: V13 六路(emotion/keyword/spine/locus/entity/work) 均不查 black_diamond 表，
  //   Foundation BlackDiamondAdapter 是户主模式黑钻(💎珍藏记忆)的唯一直接源，必须保留。
  //   vault/note: 旧金库块已随 WS_FOUNDATION_ROUTES 关闭，Foundation 是唯一源。
  if (deps.sqlite) {
    reg.register(new BlackDiamondAdapter(deps.sqlite));
    reg.register(new VaultAdapter(deps.sqlite));
    reg.register(new NoteAdapter(deps.sqlite));
    // 🔴 ADR-010 P1-C1: 对话块域。
    //   为什么可以进默认注册（与 conversation/memory/family_graph「默认不注册」不同）：
    //   那三域已由 V13/V11 主链覆盖，接入会**重复注入**；而「块」是一个**新的聚合粒度**，
    //   主链任何一路都不产出它 —— 不会与既有路重叠。
    //   为什么用「注册级」开关而非查询级：注册表在编排层构造，关掉即整条路不存在，
    //   不会出现「开关关了但某处仍在查」的半失效状态，回退语义干净。
    let _dgOn = true;
    try { _dgOn = getRetrievalFusionConfig().enable_dialog_group_memory !== false; }
    catch { /* 配置读取失败 → 保持默认开（块检索是本期交付的能力，失败不应静默降级） */ }
    if (_dgOn) reg.register(new DialogGroupAdapter(deps.sqlite));
  }

  return reg;
}

/**
 * 创建扩展适配器注册表（S3 5 域 + S6 3 域 = 8 域）。
 * 🔴 供未来 SearchOrchestrator 显式启用——接入 conversation/memory/family_graph
 *    前必须先停用 V13/V11 主链的对应召回，否则重复注入。
 */
export function createExtendedRegistry(deps: FoundationDeps): AdapterRegistry {
  const reg = createDefaultRegistry(deps);
  if (deps.sqlite) {
    reg.register(new ConversationAdapter(deps.sqlite));
  }
  if (deps.familyGraph) {
    reg.register(new FamilyGraphAdapter(deps.familyGraph));
  }
  if (deps.memoryRetriever) {
    reg.register(new MemoryAdapter(deps.memoryRetriever));
  }
  return reg;
}

export * from './types.js';
export * from './adapter.js';
export * from './fusion.js';
export * from './backref.js';
