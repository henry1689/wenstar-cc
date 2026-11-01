---
id: P136
type: report
title: dedupePendingItems 数组 value 崩溃修复（normalizePendingKey 签名缺陷，7-19 老 bug）
author: 主任务PI
status: done_waiting_review
created: 2026-10-30
related: [P125, 熊梓铭档案, 隐私红线]
---

# P136 · `value.trim is not a function` 修复报告

> ✅ **执行完成（2026-10-30 17:52）**：commit `d2fb509`（Harness 全10阶段 `run_mvusi35r_597i` + 人工票
> `ck_0c1db745f8825a84` + R4 `ex-883d2cb7`）；tsc=0、新4用例全绿、household 回归 **21文件256/256**；
> 17:55 重启加载，err.log 错误计数基线=5（此后应不再增长，作为生效观察判据）。

## 一、现象与归因

- **现象**：`err.log` 出现 5 次 `TypeError: value.trim is not a function`（`normalizePendingKey` ← `dedupePendingItems` ← `updatePersonProfile` ← `integrateFromEntity`），**5 次全部在 2026-10-30 恢复数据之后**；
- **根因**：`normalizePendingKey(field: string, value: string)` 签名要求 string，但 `pendingItems` 中 `taboos/dislikes/traits/likes` 类的 **value 是数组** → `value.trim()` 抛 TypeError → `dedupePendingItems` 中断 → **该轮档案 pending 写入静默失败**（异常被 catch，聊天不中断）；
- **引入时间**：`6ac709b`（2026-07-19，V4.0）——**3 个多月的老缺陷**；
- **与 10-30 恢复的关系（如实）**：恢复使熊梓铭节点数组条目从 1 条回到 5 条，**扩大了触发面**；恢复前为何无记录（当日早间会话可能未走该 PAE 路径）日志无法证明——根因是老签名缺陷，非恢复引入。

## 二、同族审查（举一反三）

- `FamilyGraph.ts:629` 同款 `value.trim().length` —— 调用方（`isInvalidProfileSnippet` 于 updatePersonProfile filter 中）**恒传字符串**（appearance/workplace 字段），无实证风险 → **不动**（防扩大变更面）；
- 全仓 `normalizePendingKey` 调用点唯一（2763，传全量 pendingItems）→ 修复点唯一。

## 三、修法

`normalizePendingKey` 放宽为 `value: unknown`，非字符串走 `JSON.stringify` 归一：

```ts
const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
return `${field}::${s.trim().replace(/\s+/g, ' ')}`;
```

去重语义不变（同 field+同值 → 同 key）；数组条目获得稳定 key。

## 四、回归测试（新）

`src/m4/household/__tests__/pending-dedupe-array-value.test.ts`：
1. 数组 value 条目过 dedupe **不抛**；
2. 同 field+同数组去重合并（occurrences 合并）；
3. 字符串条目行为不变（原语义回归）；
4. **生产复现路径 smoke**：带数组 pending 的节点走 `updatePersonProfile`（原 5 次崩溃路径）→ 不抛、pending 保留。

## 五、合规

Harness 全流程（run_flow + 人工票 + R4 豁免 `ex-883d2cb7`）；改动仅 `normalizePendingKey` 函数体 + 新测试；隐私红线遵守（报告不含任何实体信息内容）。
