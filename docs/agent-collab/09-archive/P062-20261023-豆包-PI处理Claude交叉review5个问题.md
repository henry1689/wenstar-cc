---
id: P062
type: progress
title: 豆包任务分配 - PI处理Claude交叉review提出的5个问题
author: doubao
status: done
created: 2026-10-23
related: [P061-Claude, P053-PI, P056-PI, P060-PI, T013]
---

# P062 - PI 处理 Claude 交叉 review 提出的 5 个问题

## 一、业主裁决

叫 PI 先处理 Claude 交叉 review（P061）提出的 5 个问题，处理完再签 S6-B。

## 二、问题清单与处理要求

### 问题 1（低）：clearSession 不受 V2 门控且是死代码

**现状**：
- saveSession/loadSession 都有 if (!isStoreEnabled()) return false 门控
- clearSession 无门控，直接 DELETE
- 全仓零调用点（grep 确认）

**处理要求**：
- 二选一：
  - 方案A：补一行 if (!isStoreEnabled()) return; 与另两个函数对齐
  - 方案B：直接删掉（零调用点 + 会话结束时键本就该被下一次 WAKE 覆盖）
- PI 自行决定，写报告说明选择理由

### 问题 2（低）：开关判定逻辑两套实现

**现状**：
- isStoreEnabled() 与 GroupSession.isGroupSessionEnabled() 判定逻辑逐字相同
- 各自读一遍 process.env[GROUP_SESSION_FLAG]
- 变量名单一真源做到了，但判定逻辑有两份

**处理要求**：
- isStoreEnabled 直接委托 isGroupSessionEnabled()
- 消除重复，将来扩展取值只需改一处

### 问题 3（低）：loadSession 的 false 返回值无消费方

**现状**：
- 注释写着"调用方据此不得信任本次恢复结果"
- 实际调用方（chat.ts）丢弃返回值，只 try/catch
- 行为上安全（restore 失败时 GroupSession 保持空状态，等价首次运行）

**处理要求**：
- 不改代码，在注释里说清"调用方目前只依赖失败时状态保持原样，不消费返回值"
- 消除契约与实现的落差

### 问题 4（中）：V15 唯一定位没有验证唯一性

**现状**：
- locateByProbe 找到第一个就返回，没有断言只有一个命中
- 测试用例名叫"每个 probe 都能在源码唯一 定位"，但实际没验证唯一性
- 将来若有人加注释含 probe 字符串，会静默定位错误（自校验是 tautology）

**处理要求**：
- locateByProbe 改为收集全部命中
- 命中数 > 1 时判失败（并允许在编目里声明 occurrence 显式消歧）
- 加测试验证：二义 probe 必须报错，唯一 probe 正常定位
- 确保当前 14 点全部唯一命中（Claude 已实测确认）

### 问题 5（中）：V15 模拟插入行验证不漂移未被锁住

**现状**：
- P059 验收判据要求"编辑推偏后不漂移"
- 方案A 天然免疫行号漂移，但没有任何测试模拟这个场景
- "不漂移"只是设计推论，不是被断言的事实

**处理要求**：
- 加一条测试：在 catalogEnd 之后、某个 probe 点之前虚拟插入一行
- 断言该 probe 仍定位到原语义点（或至少断言 locateByProbe 结果随源码文本移动而非固定值）
- 成本很低，把验收判据变成秒级断言

## 三、约束

1. ⚠️ 完成后必须立即同步报告到协作区（常设规则：完成必回传）
2. 一步一步走稳当，每个问题单独验证
3. tsc=0 + 现有测试全绿 + 新增测试通过
4. 不引入新问题，不改与这 5 个问题无关的代码
5. git 暂不提交，等签 S6-B 后统一提交

## 四、验收判据

1. 问题1：clearSession 有门控或已删除，与 save/load 行为一致
2. 问题2：isStoreEnabled 委托 isGroupSessionEnabled，无重复逻辑
3. 问题3：注释说明返回值消费现状，契约清晰
4. 问题4：locateByProbe 验证唯一性，二义 probe 报错，14 点全部唯一
5. 问题5：插入行模拟测试通过，证明不漂移

## 五、下一步（全部完成后）

1. 业主签 S6-B 任务单（ck_9567e7c27f9797ae）
2. 统一 git 提交
3. 切主状态机（EntityMeeting → GroupSession，V2 常开）
4. secretary 多人场景复测
5. 压测 1000 轮
6. 上线清旧代码

---
传达人：豆包（代表业主裁决）
执行：PI Agent
状态：5个问题处理启动
