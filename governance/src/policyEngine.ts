/**
 * policyEngine.ts — 声明式策略引擎
 *
 * 职责：
 * 1. 管理声明式策略规则（allow / deny）
 * 2. 按优先级 + deny 优先原则评估请求
 * 3. 支持条件表达式（时间窗、IP、资源标签、主体属性）
 *
 * 设计理由：
 * - 策略评估是纯函数操作，热路径无 I/O，P99 < 0.5ms
 * - deny 优先原则：任何匹配的 deny 规则直接否决，防止越权
 * - 条件表达式用函数式，不用 eval，防止代码注入
 */

import { randomUUID } from 'node:crypto';

// ============================================================
// 类型定义
// ============================================================

/** 策略效果 */
export type Effect = 'allow' | 'deny';

/** 策略规则 */
export interface PolicyRule {
  /** 规则唯一 ID */
  id: string;
  /** 效果：允许或拒绝 */
  effect: Effect;
  /** 主体匹配：角色名或 '*'（通配所有） */
  subject: string;
  /** 资源匹配：资源路径或 '*' */
  resource: string;
  /** 动作匹配：read/write/delete/export/audit 或 '*' */
  action: string;
  /** 条件表达式：返回 true 表示条件满足 */
  condition?: (ctx: EvaluationContext) => boolean;
  /** 优先级：数字越大越先评估（deny 规则优先级更高） */
  priority: number;
  /** 规则描述（审计用） */
  description?: string;
}

/** 策略评估上下文 */
export interface EvaluationContext {
  /** 主体（角色） */
  subject: string;
  /** 主体 ID */
  subjectId: string;
  /** 资源标识 */
  resource: string;
  /** 资源标签（ABAC 属性） */
  resourceTags?: Record<string, string>;
  /** 动作 */
  action: string;
  /** 请求来源 IP */
  sourceIp?: string;
  /** 请求时间戳（默认当前时间） */
  timestamp?: number;
  /** 主体额外属性 */
  subjectAttrs?: Record<string, unknown>;
}

/** 决策结果 */
export interface Decision {
  /** 是否允许 */
  allow: boolean;
  /** 决策原因 */
  reason: string;
  /** 匹配到的规则 ID（如果有） */
  matchedRuleId?: string;
  /** 决策耗时（毫秒） */
  durationMs: number;
}

// ============================================================
// 内部状态
// ============================================================

/** 策略规则表 */
let rules: Map<string, PolicyRule> = new Map();

/** 默认决策：未匹配任何规则时的决策 */
let defaultAllow = false;

// ============================================================
// 内部工具
// ============================================================

/**
 * 通配符匹配
 * 支持 '*' 匹配任意后缀，前缀精确匹配
 * 例如：'mem:*' 匹配 'mem:abc'、'mem:xyz'
 */
function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return pattern === value;
}

/**
 * 检查规则是否匹配上下文
 */
function ruleMatches(rule: PolicyRule, ctx: EvaluationContext): boolean {
  // 主体匹配
  if (!wildcardMatch(rule.subject, ctx.subject)) {
    return false;
  }
  // 资源匹配
  if (!wildcardMatch(rule.resource, ctx.resource)) {
    return false;
  }
  // 动作匹配
  if (!wildcardMatch(rule.action, ctx.action)) {
    return false;
  }
  // 条件匹配
  if (rule.condition && !rule.condition(ctx)) {
    return false;
  }
  return true;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 设置默认决策
 * @param allow true 表示默认允许，false 表示默认拒绝（安全默认）
 */
export function setDefaultDecision(allow: boolean): void {
  defaultAllow = allow;
}

/**
 * 新增或更新策略规则
 * @param rule 策略规则（id 可选，不传则自动生成）
 * @returns 规则 ID
 */
export function upsertRule(rule: Omit<PolicyRule, 'id'> & { id?: string }): string {
  const id = rule.id ?? randomUUID();
  const fullRule: PolicyRule = { ...rule, id };
  rules.set(id, fullRule);
  return id;
}

/**
 * 删除策略规则
 */
export function removeRule(id: string): boolean {
  return rules.delete(id);
}

/**
 * 获取所有策略规则（只读）
 */
export function listRules(): PolicyRule[] {
  return Array.from(rules.values());
}

/**
 * 清空所有策略规则（测试用）
 */
export function clearRules(): void {
  rules.clear();
  defaultAllow = false;
}

/**
 * 评估策略：根据上下文返回决策结果
 *
 * 评估顺序：
 * 1. 收集所有匹配的规则
 * 2. 先看 deny 规则：优先级最高的 deny 匹配 → 拒绝
 * 3. 再看 allow 规则：优先级最高的 allow 匹配 → 允许
 * 4. 都没匹配 → 默认决策
 *
 * 设计理由：deny 优先是安全系统的基本原则，
 * 即使有多个 allow 规则，只要有一个 deny 匹配就否决
 */
export function evaluatePolicy(ctx: EvaluationContext): Decision {
  const start = performance.now();

  // 收集所有匹配的规则
  const matchedDeny: PolicyRule[] = [];
  const matchedAllow: PolicyRule[] = [];

  for (const rule of rules.values()) {
    if (ruleMatches(rule, ctx)) {
      if (rule.effect === 'deny') {
        matchedDeny.push(rule);
      } else {
        matchedAllow.push(rule);
      }
    }
  }

  // deny 优先：按优先级降序，取最高优先级的 deny
  matchedDeny.sort((a, b) => b.priority - a.priority);
  if (matchedDeny.length > 0) {
    const topDeny = matchedDeny[0]!;
    return {
      allow: false,
      reason: `被策略拒绝：${topDeny.description ?? topDeny.id}`,
      matchedRuleId: topDeny.id,
      durationMs: performance.now() - start,
    };
  }

  // allow 规则：按优先级降序，取最高优先级的 allow
  matchedAllow.sort((a, b) => b.priority - a.priority);
  if (matchedAllow.length > 0) {
    const topAllow = matchedAllow[0]!;
    return {
      allow: true,
      reason: `被策略允许：${topAllow.description ?? topAllow.id}`,
      matchedRuleId: topAllow.id,
      durationMs: performance.now() - start,
    };
  }

  // 默认决策
  return {
    allow: defaultAllow,
    reason: defaultAllow ? '默认允许' : '默认拒绝（无匹配规则）',
    durationMs: performance.now() - start,
  };
}

/**
 * 便捷函数：时间窗条件
 * 只在指定的小时区间内允许
 */
export function timeWindowCondition(startHour: number, endHour: number) {
  return (ctx: EvaluationContext): boolean => {
    const now = new Date(ctx.timestamp ?? Date.now());
    const hour = now.getHours();
    return hour >= startHour && hour < endHour;
  };
}

/**
 * 便捷函数：IP 白名单条件
 */
export function ipWhitelistCondition(allowedIps: string[]) {
  return (ctx: EvaluationContext): boolean => {
    if (!ctx.sourceIp) return false;
    return allowedIps.includes(ctx.sourceIp);
  };
}

/**
 * 便捷函数：资源标签条件
 */
export function resourceTagCondition(key: string, value: string) {
  return (ctx: EvaluationContext): boolean => {
    return ctx.resourceTags?.[key] === value;
  };
}
