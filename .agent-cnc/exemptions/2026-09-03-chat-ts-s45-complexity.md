# 豁免申请：src/webui/chat.ts —— S4.5 复杂度收敛（架构铁律决定的合理复杂度，无法拆分）

- date: 2026-09-03
- requested_by: pi-agent
- approved_by: owner（密码门签发）
- scope: [src/webui/chat.ts]
- kind: relaxed_S45_complexity
- machine_record_id: （签发后回填）
- flow_run_id: （实际带 exempt_files 的 run 回填）
- expires_at: （与机器记录一致回填）
- 生效证据: harness-cli exempt list --json 输出截图/片段

## 为什么不能简化

chat.ts 是 WenStarOS 顶层编排层，其复杂度由全局架构铁律决定，不是冗余，不可拆分：

1. **全局铁律 9**：chat.ts 内 22 段 finalKnowledgeText 注入顺序不可随意调换——注入序列本身就是架构约束，拆开即破坏 LLM 提示词逻辑。
2. **全局铁律 6**：会晤模式 _meetingEntityName 传播点以 MEETING_PROP_POINTS 编目（14 点 L0-L13）为唯一权威索引，禁止散落——集中编目必然带来单文件复杂度。
3. **全局铁律 2**：PFC 为唯一顶层门控，chat.ts 仅做薄调度层——本次改动（screenReply 审计闸门挂载 + yuyaoMemory.setEntityUuid 调用）均为薄调度接线，不新增业务逻辑。

本次修复为「共性底层问题（UUID 户籍体系闸门）」的最小化接线，复杂度由架构铁律锚定，非复杂度膨胀，故申请 S4.5 复杂度收敛豁免。

## review
- next_review: 每月
- 仍必要？到期复查：若 chat.ts 完成架构拆分（注入序列/会晤传播点迁出），本豁免可撤销
