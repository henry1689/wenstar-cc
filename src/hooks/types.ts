/**
 * Hooks — 探针类型定义
 *
 * S3.1 通用探针装饰器配套类型
 * 采集12个标准字段 + 本地兜底
 */
export interface HookEvent {
  /** 操作类型标识,如 'module_clean_entry', 'storage_write' */
  operation_type: string;
  /** 执行耗时(ms) */
  duration_ms: number;
  /** 执行状态 */
  status: 'success' | 'fail' | 'error';
  /** 关联 DNA 编码（可能为空，见点位图 §5.2） */
  dna_code?: string;
  /** 输入素材标签 */
  input_tags?: string[];
  /** 源存储层级 */
  source_tier?: string;
  /** 目标存储层级 */
  target_tier?: string;
  /** 素材体积(字节) */
  payload_size?: number;
  /** 检索匹配数 */
  match_count?: number;
  /** 异常信息 */
  error_info?: string;
  /** 时间戳（装饰器自动注入） */
  timestamp: string;
}

export interface HookBatch {
  events: HookEvent[];
  source: string;
}

export interface HookDecoratorConfig {
  /** 操作类型 */
  operationType: string;
  /** 是否采集输入快照 */
  collectInput?: boolean;
  /** 是否采集输出快照 */
  collectOutput?: boolean;
}
