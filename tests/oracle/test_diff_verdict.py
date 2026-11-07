#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""差分脚本判定分支与治理规则的单测（B-3 任务 4 / 9 + 验收 #8）

**为什么需要这个文件**：验收 #8 要求「`无有效基线` 分支存在且可触发」，
而原先判定逻辑内联在 `main()` 里，除了真跑一遍无法触发。故判定抽成
`evaluate_verdict()` 纯函数后，逐条分支在这里用用例打红打绿。

判定条件属 **R2**（oracle-change-policy §七）——本文件是它的**回归守卫**，
不是修改：下面几组 `test_verdict_*` 锁住原有判定语义，
若有人顺手放宽某条，这里会先红。

不依赖 pytest（本机未装）：全部用裸 `assert`，由
`tests/oracle/run_oracle_tests.py` 收集执行，也兼容 pytest。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile

import diff_spacestate as d

_ORACLE_SHA = "a" * 64


# ══════════════════════════════════════════════════════════════
# 验收 #8 · 「无有效基线」分支可触发
# ══════════════════════════════════════════════════════════════
def test_verdict_no_baseline_branch_triggers():
    """记录不存在 / 缺内容寻址字段 → BASELINE_ESTABLISHED，且明写「无有效基线」。"""
    verdict, ok, note = d.evaluate_verdict(
        self_check=False, hash_stable=True, oracle_sha=_ORACLE_SHA,
        approved_sha=None, registration_valid=False,
        registration_reason="", unhit=[], mismatches=0,
    )
    assert verdict == "BASELINE_ESTABLISHED", verdict
    assert ok is True
    assert "无有效基线" in note
    # R-5 的反面：没有有效基线时，绝不能输出那句「与上次放行基线一致」
    assert "与上次放行基线一致" not in note


def test_verdict_baseline_established_is_not_pass():
    """BASELINE_ESTABLISHED ≠ PASS：当次不得作为放行依据。"""
    verdict, ok, _ = d.evaluate_verdict(
        self_check=False, hash_stable=True, oracle_sha=_ORACLE_SHA,
        approved_sha=None, registration_valid=True,
        registration_reason="ok", unhit=[], mismatches=0,
    )
    assert verdict != "PASS"
    assert ok is True  # 脚本本身跑成功了，只是结论不能放行


# ══════════════════════════════════════════════════════════════
# R-5 · registration_ref 未被提交说明引用 → 不得输出「与上次放行基线一致」
# ══════════════════════════════════════════════════════════════
def test_r5_registration_missing_blocks_pass():
    """其它检查全绿，但 registration_ref 无效 → REVIEW_REQUIRED + 无有效基线。"""
    verdict, ok, note = d.evaluate_verdict(
        self_check=False, hash_stable=True, oracle_sha=_ORACLE_SHA,
        approved_sha=_ORACLE_SHA, registration_valid=False,
        registration_reason="无有效基线（registration_ref=OCL-1 未被提交说明引用，R-4）",
        unhit=[], mismatches=0,
    )
    assert verdict == "REVIEW_REQUIRED", verdict
    assert ok is False
    assert "无有效基线" in note
    assert "与上次放行基线一致" not in note


def test_r5_registration_valid_yields_pass():
    verdict, ok, note = d.evaluate_verdict(
        self_check=False, hash_stable=True, oracle_sha=_ORACLE_SHA,
        approved_sha=_ORACLE_SHA, registration_valid=True,
        registration_reason="已引用", unhit=[], mismatches=0,
    )
    assert verdict == "PASS"
    assert ok is True
    assert note == "与上次放行基线一致，全部检查通过"


# ══════════════════════════════════════════════════════════════
# R2 回归守卫 · 抽函数不得改坏原有判定
# ══════════════════════════════════════════════════════════════
def _run(**kw):
    base = dict(
        self_check=False, hash_stable=True, oracle_sha=_ORACLE_SHA,
        approved_sha=_ORACLE_SHA, registration_valid=True,
        registration_reason="ok", unhit=[], mismatches=0,
    )
    base.update(kw)
    return d.evaluate_verdict(**base)


def test_verdict_hash_unstable_is_review():
    verdict, ok, note = _run(hash_stable=False)
    assert verdict == "REVIEW_REQUIRED"
    assert ok is False
    assert "before != after" in note


def test_verdict_oracle_changed_is_review():
    verdict, ok, note = _run(approved_sha="b" * 64)
    assert verdict == "REVIEW_REQUIRED"
    assert ok is False
    assert "oracle 已变更" in note


def test_verdict_unhit_branch_is_review():
    verdict, ok, note = _run(unhit=["dim_evidence.clip_hit"])
    assert verdict == "REVIEW_REQUIRED"
    assert ok is False
    assert "clip_hit" in note


def test_verdict_mismatch_is_review():
    verdict, ok, note = _run(mismatches=3)
    assert verdict == "REVIEW_REQUIRED"
    assert ok is False
    assert "E-27" in note


