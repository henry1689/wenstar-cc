/**
 * ⛔ 已报废（2026-10-31）
 * 一次性历史工具（停用 chat.ts 的 proactivePatterns 提取），目的早已达成。
 * 保留而非删除，是为了封死风险：它【无治理门控】地改写 chat.ts（HIGH_RISK），
 * 且原路径指向旧根 D:/wenstar。若把路径"修正"到当前根，等于凭空开放
 * "一键破坏生产源码"的能力。
 * 如需相关变更：走 harness 流水线（harness_run_flow），不要在脚本里直改源码。
 */
console.error('⛔ 本脚本已报废（一次性历史工具，目的已达成）。如需变更 chat.ts 请走 harness 流水线。');
process.exit(1);
/* eslint-disable */
const fs = require('fs');
let c = fs.readFileSync('D:/wenstar/src/webui/chat.ts', 'utf8');

const start = c.indexOf('const proactivePatterns: Array<{ match: RegExp; prefix: string }> = [');
if (start < 0) { console.log('FAIL'); process.exit(1); }

// Find the end of this block: look for 2 blank lines after "已悄悄记住"
const marker = '💡 我已悄悄记住啦～';
const mIdx = c.indexOf(marker, start);
if (mIdx < 0) { console.log('MARKER NOT FOUND'); process.exit(1); }
// Find the closing of the if block: 4 closing brackets/parens
const afterM = c.indexOf('}\n\n      // ── 角色扮演检测', mIdx);
if (afterM < 0) { console.log('END NOT FOUND'); process.exit(1); }
const end = afterM + '}\n\n'.length;

const block = c.substring(start, end);
const replacement = '      // [停用] 自动提取聊天信息到知识库（知识库应只用于文件/资料）\n      // 原 proactivePatterns 5 个匹配模式已禁用\n      // 用户信息由 FamilyGraph.integrateFromEntity() 自动管理\n      // 如需手动添加知识，请使用 📚 知识库按钮上传文件\n';

c = c.replace(block, replacement);
fs.writeFileSync('D:/wenstar/src/webui/chat.ts', c, 'utf8');
console.log('DONE');
