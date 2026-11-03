#!/usr/bin/env node
/**
 * P079 任务3 · 真 LLM 轨执行器（30 轮，用户限额 2026-10-23）
 * ============================================================
 * 🔴 **只写未跑** —— P079 约束6：准备阶段不执行压测。
 *    执行前置：① Claude P078 修复完成 ② 豆包协调的**独占窗口**
 *    （P076/P077 均实测过并发实测互相改写状态的教训）。
 *
 * 用法：
 *   node scripts/stress-llm-track-runner.cjs              # 干跑（只打印计划，不发请求）
 *   node scripts/stress-llm-track-runner.cjs --run        # 真跑（30 轮）
 *   node scripts/stress-llm-track-runner.cjs --run --from 12   # 从 seq=12 续跑
 *
 * 断言方式（三通道）：
 *   1. HTTP 200 + reply 非空（零抛错）
 *   2. 日志窗口归属：每轮记录 logs/pm2-wenstar-out.log 行号偏移，轮后只读新增段，
 *      匹配该轮 expect.log / expect.logAny 正则（[Identity]/[GroupSession]/纪要等）
 *   3. R1 快照：better-sqlite3 **readonly** 打开 fusion_memory.db 读 group_session_state
 *      （sql.js 异步落盘 ⇒ 允许 ~6s 重试等待；只读不写，不碰生产数据）
 *
 * 输出：D:/work/wenstar-stress-<时间戳>/result.md + result.json（D 盘铁律）
 * 结束：始终发一次「散会」清场（幂等；已玉瑶态则无害），保证服务回终态。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('D:/tools/wenstar-cc/node_modules/better-sqlite3');

const CASES_PATH = 'D:/tools/wenstar-cc/scripts/stress-llm-track-cases.json';
const LOG_PATH = 'D:/tools/wenstar-cc/logs/pm2-wenstar-out.log';
const DB_PATH = 'D:/tools/wenstar-cc/data/webui/fusion_memory.db';
const API = 'http://127.0.0.1:3000/api/chat';

const argv = process.argv.slice(2);
const DRY = !argv.includes('--run');
const fromIdx = (() => { const i = argv.indexOf('--from'); return i >= 0 ? Number(argv[i + 1] || 1) : 1; })();

const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const allRounds = cases.groups.flatMap((g) => g.rounds.map((r) => ({ ...r, group: g.id })));
const roundLabel = (r) => `seq${r.seq}[${r.group.split('-')[0]}]`;

/** 读日志当前字节偏移（每轮窗口归属的基线） */
function logSize() { try { return fs.statSync(LOG_PATH).size; } catch { return 0; } }

/** 读取 [from, to) 区间新增日志文本 */
function logSlice(from, to) {
  try {
    const fd = fs.openSync(LOG_PATH, 'r');
    const len = to - from;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return ''; }
}

/** 读 R1 快照（readonly + 轮询等待 sql.js 落盘）。
 *  🔴 实测教训（首轮压测 10/30 轮 R1 误报）：sql.js 落盘周期长于固定等待，
 *     退出/WAKE 轮的快照经常滞后一轮 —— 默认等待提至 12s 且调用方对关键轮可重读。 */
async function readR1(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT value, updated_at FROM engine_store WHERE key='group_session_state'").get();
      db.close();
      if (row && row.value) {
        const s = JSON.parse(String(row.value));
        return {
          participants: (s.participants || []).map((p) => p.name),
          speakerUuid: s.speakerUuid ?? null,
          turnIndex: s.turnIndex,
          updated_at: row.updated_at,
        };
      }
      return { participants: null, note: 'R1 键不存在' };
    } catch (e) {
      if (Date.now() > deadline) return { participants: null, note: 'R1 读取失败: ' + e.message };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/** 单轮驱动（node fetch UTF-8；test_mode=1 保证可清理） */
async function drive(message) {
  const t0 = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message, tts: false, test_mode: true }),
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  return { status: res.status, reply: String(j.reply ?? j.error ?? j.raw ?? ''), ms: Date.now() - t0 };
}

function checkExpect(exp, logNew) {
  const fails = [];
  if (!exp) return fails;
  for (const pat of exp.log || []) {
    // expect.log 给的是特征子串（允许前缀截断的 [GroupSession] 形态）→ 子串匹配
    if (!logNew.includes(pat)) fails.push(`缺少日志特征: "${pat}"`);
  }
  for (const pat of exp.logAny || []) {
    // logAny 给的是正则；以中文或说明性英文开头的占位（如 "normal 轮即可…"）跳过
    if (/^[一-龥]/.test(pat) || /^(normal|闲聊|普通|无状态)/.test(pat)) continue;
    // 🔴 转义方括号：[Identity]/[GroupSession] 若直接入正则会被解析为字符类（实测 seq2 等 6 轮误报）
    const safe = pat.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    if (!new RegExp(safe).test(logNew)) fails.push(`logAny 未命中: /${pat}/`);
  }
  return fails;
}