def test_verdict_hash_unstable_beats_baseline_branch():
    """顺序也是语义：运行中被改动优先于「无基线」，不得因为没基线就去建。"""
    verdict, ok, note = _run(hash_stable=False, approved_sha=None)
    assert verdict == "REVIEW_REQUIRED"
    assert "无有效基线" not in note


def test_verdict_selfcheck_must_report_red():
    verdict, ok, _ = _run(self_check=True, mismatches=5)
    assert verdict.startswith("SELF-CHECK PASS")
    assert ok is True

    verdict, ok, _note = _run(self_check=True, mismatches=0)
    assert verdict.startswith("REVIEW_REQUIRED")
    assert ok is False
    # 自检分支的原因写在 verdict 里（外层 note 只有非自检分支才用）
    assert "失去检出能力" in verdict


def test_verdict_selfcheck_never_claims_consistent_with_baseline():
    """自检档既不走建立基线分支，也不该说「与上次一致」。"""
    verdict, _ok, note = _run(self_check=True, approved_sha=None, mismatches=7)
    assert verdict.startswith("SELF-CHECK PASS")
    assert "与上次放行基线一致" not in note


# ══════════════════════════════════════════════════════════════
# R-1 / R-2 · 基线写入闸门
# ══════════════════════════════════════════════════════════════
def test_r2_quick_and_selfcheck_never_write():
    for mode in ("quick", "selfcheck"):
        allowed, why = d.should_write_baseline(mode)
        assert allowed is False, mode
        assert "R-2" in why
    allowed, why = d.should_write_baseline("full")
    assert allowed is True
    assert why == ""


def _patched_write(tmpdir: str, dirty: bool, mode: str = "full"):
    """把基线路径指到临时目录、把脏检查换成受控返回值，跑一次写入。"""
    saved_path, saved_dirty = d.LAST_APPROVED_PATH, d.worktree_dirty
    target = os.path.join(tmpdir, "last-approved.json")
    d.LAST_APPROVED_PATH = target
    d.worktree_dirty = lambda *a, **k: (dirty, " M src/spacestate/core/config.ts")
    try:
        d.write_last_approved(_ORACLE_SHA, mode, "deadbeef", "OCL-TEST-01")
        return target, None
    except d.BaselineWriteRefused as e:
        return target, str(e)
    finally:
        d.LAST_APPROVED_PATH, d.worktree_dirty = saved_path, saved_dirty


def test_r1_full_tier_refuses_to_write_on_dirty_tree():
    """验收 #7 的单测形态：脏工作区下完整档拒写，且错误里给出具体文件。"""
    with tempfile.TemporaryDirectory() as tmp:
        target, err = _patched_write(tmp, dirty=True, mode="full")
        assert err is not None, "脏树必须拒写"
        assert "R-1" in err
        assert "src/spacestate" in err and "M src/spacestate/core/config.ts" in err
        assert not os.path.exists(target), "拒写 = 文件不得被创建"


def test_r1_full_tier_writes_when_clean():
    with tempfile.TemporaryDirectory() as tmp:
        target, err = _patched_write(tmp, dirty=False, mode="full")
        assert err is None, err
        with open(target, encoding="utf-8") as f:
            rec = json.load(f)
        for key in d.REQUIRED_BASELINE_KEYS:
            assert key in rec, f"缺字段 {key}"
        assert rec["ts_dirty"] is False
        assert rec["registration_ref"] == "OCL-TEST-01"
        # R-3：脚本哈希必须入记录——容差与采样是信任根
        with open(d.SCRIPT_PATH, "rb") as f:
            assert rec["script_hash"] == hashlib.sha256(f.read()).hexdigest()
        # ts_content_hash 必须是「内容的哈希」，与 HEAD 无关
        assert rec["ts_content_hash"] == d.ts_content_hash()
        assert len(rec["ts_content_hash"]) == 64


def test_r2_blocks_write_even_on_clean_tree():
    with tempfile.TemporaryDirectory() as tmp:
        target, err = _patched_write(tmp, dirty=False, mode="quick")
        assert err is not None
        assert "R-2" in err
        assert not os.path.exists(target)


def test_required_baseline_keys_match_task_book():
    """字段清单与任务书第四节逐字一致（改名会让 CI 校验失效）。"""
    assert list(d.REQUIRED_BASELINE_KEYS) == [
        "oracle_hash", "ts_content_hash", "ts_commit", "ts_dirty",
        "script_hash", "mode", "registration_ref",
    ]


