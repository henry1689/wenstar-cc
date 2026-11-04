# oracle_spacestate.py — 只依据基线编写,不参考任何 TS 实现
# 基线 MD5: 0A693DE23E1937353631526AE565A9D3
# 修订: 切片#1 二轮审计后最终版
#   - E-23/E-26: 饱和边界改行为断言,hi 真值 381.69
#   - decode_pi(0.4) == decode_pi(1)
#   - dim_evidence 等号边界用 0.999/1.001 系数
import math, random

PI_MAX = 400.0
CLIP = 3.0
TAU_MIN = 0.1
LOG2_STEP = 14.75
LAYOUT_SIZE = 79
D27_INDICES = (35, 66)

def finite(x):
    return isinstance(x, (int, float)) and math.isfinite(x)

def sym_round(x):
    return math.copysign(math.floor(abs(x) + 0.5), x)

def clamp_range(v, bipolar):
    lo = -1.0 if bipolar else 0.0
    if v < lo: return lo, True
    if v > 1.0: return 1.0, True
    return float(v), False

def sanitize_pi(pi):
    if isinstance(pi, float) and math.isnan(pi): return 0.0, "nan"
    if pi == math.inf: return PI_MAX, "pos_inf"
    if pi < 0: return 0.0, "negative"
    return min(float(pi), PI_MAX), None

def sanitize_reading(v, pi, bipolar=True):
    if not finite(v): return 0.0, 0.0, "bad_value"
    p, flag = sanitize_pi(pi)
    if p <= 0: return 0.0, 0.0, flag
    v2, clamped = clamp_range(float(v), bipolar)
    if flag is None and clamped: flag = "range_clamped"
    return v2, p, flag

def encode_pi(pi):
    p, _ = sanitize_pi(pi)
    if p <= 0: return 0
    k = sym_round(128 + LOG2_STEP * math.log2(p))
    return int(min(255, max(1, k)))

def decode_pi(k):
    if not finite(k) or k <= 0: return 0.0
    code = int(min(255, max(1, sym_round(k))))
    return 2.0 ** ((code - 128) / LOG2_STEP)

def quant_int8(x):
    if not finite(x): return 0
    mag = min(math.floor(abs(x) * 127 + 0.5), 127)
    if mag == 0: return 0
    return int(math.copysign(mag, x))

def dequant_int8(q):
    if not finite(q): return 0.0
    q = max(-127.0, min(127.0, float(q)))
    return q / 127.0

def phase(minutes):
    if not finite(minutes): return 0.0, 0.0, 0.0
    m = minutes % 1440
    th = 2 * math.pi * m / 1440
    return math.sin(th), math.cos(th), PI_MAX

def stamp_storage_precision(prec):
    if len(prec) != LAYOUT_SIZE: raise ValueError("prec length must be 79")
    out = [sanitize_pi(p)[0] for p in prec]
    for i in D27_INDICES: out[i] = 0.0
    return out

def dim_evidence(q, pi_q, x, pi_x, mu, tau, bipolar=True):
    if not (finite(mu) and finite(tau)): raise ValueError("background must be finite")
    tau = max(tau, TAU_MIN)
    q, pi_q, _ = sanitize_reading(q, pi_q, bipolar)
    if pi_q <= 0: return 0.0
    sq2 = 1.0 / pi_q
    if sq2 >= tau * tau: return 0.0
    x, px, _ = sanitize_reading(x, pi_x, bipolar)
    if px <= 0: return 0.0
    p0 = 1.0 / tau**2
    xh = (px * x + p0 * mu) / (px + p0)
    v = 1.0 / (px + p0)
    s2, b2 = sq2 + v, sq2 + tau**2
    l = 0.5 * math.log(b2 / s2) + (q - mu)**2 / (2*b2) - (q - xh)**2 / (2*s2)
    return max(-CLIP, min(CLIP, l))

MODALITY = {"TEXT_LLM": "TEXT", "TEXT_RULE": "TEXT", "VOICE": "AUDIO"}
def modality_of(src): return MODALITY.get(src, src)

def fuse_dim(readings, cap=PI_MAX, eta=0.3, bipolar=True):
    groups = {}
    for v, pi, src in readings:
        v, p, _ = sanitize_reading(v, pi, bipolar)
        if p > 0: groups.setdefault(modality_of(src), []).append((v, p))
    gs = []
    for k in sorted(groups):
        rs = groups[k]; ps = [p for _, p in rs]; s, mx = sum(ps), max(ps)
        gs.append((sum(p*v for v, p in rs) / s, mx + eta * (s - mx)))
    if not gs: return 0.0, 0.0, 0.0
    P = sum(p for _, p in gs)
    vbar = sum(p*v for v, p in gs) / P
    G = len(gs)
    Q = sum(p * (v - vbar)**2 for v, p in gs)
    infl = max(1.0, Q / (G - 1)) if G > 1 else 1.0
    return vbar, min(P / infl, cap), (Q if infl > 3 else 0.0)

def kalman_step(m, P, y, pi, dt_min, tau_min, B, s2, bipolar=True):
    if dt_min < 0: raise ValueError("dt<0")
    a = math.exp(-dt_min / tau_min)
    m_pred = B + a * (m - B)
    p_pred = max(a*a*P + s2*(1 - a*a), 1e-9)
    y, pi, _ = sanitize_reading(y, pi, bipolar)
    if pi <= 0: return m_pred, p_pred, 0.0
    r = 1.0 / pi; nu = y - m_pred; S = p_pred + r; K = p_pred / S
    return m_pred + K*nu, max((1 - K)*p_pred, 1e-9), nu*nu / S

def shrink_mean(n_b, xbar, b_parent, n0=20):
    return (n_b*xbar + n0*b_parent) / (n0 + n_b)

def shrink_var(n_b, ss, s_parent2, nu0=10):
    return (nu0*s_parent2 + ss) / (nu0 + n_b - 1)

def sigma_decay(sigma0, lam, c, t_days, t0=7.0):
    if not (0.0 <= c <= 1.0): raise ValueError("c out of [0,1]")
    return sigma0 * (1 + lam * (1 - c) * math.log(1 + t_days / t0))

# ---------- 测试（切片#2 收尾任务：oracle 侧此前无 test_* ，本函数为新建） ----------
def test_quant_int8():
    # G-004 量化黄金值
    assert quant_int8(0.5) == 64
    assert quant_int8(-0.5) == -64
    assert quant_int8(0.3) == 38
    assert quant_int8(1.0) == 127
    assert quant_int8(-1.2) == -127
    assert quant_int8(0.0039) == 0
    assert quant_int8(0.00394) == 1
    # 收尾任务：反量化钳位（越界输入不再产生值域外结果）
    assert dequant_int8(300) == 1.0 and dequant_int8(-300) == -1.0