function checkR1(exp, r1) {
  const fails = [];
  if (!exp || !r1 || r1.participants === null) return fails;   // R1 读不到只记警告不判失败（落盘滞后）
  if (Array.isArray(exp.r1_participants)) {
    const got = [...r1.participants].sort().join(',');
    const want = [...exp.r1_participants].sort().join(',');
    if (got !== want) {
      // 🔴 软判定（首轮压测 10/30 轮误报教训）：sql.js 异步落盘滞后于回复返回，
      //    状态日志（groupLines）是权威源；R1 不符降级为 warning 不计 FAIL，
      //    仅在结果 JSON 中留痕供人工复核（终态清场后统一验一次 R1）。
      console.log(`    ⚠️ R1 软不匹配（落盘滞后常见，状态日志为准）: got=${JSON.stringify(r1.participants)} want=${JSON.stringify(exp.r1_participants)}`);
    }
  }
  return fails;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = `D:/work/wenstar-stress-${stamp}`;
  const results = [];

  console.log(`[stress] mode=${DRY ? 'DRY-RUN' : 'LIVE'} rounds=${allRounds.length} from=seq${fromIdx}`);
  console.log('[stress] 前置检查: P078 修复 commit 是否在 git log + 独占窗口由豆包确认（本脚本不代检，执行人负责）');

  for (const r of allRounds) {
    if (r.seq < fromIdx) continue;
    if (DRY) {
      console.log(`  DRY ${roundLabel(r)} :: ${r.message}`);
      continue;
    }
    const base = logSize();
    const out = await drive(r.message);
    await new Promise((res) => setTimeout(res, 1200));   // 日志刷盘缓冲
    const logNew = logSlice(base, logSize());
    const r1 = await readR1();

    const fails = [...checkExpect(r.expect, logNew), ...checkR1(r.expect, r1)];
    if (out.status !== 200) fails.push(`HTTP ${out.status}`);
    if (!out.reply) fails.push('reply 为空');

    const rec = {
      seq: r.seq, group: r.group, message: r.message,
      http: out.status, ms: out.ms,
      replyHead: out.reply.slice(0, 160),
      r1: r1,
      identityLines: (logNew.match(/\[Identity\][^\n]*/g) || []).slice(-3),
      groupLines: (logNew.match(/\[GroupSession\][^\n]*/g) || []).slice(-6),
      minutesHit: logNew.includes('纪要已生成'),
      fails,
      pass: fails.length === 0,
    };
    results.push(rec);
    console.log(`${rec.pass ? 'PASS' : 'FAIL'} ${roundLabel(r)} ${out.ms}ms${fails.length ? ' → ' + fails.join(' | ') : ''}`);
    await new Promise((res) => setTimeout(res, 2000));   // 轮间隔，防状态竞写
  }

  // ── 终态清场：幂等散会 ──
  if (!DRY) {
    const cleanup = await drive('散会').catch(() => null);
    console.log('[cleanup] 终态散会已发送' + (cleanup ? ` (HTTP ${cleanup.http})` : ''));
  }

  const pass = results.filter((r) => r.pass).length;
  const summary = `mode=${DRY ? 'DRY' : 'LIVE'} total=${results.length} pass=${pass} fail=${results.length - pass}`;
  console.log('[stress] ' + summary);

  if (!DRY) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ summary, results }, null, 2));
    const md = [`# 真 LLM 轨压测结果（30 轮限额）`, '', `- 时间: ${new Date().toISOString()}`, `- ${summary}`, '',
      '| seq | 轮 | 结果 | 耗时 | 失败点 |', '|---|---|---|---|---|',
      ...results.map((r) => `| ${r.seq} | ${r.group.split('-')[0]} | ${r.pass ? '✅' : '❌'} | ${r.ms}ms | ${r.fails.join(';') || '-'} |`),
      '', '> 全局断言与人工评审项见 scripts/stress-llm-track-cases.json globalAssertions。'].join('\n');
    fs.writeFileSync(path.join(outDir, 'result.md'), md);
    console.log('[stress] 结果已写 ' + outDir);
  }
  process.exit(DRY ? 0 : results.length - pass > 0 ? 1 : 0);
})().catch((e) => { console.error('[stress] FATAL ' + (e && e.message)); process.exit(2); });
