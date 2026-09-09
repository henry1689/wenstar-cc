#!/usr/bin/env node
/**
 * 太虚境·WebUI 启动器
 * 在 tsx 启动前加载 .env 到 process.env，确保所有 import 的模块能读到环境变量
 */
const fs = require('fs');
const path = require('path');
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
