---
id: P040
type: progress
title: AI-PSI 本地技术验证 — Memory Promotion 链路实测（5/5 通过，去重路径零覆盖）
author: claude-code
status: done_waiting_review
created: 2026-10-21
related: [AI-PSI-DT-019, P039]
---

# P040 · AI-PSI Memory Promotion 链路本地技术验证

**范围**：`D:/projects/ai-psi` 的 `src/ai_psi/phase_one/**` 记忆晋升链路。
**性质**：本次技术验证结果 —— **不是等级证据，不表示生产可用或安全认证**。
**明确不推进**：DT-019 治理任命（仍暂停等业主材料）｜ `E8` 独立复核 ｜ 能力等级认证 ｜ 真实业务接入。

---

## 一、结论摘要

| 项 | 结果 |
|---|---|
| 链路是否跑通 | ✅ **跑通** —— 合成样本 → `ContentGate` → 五路校验 → `propose()` → `promote()` → 内存仓储落库 |
| 用例 | **5/5 通过**（另 case0 合成数据自检） |
| 退出码 / stderr | **0** / **0 字节**，总耗时 977 ms |
| 仓库改动 | **零** —— HEAD `429141b…`、ahead 31、工作树 clean、`__pycache__` 仍 23、近 10 分钟新增 `.pyc` = **0** |
| 🔴 最大覆盖缺口 | **去重路径一次都没执行到**（见 §五 风险 1） |

产物：`D:/tmp/ai-psi-local-validation/`（driver / result.json / stdout / stderr / EXECUTION-RECORD.md，各自 SHA-256 已记）。**未写入仓库。**

---

## 二、执行边界

- 解释器：`.venv` **Python 3.13.2**（`requires-python >=3.12` ✅）
  ⚠️ **系统 PATH 上的 `python` 是 3.11.15，不可用** —— `stores.py` 用 PEP 695 泛型 `class PhaseOneStore[K, T]`，需 3.12+
- 调用：`.venv` **直调**，**未用 `uv run`**（避免触发依赖解析/潜在网络），**未安装任何依赖**
- 样本：全部虚构，**不形似真实凭据**；隐私一例用 `sensitivity="highly_sensitive"` 触发隔离而非凭据拒绝
- 未修改 标准 / `src` / `tests` / 配置 / 历史文件；未暂存未提交未推送

### 隔离措施（三类状态严格区分）

| 状态 | 内容 |
|---|---|
| 🔴 **已阻断** | 网络 —— import 前 patch `socket.socket.connect` + `create_connection`；**主动探测** `127.0.0.1:9` 被拦截抛 `NetworkBlocked` |
| 🟢 **已观测** | 零外部连接尝试（`BLOCK_LOG` **只含那条主动探测**）；零仓库写入 |
| ⚪ **刻意不采信** | `SyntheticDataset.real_high_risk_invocations` 恒为 0 —— **不以固定为 0 的字段证明无外部行为** |

> 隔离的证明方式不是「日志为空所以没事」，而是**故意发一次连接验证拦截生效**。若隔离层失效，探测会以 `OSError` 返回而暴露。

---

## 三、实测支持的安全行为

| 行为 | 实测 |
|---|---|
| 默认拒绝 + 结构化依据 | 错误提交者 → `not_authorized` / **`owner:mismatch`**；角色不符 → **`role:missing_commit`** |
| 越权在碰不到状态前被拦 | 两次拒绝后 `record_count` 与 `fingerprints` **完全不变**（`refused_non_owner` +2 是预期审计痕迹） |
| 门禁确实生效（非链路不通） | 对照实验：正确 owner + `perm:commit` → **committed** |
| 撤销立即生效、无缓冲 | 撤销后同一身份再请求 → `not_authorized` / `权限 'perm:commit' 已被 'synthetic_owner' 撤销（立即生效）` |
| 五路各缺一路全部拦截 | 5 次全部 `nothing_written=true`，原因码 `source:missing` / `privacy:highly_sensitive` / `unobserved:check_not_executed` / `quality:invalid` / `scope:invalid`，**全部结构化** |
| 确定性（**有限定**） | 两独立实例相同输入 → `business_identical=true`、`nondeterministic_differences={}`。🔴 **但见风险 2** |

---

## 四、一次真实的调用约定陷阱

`records.py:647-649`：

```python
expected = request.expected_predecessor
if expected is None:
    return STALE_VERSION, "version:missing"
```

**新建记忆时 `expected_predecessor` 必须传 `0`。** 而 `propose()` 的**默认值恰好是 `None`** → 直接调用会得到 `STALE_VERSION`，链路看起来「不通」。

**不是缺陷**（`None` 语义是「未携带」，代码注释已写明），但**默认值对新建场景不 work**，任何后续调用方都会踩。本次靠 case2 的对照实验才定位。

---

