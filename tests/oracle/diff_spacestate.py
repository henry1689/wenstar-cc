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
                                                        # （默认走 1 万组，除非显式 --full）

两档均使用**固定种子 20261104**，结果可复现。

样本构成（可审计，B-3 任务 9：**分层精确配额**）
------------------------------------------------
- wild 集合：{NaN, +∞, -∞, -1, 0, 1e-9, 1e9}
- 目标占比 `WILD_RATIO = 0.30`，按**最大余数法**把名额分到各抽样层
  （q / piQ / x / piX / stamp），每层内部先定名额再打乱。
  → `wild 占比` **恒等于**设定值，不随种子漂移；不再是「随机凑到 ≥ 0.3」。
- 剩余名额走常规分布（值层 uniform(-1.5,1.5)；π 层按未知/负/正常/超界四段）。
- `bipolar` 每组显式传入（不靠默认值）

容差判定（E-27 混合容差，**待裁决**）
----------------------------------
    |Δ| ≤ 1e-9  或  |Δ| / max(|期望值|, 1e-6) ≤ 1e-9   （满足其一即通过）
聚合量仍只用绝对容差。E-27 裁决前，本脚本的结论不作为正式口径。

覆盖范围（报告必填）
--------------------
差分只覆盖 ℓ、量化、编码、清洗、相位、精度戳记；
**不覆盖层参数、Kalman、聚合**。层参数由
`src/spacestate/__tests__/config-snapshot.json` ↔ oracle 的逐项对拍
（`oracle_spacestate.py::test_ts_layer_constants_crosscheck`）+ 变异测试保护。
**单一镜像**：TS 侧快照测试与 Python 侧对拍读同一份文件，中间无第三份副本。
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


# 上次放行基线（补包 B2 第 6 项；B-3 任务 4 改**内容寻址**）。
LAST_APPROVED_PATH = os.path.join(HERE, "reports", "last-approved.json")
SCRIPT_PATH = os.path.abspath(__file__)

# R-1：完整档写基线前必须干净的范围（任务书原文口径，未放宽）
DIRTY_SCOPE = ("src/spacestate", "tests/oracle")

# 内容寻址字段（B-3 任务 4）。**缺任一字段即视为「无有效基线」**：
# 老结构只记 `ts_commit`（跑批时刻的 HEAD），而那个 HEAD 未必包含被验证的
# 代码（实测：跑批打 ed4040d、记录写 fb8f889）——时序错位的记录不算基线。
REQUIRED_BASELINE_KEYS = (
    "oracle_hash", "ts_content_hash", "ts_commit", "ts_dirty",
    "script_hash", "mode", "registration_ref",
)


class BaselineWriteRefused(RuntimeError):
    """R-1 / R-2 拒绝写入基线。reason 可直接打印给复核人。"""


def worktree_dirty(paths=DIRTY_SCOPE):
    """R-1 判据：`git status --porcelain -- <paths>` 为空才算干净。

    返回 (是否脏, porcelain 原文)。原文要原样带出去——只说「工作区脏」
    却不说哪几个文件，复核人还得自己再跑一遍。
    git 本身不可用时**不得默认「干净」**（那会让 R-1 形同虚设）。
    """
    try:
        out = subprocess.run(
            ["git", "-C", REPO, "status", "--porcelain", "--", *paths],
            capture_output=True, text=True, timeout=30, encoding="utf-8",
        )
        txt = (out.stdout or "").strip()
    except Exception as e:  # noqa: BLE001
        return True, f"<git status 不可用: {e}>"
    return (len(txt) > 0), txt


def ts_content_hash() -> str:
    """`src/spacestate/**` 逐文件 sha256，按相对路径排序后汇总。

    为什么是内容哈希而不是 commit：记录 HEAD 会出现时序错位（见
    REQUIRED_BASELINE_KEYS 上方说明），内容哈希与被验证的代码一一对应。
    """
    root = os.path.join(REPO, "src", "spacestate")
    acc = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            acc.update(rel.encode("utf-8"))
            acc.update(b"\0")
            with open(full, "rb") as f:
                acc.update(hashlib.sha256(f.read()).digest())
    return acc.hexdigest()