def test_read_last_approved_rejects_old_structure():
    """旧结构（只记 ts_commit 的 HEAD）必须被判为「无有效基线」。"""
    saved = d.LAST_APPROVED_PATH
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "last-approved.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"oracle_sha256": _ORACLE_SHA, "ts_commit": "fb8f889",
                       "mode": "quick", "approved_at": "2026-11-05T19:43:24",
                       "note": "首次运行建立的基线"}, f, ensure_ascii=False)
        d.LAST_APPROVED_PATH = path
        try:
            rec, reason = d.read_last_approved()
        finally:
            d.LAST_APPROVED_PATH = saved
    assert rec is None
    assert "无有效基线" in reason
    assert "ts_content_hash" in reason and "registration_ref" in reason


def test_read_last_approved_missing_file():
    saved = d.LAST_APPROVED_PATH
    d.LAST_APPROVED_PATH = os.path.join(tempfile.gettempdir(), "ss-no-such-file.json")
    try:
        rec, reason = d.read_last_approved()
    finally:
        d.LAST_APPROVED_PATH = saved
    assert rec is None
    assert "不存在" in reason


# ══════════════════════════════════════════════════════════════
# R-4 / R-5 · registration_ref 绑定
# ══════════════════════════════════════════════════════════════
class _FakeProc:
    def __init__(self, text: str):
        self.stdout = text


def _binding_with_log(rec, log_text: str):
    saved = d.subprocess.run
    d.subprocess.run = lambda *a, **k: _FakeProc(log_text)
    try:
        return d.registration_binding(rec)
    finally:
        d.subprocess.run = saved


def test_registration_binding_ok_when_commit_message_cites_ref():
    ok, reason = _binding_with_log({"registration_ref": "OCL-20261106-01"},
                                   "fix(oracle): xxx\n\nregistration_ref=OCL-20261106-01\n")
    assert ok is True
    assert "OCL-20261106-01" in reason


def test_registration_binding_fails_when_commit_message_omits_ref():
    ok, reason = _binding_with_log({"registration_ref": "OCL-20261106-01"},
                                   "fix(oracle): 改了但没写登记号\n")
    assert ok is False
    assert "无有效基线" in reason
    assert "R-4" in reason


def test_registration_binding_fails_when_ref_empty():
    ok, reason = d.registration_binding({"registration_ref": ""})
    assert ok is False
    assert "无有效基线" in reason

    ok, reason = d.registration_binding(None)
    assert ok is False
    assert "无有效基线" in reason


# ══════════════════════════════════════════════════════════════
# 任务 9 · 分层精确配额
# ══════════════════════════════════════════════════════════════
def _counts(n: int) -> dict:
    """与 build_cases 完全同口径的各层抽样次数。"""
    stamp_cases = max(1, n // 100)
    return {"q": n, "piQ": n, "x": n, "piX": n,
            "stamp": stamp_cases * d.o.LAYOUT_SIZE}


def test_wild_quota_total_is_exact_for_every_tier():
    for n in (1, 7, 99, 100, 10_000, 100_000):
        counts = _counts(n)
        quotas = d.wild_quota(counts, d.WILD_RATIO)
        total = sum(counts.values())
        got = sum(1 for flags in quotas.values() for f in flags if f)
        # 整数比较，不走浮点相等（这正是原来 0.3004 能溜过去的原因）
        assert got == round(total * d.WILD_RATIO), (n, got, round(total * d.WILD_RATIO))


def test_wild_quota_layer_lengths_match_and_flags_are_binary():
    counts = _counts(10_000)
    quotas = d.wild_quota(counts)
    for key, cnt in counts.items():
        assert len(quotas[key]) == cnt, key
        assert set(quotas[key]) <= {True, False}, key


def test_wild_quota_never_exceeds_layer_size():
    """最大余数法分配后单层名额不得超过该层样本数。"""
    for n in (1, 3, 10, 10_000):
        counts = _counts(n)
        quotas = d.wild_quota(counts, d.WILD_RATIO)
        for key, cnt in counts.items():
            assert sum(quotas[key]) <= cnt, (n, key)


def test_wild_quota_is_deterministic():
    counts = _counts(10_000)
    a, b = d.wild_quota(counts), d.wild_quota(counts)
    assert a == b, "同种子必须得到同一配额（结果可复现）"


# ══════════════════════════════════════════════════════════════
# 任务 8 · 报告路径互不覆盖
# ══════════════════════════════════════════════════════════════
def test_report_paths_are_distinct_per_mode():
    paths = [d.report_path(m) for m in ("quick", "full", "selfcheck")]
    assert len(set(paths)) == 3
    assert d.report_path("selfcheck").endswith("diff-report-selfcheck.json")


# ══════════════════════════════════════════════════════════════
# __pycache__ 不得把 R-1 的脏检查永久判脏
# ══════════════════════════════════════════════════════════════
def test_pycache_is_not_reported_as_dirty():
    """tests/oracle/.gitignore 必须生效，否则完整档永远写不了基线。"""
    _dirty, detail = d.worktree_dirty()
    assert "__pycache__" not in detail, (
        "__pycache__ 出现在 porcelain 输出里——R-1 会被它永久卡死：\n" + detail
    )