# 豁免记录：P0 隐私门阀整改

- 日期：2026-08-25
- 级别：`S45_WIDE`
- 任务：`P0-PRIV-01`、`P0-PRIV-02`
- 有效范围：仅本次 Harness 流程签发的 60 分钟窗口
- 原因：Harness v2.10 将令牌绑定写入前 `content_hash`，Sentinel watcher 在写入后复用该哈希校验，导致合法修改被判定为 `token_content_changed` 并回滚。使用项目现有的限时文件豁免分支完成已通过 S1-S7 的业务修复，不修改 Harness 自身。

## 豁免文件

- `src/m4/M4Orchestrator.ts`
- `src/m4/household/EntityPrivacyFilter.ts`
- `src/webui/chat.ts`

测试文件不纳入豁免：

- `src/__tests__/entity-privacy-filter.test.ts`
- `src/m4/__tests__/m4-privacy-gate.test.ts`

## 修改目标

1. UUID 门阀必须先于记忆压缩、回调、缓存和 `SceneSnapshot` 构建执行。
2. 门阀异常、ACL 异常、UUID 缺失、来源不可信及空过滤结果均 fail-closed。
3. 恢复 Sentinel 首次回滚前已存在的 `src/webui/chat.ts` 用户未提交改动，不覆盖或丢弃原工作区内容。

## 验证与收回

- 运行两组新增/更新的隐私回归测试。
- 运行根项目 TypeScript 类型检查和 `git diff --check`。
- 核对 `git status`，确认关机前 4 个既有修改仍在且仅增加本轮目标文件。
- 不提交、不推送、不重启服务。
- 限时豁免到期后由 Harness 自动失效；不申请长期豁免。
