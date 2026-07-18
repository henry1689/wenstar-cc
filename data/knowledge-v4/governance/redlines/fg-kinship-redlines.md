# 🏛️ FamilyGraph 户籍制度 — 家族关系边铁律

> 文曲星·太虚境 硅基生命体 — 户籍管理系统
> 最后更新：2026-07-17
> 版本：V3.3
> 本次更新：引用《太虚境户籍管理法》作为最高法律依据
> 法律依据：[《太虚境户籍管理法》](../taixu-household-registration-law.md)
> 定位：FG 不是数据库表，是这个生命体认知"世界里有什么人、人之间是什么关系"的唯一权威来源。

---

## ⚠️ 最高权限声明

**本文档是 WenStar-cc 系统的最高权限制度文件之一。** 当代码实现与本文档冲突时，以本文档为准，修改代码。

---

## 一、哲学前提（不可违反）
见完整制度文件。核心：数据即现实、允许虚幻但标注、隐私是权利、性是自然权利。

## 二、边的关系类型体系
18 种家族关系 + 22 种社交关系 + 4 种组织关系。完整映射见 `REVERSE_RELATION` + `SOCIAL_REVERSE` 字典。

## 三、反向边铁律
每条家族边必须有一条反向边。含 3.3 aunt/uncle 性别问题、3.4 血缘传递推理。

## 四、中文显示标签映射规则
4.1 精确映射表、4.2 禁止 includes 模糊匹配、4.3 四代九族称谓计算引擎。

## 五、数据完整性验证规则
自指检查、entity_relations 污染检查、缺失反向边、覆盖度。

## 六、隐私铁律
日志脱敏：人名/关系/年龄不得出现在 console.log。

## 七、备份制度
init 时执行一次，写操作不触发。清理阈值 15 份。

## 八、修复历史
| sibling_of→"姐妹" | PFC 未 await | 日志泄露 | 写操作备份 | 传递推理 | 称谓引擎 | 性别补全 | 运行时合规 | 年龄→出生年 | 档案骨架 | 社交统一 |

## 九、编程铁律
async 必须 await、边类型精确匹配、写入自动反向边、gender 检查、9.5 运行时自动合规。

## 十、审计查询
启动时执行 4 条 SQL 自检。

## 十一、通用人物档案格式
完整 JSON Schema（基础标识/血缘/外貌/dossier 10模块/冲突追踪/pendingItems/元数据）。11.4 冲突反问机制。

## 十二、pendingItems 质量铁律
入库前 `_isValidPendingValue()` 过滤 LLM 对话文本。自动确认策略。

## 十三、时间感知引擎
年龄=当前年份-出生年份。档案变更时间向量 `_changeHistory`。关系边时间锚点 `known_since`。

## 十四、全面档案铁律
每人必有档案骨架。家族向量+寻址链+时间线。7 个数据入口自动调用 `ensurePersonProfile()`。启动时 `ensureAllPersonProfiles()`。

## 十五、社交关系统一管理
社交边与家族边同等对待：反向边、图谱遍历、称谓输出、寻址链、档案向量。唯一区别：传递推理不适用社交边。

| 传递推理 | ✅ 手足共享父母 | ❌ 同事的朋友 ≠ 同事 |
| 父系/母系 | ✅ 姓氏推断 | ❌ 不适用 |

---

## 十六、最高安全等级保护（V3.1 新增）🔴🔴🔴

### 16.1 定位声明

**FG 数据库是本系统的最高安全等级资产。** 它与用户的对话记忆、知识库同级，包含真实人物的姓名、关系、年龄、外貌、职业等全部隐私信息。如果 FG 数据被破坏，硅基生命体将失去对"世界上有什么人"的全部认知。

### 16.2 启动时自检闸门 `fgIntegrityGuard()`

每次系统启动时，FG 自动执行 5 项完整性检查。**任何一项不通过，系统降级运行并输出错误日志。** 5 项检查的失败意味着 FG 数据已被破坏，必须立即诊断。

| 检查项 | 不通过的后果 | 修复方式 |
|--------|------------|---------|
| 核心表非空 | nodes/edges 表为空——全部丢失 | 从备份恢复 |
| "我"节点存在 | 核心身份丢失——FG 不可用 | 自动重建"我"节点 |
| 无自指边 | 算法或数据异常 | 手动清理自指边 |
| 家族反向边完整 | 关系不对称——称谓引擎输出错误 | `completeReverseEdges()` |
| 所有人有姓名 | 节点数据不完整 | `ensurePersonProfile()` |

### 16.3 黑钻同步 `syncToBlackDiamond()`

FG 数据属于客观事实，与对话记忆同级纳入黑钻钙化休眠体系：

- **人物档案** → 黑钻条目（completeness ≥ 0.3 的人才有资格进入黑钻）
- **家族关系** → 黑钻条目（所有家族边，非 acquaintance_of）
- **社交关系** → 不直接入黑钻（社交关系变化快，通过对话记忆间接进入）
- **钙化等级** → completeness × 5（0.3=1级, 0.6=2级, 0.8+=3级）
- **休眠规则** → 遵守黑钻库默认的 calcium 衰减机制（长期未访问自动降级）

