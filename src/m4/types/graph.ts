// M4 家族知识库图结构类型定义 — v2.0 (EntityGraph)
// Ref: M4-design-v1.md §3 + 2026-07-05 升级方案

import type { EntityGene } from '../../m1/types/dna.js';

export type NodeType = 'person' | 'place' | 'thing' | 'concept' | 'object' | 'feature' | 'org';

// ─── 5级圈层 ───
// 0=未分类  1=核心层(家人/伴侣)  2=亲密层(挚友)
// 3=熟人层  4=商务层  5=泛泛之交
export type CircleLevel = 0 | 1 | 2 | 3 | 4 | 5;

// ─── 关系权重（映射24D社交/亲密象限） ───
export interface RelationWeights {
  trust?: number;              // 信任度 0-1
  intimacy?: number;           // 亲密度 0-1
  respect?: number;            // 尊重度 0-1
  power_diff?: number;         // 权力差 -1~1
  interaction_freq?: number;   // 互动频次 0-1
  emotional_intensity?: number;// 情绪强度 0-1
  base_intimacy?: number;      // 基础亲密度（关系类型决定，只读）
  _locked?: string[];          // 被手动锁定的字段名
}

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  aliases?: string[];
  properties?: Record<string, unknown>;
  /** v2.0: 圈层级别 */
  circle_level?: CircleLevel;
  /** v2.0: 标签（如"家人""同事""客户"） */
  tags?: string[];
}

export interface GraphEdge {
  id?: string;
  source_id: string;
  target_id: string;
  relation: string;
  properties?: Record<string, unknown>;
  /** v2.0: 关系权重 */
  weights?: RelationWeights;
  /** v2.0: 角色模板引用（如"父亲""上级"，不做节点） */
  role_template?: string;
  /** v2.0: 圈层归属（覆盖两端节点较低者） */
  circle?: CircleLevel;
}

export interface GraphQueryResult {
  node: GraphNode;
  relationships: Array<{
    relation: string;
    direction: 'outgoing' | 'incoming';
    targetNode: GraphNode;
  }>;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface InferenceResult {
  nodes_created: number;
  edges_created: number;
  details: string[];
}

export interface FamilySummary {
  members: Array<{ name: string; relation_to_user: string; aliases: string[]; circle_level?: CircleLevel }>;
  locations: string[];
}

export interface RelationCandidate {
  sourceName: string;
  targetName: string;
  relation: string;
  confidence: number;
}

export type FamilyManualAPI = {
  handleUserDefinedRelation(utterance: string): Promise<void>;
  handleCorrection(utterance: string): Promise<void>;
};

export interface FamilyGraph {
  findRelated(entityName: string, relation?: string): Promise<GraphQueryResult[]>;
  findPath(sourceName: string, targetName: string): Promise<GraphPath | null>;
  addNode(node: GraphNode): Promise<void>;
  addEdge(edge: GraphEdge): Promise<void>;
  integrateFromEntity(entities: EntityGene[], rawInput: string, selfName?: string): Promise<InferenceResult>;
  correctRelation(source: string, target: string, correctRelation: string): Promise<void>;
  addFamilyMember(name: string, relation: string, aliases?: string[]): Promise<void>;
  getFamilySummary(): Promise<FamilySummary>;
}

// ─── 关系权重默认值（映射24D社交/亲密象限） ───
export const DEFAULT_BASE_INTIMACY: Record<string, number> = {
  // 亲属
  mother_of: 0.9, father_of: 0.85, spouse_of: 0.95, sibling_of: 0.8,
  child_of: 0.85, parent_of: 0.85, grandparent_of: 0.75, grandchild_of: 0.75,
  // 社交
  friend_of: 0.6, classmate_of: 0.4, roommate_of: 0.5, neighbor_of: 0.3,
  // 商业
  colleague_of: 0.4, boss_of: 0.3, subordinate_of: 0.3,
  client_of: 0.2, partner_of: 0.5, server_of: 0.2,
  teacher_of: 0.4, student_of: 0.3,
  // 实体从属
  belongs_to: 0.0, located_in: 0.0, operated_by: 0.2, inspected_by: 0.1,
  // 默认
  acquaintance_of: 0.1,
};
