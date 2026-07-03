/**
 * RoleplayDomain — 角色扮演域类型定义
 *
 * 所有管线步骤共用类型收敛于此。
 */
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';

/** 就绪门判定结果严重度 */
export type Severity = 'error' | 'warning' | 'pass';

/** 角色分类 */
export type CharacterClass = 'A' | 'B' | 'C';

/** 用户意图分类 */
export type UserIntent = 'ask_person' | 'ask_age' | 'ask_background' | 'ask_relation' | 'chat';

// ─── 数据采集器输出 ───

export interface CollectedData {
  fg: {
    branch: FamilyGraphRoleBranch | null;
    treeText: string;
    rootProfile: Record<string, any> | null;
    familyMembers: string[];
  };
  kb: Array<{ title: string; content: string }>;
  history: Array<{ role: string; content: string }>;
  portrait: string | null;
  context: {
    message: string;
    entities: string[];
    kinshipTerms: string[];
    pronounTarget: string | null;
    intent: UserIntent;
  };
  knownFields: {
    hasAge: boolean;
    hasRelations: boolean;
    hasAppearance: boolean;
    hasOccupation: boolean;
    hasPersonality: boolean;
    askedPersonFound: boolean;
  };
}

// ─── 就绪门输出 ───

export interface ReadinessDecision {
  canAnswer: boolean;
  missingFields: string[];
  constraints: string[];
  antiFabricationGuard: string;
}

// ─── 验证器输出 ───

export interface ValidationResult {
  pass: boolean;
  issues: string[];
  severity: Severity;
  fix: 'none' | 'regenerate' | 'override';
}

// ─── 管线输出 ───

export interface PipelineOutput {
  knowledgeBaseText: string;
  portrait: string;
  collectedData: CollectedData;
  readiness: ReadinessDecision;
  validation: ValidationResult;
}

/** 域上下文（从 chat.ts 传入的参数集合） */
export interface DomainContext {
  roleplay: string;
  characterClass: CharacterClass;
  message: string;
  dna: any;
  knowledgeBaseText: string;
  m4: any;
  knowledgeBase: any;
  conversationDB: any;
  conversationHistory: Array<{ role: string; content: string; timestamp?: string; topic?: string }>;
  currentRPBranch: FamilyGraphRoleBranch | null;
  rpParamsSnapshot: any;
  currentRoleplay: string;
}
