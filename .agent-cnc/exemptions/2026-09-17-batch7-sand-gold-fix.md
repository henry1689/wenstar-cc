# 批次7：砂金库P0修复 + topic_label混合策略

**日期**: 2026-09-17
**流水线**: wenstaros_core_repair_flow.yaml
**S2 审批依据**: 本文件

## 目标

修复砂金库三个P0问题 + topic_label混合策略实现。

## 改动清单

### 1. `src/app/vault/MemoryAssessor.ts` — DNA根码继承修复

**根因**：原代码使用 `Date.now()` 生成fallback，导致晋升后 dna_root_id 与实际对话组不匹配。

**修复**：
```typescript
let dnaRootId = String(conv.dna_root_id || '');
if (!dnaRootId && conv.dialog_group_id) {
  // 兜底：从同dialog_group_id的其他记录获取正确DNA
  const groupConvs = sqlite.queryAll(
    'SELECT dna_root_id FROM conversations WHERE dialog_group_id = ? AND dna_root_id IS NOT NULL LIMIT 1',
    [conv.dialog_group_id]
  );
  dnaRootId = String(groupConvs[0]?.dna_root_id || `sand_fallback_${conversationId}`);
}
```

### 2. `src/config/MemoryConfig.ts` — batchSize提升

- `sandToGold.batchSize`: 30 → 100
- 减少晋升积压（原需2.2天清空）

### 3. `src/webui/chat/persistence-stage.ts` — topic_label混合策略

**方案C：关键词优先 + 上下文推断 + LLM兜底**

- Step1: 关键词匹配（扩展至11类：健身/工作/情感/家庭/亲密/知识/健康/日常/学习/娱乐/旅行）
- Step2: 对话组历史推断（短消息继承上下文话题）
- Step3: LLM兜底（异步，返回默认'日常'）

**新增参数**：
```typescript
export interface PersistInput {
  // ... 原有字段
  context?: string[];         // 对话历史
  dialogGroupId?: string | null;  // 当前对话组ID
}
```

### 4. `src/webui/chat.ts` — 传递context和dialogGroupId

```typescript
persistConversation({
  ctx, message, reply, seqPos, dna, p, decision,
  context: ctx.conversationHistory.map(t => t.content).filter(Boolean),
  dialogGroupId: _dg?.id || null,
}).catch(...)
```

### 5. `src/m8/M8FusionAdapter.ts` — 脏值净化

- markScar/promoteMemory 均使用 `sanitizeBelongUuid()`
- 防止字符串 'null' 向 vault_log 传播

## 验收标准

- [x] TypeScript 编译通过
- [x] 相关测试通过（m2: 162, vault: 12, chat: 87）
- [ ] git push 成功
