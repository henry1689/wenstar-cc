# Oracle 变更分级与留痕规则（起草）

> **状态：待业主签署。** 本文件由工程方起草（补包 B 第 8 项），
> **只起草，不替业主登记**。签署前 oracle 修改的放行效力受限。

- 起草日期：2026-11-05
- 适用对象：`tests/oracle/` 下全部文件（`oracle_spacestate.py`、`diff_spacestate.py`、
  `oracle-change-log.md`、`test_diff_verdict.py`、`run_oracle_tests.py`、
  `reports/**`、本文件）
- 关联：基线 MD5 `0A693DE23E1937353631526AE565A9D3`

---

## 〇、为什么需要这份规则

oracle 是 **TS 实现的对拍标准答案**。若工程方既能改实现、又能改 oracle，
差分就退化成「自己和自己比」——**任何实现缺陷都可以通过改 oracle 抹平**。
分级的目的是把「标准答案的定义权」与「实现的修改权」分开。

---

## R1 · 工程方可改，但必须留痕

| 类别 | 例子 |
|---|---|
| 常量表 | `LAYER_PARAMS`、`DIMS_BY_LAYER`、`NO_KALMAN`、`OBSERVE_ONLY`、`PRIVATE_ONLY` |
| 层映射表 | 七层的维度归属 |
| 测试用例 | `test_*` 函数、黄金值用例 |
| 日志与格式化 | 打印、缩进、注释 |

**前提**：改动**不得改变 R2 区域的语义**（见下）。若某次「改常量」实际改动了
计算路径，即降级为 R2。

---

## R2 · 必须由 oracle 方出补丁，工程方只读

| 区域 | 说明 |
|---|---|
| 证据公式 ℓ | `dim_evidence` 的对数似然比 |
| 截断 | `CLIP = ±3` 的应用位置（先截断后乘权重） |
| 清洗 | `sanitizeValue` / `sanitize_reading` / E-25 非有限输入规则 |
| 量化与反量化 | `quant_int8` / `dequant_int8` / `encode_pi` / `decode_pi` |
| 融合公式 | `fuse_dim`（多源精度加权） |
| Kalman 公式 | 预测与更新、`p0`、`v̂` |
| **任何数值常量的计算路径** | 取值属 R1，**计算方式**属 R2 |
| **差分脚本的容差判定与采样逻辑** | `diff_spacestate.py` 的容差与采样——否则工程方可放宽容差让差分变绿 |
| **层参数加载断言** | TS 侧 `assertLayerParams` 与 oracle 侧对应校验 |

> 🔴 **判定口径**：改的是「**取什么值**」→ R1；改的是「**这个值怎么算出来的**」→ R2。

---

## R3 · 业主签字

以下任一情形**必须**业主签字后才可落地：

1. 改变任一 **R2 区域的语义**
2. 改变**容差**（含 E-27 混合容差的采纳与取值）
3. **放宽任何断言**（含删除断言、把 `toBe` 改成 `toBeGreaterThanOrEqual`、
   把精确比对改成 `toBeCloseTo` 并加大位数）

---

## 四、留痕规则

每次变更必须记录：

| 字段 | 说明 |
|---|---|
| 文件哈希前后值 | 变更前 / 变更后的 SHA-256 |
| 变更分级 | R1 / R2 / R3 |
| 涉及 S/E 编号 | 如 `S-046`、`E-27`、`E-28` |
| 变更人 | 谁改的 |

**差分报告头必须打印 oracle 哈希**（`diff_spacestate.py` 已实现，运行前/后各一次）。
**哈希与上次放行记录不一致 → 结论标「待复核」。**

---

## 五、同 PR 规则

同 PR 内若同时包含：
- **R1 的 oracle 变更**，以及
- **被该变更验证的 TS 实现变更**

则两者之间**须有第二人看过 oracle diff**（不能是同一人既改 oracle 又改实现）。

---

## 六、删除常量规则

1. **删除导出常量**，必须同步清理**全仓引用**，并搜索其名字在**测试**里的出现
2. 针对已删除常量的测试改为**正向断言**：
   ```ts
   expect('LOCKED_WEIGHT_DIMS' in config).toBe(false);
   ```
3. **禁止**对可能为 `undefined` 的值使用 `Object.isFrozen`、`Object.keys`
   这类「对非对象宽容」的断言——`Object.isFrozen(undefined) === true`，
   断言永远通过却零验证
4. 冻结断言前**必须**先断言 `typeof x === 'object' && x !== null`

> 反面教材（补包 B 第 6 项实际清除的永真断言）：
> ```ts
> const locked = (config as { LOCKED_WEIGHT_DIMS?: readonly string[] }).LOCKED_WEIGHT_DIMS;
> expect(Object.isFrozen(locked)).toBe(true);   // 属性删除后恒真，零验证力
> ```
> 两处根因：① 用可选属性断言绕过类型检查；② 断言对象身份前未证明它是对象。

---

## 七、差分脚本归 R2

`tests/oracle/diff_spacestate.py` 的**容差判定与采样逻辑**属 R2：
- 容差（E-27 混合容差的两个分支与阈值）
- 样本构成（wild 占比、随机种子、各函数抽样数量）
- 通过/失败的判定条件

改动以上任一项需 **oracle 方补丁或业主签字**。
其余部分（打印格式、报告字段增删）属 R1。
