# 太虚境户籍制落地蓝皮书 V4.0

> 法律依据：《太虚境户籍管理法 V2.0》（41条）
> 本文定位：第四效力层级——法律→红线→本文→PAE→代码
> 版本：V4.0（V6 七子卷配套版）
> 日期：2026-07-18

---

## 一、户籍登记表 + 人生卷宗 双分架构

### 1.1 户籍登记表（结构化固定表格）

存储位置：`nodes` 行级列 + `dossier.basicInfo` 当前快照。

| 字段 | 存储位置 | 允许空 | 说明 |
|------|---------|:--:|------|
| TXS-ID | nodes.uuid | ❌ | 终身不变，9位流水号 |
| 法定姓名 | nodes.name | ✅ | 只存本名，不存关系称谓 |
| 别名列表 | nodes.aliases | ✅ | JSON数组，含昵称、曾用名 |
| 实体本源类型 | nodes.entity_source | ❌ | real/ai/fictional/historical/placeholder |
| 实体分类 | nodes.category | ❌ | A/B/C/D/E/F/G/H/X/S |
| 性别 | dossier.basicInfo.gender | ✅ | 待采集 |
| 出生年份 | dossier.basicInfo.birthYear | ✅ | 待采集 |
| 出生地 | dossier.basicInfo.birthPlace | ✅ | 待采集 |
| 学历 | dossier.basicInfo.education | ✅ | 待采集 |
| 所属家庭户 | nodes.family_gene | ✅ | FA01，edges BFS 分配 |
| 所属社团 | nodes.social_group_genes | ✅ | CO01/SC01/WW，edges BFS 分配 |
| 实体状态 | nodes.status | ❌ | active/dormant/archived/deceased |
| 安全密级 | nodes.security_level | ❌ | 1公开/2内部/3私密 |
| 立户时间 | nodes.created_at | ❌ | ISO时间戳 |
| 兜底字段 | dossier.misc | ✅ | 自由格式JSON |

🔴 空白属于合法在册状态。未采集到的信息留空，不编造，不推测。公安不会凭空填写猜测内容。

### 1.2 人生卷宗（七子卷 · 无限增量时序记录）

存储位置：`dossier.*` + `nodes.properties` + `conversations` 表 + `_changeHistory`

| 子卷 | 存储字段 | 规则 |
|------|------|------|
| **子卷① 基础信息** | `dossier.basicInfo` | 性别/出生年/出生地/学历，登记表快照 |
| **子卷② 完整人设** | `dossier.selfProfile` | 性格/外貌/习惯/喜恶/禁忌/语言习惯/健康，PAE 高置信入库 |
| **子卷③ 社会身份** | `dossier.socialIdentity` | 职业时间线/婚恋时间线/当前职业快照 |
| **子卷④ 人生里程碑** | `dossier.lifeMilestones` | 时间排序，每条绑定 sourceRef 佐证索引 |
| **子卷⑤ 绑定典籍** | `dossier.boundDocuments` | TXJ 典籍双向绑定清单 |
| **子卷⑥ 变更流水** | `_changeHistory` | V6 格式：{time, operation, field, before, after, reason, source}，上限 10000 条 |
| **子卷⑦ 兜底杂项** | `dossier.misc` | 无固定归档字段的零散补充信息 |
| **归档旧卷** | `dossier._deprecated` | V6 迁移前的旧模块归档（卷宗只增不删） |

🔴 卷宗只增不删铁律：任何历史记录禁止删除、覆盖、篡改。所有修改以新增记录形式追加。

### 1.3 V6 旧模块兼容

V6 重构将旧 10 模块（contact, lifeResume, imageTraits, personalityPrefs, relationMap, familyNetwork, health, socialCapital, memoryAnchors）标记为 `_deprecated`。旧模块内容已迁移至新七子卷，但原始数据结构保留在 `_deprecated` 中以确保向下兼容。代码中 `PersonDossier` 接口仍保留旧模块的可选字段，新采集优先写入七子卷路径。