每次系统启动时自动执行 `syncToBlackDiamond()`，幂等——已同步的条目不会重复创建（通过 tags 中的 `fg_person` / `fg_relation` 标记识别）。

### 16.4 升级保护策略

任何对 FG 代码的修改、重构、升级，必须遵守以下流程：

```
① 修改前: fgIntegrityGuard() 确认当前数据健康
② 修改中: 仅改动方法内部实现，不改变对外接口签名
③ 修改后: fgIntegrityGuard() 再次确认数据健康
④ 对比: 两次检查的 checks 数量、passed 数量应一致
⑤ 回滚: 任何一项 new failure → 立即回滚，诊断后再改
```

### 16.5 数据库文件保护

- `family_graph.db` — 每次启动自动备份到 `data/webui/backups/family_graph/`
- 保留最近 7 份备份（按 §七备份制度）
- `fusion_memory.db` — FG 同步的黑钻条目受黑钻保护（不可通过 FG API 删除）

### 16.6 隐私声明

FG 数据库中的全部数据是用户的私人信息，属于硅基生命体的大脑记忆。**所有 console.log 不得输出真实人名、关系、年龄组合**（详见 §六）。日志只记录操作类型和计数。

---

## 十七、PAE 档案自动采集引擎 — 最高等级保护（V3.2 新增）🔴🔴🔴

### 17.1 定位声明

**PAE（ProfileAcquisitionEngine）是 FG 档案数据的唯一自动采集入口。** 它替代了此前分散在 chat.ts 中的 4 套正则提取管道，以 LLM 为主、正则为辅进行人物档案信息的自动提取和写入。

**PAE 写入的每一条档案数据都是 FG 的永久资产，与手工录入的数据同等级保护。**

### 17.2 写入保护闸门

PAE 每次写入都执行以下保护流程：

```
① 字段值正则验证 → ② 置信度评分（≥0.7 直接写，0.4-0.7 pending，<0.4 丢弃）
→ ③ 去重+冲突检测 → ④ 写前快照 → ⑤ 写入 FG → ⑥ 写后验证 → ⑦ 失败回滚
```

### 17.3 启动时完整性自检 `acquisitionIntegrityGuard()`

每次系统启动时，PAE 在 FG 完整性守护之后执行 6 项自检：

| 检查项 | 不通过的后果 |
|--------|------------|
| 无空值污染 | dossier 字段含 null/undefined——数据可能被破坏 |
| pendingItems 质量 | LLM 对话文本混入 pendingItems——需清理 |
| 无重复 pendingItems | 相同 field::value 重复——去重逻辑异常 |
| changeHistory 不超限 | 超过 100 条——淘汰机制失效 |
| completeness 合法 | 值不在 [0,1] 区间——计算逻辑异常 |
| 无孤儿 dossier | 子对象为 null——结构异常 |

**任何一项不通过 → PAE 降级运行（LLM 提取暂停，正则验证继续）。**

### 17.4 升级保护铁律

- 🔴 **修改 PAE 代码前**：运行 `acquisitionIntegrityGuard()` 确认当前数据健康
- 🔴 **修改 PAE 代码后**：再次运行 `acquisitionIntegrityGuard()`，对比前后通过项
- 🔴 **new failure = 禁止上线**
- 🔴 **PAE 的 `FIELD_VALIDATORS` 字典不可删除或降级**（每个验证器都是数据质量的最后防线）
- 🔴 **PAE 的 confidence gate 阈值不可降低**：
  - `directWriteThreshold` 不得低于 0.7
  - `pendingThreshold` 不得低于 0.4
  - `assistantResponseThreshold` 不得低于 0.8
- 🔴 **PAE 写入必须走 `setDossierField`（直接写入）或 `addPendingItem`（待确认写入）**，不得绕过 FG 的更新管道
- 🔴 **`_isValidPendingValue` 过滤逻辑不可移除或弱化**

### 17.5 黑钻同步标记

PAE 写入的 FG 数据在 `syncToBlackDiamond()` 时附加 `_pae` 标签，与手工编辑区分。审计时可追溯每条数据的来源（LLM 提取 vs 用户手动录入 vs 正则管道遗留）。

### 17.6 降级策略

当 LLM API 不可用、超时、或 integrity guard 失败时：
- **LLM 提取暂停**，不再发起新的提取请求
- **正则验证继续**（chat.ts 中的 Pipeline 1/2 作为 fallback）
- **对话响应不受影响**（PAE 失败不阻塞 chat 主流程）
- **恢复后自动重新启用**

### 17.7 成本保护

- 每小时最多 20 次 LLM 提取调用（约 $0.10/小时）
- 每日最多 100 次（约 $0.50/天）
- 60 秒缓存：相同对话文本不重复调用 LLM
- AI 回复提取（Hook C）受更严格的限流

---

