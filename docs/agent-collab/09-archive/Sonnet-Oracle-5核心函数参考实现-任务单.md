---
id: P0-Slice-Oracle
type: taskbook_slice
title: Sonnet Oracle · 5 个核心函数 Python 参考实现
status: ready_to_dispatch
created: 2026-11-03
executor: Sonnet (独立审计方)
baseline: SpaceState-S验收基线-永久归档版-20261103.md
confidentiality: 禁止阅读 Claude Code 的任何实现代码；只按本任务书写
---

# Sonnet Oracle · 5 个核心函数 Python 参考实现

> 你的角色：独立审计方。你**不看** Claude Code 的代码，只按本任务书给出的规约写 Python 参考实现（oracle）。
> Claude Code 的 TS 实现完成后，两边用 10⁵ 组随机输入做差分对比，相对误差必须 ≤ 1e-9。
> 任何不一致，以你的 oracle 为准排查 TS 侧——你是公式正确性的最终裁判。

---

## 函数 1：dimEvidence（对应 S-010）

```
输入：q, piQ, x, piX, mu, tau   （全部 float，注意接口只传精度 pi，不传方差）
输出：ell ∈ [-3, 3]
```

规约：

1. piQ == 0 时返回 0（查询不可靠）
2. 换算方差：sigmaQ² = 1/piQ；sigmaX² = 1/piX（piX=0 时该维未知）
3. 若 sigmaQ² >= tau²，返回 0（查询噪声大于背景，无证据）
4. 收缩：
   px = piX,  p0 = 1/tau²
   xHat = (px·x + p0·mu) / (px + p0)
   vHat = 1 / (px + p0)
5. s² = sigmaQ² + vHat
   b² = sigmaQ² + tau²
6. ell = 0.5 · ln(b²/s²) + (q−mu)²/(2b²) − (q−xHat)²/(2s²)
7. 截断：ell = max(-3, min(3, ell))

黄金算例 G-010（公共参数 piQ=100, tau=0.3, mu=0，容差 1e-6）：

```
#1  q=0,   x=0,   piX=100     → ell = 0.830366
#2  q=0.6, x=0.6, piX=100     → ell = 2.535629
#3  q=0.6, x=任意, piX=0      → ell = 0（精确）
#4  q=0.6, x=-0.6, piX=100    → 原始 -31.5696，截断后 -3
#5  q=0.6, x=0.6, piX 使得 sigmaX=0.378108 → ell = 0.974419
#6  piQ=11.111 (sigmaQ²=tau²) → ell = 0
#7  q=0.6, x=0.6, sigmaX=3.0  → ell = 0.024077
链式检查：#2 > #5 > #7 > #3，且 #2 > #1
```

## 函数 2：fuseDim（对应 S-027）

输入：读数列表 [{v, pi, src}]，先按模态分组：
TEXT 组 = TEXT_LLM + TEXT_RULE；AUDIO 组 = VOICE；VISION/TOUCH/IMU/ENV/PHYSIO/DERIVED 各自独立成组。

1. 组内合并：pi_g = max(pi) + 0.3·(sum(pi) − max(pi))，v_g = Σ(pi·v)/Σpi
2. 跨组融合：v̄ = Σ_g(pi_g·v_g)/Σ_g pi_g；P = Σ_g pi_g
3. Birge 冲突：Q = Σ_g pi_g·(v_g − v̄)²；G=组数；膨胀 = max(1, Q/(G−1))（G=1 时膨胀=1）
4. 输出 {v=v̄, pi=P/膨胀, conflict=膨胀 if 膨胀>3 else 0}

黄金算例 G-027（容差 1e-4）：

```
#1 一致：TEXT_LLM(v=.6,pi=25)+TEXT_RULE(v=.4,pi=8)+VOICE(v=.5,pi=25)
   TEXT组: v=0.551515, pi=27.4；VOICE组: v=0.5, pi=25
   融合: v=0.526937, pi=52.4, Q=0.0347, 膨胀=1, conflict=0
#2 冲突 D08: TEXT(v=.1,pi=25)+PHYSIO(v=.9,pi=44.444)
   v=0.612, P=69.444, Q=10.24, 膨胀=10.24 → pi=6.7817, conflict=10.24
#3 单组 G=1 → 膨胀=1
#4 全未知 → v=0, pi=0
```

## 函数 3：kalmanStep（对应 S-035）

```
输入：st={m, P}, y, pi, dtMin, tauMin, B, s2
```

1. a = exp(−dtMin/tauMin)
2. mPred = B + a·(st.m − B)
3. pPred = a²·st.P + s2·(1 − a²)
4. pi <= 0 时：返回 {m=mPred, P=pPred, nis=0}（只预测）
5. 否则：r = 1/pi；nu = y − mPred；S = pPred + r；K = pPred/S
   m = mPred + K·nu；P = (1−K)·pPred；nis = nu²/S

黄金算例 G-035（m=0.2, P=0.04, B=0, s²=0.09, dtMin=20, tauMin=20，容差 1e-4）：

```
#1 预测: a=0.367879 → m⁻=0.073576, P⁻=0.083233
#2 pi=0: m=0.073576, P=0.083233, nis=0
#3 y=0.5, pi=25: K=0.675412, m=0.361588, P=0.027016, nis=1.4756
```

## 函数 4：baselineShrink（对应 S-039）

```
Bhat = (n_b·x̄ + n0·B_parent) / (n_b + n0)，n0 = 20
s²   = (ν0·s_parent² + SS) / (ν0 + n_b − 1)，ν0 = 10
```

黄金算例 G-039：

```
n_b=5, x̄=0.6, B_parent=0.2 → Bhat=0.28
ν0=10, s_parent²=0.04, SS=0.05 → s²=0.032143
n_b=0 → Bhat=0.2, s²=0.044444
```

## 函数 5：sigmaDecay（对应 S-045）

```
输入：sigma0, lambda_L, c, ageDays（天）
t0 = 7
sigma(t) = sigma0 · (1 + lambda_L·(1−c)·ln(1 + ageDays/t0))
c=1 时不衰减；ageDays=0 时返回 sigma0
```

黄金算例 G-045（sigma0=0.1, c=0.3, ageDays=365）：

```
ln(1+365/7) = 3.972984
scene(lambda=1.0) → 0.378108
core (lambda=0.15) → 0.141716
c=1 → 0.1；ageDays=0 → 0.1
场景层粗化日（tau=0.3）：t_c = 7·(e^(1.4/0.7) − 1) = 44.723 天
```

---

## 交付物

1. `oracle.py`：5 个函数，纯 Python（math 库即可，不要 numpy 依赖），全部 float64
2. `test_oracle.py`：上面 5 组黄金算例全部跑通的自验脚本
3. 边界处理：所有分母前置校验；log 参数 ≥ 1e-12；NaN 输入返回 0 证据
4. 交付后冻结版本号，作为后续 10⁵ 组差分测试的基准
