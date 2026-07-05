/**
 * RoleplaySessionCache — 角色扮演会话级缓存
 *
 * 约束 2（常驻层缓存）：
 *   Layer1 核心身份 + Layer2 关系摘要 → 同一会话内仅首次加载时查询一次
 *   仅当人设变更/关系重大节点时主动刷新
 *
 * 🔴 不缓存 Layer3（记忆激活层），保证话题切换时记忆能同步激活
 */
export interface SessionCache {
  roleplay: string;
  layer1Identity: string | null;
  layer2Relations: string | null;
  version: number;
}

let _cache: SessionCache | null = null;

export function getSessionCache(): SessionCache | null {
  return _cache;
}

export function initSessionCache(roleplay: string): void {
  _cache = { roleplay, layer1Identity: null, layer2Relations: null, version: 1 };
}

export function setLayer1(value: string): void {
  if (_cache) _cache.layer1Identity = value;
}

export function setLayer2(value: string): void {
  if (_cache) _cache.layer2Relations = value;
}

export function hasLayer1(): boolean {
  return !!_cache?.layer1Identity;
}

export function hasLayer2(): boolean {
  return !!_cache?.layer2Relations;
}

export function clearCache(): void {
  _cache = null;
}
