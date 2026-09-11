#!/usr/bin/env node
/**
 * 太虚境·WebUI 启动器
 * 在 tsx 启动前加载 .env 到 process.env，确保所有 import 的模块能读到环境变量
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const TSC_CLI = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// 加载 .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (key) process.env[key] = val;
  }
  console.log('[Start] .env 已加载');
}

// ── 启动前脚本（非阻断，静默收集结果） ──
// 🔴 V15: prestart-patch.ts 已删除
// 🔴 V15: rebuild-memories → SQLiteAdapter._rebuildMemoryAnchors()
// 🔴 V16: backfill-uuid → repairDataIntegrity, fix-xsy-kb → _fixKnowledgeBase,
//         fix-all-entities-final → _fixEntityRelations + _fixKnowledgeBase
// 🔴 v2.9: 移除 fix-kb-gates boot 改写（改 src 的 HIGH_RISK 文件 = 绕过治理）。
//   KB 会晤闸门修复改走 harness_run_flow 落 src 并 commit——已提交 src 是唯一权威。
//   仅允许 DB/数据修复脚本（写库不写 src/dist），禁止 src/dist 改写。
const prestartScripts = [
  // 🔴 2026-09-09 Phase C: 停用 clean-all-person-edges.cjs（硬编码覆写档案：对熊梓铭/徐诗雨/徐诗韵
  //   整覆写 dossier.basicInfo/selfProfile 等，覆盖 Owner 拍板真值如诗韵 2012、诗雨大学已毕业）。
  //   档案唯一源 = PAE + 用户确认真值（S4 治理）。边管理归 FamilyGraph 自身（脚本 V17 注释自述）。
  //   原脚本保留在 scripts/ 供参考，不再执行。
  { label: '时空回填', cmd: `node "${path.join(__dirname, 'scripts', 'backfill-temporals.cjs')}"` },
];

const prestartResults = [];

// ── V21: ServerLock — 生产数据库写保护（监督进程侧）──
// 🔴 锁由「真正写库的 server 进程」自己持有（见 server.ts main() → ServerLock.acquire()）。
//   进程树: start.cjs(P0) → tsx CLI(P1) → node server.ts(P2)，写库的是 P2。
//   若由 P0/P1 代写锁，P2 会判定「他人持锁」而被自己拒绝 → 服务无法启动。
//   本监督进程职责仅两件：① 启动前拒绝重复实例 ② 清理陈旧锁。
const LOCK_PATH = path.join(__dirname, 'data', 'webui', 'server.lock');

// [1] 启动前：陈旧锁清理 / 存活则拒绝启动
if (fs.existsSync(LOCK_PATH)) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (e) {
    console.warn('[Start] 锁文件损坏，清理后继续:', e.message);
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }
  if (prev && typeof prev.pid === 'number') {
    // 他机锁 → 本机视为陈旧
    const foreignHost = typeof prev.host === 'string' && prev.host !== os.hostname();
    let alive = false;
    if (!foreignHost) {
      try { process.kill(prev.pid, 0); alive = true; }
      catch (e) { alive = e && e.code === 'EPERM'; } // Windows: 无权限 = 进程存在
    }
    if (alive) {
      console.error('[Start] ❌ 服务已在运行 (PID ' + prev.pid + ', host ' + prev.host + ')');
      console.error('[Start]    启动时间: ' + prev.startedAt);
      console.error('[Start]    请先停止现有实例（或删除 data/webui/server.lock 后重试）。');
      process.exit(1);
    }
    console.warn('[Start] 清理陈旧锁 (PID ' + prev.pid + ', host ' + prev.host + ')');
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }
}

// V20: 写库脚本守卫 — 若端口 3000 已被旧实例占用，跳过所有写库脚本（并发写 fusion_memory.db 会 SQLITE_CORRUPT）
const PORT = process.env.PORT || '3000';
let _portBusy = false;
try {
  const out = execSync(`netstat -ano | findstr ":${PORT}.*LISTENING"`, { encoding: 'utf8', timeout: 5000, shell: 'cmd', windowsHide: true }).toString().trim();
  _portBusy = out.length > 0;
} catch { _portBusy = false; }
if (_portBusy) {
  console.warn(`[Start] ⚠️ 端口 ${PORT} 已被占用，跳过 ${prestartScripts.length} 个写库脚本（防 DB 损坏）。`);
}

for (const s of prestartScripts) {
  if (_portBusy) { prestartResults.push({ label: s.label, ok: false, reason: '端口占用，跳过写库' }); continue; }
  try {
    execSync(s.cmd, { cwd: __dirname, stdio: 'pipe', timeout: 30000, windowsHide: true });
    prestartResults.push({ label: s.label, ok: true });
  } catch (e) {
    prestartResults.push({ label: s.label, ok: false, reason: (e.stderr || e.message || '').toString().split('\n')[0] });
  }
}

// 汇总非阻断结果
const failed = prestartResults.filter(r => !r.ok);
if (failed.length > 0) {
  console.warn('[Start] ' + failed.length + ' 个启动前脚本跳过（不影响启动）:');
  for (const f of failed) console.warn('  - ' + f.label + ': ' + (f.reason || 'unknown'));
}

// 启动 server.ts
console.log('[Start] 启动 server.ts (端口 ' + (process.env.PORT || '3000') + ')...');
const memLimit = process.env.TIANQUAN_LITE === 'true'
  ? '--max-old-space-size=10240'
  : '--max-old-space-size=12288';
// 🔴 闪屏修复：去 shell:true + windowsHide:true。
// shell:true 在 Windows 强制走 cmd.exe /c 弹黑窗；process.execPath 是当前 node 绝对路径，
// windowsHide:true 用 CREATE_NO_WINDOW 创建无控制台子进程 → server 无窗口启动。
const child = spawn(process.execPath, [TSC_CLI, 'src/webui/server.ts'], {
  cwd: __dirname,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: memLimit },
});

// 锁由 server 进程自己持有（server.ts main() → ServerLock.acquire()），
// 监督进程不代写、不代删（避免与 server 的双实现漂移）。

child.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n[Start] ❌ 端口 ' + (process.env.PORT || '3000') + ' 已被占用。');
    console.error('[Start]    可能已有实例在运行 → http://localhost:' + (process.env.PORT || '3000') + '/api/health');
    console.error('[Start]    如需重启: npm run port:3000  # 先检查端口');
  } else {
    console.error('[Start] 启动失败:', err.message);
  }
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
