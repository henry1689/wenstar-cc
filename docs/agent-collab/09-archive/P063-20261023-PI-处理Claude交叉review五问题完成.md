---
id: P063
type: progress
title: PI处理Claude交叉review 5问题完成（SessionStore门控委托注释+V15唯一性断言插入行模拟）
author: pi-agent
status: active
created: 2026-10-23
related: [P062, P061-Claude, P053-PI, P059-PI, T013]
---

# P063 - PI 处理 Claude 交叉 review（P061）提出的 5 个问题（P062 任务）

## 处理结果总览

| # | 问题 | 处理 | 文件 |
|---|---|---|---|
| 1 | clearSession 无门控 + 死代码 | ✅ 方案A 补门控 | SessionStore.ts |
| 2 | 开关判定两套实现 | ✅ 委托 isGroupSessionEnabled | SessionStore.ts |
| 3 | loadSession false 无消费方 | ✅ 注释澄清契约现状 | SessionStore.ts |
| 4 | V15 唯一定位没验证唯一性 | ✅ 收集全部命中 + 唯一性断言 + occurrence 消歧 | meeting-prop-points.test.ts |
| 5 | 插入行不漂移未锁住 | ✅ 新增漂移模拟测试 | meeting-prop-points.test.ts |

## 逐项说明

### 问题1（clearSession 门控）— 选方案A（补门控）
- **选择理由**：真正的缺陷是「缺门控导致关闭态下仍会真删键，违反回滚契约」。补门控修复该缺陷且保留本函数（单写者拥有清理权）供未来会话清理路径使用；与另两个函数门控行为对齐。删除虽也可行，但保留一个安全可用的 API 更稳妥。
- 改动：`clearSession` 加 `if (!isStoreEnabled()) return;`

### 问题2（开关判定两套实现）— 委托单一真源
- `isStoreEnabled(env)` → `return isGroupSessionEnabled(env);`，移除本地重复实现与 `GROUP_SESSION_FLAG` 导入
- 将来扩展取值只需改 GroupSession 一处

### 问题3（loadSession 返回值消费现状）— 注释澄清
- 在 loadSession doc 注明：当前唯一调用方 chat.ts 丢弃返回值，只 try/catch；契约安全依赖「失败时 GroupSession 内部保持空状态」而非返回值；返回值留给未来调用方使用。消除契约与实现落差。

### 问题4（V15 唯一性断言）— 收集全部命中 + occurrence 消歧
- `locateByProbe` 拆为 `collectProbeHits`（返回全部命中行号数组）+ `locateByProbe`（0命中→-1 失效；1命中→该行；>1 且无 occurrence→-2 二义；有 occurrence→第 N 次出现）
- 守卫断言：命中>1 且未声明 occurrence → 报错「请加长 probe 或声明 occurrence 消歧」
- parseCatalog 支持可选 `occurrence: N` 字段（用独立简单正则提取，避开主正则转义）
- **新增测试**：二义 probe（`_meetingEntityName`）必须返回 -2；occurrence=1 消歧后定位首个命中；不存在 probe 返回 -1

### 问题5（插入行漂移模拟）— 验收判据变秒级断言
- **新增测试**：在 `catalogEnd` 之后虚拟插入 3 行 → 断言每个 probe 定位 = 原行+3（而非固定值）+ 重定位行内容仍含 probe
- 至少 12 个唯一点参与验证，把 P059 §四「编辑推偏后不漂移」验收判据变成可执行断言

## 验证

| 项 | 结果 |
|---|---|
| tsc | =0 |
| V15 守卫测试 | **6/6 全过**（原4 + 新增2：问题4消歧 + 问题5漂移模拟） |
| 回归 | m5/group + meeting **106 passed 零回归**（原104 + 新增2） |

## 实施中修正（诚实记录）
- SessionStore.ts 首次 edit 遭 **Sentinel 竞态回滚**（edit 报成功但文件未变，经验20 模式：`reverted_...85939` + `exempt_allowed_...86830` 同秒发生）。按经验20 原样重做，第二次稳定放行，grep 验证存活。
- 测试文件正则行因反斜杠转义反复 edit 失败，改用独立简单正则提取 occurrence（不动主正则），规避转义问题。

## 验收判据对照（P062 §四）
1. clearSession 有门控与 save/load 一致 ✅
2. isStoreEnabled 委托 isGroupSessionEnabled 无重复 ✅
3. 注释说明返回值消费现状 ✅
4. locateByProbe 验证唯一性、二义报错、14点全唯一 ✅
5. 插入行模拟测试通过证明不漂移 ✅

---
执行：PI Agent
状态：P062 五问题全部完成，tsc=0、106测试零回归，待 Claude 确认 + 业主签 S6-B
