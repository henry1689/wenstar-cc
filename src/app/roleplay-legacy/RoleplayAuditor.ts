/**
 * RoleplayAuditor — 角色扮演域·全链路审计（阶段3-1）
 *
 * 职责：每轮角色扮演完整链路留痕，支持按角色/时间/问题类型回溯。
 *       定期统计编造率/人设漂移率，异常自动告警。
 */
import type { CollectedData, DataCoverageReport, ValidationResult } from './types.js';

/** 单轮审计记录 */
export interface AuditRecord {
  timestamp: string;
  sessionId: string;
  roleplay: string;
  turnNumber: number;
  userMessage: string;
  llmReply: string;
  /** 管线各阶段耗时(ms) */
  timings: {
    collect: number;
    readiness: number;
    assemble: number;
    generate: number;
    validate: number;
  };
  /** 就绪门输出 */
  readiness: {
    canAnswer: boolean;
    missingFields: string[];
  };
  /** 验证器输出 */
  validation: {
    pass: boolean;
    severity: string;
    issues: string[];
  };
  /** 数据采集摘要 */
  dataSummary: {
    fgMembers: number;
    kbEntries: number;
    historyTurns: number;
    hasPortrait: boolean;
    entitiesFound: string[];
  };
}

/** 角色健康报告 */
export interface RoleHealthReport {
  roleplay: string;
  totalTurns: number;
  fabricationRate: number;
  driftRate: number;
  lastActive: string;
  avgConfidence: number;
}

// ─── 域内审计存储（环形缓冲区，保留最近 1000 条） ───

const MAX_RECORDS = 1000;
const _auditLog: AuditRecord[] = [];

let _turnIndex = 0;

/** 追加一条审计记录 */
export function appendAuditRecord(record: Omit<AuditRecord, 'timestamp'>): void {
  const full: AuditRecord = { ...record, timestamp: new Date().toISOString() };
  _auditLog.push(full);
  if (_auditLog.length > MAX_RECORDS) _auditLog.shift();
}

/** 获取审计日志（按角色筛选，最近 N 条） */
export function getAuditLog(roleplay?: string, limit = 50): AuditRecord[] {
  let results = roleplay
    ? _auditLog.filter(r => r.roleplay === roleplay)
    : [..._auditLog];
  return results.reverse().slice(0, limit);
}

/** 清空审计日志 */
export function clearAuditLog(): void {
  _auditLog.length = 0;
}

/** 计算角色健康报告 */
export function computeHealthReport(roleplay: string): RoleHealthReport | null {
  const records = _auditLog.filter(r => r.roleplay === roleplay);
  if (records.length === 0) return null;

  const totalTurns = records.length;
  const fabricated = records.filter(r => !r.validation.pass).length;
  const drifted = records.filter(r => r.validation.issues.some(i => i.includes('身份漂移'))).length;

  return {
    roleplay,
    totalTurns,
    fabricationRate: totalTurns > 0 ? fabricated / totalTurns : 0,
    driftRate: totalTurns > 0 ? drifted / totalTurns : 0,
    lastActive: records[records.length - 1]?.timestamp || '',
    avgConfidence: 1 - (totalTurns > 0 ? fabricated / totalTurns : 0),
  };
}

/** 获取所有角色的健康报告 */
export function getAllHealthReports(): RoleHealthReport[] {
  const roles = [...new Set(_auditLog.map(r => r.roleplay))];
  return roles.map(r => computeHealthReport(r)).filter(Boolean) as RoleHealthReport[];
}

/** 获取编造率（全局） */
export function getGlobalFabricationRate(): number {
  if (_auditLog.length === 0) return 0;
  const failed = _auditLog.filter(r => !r.validation.pass).length;
  return failed / _auditLog.length;
}

/** 记录管线运行（在 RoleplayDomain 中调用） */
export function recordPipelineRun(
  roleplay: string,
  sessionId: string,
  turnNumber: number,
  message: string,
  reply: string,
  timings: AuditRecord['timings'],
  coverage: DataCoverageReport,
  validation: ValidationResult,
  data: CollectedData,
): void {
  _turnIndex++;
  appendAuditRecord({
    sessionId,
    roleplay,
    turnNumber,
    userMessage: message.substring(0, 500),
    llmReply: reply.substring(0, 500),
    timings,
    readiness: {
      canAnswer: coverage.missingFields.length === 0,
      missingFields: coverage.missingFields,
    },
    validation: {
      pass: validation.pass,
      severity: validation.severity,
      issues: validation.issues,
    },
    dataSummary: {
      fgMembers: data.fg.familyMembers.length,
      kbEntries: data.kb.length,
      historyTurns: data.history.length,
      hasPortrait: !!data.portrait,
      entitiesFound: data.context.entities,
    },
  });
}
