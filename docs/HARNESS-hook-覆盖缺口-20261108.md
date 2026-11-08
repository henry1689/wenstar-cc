# Harness hook 覆盖缺口（2026-11-08 实测与修复）

## 1. 现象

本次会话对同一源文件（`src/webui/maintenance.ts`）连续写入 6 次，均成功；
对应 run 的令牌（`cd1nck.json` / `e0e9fe87-….json`）**始终 `consumed=false`、`usage_count=null`**；
当日 `data/audit/bypass` **0 条**记录（若 hook 正常运行，未消费令牌的源文件写入应触发 BYPASS 告警）。

## 2. 根因

- Harness 的 `PreToolUse` / `PostToolUse` 只配置在 **项目级**
  `D:\tools\wenstar-cc\.claude\settings.json`。
- 本次会话的工作目录是 `C:\Users\henry`（用户级 settings.json 的 `hooks` 为空）。
- Claude Code **只加载会话所属项目**的 settings ⇒ 项目级 hooks 从未被加载。

结论：**会话不在项目目录时，Harness 的 hook 层整体静默失效** ——
令牌校验/消费、BYPASS 检测、写入审计全部不执行。MCP 侧的 `harness_run_flow` 仍会跑，
但「拿到令牌 ≠ 写入被消费」这一层完全空转。

历史对照：`data/tokens/*.consumed` 中 2026-11-05 的记录（`file: D:/tools/wenstar-cc/src/...`）
证明 hook 在项目目录内启动的会话中是正常工作的；本次不是判据写错，而是**根本没运行**。

## 3. 影响范围（如实记录）

- 本系列批1–批6 的代码改动，**hook 层写入闸门未生效**（S1–S7 MCP 流水线本身仍按流程执行）。
- 2026-11-08 的 `harness_evolution_analyze` 报出 10 条 `critical`「批量修改攻击：N 个文件在 1 秒内被无令牌修改」——
  正是本次会话的写入轨迹被哨兵记录、但 hook 未拦截的结果。

## 4. 修复（已完成，非补丁）

新增 `hooks/harness-hook-dispatch.cjs`（本项目内，非 Harness 自身代码），并挂到**用户级**
`C:\Users\henry\.claude\settings.json` 的 PreToolUse/PostToolUse：

| 条件 | 行为 |
|---|---|
| 目标路径不在 `D:/tools/wenstar-cc/` 下 | 直接放行（不干扰其它项目） |
| 会话 cwd 已在项目内 | 直接退出 → 交给项目级 hooks（**避免双跑把 `usage_count` 顶到 2 误判 TOKEN REUSED**） |
| 会话 cwd 在项目外 + 项目内文件 | 原样转交 `harness-pre-check.cjs` / `harness-post-check.cjs`，stdout/stderr/退出码透传 |
| 转交失败 | fail-closed（阻断并告警），不静默放行 |

实测三例：
1. cwd=项目内 → 静默 exit 0（不双跑）。
2. cwd=用户主目录 + 项目文件 → Harness 输出原样返回（`{"decision":"approve"}`）。
3. cwd=用户主目录 + 项目外文件 → 静默 exit 0。

⚠️ **用户级 hooks 在会话启动时加载**：本次会话需**重启**后才受新 hook 约束。

## 5. 给 Harness 自进化的建议（未自动应用）

1. **启动自检 hook 是否真的加载**：会话启动时写一个探针文件并检查是否产生 `.consumed` 记录；
   无记录 ⇒ 明确告警「本会话未受监管」，而不是静默运行。
2. `harness_evolution_analyze` 已生成 30 条待确认升级，其中「同一批次 ≥3 个高风险文件 → 自动锁定」
   与本缺口症状一致；建议优先评估。
3. **待验证项**：pre-check 会把绝对路径归一为项目相对路径，post-check 未做同样归一。
   本次缺口的根因是 hook 完全未运行，与此无关；但两脚本的路径口径是否一致值得单独核验
   （若不一致，会出现「令牌能验签但永不被消费」的隐性漏洞）。
