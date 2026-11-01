---
id: P061
type: progress
title: Claude 交叉 review PI — R1 单写者 / 多人会晤实测报告 / V15 方案A
author: claude
status: done
created: 2026-10-23
related: [P059, P053-PI, P056-PI, P057-PI, T013, ADR-013]
---

# P061 · Claude 交叉 review PI 的三项产出

- 日期：2026-10-23
- 依据：P059 §二「交叉 review」— Claude 负责 review PI
- 被审对象：`SessionStore.ts`（P053-PI）、多人会晤生产实测报告（P057-PI）、V15 方案A（P056-PI 评估 + P059 任务1 实施）
- 方法：**读代码 + 实跑验证**（tsc、14 点 probe 唯一性统计、104 例测试），不是只读文档

---

## 〇、先认领一件事：P057-PI 记录的生产事故是我的

P057-PI §一 记录了服务崩溃重启循环（restarts 83→1264），根因是
`GroupSession.ts:141 Unexpected "finally"`。

**那是我造成的。** 我在 P055 任务1 加 M 层埋点时，`try/finally` 包裹把 `return next;`
写进了 `for` 内部导致语法错误，而我修这个错误期间仓库一度处于**不可编译态**；
PI 的重启恰好在那个窗口强制重读，把中间态暴露成崩溃循环。

我已完成修复（10:06:33，见 P057 §四「令牌坑」），崩溃循环自动终止。
PI 记录准确、归因清楚（「PI 未碰该文件（一人一车道）」），且确认了纯解析期失败、不碰数据库、
无数据损坏 —— **这份诚实记录对定位帮助很大，没有它我要多花很久才能对上时间线**。

教训在我这边：**改共享仓库里的源码时，中间态会实时暴露给并行的同事**。
下次遇到「必须重签令牌才能修」的中间态，应优先把文件恢复到可编译态（哪怕先删掉新加的块），
再重新实施，而不是让它停在语法错误态等下一张令牌。

---

## 一、R1 单写者（`src/m5/group/SessionStore.ts`）— ✅ 认可，3 个非阻塞问题

### 做对的部分

| 判据 | 结论 |
|---|---|
| 职责单一 | ✅ 只管 `group_session_state` 一个键，不新增表、不动库结构 |
| 整份拒绝语义 | ✅ `restore` 失败返回 false 且**状态保持原样**（不半恢复），`loadSession` 把 false 原样上抛 |
| engine_store 键隔离 | ✅ 键名 `group_session_state` 与既有键（emotion / daily / black_diamond_password…）无冲突，已逐个核对 |
| 数据零写入约束 | ✅ 只 INSERT/DELETE 自有键，不 UPDATE/DELETE 任何既有行 |
| writeRaw 参数风格 | ✅ **查过真实签名**：`SQLiteAdapter.writeRaw` 显式兼容 `writeRaw(sql, [a,b])`（`params.length===1 && Array.isArray(params[0])` 时展开），PI 用数组风格合法 |
| 失败不伤主链路 | ✅ save/load 均 try/catch + warn，返回 false 不抛 |

### 问题 1（低）：`clearSession` **不受 `WS_GROUP_V2` 门控**，且是死代码

```ts
saveSession   → if (!isStoreEnabled()) return false;   // 有门控
loadSession   → if (!isStoreEnabled()) return false;   // 有门控
clearSession  → （无门控）                              // ⚠️ 直接 DELETE
```

注释说「关闭时 save/load 均为空操作（no-op），与改动前逐字一致 —— 回滚 = 关开关」，
但 `clearSession` 不在这个承诺内：**开关关闭时它仍会真的删键**。

已实测确认：**全仓零调用点**（`grep clearSession` 在 m5 内只命中定义，
其余命中是 `GoalStack.clearSession` / `gatekeeper.clearSessionEntities` 等同名不同物）。
所以当前不构成事故，但它是「将来若有人直接调用就会踩」的地雷。

**建议**：要么补一行 `if (!isStoreEnabled()) return;` 与另两个函数对齐，
要么直接删掉（零调用点 + 会话结束时键本就该被下一次 WAKE 覆盖）。

### 问题 2（低）：开关判定逻辑**两套实现**

`isStoreEnabled()` 与 `GroupSession.isGroupSessionEnabled()` 判定逻辑逐字相同，
各自读一遍 `process.env[GROUP_SESSION_FLAG]`。而 `GROUP_SESSION_FLAG` 的注释自己写着
「开关环境变量名（单一真源）」—— 变量名单一真源做到了，**判定逻辑却有两份**。

将来若扩展取值（比如支持 `yes`），要改两处、且很容易只改一处。

**建议**：`isStoreEnabled` 直接委托 `isGroupSessionEnabled`。

### 问题 3（低）：`loadSession` 的 false 返回值**没有消费方**

注释写着「调用方据此不得信任本次恢复结果」，但实际调用方（chat.ts）是：
```ts
try { loadSession(ctx.storage?.getSQLite?.(), ctx._groupSession); }
catch (_e) { console.warn('[GroupShadow] R1 恢复异常（非阻塞）:', ...); }
```
**返回值被丢弃**，契约有声明无消费者。

好在行为上是安全的：restore 失败时 GroupSession 内部保持空状态，投影会从空状态 WAKE，
等价于「首次运行」。所以这不是缺陷，是**契约与实现的落差**，值得在注释里说清
「调用方目前只依赖失败时状态保持原样，不消费返回值」。

---

## 二、多人会晤生产实测报告（P057-PI）— ✅ 认可，诚实保留项**合理**

### 核心行为验证：充分

八项验证点都有**生产日志证据**（`dispatch action=WAKE/SPEAK participants=3,4`、
`speakerChanged`、`UUIDPolice screenContext 过滤 4/13 行`、`GroupShadow 玉瑶现场已恢复=true`、
`engine_store` 键 `valueLen=656`），不是文档推演。

