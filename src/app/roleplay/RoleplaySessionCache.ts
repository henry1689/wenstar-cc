/**
 * RoleplaySessionCache — 会话级缓存（Layer1+Layer2）
 *
 * 🔴 铁律：
 *   - Layer1+Layer2 同一会话仅首次加载
 *   - Layer3+Layer4 每轮重新检索（不缓存）
 *   - 仅人设/关系明确变更时刷新
 */
export interface SessionCacheData {
  roleplay: string;
  layer1: string;
  layer2: string;
  version: number;
}

let _cache: SessionCacheData | null = null;

export function getSessionCache(): SessionCacheData | null {
  return _cache;
}

export function setSessionCache(roleplay: string, layer1: string, layer2: string): void {
  _cache = { roleplay, layer1, layer2, version: 1 };
}

export function clearSessionCache(): void {
  _cache = null;
}

export function hasSessionCache(roleplay: string): boolean {
  return !!_cache && _cache.roleplay === roleplay;
}