def read_last_approved():
    """读放行记录，返回 (记录 | None, 原因)。

    缺内容寻址字段 → None，原因写明缺哪些。老结构的记录不再被当作可比基线，
    由下一次**完整档 + 干净工作区**重建。
    """
    if not os.path.exists(LAST_APPROVED_PATH):
        return None, "记录不存在"
    try:
        with open(LAST_APPROVED_PATH, encoding="utf-8") as f:
            rec = json.load(f)
    except Exception as e:  # noqa: BLE001
        return None, f"记录不可解析：{e}"
    missing = [k for k in REQUIRED_BASELINE_KEYS if k not in rec or rec[k] in (None, "")]
    if missing:
        return None, f"无有效基线：缺少内容寻址字段 {missing}（B-3 任务 4 之前的旧结构）"
    return rec, ""


def should_write_baseline(mode: str):
    """R-2：快速档 / 自检档**永不写** last-approved.json，只出报告。

    返回 (是否允许写, 原因)。理由：快速档允许 dirty 工作区，若它能写基线，
    一份由脏树产出的记录就会被后续当作放行依据。
    """
    if mode in ("quick", "selfcheck"):
        return False, f"R-2：{mode} 档永不写 last-approved.json（报告标 non-release）"
    return True, ""


def write_last_approved(sha: str, mode: str, ts_commit: str, registration_ref) -> None:
    """写放行记录（内容寻址）。任一治理规则不满足即抛 `BaselineWriteRefused`。

    - R-1 完整档写入前 `git status --porcelain -- src/spacestate tests/oracle` 必须为空
    - R-2 非完整档不允许写（`should_write_baseline` 先拦一道）
    - R-3 `script_hash` 必须入记录：容差与采样是信任根，脚本被改而 oracle 未改时，
      「与上次一致」仍会显示通过
    """
    allowed, why = should_write_baseline(mode)
    if not allowed:
        raise BaselineWriteRefused(why)
    dirty, detail = worktree_dirty()
    if dirty:
        raise BaselineWriteRefused(
            "R-1 拒写：完整档要求工作区干净"
            "（`git status --porcelain -- src/spacestate tests/oracle` 为空），实际改动：\n"
            + detail
        )
    payload = {
        "oracle_hash": sha,
        "ts_content_hash": ts_content_hash(),
        "ts_commit": ts_commit,
        # R-1 已保证「能写入即干净」，此处是断言后的事实而非假设
        "ts_dirty": False,
        "script_hash": sha256_file(SCRIPT_PATH),
        "mode": mode,
        "registration_ref": registration_ref,
        "approved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "内容寻址基线（B-3 任务 4）：更新本文件的 commit message 必须引用 registration_ref（R-4）",
    }
    os.makedirs(os.path.dirname(LAST_APPROVED_PATH), exist_ok=True)
    with open(LAST_APPROVED_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def registration_binding(rec):
    """R-4 / R-5：`registration_ref` 是否被**改该文件的那次提交**的 message 引用。

    返回 (是否有效, 说明)。commit message 不引用 → 基线来源不可追溯，
    按 R-5 不得输出「与上次放行基线一致」。
    """
    if rec is None:
        return False, "无有效基线（记录不存在或缺内容寻址字段）"
    ref = rec.get("registration_ref")
    if not ref:
        return False, "无有效基线（registration_ref 为空）"
    try:
        out = subprocess.run(
            ["git", "-C", REPO, "log", "-1", "--format=%B", "--", LAST_APPROVED_PATH],
            capture_output=True, text=True, timeout=30, encoding="utf-8",
        )
        msg = out.stdout or ""
    except Exception as e:  # noqa: BLE001
        return False, f"无有效基线（读取提交说明失败: {e}）"
    if ref not in msg:
        return False, (
            f"无有效基线（registration_ref={ref} 未被 last-approved.json 所在提交的 "
            "message 引用，R-4）"
        )
    return True, f"registration_ref={ref} 已被提交说明引用"


def evaluate_verdict(
    *,
    self_check: bool,
    hash_stable: bool,
    oracle_sha: str,
    approved_sha,
    registration_valid: bool,
    registration_reason: str,
    unhit,
    mismatches: int,
):
    """判定（补包 B2 第 6 项口径 + B-3 任务 4 的 R-5）。返回 (verdict, ok, note)。

    判定条件属 **R2**（oracle-change-policy §七）：改动需 oracle 方补丁或业主签字。
    抽成纯函数是为了让每条分支都能被单测逐条触发（验收 #8 要求「可触发」），
    行为与原内联版本一致，**只新增 R-5 一条**：
    registration_ref 缺失或未被提交说明引用 → 不得输出「与上次放行基线一致」，
    改判 REVIEW_REQUIRED（修掉「重建基线后该句恒真」的缺陷）。
    """
    if self_check:
        # 自检档：注入偏差后**必须**报红；不报红 = 脚本失去检出能力
        if mismatches > 0:
            return "SELF-CHECK PASS（注入 1e-6 后如期报红）", True, ""
        return "REVIEW_REQUIRED（注入偏差却仍全绿 → 脚本失去检出能力）", False, ""
    if not hash_stable:
        return "REVIEW_REQUIRED", False, "运行中 oracle 被改动（before != after），判定作废"
    if approved_sha is None:
        return (
            "BASELINE_ESTABLISHED",
            True,
            "无有效基线（记录不存在或缺内容寻址字段）——当次**不得作为放行依据**，"
            "仅建立基线供后续比对",
        )
    if approved_sha != oracle_sha:
        return "REVIEW_REQUIRED", False, "oracle 哈希与上次放行基线不一致（oracle 已变更，需复核）"
    if unhit:
        return "REVIEW_REQUIRED", False, f"存在未命中分支：{unhit}（采样未覆盖早退/截断路径）"
    if mismatches:
        return "REVIEW_REQUIRED", False, "存在超出 E-27 容差的差异"
    if not registration_valid:  # R-5
        return "REVIEW_REQUIRED", False, registration_reason
    return "PASS", True, "与上次放行基线一致，全部检查通过"


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
        total = max(self.values_sampled, 1)
        quota = round(self.values_sampled * WILD_RATIO)
        return {
            "total": self.total,
            "values_sampled": self.values_sampled,
            "wild_values": self.wild,
            "wild_ratio": round(self.wild / total, 4),
            # 分层配额是否**精确**达标（整数比较，不走浮点相等）
            "wild_quota_target": quota,
            "wild_quota_exact": self.wild == quota,
            "flags": dict(self.flags),
            "branches": dict(self.branches),
        }


def wild_quota(counts, ratio=WILD_RATIO, rng=None):
    """分层精确配额（B-3 任务 9）：把 wild 名额分到各抽样层，总量恒等于
    `round(Σcount × ratio)`，然后**逐层打乱**，使层内位置不带任何规律。

    为什么不能像原来那样每抽一个值掷一次骰子：那只能得到「期望 0.3」，
    实测 47900 个值抽出 14389（0.3004），余量仅 0.0004——任何采样顺序改动
    都会破线。改成配额后占比不随种子漂移。

    分配用**最大余数法**（先按小数截断，再把不足的名额给小数部分大的层），
    保证 Σfloor ≤ target ≤ Σceil，不会出现总量漂移。

    返回 {层名: [是否 wild, ...]}，长度与该层抽样次数一致。
    """
    rng = rng or random.Random(SEED)
    total = sum(counts.values())
    target = round(total * ratio)
    floors = {k: int(v * ratio) for k, v in counts.items()}
    # 小数部分从大到小补名额（平手时按层名字典序，保证确定性）
    order = sorted(counts, key=lambda k: (-(counts[k] * ratio - int(counts[k] * ratio)), k))
    deficit = target - sum(floors.values())
    i = 0
    while deficit > 0:
        floors[order[i % len(order)]] += 1
        deficit -= 1
        i += 1
    while deficit < 0:  # 理论上不会发生（floor 之和 ≤ target），留作断言性回退
        floors[order[i % len(order)]] -= 1
        deficit += 1
        i += 1

    out = {}
    for k, cnt in counts.items():
        flags = [True] * floors[k] + [False] * (cnt - floors[k])
        rng.shuffle(flags)
        out[k] = flags
    return out


def sample_value(rng, stats, wild):
    stats.values_sampled += 1
    if wild:
        stats.wild += 1
        return rng.choice(WILD_VALUES)
    return rng.uniform(-1.5, 1.5)


def sample_pi(rng, stats, wild):
    stats.values_sampled += 1
    if wild:
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

    # 各层的抽样次数是 n 的确定函数，可先算出再配额（B-3 任务 9）：
    #   每个 case 抽 q / piQ / x / piX 四个值（sanitize、coding 复用，不再抽）
    #   每个 stamp case 抽 LAYOUT_SIZE 个 π
    stamp_cases = max(1, n // 100)
    counts = {
        "q": n, "piQ": n, "x": n, "piX": n,
        "stamp": stamp_cases * o.LAYOUT_SIZE,
    }
    quotas = wild_quota(counts, WILD_RATIO, rng)

    for _ in range(n):
        stats.total += 1
        bipolar = rng.random() < 0.5
        q = sample_value(rng, stats, quotas["q"].pop())
        pi_q = sample_pi(rng, stats, quotas["piQ"].pop())
        x = sample_value(rng, stats, quotas["x"].pop())
        pi_x = sample_pi(rng, stats, quotas["piX"].pop())
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

    for _ in range(stamp_cases):
        prec = [sample_pi(rng, stats, quotas["stamp"].pop()) for _ in range(o.LAYOUT_SIZE)]
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
                    help="自检：注入 1e-6 偏差，预期报红（不改源文件；默认走 1 万组）")
    ap.add_argument("--registration-ref", default=None,
                    help="建立基线时写入 registration_ref（R-4/R-5），如 OCL-20261106-01；"
                         "不给则记为空 → 后续一律判「无有效基线」")
    args = ap.parse_args()

    mode = "selfcheck" if args.self_check else ("quick" if args.quick else "full")
    # B-3 任务 8：--self-check 默认走快速档，显式 --full 才走 10 万组。
    # 自检只验证「1e-6 注入能被抓到」，1 万组足够；跑 10 万组是白等两分钟。
    if args.self_check:
        n = FULL_SAMPLES if args.full else QUICK_SAMPLES
    else:
        n = FULL_SAMPLES if args.full or not args.quick else QUICK_SAMPLES
    inject = "1e-6" if args.self_check else "0"

    print(f"=== diff_spacestate · mode={mode} · samples={n} · seed={SEED} ===")
    print(f"oracle: {ORACLE_PATH}")

    # R-1 预检（任务书：完整档**跑批前**必须干净）。这里只打印与打标，
    # 真正拦写入的那道闸在 write_last_approved 里（不依赖本次预检的结果）。
    r1_dirty, r1_detail = worktree_dirty()
    if mode == "full":
        print(f"R-1 工作区检查（{'脏' if r1_dirty else '干净'}）:"
              f" git status --porcelain -- {' '.join(DIRTY_SCOPE)}")
        if r1_dirty:
            for line in r1_detail.splitlines():
                print(f"    {line}")

    # 运行前哈希（补包 B 第 7 项）
    h_before = sha256_file(ORACLE_PATH)
    print(f"oracle sha256 (before): {h_before}")

    prev_report = previous_report_hash(mode)
    if prev_report:
        print(f"oracle sha256 (last report): {prev_report}")
    approved_rec, approved_reason = read_last_approved()
    approved_sha = approved_rec["oracle_hash"] if approved_rec else None
    if approved_sha:
        print(f"oracle hash (last approved): {approved_sha}")
    else:
        print(f"oracle hash (last approved): 无 —— {approved_reason}")
    reg_valid, reg_reason = registration_binding(approved_rec)
    print(f"registration_ref 校验: {'有效' if reg_valid else '无效'}（{reg_reason}）")
    ts_head = git_head()
    print(f"ts commit: {ts_head}")
    print(f"ts content hash: {ts_content_hash()}")

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
    print(
        f"wild 占比: {stats_dict['wild_ratio']}  "
        f"(设定 {WILD_RATIO} · 配额 {stats_dict['wild_values']}/{stats_dict['values_sampled']} "
        f"= 目标 {stats_dict['wild_quota_target']} · 精确相等: {stats_dict['wild_quota_exact']})"
    )
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

    # ══════════ 判定（补包 B2 第 6 项口径 + B-3 任务 4 的 R-5） ══════════
    #
    # BASELINE_ESTABLISHED：无有效基线（记录不存在 / 缺内容寻址字段）。
    #   → 在规则允许时写入 last-approved.json，但**当次不得作为放行依据**
    #     （没有参照，只能说明「这一版自己和自己一致」）
    # REVIEW_REQUIRED：哈希不一致 / 分支未覆盖 / 自检未报红 / registration_ref 未绑定
    #   → 一律**不得作为放行依据**
    # PASS：与上次放行基线一致且全部检查通过 → 唯一可作放行依据的结论
    #
    # 判定条件属 R2，已抽成纯函数 evaluate_verdict（行为等价，便于逐条单测触发）。
    verdict, ok, baseline_note = evaluate_verdict(
        self_check=args.self_check,
        hash_stable=hash_stable,
        oracle_sha=h_before,
        approved_sha=approved_sha,
        registration_valid=reg_valid,
        registration_reason=reg_reason,
        unhit=unhit,
        mismatches=diff["mismatches"],
    )

    # ══════════ 基线写入（R-1 完整档须干净 / R-2 快速与自检档永不写） ══════════
    write_state = "未触发（本次不建立基线）"
    if verdict == "BASELINE_ESTABLISHED":
        allowed, why = should_write_baseline(mode)
        if not allowed:
            write_state = f"未写入：{why}"
        else:
            try:
                write_last_approved(h_before, mode, ts_head, args.registration_ref)
                write_state = f"已写入 {LAST_APPROVED_PATH}"
            except BaselineWriteRefused as e:
                # R-1 拒写 = 这一次根本没有建立基线，
                # 不得一边拒写一边仍报「已建立基线」
                verdict, ok, baseline_note = "REVIEW_REQUIRED", False, str(e)
                write_state = "R-1 拒写（本次未建立基线）"

    # 报告级别：快速/自检档恒为 non-release（R-2）；完整档脏树同样不作放行依据（R-1）
    if mode in ("quick", "selfcheck") or r1_dirty:
        level = "non-release"
    else:
        level = "release"

    if baseline_note:
        print(f"判定说明: {baseline_note}")
    print(f"基线写入: {write_state}")
    print(f"报告级别: {level}")
    if verdict == "BASELINE_ESTABLISHED":
        print("⚠️ BASELINE_ESTABLISHED ≠ PASS：本次只建立基线，不作为放行依据。")

    total_s = gen_s + ts_s
    print(f"耗时(生成+跑批): {total_s:.2f}s")

    report = {
        "mode": mode,
        "level": level,
        "oracle_sha256": h_after,
        "oracle_sha256_before": h_before,
        "oracle_sha256_last_report": prev_report,
        "last_approved_hash": approved_sha,
        "baseline_note": baseline_note,
        "baseline_written": write_state,
        # ── B-3 任务 4：内容寻址字段（与 last-approved.json 同名） ──
        "ts_content_hash": ts_content_hash(),
        "ts_commit": ts_head,
        "ts_dirty": r1_dirty,
        "script_hash": sha256_file(SCRIPT_PATH),
        "registration_ref": (approved_rec or {}).get("registration_ref"),
        "registration_valid": reg_valid,
        "registration_reason": reg_reason,
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
        "elapsed_s": {"generate": round(gen_s, 2), "ts": round(ts_s, 2),
                      "total": round(total_s, 2)},
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
