/**
 * MemArch-v2.0.0 / M2-OnlineWrite / types
 *
 * 统一类型定义，遵循主设计文档第十六章数据结构约定
 */

// ===== 门控结果 =====
export type Gate = 'WRITE' | 'RAW_ONLY' | 'DISCARD';

// ===== 工作记忆条目（L0 编码单元） =====
export interface WorkingEntry {
  message_id: string;            // 幂等键（业务唯一）
  namespace: string;            // 'default' | 'test' | 'roleplay'
  role: string;                  // 'user' | 'assistant' | 'system'
  content: string;
  ts_utc: number;                 // epoch ms

  // L0 编码特征（由外部感知模块注入，或在线快速计算）
  arousal?: number;              // 唤醒度 [0,1]
  valence?: number;               // 效价 [-1,1]
  semantic_embedding?: number[];  // 语义向量（异步生成，在线可缺省）
  has_meaningful_entity?: boolean;
  entities?: string[];

  // 事件分割上下文
  episode_id?: string;

  // 在线显著性五因子（规则版）
  salience?: number;             // 最终合成显著性 [0,1]
  salience_components?: {
    imp_rule: number;
    self_rule: number;
    arousal: number;
    nov_rule: number;
    ent: number;
  };
}

// ===== 事件分割器输入特征 =====
export interface TurnFeat {
  ts: number;
  text: string;
  emb?: number[];                // 语义向量（可缺省）
  arousal: number;
}

// ===== 事件分割器输出 =====
export interface SegmentationResult {
  is_boundary: boolean;
  boundary_score: number;
  factors: {
    semantic: number;
    gap: number;
    arousal: number;
    cue: number;
  };
  reason: string;                // 切分原因说明
}

// ===== 前瞻记忆抽取结果 =====
export interface ProspectiveItem {
  kind: 'promise' | 'reminder' | 'plan' | 'anniversary';
  trigger_type: 'time' | 'event' | 'entity';
  content: string;
  owner: 'user' | 'assistant';
  due_at?: number;               // 推断的到期时间（可选）
  confidence: number;
  source_message_id: string;
  matched_pattern: string;
}

// ===== MemoryWriter 对外输入 =====
export interface WriteMessageInput {
  message_id: string;
  namespace?: string;
  role: string;
  content: string;
  ts_utc?: number;               // 缺省取当前时间
  arousal?: number;
  valence?: number;
  semantic_embedding?: number[];
  roleplay_char?: string;
  sensitivity?: 0 | 1 | 2;
}

// ===== MemoryWriter 对外输出 =====
export interface WriteResult {
  conversation_id: number;
  gate: Gate;
  salience: number;
  episode_id?: string;
  trace_id?: string;             // WRITE 门控时返回
  prospective_items: ProspectiveItem[];
  segmentation: SegmentationResult;
  latency_ms: number;
}

// ===== 钩子接口（加固后预留外接点） =====
export interface WriteHooks {
  onMessageWritten?: (result: WriteResult) => void;
  onGateDecision?: (entry: WorkingEntry, gate: Gate, salience: number) => void;
}
