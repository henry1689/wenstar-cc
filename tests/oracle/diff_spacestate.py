#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
diff_spacestate.py — TS 实现 vs oracle 的差分对拍（补包 B 第 9 项，**入库**）

🔴 归属 **R2**（见 oracle-change-policy.md）：
   容差判定、采样逻辑、通过/失败判定条件的改动需 oracle 方补丁或业主签字。
   打印格式与报告字段增删属 R1。

用法
----
    python tests/oracle/diff_spacestate.py              # 完整档（10 万组，放行依据）
    python tests/oracle/diff_spacestate.py --quick      # 快速档（1 万组，PR/CI 拦回归）
    python tests/oracle/diff_spacestate.py --self-check # 自检：注入 1e-6 偏差，预期报红

两档均使用**固定种子 20261104**，结果可复现。

样本构成（可审计）
------------------
- 30% wild 集合：{NaN, +∞, -∞, -1, 0, 1e-9, 1e9}
- 70% 均匀分布
- `bipolar` 每组显式传入（不靠默认值）

容差判定（E-27 混合容差，**待裁决**）
----------------------------------
    |Δ| ≤ 1e-9  或  |Δ| / max(|期望值|, 1e-6) ≤ 1e-9   （满足其一即通过）
聚合量仍只用绝对容差。E-27 裁决前，本脚本的结论不作为正式口径。

覆盖范围（报告必填）
--------------------
差分只覆盖 ℓ、量化、编码、清洗、相位、精度戳记；
**不覆盖层参数、Kalman、聚合**。层参数由
`layer-constants-ts.json` ↔ oracle 的逐项对拍 + 变异测试保护。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import time

# Windows 控制台默认 GBK，打印 ℓ（U+2113）等字符会 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ORACLE_PATH = os.path.join(HERE, "oracle_spacestate.py")
TS_CONFIG = os.path.join(REPO, "src", "spacestate", "core", "config.ts")

SEED = 20261104
QUICK_SAMPLES = 10_000
FULL_SAMPLES = 100_000

# E-27 混合容差（待裁决）：绝对 || 相对，满足其一即通过
ABS_TOL = 1e-9
REL_TOL = 1e-9
REL_FLOOR = 1e-6

# 采样构成（可审计）
WILD_RATIO = 0.30
WILD_VALUES = [float("nan"), float("inf"), float("-inf"), -1.0, 0.0, 1e-9, 1e9]

COVERAGE_SCOPE = (
    "差分只覆盖 ℓ、量化、编码、清洗、相位、精度戳记；"
    "不覆盖层参数、Kalman、聚合"
)

sys.path.insert(0, HERE)
import oracle_spacestate as o  # noqa: E402


# ══════════════════════════════════════════════════════════════
# 哈希留痕（补包 B 第 7 项）
# ══════════════════════════════════════════════════════════════
def sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_head() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", REPO, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=30, encoding="utf-8",
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def report_path(mode: str) -> str:
    return os.path.join(HERE, f"diff-report-{mode}.json")


# 上次放行基线（补包 B2 第 6 项）。首次运行建立，此后每次比对。
LAST_APPROVED_PATH = os.path.join(HERE, "reports", "last-approved.json")


def last_approved():
    """返回上次放行记录里的 oracle 哈希；没有则 None（= 尚未建立基线）"""
    if not os.path.exists(LAST_APPROVED_PATH):
        return None
    try:
        with open(LAST_APPROVED_PATH, encoding="utf-8") as f:
            return json.load(f).get("oracle_sha256")
    except Exception:
        return None


