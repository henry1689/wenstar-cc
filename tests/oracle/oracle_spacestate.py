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

# ---------- 切片#3 补包：层参数与维度级开关（与 TS 侧 config.ts 同步） ----------
LAYER_NAMES = ("body", "core", "appraisal", "motive", "relation", "scene", "dyad")

DIMS_BY_LAYER = {
    "body":      ("D01", "D02", "D03", "D04", "D05", "D06"),
    "core":      ("D07", "D08", "D09"),
    "appraisal": ("D10", "D11", "D12", "D13", "D14", "D15", "D16"),
    "motive":    ("D17", "D18", "D19", "D20", "D21", "D22", "D23"),
    "relation":  ("D24", "D25", "D26", "D27", "D28", "D29", "D30", "D31"),
    "scene":     ("D32", "D33", "D34", "D35", "D36", "D37", "D38", "D39", "D40"),
    "dyad":      ("Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7", "Y8"),
}

# (lambda, tau_min); tau None = 不走 Kalman（跳变模型，无 τ 概念）
LAYER_PARAMS = {
    "body": (0.8, 60.0), "core": (0.15, 20.0), "appraisal": (0.4, 10.0),
    "motive": (0.4, 30.0),
    # relation τ = 120 分钟。业主已批准（2026-11-05）。
    # 白皮书 §2.4 的 τ 表无 Ⅴ 关系层，此值由业主裁定。
    # 批准依据：① λ 与 dyad 同为 0.15（同属慢度类别）；
    #          ② τ 序列中应慢于 body(60)、不快于 dyad(120)；
    #          ③ τ 敏感度实测 τ=60/120/240 → 终态残差 0.066034/0.156890/0.242668
    "relation": (0.15, 120.0),
    "scene": (1.0, None),
    "dyad": (0.15, 120.0),
}

NO_KALMAN = {"D27"} | {f"D{n}" for n in range(32, 41)}
OBSERVE_ONLY = ("D29", "D30")
PRIVATE_ONLY = ("D20",)

def layer_of(dim):
    for layer in LAYER_NAMES:
        if dim in DIMS_BY_LAYER[layer]:
            return layer
    raise ValueError("layer_of: unknown dim %s" % dim)

def layer_lambda(dim):
    return LAYER_PARAMS[layer_of(dim)][0]

def layer_tau(dim):
    """返回 None 表示该维度不走 Kalman；层应有 τ 却为 None 则 raise。"""
    if dim in NO_KALMAN:
        return None
    tau = LAYER_PARAMS[layer_of(dim)][1]
    if tau is None:
        raise ValueError("%s: layer %s has no tau" % (dim, layer_of(dim)))
    return tau

def test_layer_dims_counts():
    assert {l: len(DIMS_BY_LAYER[l]) for l in LAYER_NAMES} == {
        "body": 6, "core": 3, "appraisal": 7, "motive": 7,
        "relation": 8, "scene": 9, "dyad": 8,
    }
    assert sum(len(v) for v in DIMS_BY_LAYER.values()) == 48

def test_layer_lambda_order():
    lam = {l: LAYER_PARAMS[l][0] for l in LAYER_NAMES}
    # S-046: scene >= body >= appraisal = motive >= core = relation = dyad
    assert lam["scene"] >= lam["body"] >= lam["appraisal"] >= lam["core"]
    assert lam["appraisal"] == lam["motive"]
    assert lam["core"] == lam["relation"] == lam["dyad"]
    assert [l for l in LAYER_NAMES if LAYER_PARAMS[l][1] is None] == ["scene"]

def test_layer_tau_none():
    nulls = sorted(d for l in LAYER_NAMES for d in DIMS_BY_LAYER[l] if layer_tau(d) is None)
    assert nulls == sorted(NO_KALMAN)
    assert len(nulls) == 10  # D27 + D32..D40
    assert layer_tau("D27") is None
    assert layer_tau("D32") is None and layer_tau("D40") is None
    # relation 层有 τ，只有 D27 这一个维度例外
    assert layer_tau("D25") == 120.0

def test_relation_tau():
    for dim in DIMS_BY_LAYER["relation"]:
        if dim == "D27":
            assert layer_tau(dim) is None
        else:
            assert layer_tau(dim) == 120.0
    assert layer_of("D24") == "relation"
    assert layer_lambda("D24") == 0.15
    assert layer_of("Y8") == "dyad" and layer_lambda("Y8") == 0.15

def test_ts_layer_constants_crosscheck():
    """补包 B 第 5 项：TS 侧常量 vs oracle 常量逐项对拍。

    10⁵ 差分跑不到层参数（它只覆盖 ℓ / 量化 / 编码），
    常量的唯一交叉验证就是这份对拍。
    产出文件由 TS 侧 exportLayerConstants() 生成，随代码入库。
    """
    import json, os
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "layer-constants-ts.json")
    with open(path, encoding="utf-8") as f:
        ts = json.load(f)

    assert ts["dimsByLayer"] == {k: list(v) for k, v in DIMS_BY_LAYER.items()}, \
        "DIMS_BY_LAYER 与 TS 侧不一致"
    assert ts["layerParams"] == {
        k: {"lambda": v[0], "tauMin": v[1]} for k, v in LAYER_PARAMS.items()
    }, "LAYER_PARAMS 与 TS 侧不一致"
    assert ts["noKalman"] == sorted(NO_KALMAN), "NO_KALMAN 与 TS 侧不一致"
    assert ts["observeOnly"] == sorted(OBSERVE_ONLY), "OBSERVE_ONLY 与 TS 侧不一致"
    assert ts["privateOnly"] == sorted(PRIVATE_ONLY), "PRIVATE_ONLY 与 TS 侧不一致"

# ---------- 依赖拓扑（补包 B 第二节；白皮书 §1.6） ----------
#
# 层 Kalman 与关系指数 Y* 的**五步顺序**，写在这里是为了让后续 kalman 模块
# 的实现者不必再去翻白皮书：
#
#   ① core 层 Kalman（D07–D09）                      → 供 Y1 / Y2
#   ② relation 层 Kalman（D24–D26, D28–D31；不含 D27） → 供 Y3 / Y4
#   ③ 计算 Y1 / Y2 / Y3 / Y4 / Y7
#   ④ Y1 → 回填 D27
#   ⑤ Y5 / Y6 / Y8（LLM 估计）
#
# 四条约束（实现时不得违背）：
# 1. D27 在 relation Kalman 中被排除的原因是「由步骤④回填」，**不是「缺观测」**
# 2. relation 层 Kalman **不得等 Y1**——Y1 只依赖 core 层（步骤①）
# 3. D27 回填时间点白皮书未说明：先按「**片段封口时回填**」，作为**未决项记入 E-28**
# 4. Y7 的输入（话题发起、提问比例）**不在 Kalman 里**，可**并行**计算，
#    注释不得让人误以为要等 relation 层
#
# 依据（§1.6 原文）：
#   Y1 同频 | [0,1] | 计算 | self 与 user_est 核心情感轨迹的相关度 × 水平接近度
#   Y3 相互亲近 | [0,1] | 计算 | self.D24 · user.D24
#   Y4 亲近不对称 | [−1,1] | 计算 | user.D24 − self.D24