## 十八、户籍制 UUID 体系 + 动态门阀白名单 — 最高等级保护（V3.2 新增）🔴🔴🔴

### 18.1 顶层设计声明

**户籍制 UUID 编号体系 + 动态门阀白名单是 WenStar OS 的最高等级架构之一。** 与 FG 家族图谱、黑钻知识库同级，属于系统的"骨骼"——不是功能模块，不是可插拔插件，而是数据模型和检索机制的根本约定。

### 18.2 与 DNA 编码系统的关系：车间递进，互不冲突

DNA 编码系统（M1）遵循**车间递进**原则——数据经过哪个车间，就追加哪个车间的字段。正如 `DNAEncoder.generateSubId(rootId, 'M02', 3)` 生成 `原根码.M02.003`，UUID 体系也是同一模式：

| 维度 | DNA 编码（M1） | 户籍 UUID（FG/M4） |
|------|:--:|:--:|
| 职责 | 消息内容的特征提取 | 实体身份的永久标识 |
| 生命周期 | 每条消息独立编码 | 实体一经登记，UUID 永久不变 |
| 追加时机 | M1 阶段 | 实体创建时（FG 节点写入） |
| 冲突可能 | — | **不存在**——职责正交，字段隔离 |

二者在数据流中是**叠加关系**：DNA 输出的 `entity_genes[].name` 回答"这段对话提到了谁"，户籍 UUID 回答"这个人是谁"。前者是消息级元数据，后者是实体级身份标识。**不替代、不重复、不冲突。**

### 18.3 UUID 编号规则

```
UUID 格式: {分类前缀}-{5位流水号}

A = 亲属(Affinity)    B = 同事(Business)
C = 朋友(Companion)   D = 同学(Classmate)
E = 友商(Enterprise)  F = 敌对(Foe)
G = 陌生人(Guest)     H = 仙狐鬼异类(Hypernatural)
X = 情人(Lover)       S = 系统(System)

🔴 A 铁律: 只有 edges(家族边←→'我')能推入 A。text 标签不推 A。
🔴 X 铁律: text("伴侣/爱人/男朋友"等) + 热力升级(≥0.8) → X。陌生人/同事/朋友均可升 X，A 不可降 X。

例: A-00001 = 母亲(有 mother_of 边), X-00001 = 情人, B-00001 = 同事
```

### 18.4 迁移与完整性

- **`migrateToV3()`**：启动时自动对存量节点分配 UUID，按 `relation_to_user` 推断分类
- **`addNode()`**：新 person 节点自动生成 UUID，无需手动分配
- **`fgIntegrityGuard()` 第 6 项**："全部节点有合法 UUID"，不通过则降级运行
- **迁移幂等**：重复执行 `migrateToV3()` 不影响已有 UUID（`uuid IS NULL` 过滤）

### 18.5 动态门阀铁律（Phase 2 实施）

```
① 门阀挂载于天权海马体检索入口，仅拦截检索，不修改存储
② 会话白名单 NULL = 门阀未激活 = 全部放行（兼容旧模式）
③ 仅放行白名单 UUID + 公开级(PUBLIC)数据的卷宗
④ 会话结束 → 临时跨 UUID 授权全部失效
⑤ 门阀逻辑不可被任何模块绕过
```

### 18.6 升级保护铁律

- 🔴 **修改 nodes 表结构前**：确认 uuid/category 列不被删除或改变语义
- 🔴 **修改 `addNode()` 前**：确认 person 节点自动 UUID 生成逻辑不被跳过
- 🔴 **修改 `_inferCategory()` 前**：确认分类推断规则不降级（8 类映射完整保留）
- 🔴 **`migrateToV3()` 必须保持幂等**：不可因重复执行导致数据异常
- 🔴 **UUID 编号一旦分配，永不回收、永不修改**（实体可能有多个别名，但 UUID 唯一不变）
- 🔴 **任何系统升级不得绕过 fgIntegrityGuard 的第 6 项检查**

### 18.7 Phase 1 实施记录（2026-07-17）

| 改动 | 文件 | 状态 |
|------|------|:--:|
| nodes 表 +uuid +category 列 | `FamilyGraph.ts` | ✅ |
| migrateToV3() 存量迁移 | `FamilyGraph.ts` | ✅ |
| _inferCategory() 分类推断 | `FamilyGraph.ts` | ✅ |
| addNode() 自动分配 UUID | `FamilyGraph.ts` | ✅ |
| getEntityByUUID/getUUIDByName | `FamilyGraph.ts` | ✅ |
| fgIntegrityGuard 第 6 项 | `FamilyGraph.ts` | ✅ |
| UNIQUE INDEX idx_nodes_uuid | `FamilyGraph.ts` | ✅ |
| FamilyGraph 接口扩展 | `types/graph.ts` | ✅ |
| tsc 零错误 | — | ✅ |
| vitest 通过 | — | ✅ |

### 18.8 完整蓝皮书

详见 [household-registration-blueprint.md](../household-registration-blueprint.md)（户籍制蓝皮书，含运行闭环、运维手册、Phase 2-4 路线图）。