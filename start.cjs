#!/usr/bin/env node
/**
 * 太虚境·WebUI 启动器
 * 在 tsx 启动前加载 .env 到 process.env，确保所有 import 的模块能读到环境变量
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, execFileSync } = require('child_process');

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
const PORT = process.env.PORT || '3000';

/** 读取端口 PORT 的 LISTENING 持有者 PID；未监听 / 读取失败返回 null。 */
function portHolderPid() {
  try {
    const out = execSync(`netstat -ano | findstr ":${PORT}.*LISTENING"`, {
      encoding: 'utf8', timeout: 5000, shell: 'cmd', windowsHide: true,
    }).toString().trim();
    if (!out) return null;
    // 🔴 必须按字面量锚定端口号，且要求其后紧跟空白。
    //   findstr 的 `.` 是通配符，`:3000.*LISTENING` 会捞到 `:30001`；
    //   若此处用 /:(\d+)/ 贪婪捕获，会把 30001 当成端口 3000 的持有者 →
    //   误判「锁主已换人」→ 清锁 → 启动第二实例 → 双写覆盖（正是本函数要防的事）。
    const esc = String(PORT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = out.match(new RegExp(':' + esc + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i'));
    return m ? Number(m[1]) : null;   // IPv4/IPv6 两行持有者相同，取第一条即可
  } catch { return null; }
}

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
      let pidAlive = false;
      try { process.kill(prev.pid, 0); pidAlive = true; }
      catch (e) { pidAlive = !!(e && e.code === 'EPERM'); } // Windows: 无权限 = 进程存在

      // 🔴 2026-10-28 三因子判活：仅凭 process.kill(pid, 0) 会因 **Windows PID 复用**
      //   把无关进程当成持锁者，导致锁永远判为「活着」→ 启动方反复 exit(1)。
      //   实测：PID 64816 的锁自 2026-10-15T07:54 未释放，期间撞锁失败 **31.9 万次**
      //   （err.log 里「服务已在运行」318,649 条），每一条都是一次 exit(1) → pm2 重启。
      //   端口持有者是决定性证据：server 若真活着，3000 必然由它自己监听。
      const holder = portHolderPid();
      if (holder === prev.pid) {
        alive = true;                              // 确证存活：端口正是锁主持有
      } else if (holder !== null && holder !== prev.pid) {
        alive = false;                             // 确证已死：锁主已换人，锁必然过期
      } else {
        // 端口未监听：可能是「已写锁、未 bind」的启动窗口，也可能服务已死。
        // 兜底 = PID 存活 **且** 锁新鲜。写锁与 bind 实测相隔约 19s，给足 5 分钟。
        //   反过来说，一个正常 server 不可能「活着却 13 天不监听端口」。
        const startedAt = Date.parse(prev.startedAt || '');
        const fresh = Number.isFinite(startedAt) && (Date.now() - startedAt) < 5 * 60 * 1000;
        alive = pidAlive && fresh;
      }
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
let _portBusy = false;
try {
  const out = execSync(`netstat -ano | findstr ":${PORT}.*LISTENING"`, { encoding: 'utf8', timeout: 5000, shell: 'cmd', windowsHide: true }).toString().trim();
  _portBusy = out.length > 0;
} catch { _portBusy = false; }
// 🔴 R013-A2(5) 根因修复：端口被占用时**拒绝启动**，不再继续 spawn。
//   原实现只打一条 WARN 就继续 spawn：新 server 绑不上端口，但依然会 initPipeline
//   并定时整库 export() → 两个进程各持一份内存库，后落盘者覆盖前者
//   （实测：摘要组反复回 NULL、v21 结果被回退）。这是 I005 的真根因。
if (_portBusy) {
  console.error(`[Start] ❌ 端口 ${PORT} 已被占用：拒绝启动第二实例（防双写覆盖）。`);
  console.error(`[Start]    现有实例 → http://localhost:${PORT}/api/health`);
  console.error('[Start]    如需重启：pm2 stop wenstar-webui，确认端口释放后再 start。');
  process.exit(1);
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

// ── I005 / R013-A2(5): 启动前清理孤儿 server 进程 ──
// 背景（2026-10-19 实测）：pm2 restart 后可能残留旧的 tsx/server 进程链。旧进程持有
// 旧内存库副本并定时 export() 落盘，会**整库覆盖**新实例的写入 —— 现象是「日志显示成功、
// 库里仍是 NULL」（摘要组反复回 NULL 的真实原因）。sql.js 是整库导出覆盖磁盘，后落盘者胜。
// 端口占用的情况已在上面直接拒绝启动；这里只处理「端口已释放但进程还在」的孤儿。
// 只匹配 `src/webui/server.ts`（真正写库的进程），不碰 start/tsx 自身。
if (process.platform === 'win32') {
  const _listServers = () => {
    const _ps = "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*webui*server.ts*' } | " +
      'ForEach-Object { $_.ProcessId }';
    const out = execFileSync('powershell', ['-NoProfile', '-Command', _ps], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    }).toString();
    return out.split(/\s+/).map((s) => Number(s))
      .filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
  };

  try {
    let pids = _listServers();

    // 🔴 若锁仍被某个存活 server 持有，说明它正在优雅关停（shutdownFlush 可能较慢）。
    //   先等它自己退出（最长 45s），**不要打断落盘**；超时才强杀。
    let lockPid = null;
    try { lockPid = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')).pid; } catch { /* 无锁 */ }
    if (lockPid && pids.includes(lockPid)) {
      console.log('[Start] 旧实例持锁优雅关停中，等待退出 (PID ' + lockPid + ')...');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        let alive = false;
        try { process.kill(lockPid, 0); alive = true; }
        catch (e) { alive = !!(e && e.code === 'EPERM'); }
        if (!alive) break;
        try { execSync('ping -n 2 127.0.0.1 >nul', { timeout: 3000, windowsHide: true, shell: 'cmd' }); } catch { /* 忽略 */ }
      }
      pids = _listServers();
    }

    for (const pid of pids) {
      try {
        process.kill(pid);
        console.warn('[Start] 已清理孤儿 server 进程: PID ' + pid + '（I005 单实例保护）');
      } catch (e) {
        console.warn('[Start] 清理孤儿进程失败 PID ' + pid + ': ' + (e && e.message));
      }
    }
  } catch (e) {
    // 检查失败不影响启动；ServerLock 仍是最终防线
    console.warn('[Start] 孤儿进程检查跳过:', String((e && e.message) || e).split('\n')[0]);
  }
}

// 启动 server.ts
// 🔴 2026-10-27：加时间戳。原行无时间信息，导致「1462 次启动」无法还原发生时刻、
//   无法判断是持续循环还是历史累计（实测日志跨度 38 天、日均 38.5 次）。有了时间戳即可
//   直接统计重启频率的逐日曲线，不用靠日志行号间接估算。
console.log('[Start] 启动 server.ts (端口 ' + (process.env.PORT || '3000') + ')... @ ' + new Date().toISOString());
// 🔴 2026-09-20 宿主机内存紧张下的结构性缓解：把默认 V8 堆上限从 12288 降到 4096。
//   依据：宿主可用内存仅 ~0.9GB（VS Code / WSL / Docker / llama 常驻，用户工作必须），
//   12GB 的上限使 V8 **惰性 GC**（推高 RSS 与换页）；而 `db.export()` 的缓冲是 ArrayBuffer
//   （**不计入 JS 堆**），4GB 对正常操作足够。
//   收益：① 更早 GC → 更低的 RSS；② 若真撞上限，V8 抛**可捕获的 JS OOM**（可见 + PM2 记日志重启），
//   而不是被系统静默 OOM-kill（本仓曾多次出现“零日志死亡”，排查代价极高）。
//   可用 `TIANQUAN_MAX_OLD_SPACE_MB` 覆盖（临时需要大堆：如 =8192）。
const _heapMb = Number(process.env.TIANQUAN_MAX_OLD_SPACE_MB)
  || (process.env.TIANQUAN_LITE === 'true' ? 3072 : 4096);
const memLimit = '--max-old-space-size=' + _heapMb;
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

child.on('exit', (code, signal) => {
  // 🔴 2026-10-27：记录退出原因。
  //   原实现直接 `process.exit(code || 0)` —— 而进程被 kill 时 code 为 null、
  //   只有 signal 有值，于是 `null || 0` → exit(0) → pm2 记为**正常退出**、
  //   不留下任何异常痕迹。实测后果：38 天 1462 次重启，而 err.log 里
  //   uncaughtException / EADDRINUSE / OOM / shutdown 全是 0，排查完全无从下手。
  //   signal 是「被谁杀的」的直接证据，不记录就永远查不到。
  //   ⚠️ 退出码逻辑**保持原样**（exit(code || 0)），只补日志 —— 不改变 pm2 的重启与退避行为。
  console.error('[Start] ⚠️ server.ts 已退出: code=' + code + ' signal=' + signal +
    ' @ ' + new Date().toISOString() + '（pm2 将自动重拉）');
  process.exit(code || 0);
});
