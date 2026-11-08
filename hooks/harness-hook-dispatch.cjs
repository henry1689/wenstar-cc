#!/usr/bin/env node
/**
 * harness-hook-dispatch.cjs — 让 Harness 的 pre/post 检查对「任意会话」生效
 * ================================================================
 * 背景（2026-11-08 实测根因）：
 *   Harness 的 PreToolUse / PostToolUse 只配置在 `D:\tools\wenstar-cc\.claude\settings.json`
 *   （**项目级**）。当 Claude Code 会话的工作目录不是该项目（例如从 `C:\Users\henry` 启动）时，
 *   项目级 hooks **根本不会加载** ⇒ 令牌校验/消费、BYPASS 检测全部静默失效。
 *   实证：同一 run 内可对同一源文件连续写入 6 次，令牌 `consumed` 恒为 false；
 *   当日 0 条 BYPASS 告警（因为 post-check 从未运行）。
 *
 * 本脚本挂到**用户级** settings.json，只做一件事：
 *   目标路径属于本项目 → 原样转交 Harness 检查（输出/退出码透传）；
 *   否则 → 直接放行（exit 0），不影响其它项目的正常编辑。
 *
 * 用法：node harness-hook-dispatch.cjs <pre|post>
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

/** 本项目的绝对根（统一小写、正斜杠比较） */
const PROJECT_ROOT = 'd:/tools/wenstar-cc';

/** Harness 检查脚本（与项目级 settings.json 完全同源，不复制判据） */
const SCRIPTS = {
  pre: 'D:/AI文件/harness/.claude/harness-pre-check.cjs',
  post: 'D:/AI文件/harness/.claude/harness-post-check.cjs',
};

function readStdin() {
  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
}

/** 与 Harness 两个 hook 同口径：取 file_path / path（含 tool_input 嵌套） */
function targetPath(raw) {
  try {
    const j = JSON.parse(raw || '{}');
    const ti = j.tool_input || {};
    return String(j.file_path || j.path || ti.file_path || ti.path || '');
  } catch {
    return '';
  }
}

const mode = process.argv[2] === 'post' ? 'post' : 'pre';
const raw = readStdin();
const target = targetPath(raw).replace(/\\/g, '/').toLowerCase();

// 会话已在项目目录内 → 项目级 hooks 会自己跑，这里退出避免**双重执行**
//   （pre-check 跑两次会把 usage_count 顶到 2 → 误判 TOKEN REUSED 而阻断所有编辑）
const cwd = String(process.cwd() || '').replace(/\\/g, '/').toLowerCase();
if (cwd === PROJECT_ROOT || cwd.startsWith(PROJECT_ROOT + '/')) {
  process.exit(0);
}

// 非本项目文件 → 放行（用户级 hook 不得干扰其它项目）
if (!target || !target.startsWith(PROJECT_ROOT + '/')) {
  process.exit(0);
}

// 本项目文件 → 原样转交 Harness（stdin 不变，stdout/stderr/退出码透传）
const result = spawnSync(process.execPath, [SCRIPTS[mode]], {
  input: raw,
  encoding: 'utf-8',
  maxBuffer: 4 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  // 转交失败时 **不静默放行**：按 fail-closed 阻断并说明原因（守卫故障必须暴露）
  process.stderr.write('[Harness] hook 转交失败（fail-closed）: ' + result.error.message + '\n');
  process.exit(2);
}
process.exit(result.status == null ? 0 : result.status);
