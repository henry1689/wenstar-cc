import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';

type BackupStats = {
  lastBackupTime: string | null;
  backupCount?: number;
  successCount: number;
  totalAttempts: number;
};

type OpsRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage: FusionStorageAdapter;
  knowledgeBase: any;
  backupStats: BackupStats;
  projectRoot: string;
  conversationHistory: any[];
  m7: any;
  createKnowledgeMonitor?: (sqlite: any, vectorStore: any) => { selfCheck(): any };
  getAQCReportFn?: (sqlite: any) => any;
  runSandQCFn?: (sqlite: any, history: any[]) => any;
  runGoldQCFn?: (sqlite: any) => any;
};

export async function handleOpsRoutes(deps: OpsRouteDeps): Promise<boolean> {
  const {
    req, res, url, storage, knowledgeBase, backupStats, projectRoot, conversationHistory, m7,
    createKnowledgeMonitor, getAQCReportFn, runSandQCFn, runGoldQCFn,
  } = deps;

  if (req.method === 'GET' && url.pathname === '/api/knowledge/health') {
    try {
      const engine = knowledgeBase?.engine || knowledgeBase;
      const monitor = createKnowledgeMonitor
        ? createKnowledgeMonitor(storage.getSQLite(), engine.vectorStore)
        : new (await import('../app/knowledge/KnowledgeMonitor.js')).KnowledgeMonitor(storage.getSQLite(), engine.vectorStore);
      const report = monitor.selfCheck() as any;
      const successRate = backupStats.totalAttempts > 0
        ? (backupStats.successCount / backupStats.totalAttempts * 100).toFixed(1) + '%'
        : 'N/A';
      const backupDirPath = path.join(projectRoot, 'data', 'backups');
      let backupFiles: string[] = [];
      try { backupFiles = fs.readdirSync(backupDirPath).filter((f) => f.endsWith('.db')); } catch (e) { console.warn(`[server-ops] 操作失败`, (e as Error)?.message || e); }
      report.backup = {
        lastBackupTime: backupStats.lastBackupTime,
        backupSuccessRate: successRate,
        backupCount: backupFiles.length,
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/aqc/report') {
    const getAQCReport = getAQCReportFn || (await import('../app/aqc/AQCEngine.js')).getAQCReport;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getAQCReport(storage.getSQLite())));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/aqc/run') {
    const runSandQC = runSandQCFn || (await import('../app/aqc/AQCEngine.js')).runSandQC;
    const runGoldQC = runGoldQCFn || (await import('../app/aqc/AQCEngine.js')).runGoldQC;
    const sandR = runSandQC(storage.getSQLite(), conversationHistory);
    const goldR = runGoldQC(storage.getSQLite());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', sand: sandR, gold: goldR }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/aqc/records') {
    const rows = storage.getSQLite().queryAll('SELECT * FROM aqc_records ORDER BY created_at DESC LIMIT 20');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ total: rows.length, records: rows }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dream/analyze') {
    try {
      if (m7 && typeof m7.processDreamAnalysis === 'function') {
        await m7.processDreamAnalysis();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', message: '梦境分析完成' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'skip', message: 'M7未就绪' }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}
