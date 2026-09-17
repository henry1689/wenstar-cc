# 批次6：砂金库检索逻辑修复

**日期**: 2026-09-17
**流水线**: wenstaros_core_repair_flow.yaml
**S2 审批依据**: 本文件

## 问题诊断

砂金库检索逻辑存在设计缺陷：
- 原逻辑按 `calcium_score DESC` 排序，返回历史高钙化记录（可能是很久以前的内容）
- 用户期望：超出对话窗口后，能回忆**最近的对话上下文**，而非历史重要事件
- 结果：对话组累积了多轮内容，但检索时返回的是无关的历史记录

## 修复方案

### 修改文件：`src/webui/chat/retrieval-stage.ts`

**关键改动**：将排序从 `ORDER BY calcium_score DESC` 改为 `ORDER BY created_at DESC`

```typescript
// 修改前：
_sandQuery += ' ORDER BY calcium_score DESC LIMIT 10';

// 修改后：
_sandQuery += ' ORDER BY created_at DESC LIMIT 10';
```

### 预期效果

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 与徐诗雨聊完多轮后切回 | 显示很久以前的重要对话 | 显示最近一次的对话摘要 |
| 对话组超过10轮 | 检索历史高钙化记录 | 检索最近的对话内容 |
| 上下文连贯性 | 断裂（随机历史） | 连续（最近对话） |

## 影响范围

- **修改文件**: `src/webui/chat/retrieval-stage.ts`
- **仅影响**: 砂金库检索的排序逻辑
- **不影响**: 数据写入、钙化分计算、对话组逻辑

## 验证方法

1. 与徐诗雨连续对话 5-8 轮
2. 切换到玉瑶对话
3. 切回徐诗雨，提问"我们刚才聊什么了"
4. 预期：应能回忆最近的对话内容，而非很久以前的记录