---

## 二、UUID 编码规范（V2.0）

### 格式：`TXS-{9位自增流水号}`

分类信息完全移入 `nodes.category` 可变列。分类变了 → 改 category 列 → TXS-ID 不动。

| 分类 | 含义 | 判定来源 |
|:--|------|------|
| A | 亲属 | edges(家族边←→'我') |
| B | 职场 | edges(同事边←→'我') 或 relation 标签 |
| C | 泛社交朋友 | edges 或 relation 标签 |
| D | 校园基础 | edges 或 relation 标签 |
| E | 商业合作 | edges 或 relation 标签 |
| F | 竞争/对立 | edges 或 relation 标签 |
| G | 未分类/陌生人 | 默认 |
| H | 超自然/虚构/历史 | 手动标注 |
| X | 亲密伴侣 | relation 标签 或 热力≥0.8升级 |
| S | 系统实体 | 固定 |

### 旧号兼容

旧版带前缀 UUID（如 `A-00003`）全部存入 `nodes.legacy_ids` 数组。`getEntityByUUID()` 先匹配当前 TXS-ID，未命中则遍历 legacy_ids 重定向。

---

## 三、name 列标准化

### 规则

| 规则 | 说明 |
|------|------|
| name 只存法定本名 | "王全芬""熊勇""徐诗雨" |
| 本名未知时允许留空 | 不填入关系称谓 |
| 关系称谓在 edges 中 | "妈妈" = mother_of 边，"老公" = spouse_of 边 |
| 曾用名/昵称/称谓别名存 aliases | ["芬姐","妈妈","阿姨"] |
| alias 数组自动去重 | 同一实体多称谓合并 |

### fgIntegrityGuard 校验

name 列出现关系称谓（单字亲属词：妈/爸/姐/妹/哥/弟/儿/女/夫/妻等）→ 提示修正。

---

## 四、entity_source 五类

| 来源 | 标识 | 治理规则 |
|------|:--|------|
| real | 现实真实人物 | AI不编造，模糊猜测归PendingItem |
| ai | 原生AI人格 | 基线人设锁定，对话不覆盖 |
| fictional | 虚构/影视/超自然 | 基础设定可导入，交互经历归档 |
| historical | 真实历史人物 | 正史锁定，仅归档交互内容 |
| placeholder | 占位泛称 | 匹配实名后合并，≥3次会晤自动升级 |

### 占位实体自动升级

placeholder 被独立会晤 ≥ 3 次或用户补充真名 → 自动触发合并流程 → entity_source 更新。

---

## 五、废除角色扮演 → 实体会晤

### 核心转变

旧：玉瑶扮演所有人。新：每个人用自己的身份直接对话。

| 旧模式 | 新模式 |
|--------|--------|
| 检测扮演意图 | 检测会晤目标实体 |
| 创建RP分支覆盖FG | 加载目标实体dossier |
| 注入扮演规则 | 门阀设定目标TXS-ID |
| 玉瑶扮别人 | 目标实体本人回复 |
| 退出角色恢复 | 切换会晤对象 |

### 代码层面

V5: 删除 entity_source 中的 roleplay 枚举。
下一轮: 彻底删除 ChatEntry 扮演检测、FamilyGraphRoleBranch、setFamilyGraphOverride、rpJustExited、角色扮演 guard message、roleplay personas。

---

## 六、fgIntegrityGuard 完整性守护（10 项）

每次系统启动时自动执行。对应代码：`FamilyGraph.ts fgIntegrityGuard()`。

| # | 检查项 | 说明 |
|:--|------|------|
| ① | 核心表非空 | nodes/edges 表有数据 |
| ② | "我"节点存在 | 核心身份节点 |
| ③ | 无自指边 | source_id ≠ target_id |
| ④ | 家族反向边完整 | 每条家族边对应反向边 |
| ⑤ | entity_relations 无"姐妹"污染 | 信息输出，不阻断启动 |
| ⑥ | 所有人有姓名 | name 非空 |
| ⑦ | 全部节点有合法 UUID | TXS-9位 或 旧格式 |
| ⑧ | 全部节点有 entity_source | real/ai/fictional/historical/placeholder |
| ⑨ | 全部节点 status 合法 | active/dormant/archived/deceased |
| ⑩ | social_group_genes 非空 | 自由人至少为 "WW" |

