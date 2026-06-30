/**
 * 审计系统 — 统一类型定义
 */

export type AuditHealth = 'healthy' | 'degraded' | 'critical';

export interface CheckResult {
  id: string;
  name: string;
  module: string;
  status: 'passed' | 'failed' | 'error' | 'manual';
  detail: string;
  data?: Record<string, any>;
  error?: string;
  durationMs: number;
}

export interface AuditReport {
  auditId: string;
  timestamp: string;
  commitId: string;
  branch: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    error: number;
    manual: number;
  };
  results: CheckResult[];
  recommendations: string[];
}

export interface AuditFinding {
  level: 'P0' | 'P1' | 'P2' | 'P3' | 'info';
  check: string;
  module: string;
  title: string;
  detail: string;
  value?: string | number;
  threshold?: string | number;
  suggestion: string;
}

export interface AuditCheckResult {
  checkName: string;
  status: 'passed' | 'failed' | 'warning' | 'error';
  score: number;
  findings: AuditFinding[];
  durationMs: number;
}

export interface ModuleHealth {
  module: string;
  lines: number;
  health: '🟢' | '🟡' | '🔴';
  p0Count: number;
  p1Count: number;
  p2Count: number;
  summary: string;
}

export interface AuditConfig {
  dbPath?: string;
  dataDir?: string;
  timeout?: number;
  fullScan?: boolean;
}
