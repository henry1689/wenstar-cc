/**
 * types.ts — 角色扮演域 通用类型定义
 *
 * 🔴 铁律：
 *   - 所有结构化字段独立成行（无模糊文本匹配）
 *   - 全字段共用一套逻辑，无年龄/亲属等个案补丁
 *   - 双标记隔离：source=roleplay + roleplay_id
 */
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';

/** 角色分类 */
export type CharacterClass = 'A' | 'B' | 'C';

/** 三级记忆库类型 */
export type MemoryVaultType = 'sand' | 'vault' | 'black_diamond';

// ─── PersonStructProfile — 标准化人物结构化档案 ───

/**
 * 通用结构化人物档案
 * 所有属性走结构化字段，禁止模糊文本匹配
 */
export interface PersonStructProfile {
  name: string;
  age?: number;
  birth?: string;
  occupation?: string;
  personality?: string[];
  appearance?: string;
  traits?: string[];
  interests?: string[];
  habits?: string;
  voice?: string;
  description?: string;
  relation_to_user?: string;
  relation?: string;
  /** 是否有该人物的结构化数据 */
  hasProfile: boolean;
  /** 适配点3：统一字段存在标记 */
  knownFields: Record<string, boolean>;
}

// ─── Layer1Data — 核心身份层 ───

export interface Layer1Data {
  /** 角色名 */
  roleplay: string;
  /** 结构化档案 */
  profile: PersonStructProfile | null;
  /** 已知字段标记 */
  knownFields: Record<string, boolean>;
  /** 格式化的身份文本 */
  identityText: string;
}

// ─── Layer2Data — 关系常驻层 ───

export interface Layer2Data {
  /** 直系亲属结构化档案列表 */
  relatives: PersonStructProfile[];
  /** 格式化的关系文本 */
  relationText: string;
  /** 正向映射：亲属称谓 → 人物名（如 姐姐 → 徐诗雨） */
  kinshipToName: Record<string, string>;
}

// ─── Layer3Data — 记忆激活层 ───

export interface MemoryEntry {
  id: string;
  text: string;
  source: MemoryVaultType;
  score: number;
  created_at: string;
}

export interface Layer3Data {
  /** 砂金库：短期工作记忆（<10轮） */
  sandMemories: MemoryEntry[];
  /** 金库：长期陈述记忆（已钙化） */
  vaultMemories: MemoryEntry[];
  /** 黑钻库：核心珍藏记忆 */
  diamondMemories: MemoryEntry[];
  /** 格式化的记忆文本 */
  memoryText: string;
}

// ─── Layer4Data — 知识背景层 ───

export interface Layer4Data {
  /** 知识库条目 */
  kbEntries: Array<{ title: string; content: string; score: number }>;
  /** 格式化的知识文本 */
  knowledgeText: string;
}

// ─── FourLayerData — 完整四层数据包 ───

export interface FourLayerData {
  layer1: Layer1Data;
  layer2: Layer2Data;
  layer3: Layer3Data;
  layer4: Layer4Data;
  /** 当前消息的实体解析 */
  parsedEntities: string[];
  parsedKinshipTerms: string[];
  /** 正向映射：亲属称谓 → 人物名（如 姐姐 → 徐诗雨） */
  kinshipToName: Record<string, string>;
  /** L5门控: 是否有有效关系数据 */
  hasValidRelation: boolean;
  roleplayId: string;
  source: 'roleplay';
}

// ─── 就绪门输出 ───

export interface ReadinessReport {
  /** 全局已知字段标记 */
  knownFields: Record<string, boolean>;
  /** 全局缺失字段列表 */
  missingFields: string[];
  /** 四层都有数据吗 */
  hasAnyData: boolean;
}

// ─── 校验器输出 ───

export type ValidationSeverity = 'pass' | 'warning' | 'error';

export interface ValidationResult {
  pass: boolean;
  severity: ValidationSeverity;
  issues: string[];
  /** 是否需要重生成 */
  needsRegenerate: boolean;
}

// ─── 域上下文（从chat.ts传入） ───

export interface DomainContext {
  roleplay: string;
  characterClass: CharacterClass;
  message: string;
  dna: any;
  knowledgeBaseText?: string;
  m4: any;
  knowledgeBase: any;
  storage: any;
  conversationDB: any;
  conversationHistory: Array<{ role: string; content: string; timestamp?: string; topic?: string }>;
  currentRPBranch: FamilyGraphRoleBranch | null;
  rpParamsSnapshot: any;
  currentRoleplay: string;
}

// ─── 角色数据双标记 ───

export function generateRoleplayId(): string {
  return 'rp_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
}