### 守护通过判定

10 项全部通过 → `healthy: true` → 系统正常运行。
任何一项不通过 → `healthy: false` → 降级运行，输出错误日志。

---

## 七、acquisitionIntegrityGuard（PAE 专属 6 项）

PAE 启动时在 FG 守护之后执行。对应代码：`ProfileAcquisitionEngine.ts acquisitionIntegrityGuard()`。

| # | 检查项 | 不通过的后果 |
|:--|------|------|
| ① | 无空值污染 | dossier 字段含 null/undefined |
| ② | pendingItems 质量 | LLM 对话文本混入 pendingItems |
| ③ | 无重复 pendingItems | 相同 field::value 重复 |
| ④ | changeHistory 合规 | 每人不超过 100 条（V6 放宽至 10000，但检查仍用 100 警戒线） |
| ⑤ | completeness 合法 | 值不在 [0, 1] 区间 |
| ⑥ | 无孤儿 dossier | 子对象为 null |

任何一项不通过 → PAE 降级运行（LLM 提取暂停，正则验证继续）。

---

## 八、实施路线图

```
Phase 1-4   ✅ 已完成  UUID底座 + PAE + 门阀 + 卷宗 + 热力
Phase 5     ✅ 已完成  5列补齐 + gene码 + 10项守护
Phase V5    ✅ 已完成  UUID去前缀 + name清洗 + 卷宗永久
Phase V6    ✅ 已完成  Dossier 七子卷重构 + _changeHistory V6 格式 + _deprecated 旧模块归档
Phase 6     待实施    交互协议档案 + 系统只读档案 + 授权凭证（AuthorizationCredential）
Phase 7     待实施    档案异议人工复核 + audit_log 审计表
Phase 8     待实施    roleplay代码彻底删除 + 实体会晤框架
```

---

## 九、V6 Dossier 七子卷结构明细

### 子卷① basicInfo（登记表快照）

```typescript
basicInfo: {
  gender?: string;       // "男"/"女"
  birthYear?: number;    // 出生年份
  birthPlace?: string;   // 出生地
  education?: string;    // 学历
}
```

注：V6 将 maritalStatus / zodiac / ethnicity 移入 misc 或 selfProfile。旧字段在 `_deprecated.basicInfo` 中保留。

### 子卷② selfProfile（完整人设）

```typescript
selfProfile: {
  traits?: string[];              // 性格标签 ["开朗","温柔","幽默"]
  appearance?: string;             // 外貌体态描述
  bodyFeatures?: string;           // 身体特征
  style?: string;                  // 穿着风格
  voice?: string;                  // 声音特征
  scent?: string;                  // 气味/香水
  distinguishingMarks?: string;    // 辨识特征（痣、纹身、疤痕）
  likes?: string[];                // 喜好
  dislikes?: string[];             // 排斥
  languageHabits?: string;         // 语言习惯/口头禅
  taboos?: string[];               // 禁忌话题
  healthCondition?: string;        // 健康状况（整合自旧 health 模块）
  feminineDetails?: { ... };       // 女性详细体征（保留原结构）
  pendingItems?: PendingItem[];    // 待确认条目
}
```

### 子卷③ socialIdentity（社会身份）

```typescript
socialIdentity: {
  timeline?: Array<{
    period: string;        // "2023-09 ~ 2026-06"
    role: string;          // "在校大学生，文科专业"
    detail?: string;       // "同班挚友"
    sourceRef?: string;    // 佐证对话索引
  }>;
  currentOccupation?: string;    // 当前职业快照
  currentWorkplace?: string;     // 当前工作单位
  maritalTimeline?: Array<{
    date: string;
    event: string;
  }>;
}
```

