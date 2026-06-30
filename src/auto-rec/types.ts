/**
 * AutoRec — 核心类型定义
 *
 * S2: 流水线骨架
 * 全链路唯一主键: DNA编码 {branch_id}.{seq_pos}.{locus_path}
 */
import type { DNA, SelfModelV1 } from '../m1/types/dna.js';
import type { Perception24D, CalciumResult } from '../m3/types/perception.js';
import type { ScoredMemory, SimilarityMode } from '../m2/types/index.js';

// ════════════════════════════════════════════════════════════════════
// 核心接口
// ════════════════════════════════════════════════════════════════════

export interface AutoRecModule<TIn = any, TOut = any> {
  id: string;
  name: string;
  execute(input: TIn, context: PipelineContext): Promise<TOut>;
  rollback?(input: TIn, context: PipelineContext): Promise<void>;
}

export interface PipelineContext {
  traceId: string;
  startTime: string;
  dna?: DNA;
  shared: Record<string, any>;
  hooks?: HookCollector;
}

export interface HookCollector {
  push(event: HookEvent): void;
}

export interface HookEvent {
  operation_type: string;
  duration_ms: number;
  status: 'success' | 'fail' | 'error';
  dna_code?: string;
  input_tags?: string[];
  source_tier?: string;
  target_tier?: string;
  payload_size?: number;
  match_count?: number;
  error_info?: string;
  timestamp: string;
}

// ════════════════════════════════════════════════════════════════════
// Pipeline
// ════════════════════════════════════════════════════════════════════

export type ErrorStrategy = 'stop' | 'skip' | 'retry' | 'rollback';
export type TriggerType = 'timer' | 'event';

export interface PipelineDef {
  id: string;
  name: string;
  modules: string[];
  trigger: {
    type: TriggerType;
    config: { interval?: number; eventType?: string };
  };
  errorStrategy: ErrorStrategy;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: 'running' | 'completed' | 'failed' | 'rolled_back';
  modules: PipelineModuleRun[];
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface PipelineModuleRun {
  moduleId: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  durationMs?: number;
  error?: string;
}

// ════════════════════════════════════════════════════════════════════
// 子模块输入/输出
// ════════════════════════════════════════════════════════════════════

export interface CleanInput {
  rawInput: string;
  sourceType: 'chat' | 'import' | 'upload';
  entityGenes?: any[];
}

export interface CleanOutput {
  cleanedText: string;
  safetyTags: string[];
  isSensitive: boolean;
  isCasual: boolean;
  mode: 'casual' | 'knowledge_query' | 'memory_recall' | 'vague_recall';
}

export interface FeatureInput {
  text: string;
  sceneTags?: string[];
  entityGenes?: any[];
}

export interface FeatureOutput {
  perception: Perception24D;
  calcium: CalciumResult;
  emotions: { primary?: string; secondary?: string[] };
}

export interface EncodeInput {
  text: string;
  sceneTags?: string[];
  entityGenes?: any[];
  selfModel: SelfModelV1;
}

export interface EncodeOutput {
  dna: DNA;
  branch_id: string;
  seq_pos: number;
  locus_path: string;
}

export interface VectorAlignInput {
  content: string;
  title?: string;
  knId?: string;
}

export interface VectorAlignOutput {
  chunks: number;
  embeddingsCount: number;
}

export interface StorageInput {
  dna: DNA;
  perception: Perception24D;
  calcium: { score: number; level: number };
  input: string;
  reply?: string;
}

export interface StorageOutput {
  tier: 'sand' | 'gold';
  ref: string;
  success: boolean;
}
