/**
 * accessControl.ts — 混合访问控制（RBAC + ABAC）
 *
 * 职责：
 * 1. 五级角色：owner / admin / agent / readOnly / system
 * 2. 资源粒度：记忆条目、命名空间、操作（read/write/delete/export/audit）
 * 3. 临时令牌（带 TTL）+ 权限缓存（LRU）
 * 4. 热路径零加密、零 I/O，纯内存决策，P99 < 1ms
 *
 * 设计理由：
 * - 缓存命中直接返回，不查策略表，保证 P99 < 1ms
 * - LRU 缓存防止内存膨胀
 * - 临时令牌 TTL 到期自动失效，缩短攻击窗口
 */

import { randomUUID, createHash } from 'node:crypto';
import { evaluatePolicy, type Decision as PolicyDecision, type EvaluationContext } from './policyEngine';
import { getConfig } from './securityConfig';

// ============================================================
// 类型定义
// ============================================================

/** 角色等级（数字越大权限越高） */
export type Role = 'owner' | 'admin' | 'agent' | 'readOnly' | 'system';

/** 资源类型 */
export type ResourceType = 'memSym' | 'namespace' | 'operation';

/** 操作类型 */
export type Action = 'read' | 'write' | 'delete' | 'export' | 'audit';

/** 访问主体 */
export interface Subject {
  /** 角色 */
  role: Role;
  /** 主体唯一 ID */
  id: string;
  /** 主体属性（ABAC） */
  attrs?: Record<string, unknown>;
}

/** 资源标识 */
export interface Resource {
  /** 资源类型 */
  type: ResourceType;
  /** 资源标识（条目 ID / 命名空间名） */
  id: string;
  /** 资源标签（ABAC） */
  tags?: Record<string, string>;
}

/** 访问决策结果 */
export interface AccessDecision {
  /** 是否允许 */
  allow: boolean;
  /** 决策原因 */
  reason: string;
  /** 决策耗时 */
  durationMs: number;
  /** 是否缓存命中 */
  fromCache: boolean;
}

/** 临时令牌 */
interface TempToken {
  /** 令牌值 */
  token: string;
  /** 所属主体 */
  subject: Subject;
  /** 到期时间戳 */
  expiresAt: number;
}

// ============================================================
// 内部状态
// ============================================================

/** 权限缓存 LRU：key = role:resource:action，value = 决策结果 */
const permissionCache = new Map<string, { decision: AccessDecision; expiresAt: number }>();

/** 临时令牌表 */
const tempTokens = new Map<string, TempToken>();

/** 角色层级映射（数字越大权限越高） */
const ROLE_LEVEL: Record<Role, number> = {
  owner: 5,
  admin: 4,
  agent: 3,
  readOnly: 2,
  system: 1,
};

// ============================================================
// 内部工具
// ============================================================

/**
 * 生成缓存 key
 * 设计理由：用哈希压缩 key 长度，减少内存占用
 */
function cacheKey(subject: Subject, resource: Resource, action: Action): string {
  const raw = `${subject.role}:${resource.type}:${resource.id}:${action}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * LRU 缓存获取：命中则移到最新位置
 */
function cacheGet(key: string): AccessDecision | null {
  const cfg = getConfig();
  const entry = permissionCache.get(key);
  if (!entry) return null;

  // 检查 TTL
  if (entry.expiresAt < Date.now()) {
    permissionCache.delete(key);
    return null;
  }

  // LRU：删除后重新插入到最新位置
  permissionCache.delete(key);
  permissionCache.set(key, entry);

  return { ...entry.decision, fromCache: true };
}

/**
 * LRU 缓存写入
 */
function cacheSet(key: string, decision: AccessDecision): void {
  const cfg = getConfig();
  const expiresAt = Date.now() + cfg.permissionCacheTTLMs;

  permissionCache.set(key, { decision, expiresAt });

  // LRU 淘汰：超出容量时删除最久未使用的
  if (permissionCache.size > cfg.permissionCacheSize) {
    const oldestKey = permissionCache.keys().next().value;
    if (oldestKey) {
      permissionCache.delete(oldestKey);
    }
  }
}

/**
 * 清理过期令牌（懒加载，每次调用时顺便清理）
 */
function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [key, token] of tempTokens) {
    if (token.expiresAt < now) {
      tempTokens.delete(key);
    }
  }
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 检查权限
 * 热路径：缓存命中直接返回，P99 < 0.1ms；未命中走策略引擎，P99 < 1ms
 *
 * @param subject 访问主体（角色 + 属性）
 * @param resource 访问资源
 * @param action 执行的动作
 * @param options.sourceIp 请求来源 IP（ABAC 用）
 */
export async function checkPermission(
  subject: Subject,
  resource: Resource,
  action: Action,
  options?: { sourceIp?: string }
): Promise<AccessDecision> {
  const start = performance.now();

  // 清理过期令牌（顺便做，不单独定时器）
  cleanupExpiredTokens();

  // 查缓存
  const key = cacheKey(subject, resource, action);
  const cached = cacheGet(key);
  if (cached) {
    return cached;
  }

  // 构造评估上下文
  const ctx: EvaluationContext = {
    subject: subject.role,
    subjectId: subject.id,
    resource: `${resource.type}:${resource.id}`,
    resourceTags: resource.tags,
    action,
    sourceIp: options?.sourceIp,
    timestamp: Date.now(),
    subjectAttrs: subject.attrs,
  };

  // 调用策略引擎
  const policyResult: PolicyDecision = evaluatePolicy(ctx);

  // 组装决策
  const decision: AccessDecision = {
    allow: policyResult.allow,
    reason: policyResult.reason,
    durationMs: performance.now() - start,
    fromCache: false,
  };

  // 写入缓存
  cacheSet(key, decision);

  return decision;
}

/**
 * 颁发临时令牌
 * @param subject 主体
 * @param ttlMs 有效期（毫秒）
 * @returns 令牌字符串
 */
export function issueTempToken(subject: Subject, ttlMs?: number): string {
  const cfg = getConfig();
  const ttl = Math.min(ttlMs ?? cfg.tokenTTLMs, cfg.maxTokenTTLMs);

  const token = `tkn_${randomUUID().replace(/-/g, '')}`;
  tempTokens.set(token, {
    token,
    subject,
    expiresAt: Date.now() + ttl,
  });

  return token;
}

/**
 * 验证临时令牌
 * @returns 令牌对应的主体，无效则返回 null
 */
export function verifyTempToken(token: string): Subject | null {
  cleanupExpiredTokens();
  const entry = tempTokens.get(token);
  if (!entry) return null;
  return entry.subject;
}

/**
 * 撤销临时令牌
 */
export function revokeTempToken(token: string): boolean {
  return tempTokens.delete(token);
}

/**
 * 清除权限缓存（策略变更后调用）
 */
export function clearPermissionCache(): void {
  permissionCache.clear();
}

/**
 * 检查角色等级是否满足要求
 */
export function hasRoleLevel(subject: Subject, requiredLevel: Role): boolean {
  return ROLE_LEVEL[subject.role] >= ROLE_LEVEL[requiredLevel];
}

/**
 * 重置状态（测试用）
 */
export function _resetForTest(): void {
  permissionCache.clear();
  tempTokens.clear();
}
