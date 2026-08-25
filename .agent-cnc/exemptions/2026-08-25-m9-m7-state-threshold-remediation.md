# 豁免记录：P1 M9 状态机与 M7 阈值整改

- 日期：2026-08-25
- 任务：`P1-M9-01`、`P1-M7-01`
- Harness 流程：`wenstaros_core_repair_flow.yaml`，完整执行 S1-S7
- 豁免类型：项目所有者签发的 60 分钟文件级 `edit` 豁免；流程仅通过 `exempt_files` 放宽 S4.5 收敛评分
- 原因：Harness 当前 S4.5 对该仓库存在系统性复杂度基线误判，且 token 写后复检存在 `token_content_changed` 竞态；不跳过 S3/S5 编译与测试

## 豁免文件

- `src/m9/WorkingMemory.ts`
- `src/m7/M7Orchestrator.ts`

测试文件不纳入豁免。

## 限定方案

1. M9 由 `MemoryWriteBuffer` 继续作为 cycle 状态唯一 owner；未毕业条目在第 1～5 轮保留，第 6 轮强制毕业；`flushAll` 明确为立即排空。
2. M7 复用 `M3_CONFIG.calcium.level3Threshold` 作为高钙归纳门槛，禁止新增重复硬编码。
3. 公共 API、数据库结构、UUID/角色边界均不变。

## 验证

- M9 第 1～6 轮状态机测试。
- M7 阈值以下、等于和以上边界测试。
- 既有模块测试、根项目 `tsc --noEmit`、`git diff --check`。
- 不提交、不推送、不重启服务。
