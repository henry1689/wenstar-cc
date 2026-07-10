/**
 * logger — 四层日志体系
 *
 * 📜 架构优化：统一日志分级，为 WenStarOS 日志规范打样
 *
 * INFO  → 正常对话流转、记忆晋升、关系更新
 * DEBUG → DNA字段、向量数值、检索命中列表（调试专用）
 * WARN  → 人物冲突、权重自动修正、角色切换熔断
 * ERROR → 数据库写入失败、LLM超时、图谱节点缺失
 */

type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
}

// 日志缓冲区（内存中保留最近500条）
const buffer: LogEntry[] = [];
const MAX_BUFFER = 500;

function log(level: LogLevel, module: string, message: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const prefix = `[${level}] [${module}]`;
  switch (level) {
    case 'ERROR': console.error(prefix, message); break;
    case 'WARN':  console.warn(prefix, message); break;
    case 'DEBUG':
      // 默认关闭DEBUG，只写缓冲区
      if (process.env['DEBUG_MODE'] === 'true') console.log(prefix, message);
      break;
    default:      console.log(prefix, message); break;
  }
}

export const logger = {
  /** 正常流转 */
  info(module: string, msg: string) { log('INFO', module, msg); },

  /** 调试专用 */
  debug(module: string, msg: string) { log('DEBUG', module, msg); },

  /** 需要关注但不阻断 */
  warn(module: string, msg: string) { log('WARN', module, msg); },

  /** 阻断性问题 */
  error(module: string, msg: string) { log('ERROR', module, msg); },

  /** 获取最近的日志（监控面板用） */
  recent(limit = 50): LogEntry[] {
    return buffer.slice(-limit);
  },

  /** 按级别过滤 */
  filter(level: LogLevel, limit = 50): LogEntry[] {
    return buffer.filter(e => e.level === level).slice(-limit);
  },

  /** 清空缓冲区 */
  clear(): void { buffer.length = 0; },
};