## 五、🔴 任务书可能没想到的风险

### 风险 1（最实质）：**去重路径零覆盖**

case4 的 duplication 变体用 `known_fingerprints=None` 触发的是 **`not_observed` → `INDETERMINATE`**，**不是「检出重复」**。

`records.py:656-657` 的真实去重分支：

```python
if candidate.dedup_key in self.fingerprints:
    return NO_CHANGE, "duplication:duplicate"
```

**本轮从未执行。** 而 `promotion.py:694` 注释写「内容已存在 → `NO_CHANGE`，**不等于失败**（P4 7.3）」—— **「不等于失败」这个语义没有被实测过。**

### 风险 2：**「零非确定性」是 `DeterministicClock` 给的，不是链路本身**

两次时间戳都是 `2026-01-01T00:00:00`，因为 `LongTermMemorySystem` 默认注入 `DeterministicClock`。

正确表述是 **「在确定性时钟下链路可复现」**。若后续任务直接引用「已验证确定性」而不带此限定，属**过度声明**。

### 风险 3：**版本校验在去重之前**

`records.py:642-653`（版本）先于 `:656`（去重）。版本不匹配时返回 `STALE_VERSION` 而非 `NO_CHANGE`。
⇒ **「同内容二次提交」的答复会随版本状态改变**，是否有意为之待确认。

### 风险 4：`AuditLog` 可观测面本身不清楚

本次快照假设了 `ltm.audit.entries`，实际**无该属性** → 记 `null`。
**「审计条目计数不减少」(`MEM-009`) 是核心不变量，但审计的读取接口本轮没摸清，晋升留痕行为未验证。**

### 风险 5：隔离只存在于 driver 层

socket patch 是 driver 加的，**不是被测代码的属性**。若将来 `phase_one` 引入网络依赖，本轮验证**不会自动发现**，须固化成测试。

### 风险 6：`E4` / `E7` 仍无覆盖

只跑了手工构造的示例式验证，未跑 `hypothesis`/`@given`（`phase_one` 内属性测试框架零命中，与 CONTEXT-RECOVERY 一致）；未触及应用栈（`phase_one` 与应用栈互不连通）。

---

## 六、失败与缺口（如实记录）

| # | 项 | 性质 |
|---|---|---|
| 1 | 首 2 次运行失败 —— driver **自身 4 处缺陷**：`validation.verdicts` / `all_five_present` 应为 `.checks.*` 两处；停止规则用 `startswith("127.0.0.1")` 判断而地址串以 `(` 开头，**误把主动探测当成未预期网络尝试**；case5 两次用了不同 `candidate_id`，导致 `memory_id` 差异是**输入差异而非非确定性** | **driver 缺陷，非被测代码问题**；已修并原样留档 |
| 2 | `AuditLog` 条目数未观测 | 观测缺口 |
| 3 | 去重 / 并发 / 多路同时缺失 / 跨版本更新均未测 | 覆盖缺口 |

**未发现**：真实或疑似敏感数据、网络尝试、未授权写入、门禁被绕过。**未触发停止规则。**

---

## 七、建议的下一项工作

**补测去重路径 + `AuditLog` 追加 + 真实时钟对照**（成本低，一次跑完）：

1. `known_fingerprints` 含目标指纹 → 应得 `NO_CHANGE`，且 `record_count` **不变**
2. 先成功提交一次，再用相同内容二次提交 → 观察答复是 `NO_CHANGE` 还是 `STALE_VERSION`（**风险 3 的直接验证**）
3. 读 `AuditLog` 真实 API，核对晋升前后条目数单调不减（`MEM-009`）
4. 用**真实时钟**重跑 case5 与确定性时钟结果对照（**风险 2 的直接验证**）

---

## 八、效力边界

🔴 **本次结果仅表述为本次技术验证结果。**

**不表示**：等级通过 ｜ 生产可用 ｜ 安全认证 ｜ 治理面已实例化 ｜ `E8` 成立 ｜ `L1` 恢复 ｜ 具备试运行条件。

依 `AI-PSI-CAPABILITY-LEVEL-STANDARD-v1.0.0.md:29`「本标准明确**不以文档声明替代运行证据**」，反向亦然 —— **未经非实现方独立复核（`E8`）的本地验证结果，不得升级为等级声明。**

**当前全局裁定仍 `INDETERMINATE`，`GOVERNANCE_AUTHORITY = NOT_ESTABLISHED`，DT-019 仍暂停。**

---

## 九、待办

| # | 事项 | 谁 |
|---|---|---|
| 1 | AI-PSI 新任务书正文未收到（消息未附，仓库/`D:/tmp`/归档均无） | 业主提供 |
| 2 | DT-019 两批材料（业主身份事实资料 + B3 承接人）仍缺 | 业主 |
| 3 | 本报告 §七 的补测是否立项 | 业主 |