def write_last_approved(sha: str, mode: str, ts_commit: str) -> None:
    os.makedirs(os.path.dirname(LAST_APPROVED_PATH), exist_ok=True)
    payload = {
        "oracle_sha256": sha,
        "ts_commit": ts_commit,
        "mode": mode,
        "approved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "首次运行建立的基线；此后每次差分须与此哈希比对",
    }
    with open(LAST_APPROVED_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def previous_report_hash(mode: str):
    """同档位上一份报告里的 oracle 哈希（仅用于打印，不参与判定）"""
    path = report_path(mode)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("oracle_sha256")
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════
# 采样（R2：采样逻辑）
# ══════════════════════════════════════════════════════════════
def enc(x):
    """JSON 无法承载 NaN/±Inf，按字符串编码"""
    if isinstance(x, float):
        if math.isnan(x):
            return "nan"
        if x == math.inf:
            return "inf"
        if x == -math.inf:
            return "-inf"
    return x


def dec(v):
    if v == "nan":
        return float("nan")
    if v == "inf":
        return float("inf")
    if v == "-inf":
        return float("-inf")
    return float(v)


class Stats:
    """分支命中统计：证明采样覆盖了早退与截断分支，而非全落在常规路径"""

    def __init__(self):
        self.total = 0
        # wild 占比按「抽到的值」计数：每个 case 会抽 q/piQ/x/piX 多个值，
        # 用 case 数做分母会算出 >1 的比例
        self.values_sampled = 0
        self.wild = 0
        self.flags = {"nan": 0, "pos_inf": 0, "negative": 0,
                      "bad_value": 0, "range_clamped": 0, "none": 0}
        self.branches = {
            "dim_evidence.piQ_le_0": 0,        # S-012 查询未知 → 0
            "dim_evidence.sigmaQ2_ge_tau2": 0,  # S-012 查询不可靠 → 0
            "dim_evidence.piX_le_0": 0,         # S-060 印记未知 → 0
            "dim_evidence.clip_hit": 0,         # S-013 截断到 ±3
            "dim_evidence.finite_ok": 0,        # 常规路径
            "phase.non_finite": 0,
            "phase.normal": 0,
            "sanitize.clamped": 0,
            "encode.pi_zero": 0,
        }

    def to_dict(self):
        return {
            "total": self.total,
            "values_sampled": self.values_sampled,
            "wild_values": self.wild,
            "wild_ratio": round(self.wild / max(self.values_sampled, 1), 4),
            "flags": dict(self.flags),
            "branches": dict(self.branches),
        }


def sample_value(rng, stats):
    stats.values_sampled += 1
    if rng.random() < WILD_RATIO:
        stats.wild += 1
        return rng.choice(WILD_VALUES)
    return rng.uniform(-1.5, 1.5)


def sample_pi(rng, stats):
    stats.values_sampled += 1
    if rng.random() < WILD_RATIO:
        stats.wild += 1
        return rng.choice(WILD_VALUES)
    r = rng.random()
    if r < 0.12:
        return 0.0
    if r < 0.24:
        return rng.uniform(-5, 0)
    if r < 0.7:
        return rng.uniform(0, 400)
    return rng.uniform(400, 5000)


def build_cases(n: int, stats: Stats):
    rng = random.Random(SEED)
    cases = {"dim_evidence": [], "sanitize": [], "coding": [], "phase": [], "stamp": []}

    for _ in range(n):
        stats.total += 1
        bipolar = rng.random() < 0.5
        q, pi_q = sample_value(rng, stats), sample_pi(rng, stats)
        x, pi_x = sample_value(rng, stats), sample_pi(rng, stats)
        mu = rng.uniform(-2, 2)
        tau = rng.choice([rng.uniform(0, 0.5), rng.uniform(0.1, 3), 0.0])

        # 输入侧分支统计（oracle 与 TS 收到同一批输入，分支分布一致）
        if not (math.isfinite(mu) and math.isfinite(tau)):
            pass
        if not (isinstance(pi_q, float) and math.isfinite(pi_q) and pi_q > 0):
            stats.branches["dim_evidence.piQ_le_0"] += 1
        else:
            tau_eff = max(tau, o.TAU_MIN)
            if (1.0 / pi_q) >= tau_eff * tau_eff:
                stats.branches["dim_evidence.sigmaQ2_ge_tau2"] += 1
            elif not (isinstance(pi_x, float) and math.isfinite(pi_x) and pi_x > 0):
                stats.branches["dim_evidence.piX_le_0"] += 1
            else:
                try:
                    raw = o.dim_evidence(q, pi_q, x, pi_x, mu, tau, bipolar)
                except Exception:
                    raw = None
                if raw is not None and abs(raw) >= o.CLIP - 1e-12 and math.isfinite(raw):
                    stats.branches["dim_evidence.clip_hit"] += 1
                else:
                    stats.branches["dim_evidence.finite_ok"] += 1

        try:
            exp = o.dim_evidence(q, pi_q, x, pi_x, mu, tau, bipolar)
        except Exception:
            exp = None
        cases["dim_evidence"].append({
            "q": enc(q), "piQ": enc(pi_q), "x": enc(x), "piX": enc(pi_x),
            "mu": mu, "tau": tau, "bipolar": bipolar, "exp": enc(exp),
        })

        ev, ep, ef = o.sanitize_reading(q, pi_q, bipolar)
        stats.flags[ef if ef in stats.flags else "none"] += 1
        if ef == "range_clamped":
            stats.branches["sanitize.clamped"] += 1
        cases["sanitize"].append({
            "v": enc(q), "pi": enc(pi_q), "bipolar": bipolar,
            "ev": enc(ev), "ep": enc(ep), "ef": ef,
        })

        k = o.encode_pi(pi_q)
        if k == 0:
            stats.branches["encode.pi_zero"] += 1
        iq = o.quant_int8(q)
        cases["coding"].append({
            "pi": enc(pi_q), "k": k, "dec": enc(o.decode_pi(k)),
            "q": enc(q), "iq": iq, "dq": enc(o.dequant_int8(iq)),
        })

        m = rng.choice([rng.uniform(0, 1440), rng.uniform(-500, 2000)])
        if rng.random() < 0.08:
            m = rng.choice([float("nan"), float("inf"), float("-inf")])
        s, c, p = o.phase(m)
        if not math.isfinite(m):
            stats.branches["phase.non_finite"] += 1
        else:
            stats.branches["phase.normal"] += 1
        cases["phase"].append({"m": enc(m), "s": enc(s), "c": enc(c), "p": enc(p)})

    for _ in range(max(1, n // 100)):
        prec = [sample_pi(rng, stats) for _ in range(o.LAYOUT_SIZE)]
        cases["stamp"].append({
            "prec": [enc(v) for v in prec],
            "out": [enc(v) for v in o.stamp_storage_precision(prec)],
        })

    return cases


# ══════════════════════════════════════════════════════════════
# TS 侧跑批（runner 源码内嵌，保证单文件可审计）
# ══════════════════════════════════════════════════════════════
TS_RUNNER = r'''
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// core 目录由调用方传入（argv[4]），避免脚本被写死到某个绝对路径
const CORE = pathToFileURL(process.argv[4]).href;
// 自检注入点：SPACESTATE_DIFF_OFFSET 非空时给 ℓ 加固定偏差，用于验证脚本报红
const OFFSET = Number(process.env.SPACESTATE_DIFF_OFFSET || '0');

async function main(): Promise<void> {
  const { dimEvidence } = await import(`${CORE}evidence.js`);
  const { sanitizeValue } = await import(`${CORE}types.js`);
  const { decodePi, dequantizeInt8, encodePi, quantizeInt8 } = await import(`${CORE}coding.js`);
  const { phaseFromLocalMinutes } = await import(`${CORE}dial.js`);
  const { stampStoragePrecision } = await import(`${CORE}layout.js`);

  const num = (v: unknown): number =>
    v === 'nan' ? NaN : v === 'inf' ? Infinity : v === '-inf' ? -Infinity : Number(v);

  const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const out: Record<string, unknown[]> = { dim_evidence: [], sanitize: [], coding: [], phase: [], stamp: [] };

  for (const c of cases.dim_evidence) {
    const ell = dimEvidence(num(c.q), num(c.piQ), num(c.x), num(c.piX), num(c.mu), num(c.tau), c.bipolar);
    out.dim_evidence.push(ell + OFFSET);
  }
  for (const c of cases.sanitize) {
    const r = sanitizeValue(num(c.v), num(c.pi), c.bipolar);
    out.sanitize.push([r.v, r.pi, r.flag]);
  }
  for (const c of cases.coding) {
    out.coding.push([
      encodePi(num(c.pi)), decodePi(num(c.k)),
      quantizeInt8(num(c.q)), dequantizeInt8(num(c.iq)),
    ]);
  }
  for (const c of cases.phase) {
    const ph = phaseFromLocalMinutes(num(c.m));
    out.phase.push([ph.sin, ph.cos, ph.pi]);
  }
  for (const c of cases.stamp) {
    out.stamp.push(stampStoragePrecision(c.prec.map(num)));
  }
  writeFileSync(process.argv[3], JSON.stringify(out), 'utf8');
}
main().catch((e) => { console.error(e); process.exit(1); });
'''


def run_ts(cases_path: str, out_path: str, inject_offset: str) -> None:
    runner_path = os.path.join(tempfile.gettempdir(), "spacestate_diff_runner.mts")
    with open(runner_path, "w", encoding="utf-8") as f:
        f.write(TS_RUNNER)
    env = dict(os.environ)
    env["SPACESTATE_DIFF_OFFSET"] = inject_offset
    # 直接调 node + tsx 的 cli.mjs：Windows 下 `npx` 是 .cmd，subprocess
    # 不经 shell 会 FileNotFoundError
    tsx_cli = os.path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs")
    core_dir = os.path.join(REPO, "src", "spacestate", "core").replace("\\", "/") + "/"
    cmd = ["node", tsx_cli, runner_path, cases_path, out_path, core_dir]
    proc = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True,
                          text=True, timeout=1800, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"TS runner failed:\n{proc.stdout}\n{proc.stderr}")


# ══════════════════════════════════════════════════════════════
# 容差判定（R2 · E-27 混合容差）
# ══════════════════════════════════════════════════════════════
def within(e: float, a: float) -> bool:
    """E-27 混合容差：|Δ| ≤ 1e-9 或 |Δ|/max(|e|, 1e-6) ≤ 1e-9，满足其一即通过。

    为什么需要相对分支：ℓ 在接近 0 处存在灾难性抵消，
    绝对容差会把机器精度级的差异误判为失败（实测见过 exp=1.46e-11 的用例）。
    E-27 裁决前本脚本结论不作为正式口径。
    """
    if not (math.isfinite(e) and math.isfinite(a)):
        return (math.isnan(e) and math.isnan(a)) or e == a
    d = abs(e - a)
    if d <= ABS_TOL:
        return True
    return d / max(abs(e), REL_FLOOR) <= REL_TOL


def compare(cases, results, stats: Stats):
    max_abs = 0.0
    mismatches = 0
    checked = 0
    samples = []

    def cmp(label, e_raw, a_raw):
        nonlocal max_abs, mismatches, checked
        e, a = dec(e_raw) if isinstance(e_raw, str) else float(e_raw), \
               dec(a_raw) if isinstance(a_raw, str) else float(a_raw)
        checked += 1
        if math.isnan(e) and math.isnan(a):
            return
        if e == a:
            return
        d = abs(e - a)
        max_abs = max(max_abs, d)
        if not within(e, a):
            mismatches += 1
            if len(samples) < 5:
                samples.append(f"{label}: exp={e} act={a} abs={d}")

    for c, a in zip(cases["dim_evidence"], results["dim_evidence"]):
        cmp("dim_evidence", c["exp"], a)
    for c, a in zip(cases["sanitize"], results["sanitize"]):
        cmp("sanitize.v", c["ev"], a[0])
        cmp("sanitize.pi", c["ep"], a[1])
        checked += 1
        if (c["ef"] or None) != (a[2] or None):
            mismatches += 1
            if len(samples) < 5:
                samples.append(f"sanitize.flag: exp={c['ef']} act={a[2]}")
    for c, a in zip(cases["coding"], results["coding"]):
        cmp("encodePi", c["k"], a[0])
        cmp("decodePi", c["dec"], a[1])
        cmp("quant", c["iq"], a[2])
        cmp("dequant", c["dq"], a[3])
    for c, a in zip(cases["phase"], results["phase"]):
        cmp("phase.sin", c["s"], a[0])
        cmp("phase.cos", c["c"], a[1])
        cmp("phase.pi", c["p"], a[2])
    for c, a in zip(cases["stamp"], results["stamp"]):
        for i, (e, act) in enumerate(zip(c["out"], a)):
            cmp(f"stamp[{i}]", e, act)

    return {"checked": checked, "max_abs_diff": max_abs,
            "mismatches": mismatches, "mismatch_samples": samples}


# ══════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="快速档（1 万组，PR/CI）")
    ap.add_argument("--full", action="store_true",
                    help="完整档（10 万组，切片验收 / oracle 哈希变化时）—— 默认值，显式写法")
    ap.add_argument("--self-check", "--self-test", dest="self_check", action="store_true",
                    help="自检：注入 1e-6 偏差，预期报红（不改源文件）")
    args = ap.parse_args()

    mode = "selfcheck" if args.self_check else ("quick" if args.quick else "full")
    n = QUICK_SAMPLES if args.quick else FULL_SAMPLES
    inject = "1e-6" if args.self_check else "0"

    print(f"=== diff_spacestate · mode={mode} · samples={n} · seed={SEED} ===")
    print(f"oracle: {ORACLE_PATH}")

    # 运行前哈希（补包 B 第 7 项）
    h_before = sha256_file(ORACLE_PATH)
    print(f"oracle sha256 (before): {h_before}")

    prev_report = previous_report_hash(mode)
    if prev_report:
        print(f"oracle sha256 (last report): {prev_report}")
    approved_sha = last_approved()
    if approved_sha:
        print(f"oracle sha256 (last approved): {approved_sha}")
    else:
        print("oracle sha256 (last approved): 无（基线尚未建立）")
    ts_head = git_head()
    print(f"ts commit: {ts_head}")

    stats = Stats()
    t0 = time.time()
    cases = build_cases(n, stats)
    gen_s = time.time() - t0

    tmpdir = tempfile.gettempdir()
    cases_path = os.path.join(tmpdir, f"ss_cases_{mode}.json")
    results_path = os.path.join(tmpdir, f"ss_results_{mode}.json")
    with open(cases_path, "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False)

    t1 = time.time()
    run_ts(cases_path, results_path, inject)
    ts_s = time.time() - t1
    with open(results_path, encoding="utf-8") as f:
        results = json.load(f)

    stats_dict = stats.to_dict()
    diff = compare(cases, results, stats)

    h_after = sha256_file(ORACLE_PATH)
    print(f"oracle sha256 (after):  {h_after}")
    hash_stable = h_before == h_after
    hash_changed_since_last = prev_report is not None and prev_report != h_after

    print("\n--- 分支命中统计 ---")
    print(f"wild 占比: {stats_dict['wild_ratio']}  (目标 ≥ {WILD_RATIO})")
    print(f"flags: {stats_dict['flags']}")
    for k, v in stats_dict["branches"].items():
        print(f"  {k}: {v}")

    print("\n--- 差分结果 ---")
    print(f"checked: {diff['checked']}")
    print(f"max_abs_diff: {diff['max_abs_diff']:.6e}   (容差 {ABS_TOL})")
    print(f"mismatches: {diff['mismatches']}")
    for s in diff["mismatch_samples"]:
        print(f"  · {s}")
    print(f"覆盖范围: {COVERAGE_SCOPE}")

    # 关键分支必须真的被命中，否则「10 万组全落在常规路径」= 采样无效
    required = ["dim_evidence.piQ_le_0", "dim_evidence.sigmaQ2_ge_tau2",
                "dim_evidence.piX_le_0", "dim_evidence.clip_hit",
                "dim_evidence.finite_ok", "phase.non_finite"]
    unhit = [k for k in required if stats_dict["branches"][k] == 0]
    print(f"未命中分支: {unhit if unhit else '无'}")

    # ══════════ 判定（补包 B2 第 6 项：首次运行口径修正） ══════════
    #
    # BASELINE_ESTABLISHED：首次运行，无任何可比基线。
    #   → 可作为基线写入 last-approved.json，但**当次不得作为放行依据**
    #     （没有参照，只能说明「这一版自己和自己一致」）
    # REVIEW_REQUIRED：哈希不一致 / 分支未覆盖 / 自检未报红，**不得作为放行依据**
    # PASS：与上次放行基线一致且全部检查通过 → 唯一可作放行依据的结论
    baseline_note = ""
    if args.self_check:
        # 自检档：注入偏差后**必须**报红；自检不报红 = 脚本失去检出能力
        ok = diff["mismatches"] > 0
        verdict = "SELF-CHECK PASS（注入 1e-6 后如期报红）" if ok \
            else "REVIEW_REQUIRED（注入偏差却仍全绿 → 脚本失去检出能力）"
    elif not hash_stable:
        verdict, ok = "REVIEW_REQUIRED", False
        baseline_note = "运行中 oracle 被改动（before != after），判定作废"
    elif approved_sha is None:
        verdict, ok = "BASELINE_ESTABLISHED", True
        baseline_note = ("首次运行，无可比基线 —— 当次**不得作为放行依据**，"
                         "仅建立基线供后续比对")
        write_last_approved(h_before, mode, ts_head)
    elif approved_sha != h_before:
        verdict, ok = "REVIEW_REQUIRED", False
        baseline_note = "oracle 哈希与上次放行基线不一致（oracle 已变更，需复核）"
    elif unhit:
        verdict, ok = "REVIEW_REQUIRED", False
        baseline_note = f"存在未命中分支：{unhit}（采样未覆盖早退/截断路径）"
    elif diff["mismatches"]:
        verdict, ok = "REVIEW_REQUIRED", False
        baseline_note = "存在超出 E-27 容差的差异"
    else:
        verdict, ok = "PASS", True
        baseline_note = "与上次放行基线一致，全部检查通过"

    if baseline_note:
        print(f"判定说明: {baseline_note}")
    if verdict == "BASELINE_ESTABLISHED":
        print("⚠️ BASELINE_ESTABLISHED ≠ PASS：本次只建立基线，不作为放行依据。")
        print(f"   基线已写入 {LAST_APPROVED_PATH}")

    report = {
        "mode": mode,
        "oracle_sha256": h_after,
        "oracle_sha256_before": h_before,
        "oracle_sha256_last_report": prev_report,
        "last_approved_sha256": approved_sha,
        "baseline_note": baseline_note,
        "ts_commit": ts_head,
        "seed": SEED,
        "samples": n,
        "checked": diff["checked"],
        "max_abs_diff": diff["max_abs_diff"],
        "mismatches": diff["mismatches"],
        "mismatch_samples": diff["mismatch_samples"],
        "branch_stats": stats_dict,
        "unhit_branches": unhit,
        "tolerance": {"abs": ABS_TOL, "rel": REL_TOL, "floor": REL_FLOOR,
                      "rule": "E-27 混合容差（待裁决）"},
        "coverage_scope": COVERAGE_SCOPE,
        "self_check_offset": inject,
        "verdict": verdict,
        "elapsed_s": {"generate": round(gen_s, 2), "ts": round(ts_s, 2)},
    }

    out_path = report_path(mode)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n报告: {out_path}")
    print(f"结论: {verdict}")

    for p in (cases_path, results_path):
        try:
            os.remove(p)
        except OSError:
            pass

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