### 两条诚实保留：都合理，不夸大

1. **「日志窗口混入脚本外活动，无法 1:1 对齐」** —— 合理。
   宁可承认「核心架构行为已确证、逐场景对齐未做干净复测」，
   也不说「5 场景 1:1 全过」。这正是我要的诚实度。

2. **「`role=secretary` 待核实」** —— **这条保守是对的，我可以补一个信息但不推翻它**：
   昨天 P054 我在**单人**会晤场景实测过同一判据，结论是缺陷③已修复 ——
   退出后日志是 `role=recaller`（复原进入前角色），而非硬置 secretary。
   但 PI 的场景是**多人**会晤，我没有在多人场景验证过。
   所以 PI 说「单行日志无法区分、本报告不声称该缺陷已修复」是准确的，
   建议闭环时按同样方法在多人场景复测一次即可（方法在 P054 有）。

**结论**：不打包认可，两点保留应保留到完成干净复测为止。

---

## 三、V15 方案A（P056 评估 + P059 任务1 实施）— ✅ 实施正确，2 个守卫缺口

### 我在审评估时担心的一点，PI 的实现**规避了**

P056 §二 实测 L1 的 probe `getEntityName()` 有 7 个命中、L10 有 2 个，
评估建议「L1 用 `occurrence` 或加长 probe」。

我当时认为 **`occurrence` 是个陷阱**：它只是把「行号漂移」换成「序号漂移」——
一旦在前面插入新的 `getEntityName()`，第 N 次出现的位置就错了，而且错得比行号漂移**更隐蔽**
（行号漂移守卫会报，序号漂移可能静默定位到错误的点）。

**实际实施用的是加长 probe 唯一化**：
- L1：`getEntityName()` → **`const _activeMeetingName`**（汇聚点，区别于 entry 侧快照）
- L10：`ctx.masterProfile && !_meetingEntityName` → **`if (ctx.masterProfile && !_meetingEntityName) {`**

这个选择比评估里的 `occurrence` 更稳，**方向对**。

### 实测验证（不只读代码）

| 项 | 结果 |
|---|---|
| 编目 14 点 probe 在 `catalogEnd` 之后的真实命中数 | **全部 = 1**（无二义） |
| 守卫测试 | 4 例全过 |
| `m5/group` + 编目守卫 | **104 例全过**（5 文件） |
| tsc | **0 错误** |

`locateByProbe` 从 `catalogEnd` 起搜索，正确排除了编目自身的匹配
（`const _activeMeetingName` 全仓 3 处命中：编目注释 :396、编目数组 :401、真实点 :612 ——
前两处在 `catalogEnd` 之前被排除，定位到 612 正确）。

### 问题 4（中）：标题宣称「唯一定位」，但**没有验证唯一性**

测试第 98 行用例名叫「每个 probe 都能在源码**唯一**定位」，
但 `locateByProbe` 的实现是：
```ts
for (let i = catalogEnd; i < src.length; i++) {
  if (src[i].includes(probe)) return i + 1;   // ← 找到第一个就返回
}
```
**没有断言只有一个命中。**

后果：将来若有人在 chat.ts 里加一行注释恰好含某个 probe 字符串（比如 `orchestrate(ctx_m4`），
`locateByProbe` 会定位到那行注释，而第 107 行的自校验 `src[lineNo-1].includes(probe)` **必然通过**
（它是 tautology —— 定位依据和校验依据是同一个条件）。测试静默绿灯，定位却已错。

**建议**：把 `return i + 1` 改成收集**全部**命中，命中数 > 1 时判失败
（并允许在编目里声明 `occurrence` 显式消歧，而不是靠「第一个」隐式消歧）。

### 问题 5（中）：P059 验收判据要求的「模拟插入行验证不漂移」**未被锁住**

P059 §四验收判据 1 原文：「14点 probe 定位正确，**编辑推偏后不漂移**，tsc=0，测试全过」。

方案A 天然免疫行号漂移（不依赖行号），这是对的；但**没有任何测试模拟这个场景**，
所以「不漂移」只是设计推论，不是被断言的事实。

**建议**：加一条测试 —— 在 `catalogEnd` 之后、某个 probe 点**之前**虚拟插入一行，
断言该 probe 仍定位到原语义点（或至少断言 `locateByProbe` 的结果随源码文本移动而非固定值）。
成本很低，但能把「验收判据」变成「秒级断言」。

---

## 四、签字意见

**✅ 有条件认可。**

- **R1 单写者**：实现正确，可进入下一步。问题 1–3 均为低优先级建议，不阻塞。
- **多人会晤实测报告**：核心行为验证充分，两条诚实保留**应当保留**，待干净复测后再闭环。
- **V15 方案A**：实施正确，14 点实测全部唯一定位，方向（加长 probe 而非 occurrence）对。
  问题 4、5 是**守卫自身的缺口** —— 不影响当前正确性，但会削弱方案A 长期的防漂移能力，
  **建议在切主前补上**（成本很低）。

### 交给 PI / 豆包决策

1. 问题 1（`clearSession` 无门控 + 死代码）—— 补门控还是删，PI 定
2. 问题 4、5（唯一性断言 + 插入行模拟）—— 建议 PI 在 V15 方案A 收尾时一并补
3. `role=secretary` 多人场景复测 —— 需要开启 `WS_GROUP_V2` 的干净窗口
4. **`WS_GROUP_V2` 当前是否仍为 1**（P057-PI §六 说待业主裁决；P059 §二任务3 分给 PI 恢复关闭）—— 我未介入共享架构状态

代码**未 commit**（等 S6-B 后统一提交，P059 §五 已定）。
