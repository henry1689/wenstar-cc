#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oracle 自测的 CI 入口（B-3 任务 10-5）

**为什么不用 pytest**：本机 `python -c "import pytest"` → `ModuleNotFoundError`，
且本仓**没有远端 CI**（无 `.github` / `.gitlab-ci.yml` / `Jenkinsfile`），
实际载体是本地 git hooks：`hooks/pre-commit.template` →（`scripts/install-hooks.sh`）
→ `.git/hooks/pre-commit`。故本文件提供了一个**零依赖**的等价 runner：
收集 `test_*` 函数逐个执行，任一失败即非零退出，pre-commit 据此阻断提交。

用法
----
    python tests/oracle/run_oracle_tests.py          # 跑全部
    python tests/oracle/run_oracle_tests.py -v       # 逐个打印

覆盖对象
--------
- `oracle_spacestate.py` 的 6 个 `test_*`（常量表 / 对拍源 / 量化）
- `test_diff_verdict.py` 的判定分支与治理规则单测

另含一道**治理闸门**（不是单测，因为它依赖真实 git 历史）：
R-4 —— `last-approved.json` 里记的 `registration_ref` 必须被「改该文件的那次提交」
的 message 引用。基线尚未建立 / 仍是旧结构时跳过（不误报红）。
"""
from __future__ import annotations

import importlib
import inspect
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Windows 控制台默认 GBK，打印中文/符号会 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MODULES = ["oracle_spacestate", "test_diff_verdict"]


def collect(mod):
    """按定义顺序收集本模块内的 test_* 函数（含被 import 进来的不算）。"""
    out = []
    for name, fn in vars(mod).items():
        if not name.startswith("test_") or not inspect.isfunction(fn):
            continue
        if fn.__module__ != mod.__name__:
            continue
        out.append((name, fn))
    # vars() 保持定义顺序，这里不再排序，保证输出与文件一致
    return out


def run_unit_tests(verbose: bool) -> tuple[int, int, list[str]]:
    passed = failed = 0
    failures: list[str] = []
    for mod_name in MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except Exception:
            failures.append(f"[import] {mod_name}\n{traceback.format_exc()}")
            failed += 1
            continue
        cases = collect(mod)
        print(f"\n--- {mod_name}（{len(cases)} 个用例）---")
        for name, fn in cases:
            try:
                fn()
            except Exception as e:  # noqa: BLE001 —— 任何异常都算失败，不吞
                failed += 1
                failures.append(f"[FAIL] {mod_name}::{name}\n{type(e).__name__}: {e}")
                print(f"  ❌ {name}: {type(e).__name__}: {e}")
                if verbose:
                    traceback.print_exc()
            else:
                passed += 1
                if verbose:
                    print(f"  ✅ {name}")
    return passed, failed, failures


def _pending_commit_message() -> str:
    """pre-commit 阶段待提交的说明（`.git/COMMIT_EDITMSG`）。不在提交中用则返回空串。"""
    import diff_spacestate as d

    path = os.path.join(d.REPO, ".git", "COMMIT_EDITMSG")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _baseline_staged() -> bool:
    """本次提交是否正在更新放行记录（决定 R-4 该看「待提交说明」还是「历史提交」）。"""
    import subprocess

    import diff_spacestate as d

    try:
        out = subprocess.run(
            ["git", "-C", d.REPO, "diff", "--cached", "--name-only", "--",
             os.path.relpath(d.LAST_APPROVED_PATH, d.REPO)],
            capture_output=True, text=True, timeout=30, encoding="utf-8",
        )
        return bool((out.stdout or "").strip())
    except Exception:  # noqa: BLE001
        return False


def governance_gate() -> tuple[bool, str]:
    """R-4：放行记录必须可追溯到**引用它的那条提交说明**。

    两种场景分开处理，否则会陷入「第一次引入 registration_ref 的那次提交
    永远过不了闸门」的死结：
    - 本次提交正在更新 last-approved.json → 检查**待提交说明**（COMMIT_EDITMSG）
    - 否则 → 检查「最后一次改该文件的提交」的说明（即运行时的实际历史）
    """
    import diff_spacestate as d

    rec, reason = d.read_last_approved()
    if rec is None:
        # 基线尚未建立 / 仍是旧结构：R-4 没有适用对象，跳过（不得误报红）
        return True, f"SKIP（{reason}）"

    ref = rec.get("registration_ref")
    if not ref:
        return False, "FAIL —— 无有效基线（registration_ref 为空）"

    if _baseline_staged():
        msg = _pending_commit_message()
        if ref in msg:
            return True, f"PASS —— 待提交说明已引用 {ref}（本次提交将更新放行记录）"
        return False, (
            f"FAIL —— 本次提交更新了 last-approved.json，但提交说明未引用 {ref}（R-4）。"
            "请在 commit message 中写明 registration_ref=<编号>"
        )

    ok, why = d.registration_binding(rec)
    return ok, ("PASS —— " + why if ok else "FAIL —— " + why)


def main() -> int:
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    print("=== oracle 自测（tests/oracle）===")

    passed, failed, failures = run_unit_tests(verbose)
    print(f"\n单测：{passed} passed / {failed} failed")

    gate_ok, gate_msg = governance_gate()
    print(f"治理闸门 R-4：{gate_msg}")

    if failures:
        print("\n=== 失败明细 ===")
        for f in failures:
            print(f)

    total_failed = failed + (0 if gate_ok else 1)
    # 闸门状态原样带出：SKIP（基线未建立）与 PASS（已绑定）不是一回事，
    # 合并成「通过」会让复核人以为 R-4 已经被验证过
    gate_state = "PASS" if gate_ok and gate_msg.startswith("PASS") else (
        "SKIP" if gate_ok else "FAIL")
    print(f"\n结论：{'PASS' if total_failed == 0 else 'FAIL'}"
          f"（单测 {passed} 通过 / {failed} 失败；R-4 {gate_state}）")
    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())