### 子卷④ lifeMilestones（人生里程碑）

```typescript
lifeMilestones: Array<{
  date: string;       // "2023-09-01"
  event: string;      // "首次认识，正式建立同学关系"
  type: string;       // 'relation'|'career'|'education'|'life'|'other'
  sourceRef?: string; // 佐证对话/典籍索引
}>
```

### 子卷⑤ boundDocuments（典籍绑定）

```typescript
boundDocuments: Array<{
  docId: string;    // "TXJ-000129"
  title: string;    // "《大学阶段相处记录》"
  type: string;     // 'knowledge'|'task'|'note'|'setting'
  boundAt: string;  // ISO绑定时间
}>
```

### 子卷⑥ _changeHistory（变更流水 · V6 格式）

```typescript
_changeHistory: Array<{
  time: string;       // ISO 时间戳
  operation: string;  // "category修正"|"新建立户"|"字段更新"|"UUID重编号"|"V6迁移"
  field: string;      // 变更字段路径
  before: any;        // 变更前值
  after: any;         // 变更后值
  reason: string;     // 变更原因
  source: string;     // 触发来源 "PAE自动采集"|"用户人工更正"|"图谱同步"|"V5/V6迁移脚本"
}>
```

上限 10000 条，超出时自动归档最早记录至 `_deprecated._changeHistoryArchive`。

### 子卷⑦ misc（兜底）

```typescript
misc: Record<string, any>  // 自由格式 JSON。仅存放无固定归档字段的零散信息
```

---

## 十、不改的部分

- edges 表结构
- PAE / UUIDGatekeeper / RelationHeatTracker
- M1/M3/M4/M5 核心模块
- conversation 表结构（仅追加 belong_entity_uuid 列）
- PersonDossier 接口保留旧模块可选字段（向下兼容，标记为 `_deprecated`）

---

## 十一、运维手册

### 日常巡检

- 启动时自动运行 `fgIntegrityGuard()`（10项）
- 启动时自动运行 `acquisitionIntegrityGuard()`（6项）
- 守护不通过 → 检查错误日志 → 按错误类型修复

### 备份策略

- `family_graph.db` 启动时自动备份至 `data/webui/backups/family_graph/`
- 保留最近 7 份（按 §七备份制度）
- 迁移前必须全量快照

### 回滚策略

- 迁移脚本保留 72h 回滚窗口
- 优先使用迁移前置快照完整恢复
- 无快照时通过 BFS 重建 gene 码 + LLM 重新采集

---

## 十二、技术实现层级（V4.0 新增）

户籍管理体系在代码中的物理组织：

```
src/m4/household/          ← 户籍管理体系（法律定义的技术实现）
├── FamilyGraph.ts          ← 数据持久层（nodes + edges + dossier）
├── UUIDGatekeeper.ts       ← 门阀管控（三层白名单·会话隔离）
├── LifecycleManager.ts     ← 生命周期（四态流转·每日扫描）
├── EntityMeeting.ts        ← 实体会晤（单/多人·会议纪要）
├── MeetingMinutesStore.ts  ← 纪要存储（MD 归档·双向绑定）
├── RelationHeatTracker.ts  ← 关系热力（频次×情绪×衰减）
├── ProfileAcquisitionEngine.ts ← PAE 档案采集（LLM 驱动）
├── EntityContextBuilder.ts ← 会晤上下文（dossier → LLM prompt）
└── prompts/
    └── profile-extraction.ts ← PAE 提取提示词
```

法律定义 → 代码映射：
- 户籍登记表 → nodes 表列 + dossier.basicInfo
- 人生卷宗   → dossier.* 七子卷 + _changeHistory + conversations 表
- 关系网络   → edges 表 + BFS 基因码实时计算
- 门阀管控   → UUIDGatekeeper 三层白名单
- 生命周期   → LifecycleManager + _checkStatusDowngrade
- 档案采集   → ProfileAcquisitionEngine (PAE)
