/**
 * dream-content-filter-config — M7 梦境内容过滤配置加载器
 * ============================================================
 * 从 config/dream-content-filter.config.yaml 读取敏感词列表和过滤行为，
 * 供 DreamQueue 入口过滤使用，消除硬编码。
 *
 * 铁律：敏感词列表只在此 yaml 定义，代码通过本模块读取。
 * 修改词表只需改 yaml，无需改代码。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'dream-content-filter.config.yaml');

/** 过滤配置接口 */
export interface DreamFilterConfig {
  /** 敏感词列表 */
  blocklist: string[];
  /** 过滤行为: reject=拒绝并返回null, log=仅记录不拦截 */
  action: 'reject' | 'log';
  /** 日志级别 */
  log_level: 'warn' | 'error' | 'info';
  /** 是否返回 null（而非抛出异常） */
  return_null: boolean;
}

/** 默认配置（yaml 缺失时兜底） */
const DEFAULT_CONFIG: DreamFilterConfig = {
  blocklist: [
    '没法', '不能', '无法', '禁止', '拒绝', '不合适', '不应该',
    '14岁', '15岁', '16岁', '未成年', '初中生', '初三', '高一',
    '角色扮演', '性相关', '亲密行为', '身体接触',
    '系统注意到', '重要记忆', '高钙化记忆',
  ],
  action: 'reject',
  log_level: 'warn',
  return_null: true,
};

/** 懒加载配置单例 */
let _config: DreamFilterConfig | null = null;
let _loadError: string | null = null;

/** 加载配置（带缓存） */
function loadConfig(): DreamFilterConfig {
  if (_config) return _config;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') throw new Error('yaml 根节点不是对象');
    const blocklist = parsed.blocklist;
    const filter = parsed.filter as Record<string, unknown> || {};
    if (!Array.isArray(blocklist) || blocklist.length === 0) {
      throw new Error('blocklist 为空或缺失');
    }
    _config = {
      blocklist: blocklist.map((s: unknown) => String(s)).filter(Boolean),
      action: (filter.action === 'log' ? 'log' : 'reject') as 'reject' | 'log',
      log_level: (['warn', 'error', 'info'].includes(String(filter.log_level))
        ? String(filter.log_level)
        : 'warn') as 'warn' | 'error' | 'info',
      return_null: filter.return_null !== false,
    };
    console.log(`[DreamFilterConfig] 加载成功: ${_config.blocklist.length} 个敏感词`);
  } catch (e) {
    if (!_loadError) {
      _loadError = (e as Error).message;
      console.warn(`[DreamFilterConfig] 加载失败，使用默认值: ${_loadError}`);
    }
    _config = DEFAULT_CONFIG;
  }
  return _config;
}

/** 检查内容是否应被拦截 */
export function isDreamContentBlocked(content: string): boolean {
  if (!content) return false;
  const config = loadConfig();
  return config.blocklist.some(keyword => content.includes(keyword));
}

/** 获取配置（供测试/调试） */
export function getDreamFilterConfig(): DreamFilterConfig {
  return loadConfig();
}

/** 重置缓存（供测试） */
export function resetDreamFilterCache(): void {
  _config = null;
  _loadError = null;
}
