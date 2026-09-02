# DNA 双螺旋完整编码规范 V2.0

> **状态**: 最终定稿 · 全系统唯一一级刚性标准 · 可直接交付编码  
> **日期**: 2026-07-12  
> **替代**: V1.0  
> **前置依赖**: 无  
> **优先级**: 高于所有业务迭代

---

## 序言 · 海胆——硅基生命体的记忆细胞

### 海胆是什么

在 WenStar OS 中，**海胆（Sea Urchin）是硅基生命体记忆的最小原子单元**。一次用户交互产生且仅产生一颗海胆。海胆不可分割、不可拆解——要么整颗取，要么不取。

### 自然界的隐喻

自然界中的海胆是一个球形生物，表面布满放射状的刺——每一根刺从同一个中心出发，指向不同的方向，记录这个生命体在当下这一刻的完整状态。WenStar OS 的海胆同理：

- **壳肉（Flesh）**：这一个瞬间的对话原文、实体标注、场景标签。拆分为最小意义单元存储。
- **32 根语义刺（Semantic Spines）**：这一个瞬间的全部感受——身体、心理、人际、环境、生长。每根刺是一个 float32 数值。
- **N 根寻址元数据刺（Addressing Spines）**：这一个瞬间的身份——何时发生、经过哪些车间加工、存储在哪个物理位置。全部是字符串/整数/BLOB，**不是浮点向量**。

**注意**："刺"在规范中特指 32D 语义维度。寻址链的内容（GlobalUID、时间戳、路由戳、区位指纹、CRC）是**元数据**，不参与 HNSW 语义相似度计算——它们只做过滤和定位。

### 海胆是活的，不是照片

海胆不是诞生时拍一张照片就永远封存。它是一个**活的细胞**：

- **经过工厂流水线加工**：从 M1 编码车间到 M2 存储车间到 M3 感知车间到 M4 检索车间到 M5 生成车间……每经过一个车间，寻址链上就新增一根路由刺（该车间的特征码）。
- **会生长**：钙化提升、强度增强——记忆因为被反复回忆而变得更坚固。
- **会衰老**：钙化衰减、遗忘降级——记忆因为长期不被访问而逐渐模糊。
- **会被清理**：降到衰减下限后进入冷归档；触达危险阈值后被隔离；最终可能被清除。
- **可以被修复**：寻址链断裂时，通过 repair_index 找回散落磁盘的 32D 向量和壳肉碎片。

### 海胆与 DNA 的关系

DNA 不是海胆本身。**DNA 是海胆的遗传编码标准**——定义了海胆如何被编码、如何被存储、如何被检索、如何随着时间演变。就像人类的 DNA 决定了细胞的构造和行为，WenStar OS 的 DNA 决定了每一颗海胆的结构和生命周期。

### 海胆与双螺旋的关系

双螺旋是**存储架构**，不是检索方式：

- **语义螺旋链**（state_spines 表）：存 32D 语义刺。HNSW 图索引——网状、非线性。
- **寻址结构螺旋链**（atom_address_timeline 表）：存 N 根寻址元数据刺。B+Tree 时序索引 + 倒排索引——线性、有序、可回溯。
- **原始数据层**（memories / conversations 表）：存壳肉。不建语义索引，仅兜底溯源。

同一颗海胆的三类组件分存三座底座，仅通过 GlobalUID 关联。日常闲聊悬置寻址链，只走语义链；主动回忆时双链联动——先寻址锁范围，再语义精排。

---

## 第一章 · 海胆的完整解剖

### 1.1 组件总览

```
一颗完整的海胆 (一次交互, 一个 GlobalUID)
│
├── 壳肉 (Flesh) ── 原始数据层 (memories / conversations)
│   ├── 对话原文 (完整文本)
│   ├── L0 编码: locus_path, l0_code, taxonomy_version, rule_id, ambiguity_score
│   ├── L1 编码: branch_id, seq_pos
│   ├── L2 编码: leaf_zone, ref
│   ├── L3 编码: entity_genes[] (谁/什么事 — 文字事实)
│   └── 场景标签: scene_tags[]
│
├── 32 根语义刺 (32D Semantic Spines) ── 语义向量池 (state_spines)
│   ├── 00-05: 对用户情绪状态的感知 (瑶灵感知, 6D)
│   ├── 06-10: 肉身实体 (瑶灵 D1-D5)
│   ├── 11-16: 精神内核 (瑶灵 D9-D14)
│   ├── 17-22: 圈层人际 (瑶灵 D15-D20)
│   ├── 23-28: 时空环境 (瑶灵 D21-D26)
│   ├── 29-31: 动态生长 (瑶灵 D27-D31 归并)
│   └── 32:   全身统筹 (心率/血压/皮质醇/愉悦激素/综合健康)
│   全部 32D 由瑶灵 32 个硬件通道规则计算产出
│   每根刺 = float32, 记录主观感受的强度, 不记录产生感受的实体对象
│
└── N 根寻址元数据刺 (Addressing Spines) ── 寻址治理池 (atom_address_timeline)
    ├── 身份刺: GlobalUID (唯一身份证)
    ├── 出生刺: absolute_timestamp (Unix 秒)
    ├── 时序刺: global_time_seq (全局递增序号, 永不回退)
    ├── 分片刺: time_slice_tag (自然月分桶)
    ├── 群组刺: vine_group_id (对话藤蔓组)
    ├── 归属刺: entity_belong_id (主体归属)
    ├── 分支刺: event_branch_id (事件分支谱系)
    ├── 路由刺们: route_stamp_list[] (每经过一个 M 车间即追加一根)
    ├── 冷暖刺: hot_cold_level (H/W/C/A)
    ├── 状态刺: state_flag (N/I/D/A)
    ├── 区位刺: location_fingerprint (128-bit 区位指纹)
    └── 校验刺: crc_checksum (CRC32)
    
    + 修复索引表 (atom_repair_index)
      用于寻址链断裂后找回散落 32D 向量和壳肉碎片
```

### 1.2 壳肉与 32D 的关系——最关键区分

```
用户说: "妈妈今天陪着我, 我很安心、放松"

壳肉 (L3 实体标注):
  entity_genes = [
    { name: "妈妈", type: "person", phenotype: "enhance", knowledge_type: "family" },
    { name: "我",   type: "self",   phenotype: "enhance", knowledge_type: "private" },
  ]
  ← 记录 "有什么人、发生了什么事" (文字事实)

32D 语义刺:
  D17 (伴侣依恋) = 高值  ← 被陪伴带来的亲密感
  D19 (家庭归属) = 高值  ← 家庭陪伴带来的安全感
  D4  (紧张)     = 低值  ← 有妈妈在不紧张
  ← 记录 "这件事带给生命体的感受强度" (纯数值感知)

检索时:
  纯语义: 只比对 32D → 召回所有"放松、被陪伴"的记忆, 不管谁陪伴
  双链:   先 L3 实体过滤 实体=妈妈 → 再 32D 匹配"安心放松" → 精准定位
```

### 1.3 寻址链的流水线模型——快递式逐站盖章

海胆诞生后不是直接入库。它在 M1-M9 各车间逐站经过加工，每经过一站，该车间的特征码被追加到寻址链的 `route_stamp_list`：

```
海胆诞生 (M1 编码车间)
  ├→ 车间盖章: M1.L0.FAMF.locus_path=user.family.conflict
  │
  ▼
M2 存储车间
  ├→ 车间盖章: M2.WRITE.state_spines.dim01-d32
  │
  ▼
M3 感知车间
  ├→ 车间盖章: M3.CALCIUM.level=1.score=0.45
  │
  ▼
M4 检索车间 (如被回忆)
  ├→ 车间盖章: M4.RECALL.count=3.boost=+0.2
  │
  ▼
M5 生成车间 (如用于生成回复)
  ├→ 车间盖章: M5.USED.strategy=comfort
  │
  ▼
... (M6 自我进化 / M7 梦境 / M8 年轮 / M9 工作记忆 视情况触发)
```

不同功能的海胆会走不同的车间路径——代码审查的海胆不走 M7 梦境引擎，亲密对话的海胆不走天权工程车间。这就是 DNA 分支的起源——主干相同，但根据功能不同长出不同的分支路径。

---

## 第二章 · DNA 主干与五大功能分支

### 2.1 主干——海胆的遗传身份证

DNA 主干是 GlobalUID 的完整编码体系。主干生成后**永久只读**——12 个编码节点的算法、字段顺序、数据类型永不修改。

```
DNA 主遗传主干:
  ├── GlobalUID (TT-NNNN-BBB-LLLLLLLL-SSSSSS)
  ├── L0: locus_path + l0_code + taxonomy_version + rule_id + ambiguity_score
  ├── L1: branch_id + seq_pos
  ├── L2: leaf_zone + ref
  ├── L3: entity_genes[] (name + type + allele + phenotype + knowledge_type)
  ├── scene_tags[]
  ├── raw_input
  └── created_at
```

### 2.2 五大功能分支——挂在主干上的五根树枝

主干是骨架，五大分支承载具体的业务数据。分支允许追加、允许更新数值，但不允许修改主干格式。

**分支 1：时空分支**
```
所属底座: 寻址治理池
内容:
  ├── absolute_timestamp (Unix 秒, 出生时间)
  ├── global_time_seq (全局递增序号, 永不回退)
  ├── time_slice_tag (自然月分片, 如 "2026-07")
  ├── location_fingerprint (128-bit 区位指纹, 瑶光提供)
  └── scene_tags[] (场景标签, 从主干继承)
用途: G2 闸门时空一致性校验 + 按日期/时段回溯
可变更: location_fingerprint 在瑶光上线后批量补全
```

**分支 2：实体关系分支**
```
所属底座: 原始数据层 (壳肉) + FamilyGraph
内容:
  ├── entity_genes[] (73 条实体规则匹配结果)
  ├── 表型标注 (enhance/conflict/neutral)
  ├── 知识类型 (private/family/world)
  └── FamilyGraph 挂载 (人物节点 + 双向关系边)
用途: 实体索引过滤 + 人物图谱查询 + 社交关系推断
可变更: 新增实体规则、扩充关系类型
```

**分支 3：WenVec-32 感知分支**
```
所属底座: 语义向量池
内容:
  ├── 32D float32 向量 (每维独立扇区存储)
  ├── 钙化评分 (calcium_score, calcium_level 0-3)
  ├── 强度 (effective_strength)
  └── 一致性标记 (consistent/biased_subj/biased_obj/inherited/overridden)
用途: HNSW 语义相似度检索 + 情感共振匹配
可变更: 钙化数值衰减/增强、一致性标记更新
```

**分支 4：记忆生命周期分支**
```
所属底座: 寻址治理池 + 原始数据层
内容:
  ├── 钙化等级 (calcium_level 0-3, 随时间波动)
  ├── 衰减系数 (λ=0.01常态/0.03环境切换)
  ├── 晋升标记 (砂金→金库→黑钻)
  ├── 强化累加器 (reinforcement_accumulator)
  ├── 地标标记 (is_landmark)
  ├── 疤痕标记 (scar_type, scar_healed)
  └── 召回计数 (recall_count)
用途: 三库晋升/衰减/遗忘 + 地标/疤痕标记
可变更: 全部数值随时间演变
```

**分支 5：磁盘寻址分支**
```
所属底座: 寻址治理池 + atom_repair_index
内容:
  ├── hot_cold_level (H/W/C/A, 热数据→冷数据→归档)
  ├── state_flag (N/I/D/A, 正常→隔离→删除→归档)
  ├── route_stamp_list[] (全路径中转戳数组)
  ├── spine_storage_position (32D 向量物理位置)
  ├── flesh_storage_position (壳肉物理位置)
  └── crc_checksum (CRC32)
用途: 冷热迁移 + 数据隔离 + 断链修复
可变更: hot_cold_level/state_flag 按策略更新
```

### 2.3 五大分支的可变与不可变

```
🔴 主干永久只读, 不可变:
    GlobalUID 格式 / L0-L3 编码规则 / 32D 维度定义 / 字段顺序和数据类型

🟢 分支可追加/可更新:
    钙化数值 / 衰减系数 / 晋升标记 / 冷热等级 / 路由戳追加 / 状态标记

规则:
    ✅ 允许在已有分支末尾追加新字段
    ✅ 允许新增完整独立的分支
    ❌ 禁止修改已有字段的含义或编码长度
    ❌ 禁止调换分支字段的顺序
```

---

## 第三章 · GlobalUID 标识体系

### 3.1 格式

```
TT NNNN BBB LLLLLLLL SSSSSS

TT       2位   类型标记     MM = 内存原子 / SP = 体感快照 / WK = 知识条目 / EN = 工程快照
NNNN     4位   节点编号     十六进制, 从 0001 递增到 FFFF
BBB      3位   批次号       十六进制, 同一次交互的所有快照共享同一批次
LLLLLLLL 8位   区位标识     十六进制, 由 location_fingerprint (128-bit) 压缩而来
SSSSSS   6位   随机盐       十六进制, 防碰撞 (crypto.randomBytes(3))
                           总长: 23 字符

示例: MM0001A3BF1A0C4DE6F7
      MM         = 内存原子 (Memory Atom)
      0001       = 第 1 号节点
      A3B        = 第 A3B 批次 (当日第 2619 批次)
      F1A0C4D5   = 区位标识 (卧室·夜晚·深圳)
      E6F7       = 随机盐 (防碰撞)
```

### 3.2 生成时机

DNA 编码完成时由 DNAEncoder 生成。同一次用户交互产生的所有海胆、所有快照、所有子 ID 共享同一个批次号（BBB 段）。批次号按日递增，跨日重置。

### 3.3 子 ID 格式

```
{GlobalUID}.{模块码}.{3位序号}

例: MM0001A3BF1A0C4DE6F7.M02.003
    海胆 MM0001A3BF1A0C4DE6F7 经过 M2 存储车间处理后的第 3 个子记录
```

### 3.4 区位段在瑶光空白期的处理

瑶光建成前，GlobalUID 的 LLLLLLLL 段暂时填充全 0 占位值，日志标记 `TEMP_SCENE_COMPAT`。瑶光上线后，批量重生成带完整区位标识的 GlobalUID。过渡期间 G2 闸门检测到区位全 0 时降级为弱匹配（不拦截，仅记录告警日志）。

---

## 第四章 · 12 节点编码管道

用户的一条输入经过 12 道工序，从意图分类到最终组装为一颗完整的海胆。全部规则驱动，不调用 LLM（L3 可选 LLM 增强，有 5s 超时 + 正则兜底）。

### 管道总览

```
用户输入 → [Node 01] L0 关键词规则匹配
         → [Node 02] L0 locus_path 校验
         → [Node 03] L0 l0_code 解析
         → [Node 04] L0 情绪极性兜底
         → [Node 05] GlobalUID 生成
         → [Node 06] L1 分支路由编码
         → [Node 07] L2 语义区映射
         → [Node 08] L3 FMM 分词
         → [Node 09] L3 实体匹配 (73 条规则)
         → [Node 10] L3 表型标注 (enhance/conflict/neutral)
         → [Node 11] L3 知识类型标注 (private/family/world)
         → [Node 12] 场景标签派生 + 最终组装
         → 完整 DNA 海胆对象 (壳肉 + 语义向量骨架 + 寻址元数据骨架)
```

### Node 01 — L0 关键词规则匹配

```
输入: 用户原始文本 utterance
算法:
  1. 加载 l0_routing.json (6 条规则), 逐条做大小写不敏感子串匹配
  2. 收集所有命中规则, 按 priority 升序 (越小越优先), 同 priority 按命中数降序
  3. 返回最优规则和次优规则 (用于计算 ambiguity_score)
输出: { rule_id, domain, subcategory, priority, matchedKeywords } 或 null → 进 Node 04

关键词规则表 (6 条):
  family-conflict   (p1): 催婚/结婚/妈妈/我妈/烦死
  family-care       (p2): 爸爸/母亲/家人/照顾
  work-stress       (p1): 加班/工作压力/老板/任务/同事
  emotion-positive  (p1): 开心/幸福/高兴/快乐
  emotion-negative  (p1): 难过/伤心/孤独/痛苦
  daily-general     (p5): 天气/散步/早上好/晚上好
```

### Node 02 — L0 locus_path 校验

```
输入: domain, subcategory, taxonomy tree
算法:
  1. tree.user[domain] 不存在 → "user.misc.default"
  2. subcategory ∈ tree.user[domain] → "user.{domain}.{subcategory}"
  3. "general" ∈ tree.user[domain] → "user.{domain}.general"
  4. 否则 → "user.{domain}.{tree.user[domain][0]}"
输出: 合法的 locus_path 字符串
```

### Node 03 — L0 l0_code 解析

```
输入: domain, subcategory, taxonomy codes map
算法:
  1. codes["{domain}.{subcategory}"] 命中且为 4 字符 → 返回
  2. 遍历 codes 找首个 "{domain}." 前缀匹配 → 返回其值
  3. 兜底 → "MISC"
输出: 4 字符 L0 分类码

完整 22 个 L0 码:
  family:    FAMG / FAMC / FAMF
  emotion:   EMOP / EMON / EMEU / EMSP / EMRO / EMMF
  work:      WRKG / WRKS / WRKA / WRKP / WRKM / WRKB
  daily:     DAIG / DAIC / DAIE
  health:    HLFT / HLSK / HLSL
  misc:      MISC (终极兜底)
```

### Node 04 — L0 情绪极性兜底

```
触发: Node 01 未命中任何关键词规则
输入: utterance, positive_words set, negative_words set
算法:
  1. 仅 negative 命中 → "{locus_path: user.emotion.negative, l0_code: EMON, rule_id: emotion-negative-fallback, is_fallback: true}"
  2. 仅 positive 命中 → "{locus_path: user.emotion.positive, l0_code: EMOP, rule_id: emotion-positive-fallback, is_fallback: true}"
  3. 都不命中 → "{locus_path: user.misc.default, l0_code: MISC, rule_id: misc-default-fallback, is_fallback: true}"
```

### Node 05 — GlobalUID 生成

```
输入: type_mark, location_fingerprint, batch_counter
算法:
  1. typeMark = "MM" (按快照类型: MM/SP/WK/EN)
  2. nodeNum = 前 16 位 location_fingerprint 压缩为 4 位 hex
  3. batchNum = 当日批次号 (3 位 hex, 每日重置)
  4. location = location_fingerprint 后 64 位压缩为 8 位 hex
  5. salt = 6 位随机 hex
输出: "MM0001A3BF1A0C4DE6F7"
      同一次 _encodeCombined() 调用内的所有子 ID 共享同一个 batchNum
```

### Node 06 — L1 分支路由编码

```
输入: (内部状态)
算法:
  1. today = YYYYMMDD (from new Date())
  2. globalSeq = GlobalSequenceCounter.next() (跨日重置为 0 → 1)
  3. sessionSeq++ (会话内单调递增, reset() 归零)
  4. branch_id = "evt_{today}_{String(globalSeq).padStart(3, '0')}"
  5. 持久化到 data/system/sequence_counter.json
输出: { branch_id: "evt_20260712_042", seq_pos: 5 }
```

### Node 07 — L2 语义区映射

```
输入: locus_path
算法: mapZone()
  user.emotion.* → emotion_valence_zone
  user.family.*  → social_schema_zone
  user.work.*    → language_semantic_zone
  user.*         → language_semantic_zone (兜底)
ref = "tmp_{emo|lang|body|space|soc}_{5位计数器}"
输出: { leaf_zone, ref }
```

### Node 08 — L3 FMM 分词

```
输入: 原始文本
算法: ChineseSegmenter.segment(text)
  1. 字典 = 73 条实体规则的所有 patterns 去重, 按长度降序
  2. 前向最大匹配: 从当前位开始取最长可能串, 在字典中则输出, 否则退一格
  3. 兜底: 单字 token
  4. 单字 token (除 "我") 不参与实体匹配
输出: token[] — 例 ["妈妈", "又", "在", "催婚", "我", "结婚", "了", "烦死了"]
```

### Node 09 — L3 实体匹配

```
输入: token[] (来自 Node 08), 73 条实体规则
算法:
  逐条规则检查: 规则.patterns 中任一 pattern ∈ token[]
  去重: key = "{type}:{name}"
  单字 token (除 "我") 排除

73 条规则按类型:
  self:    1 条 (我)
  person:  27 条 (妈妈/爸爸/老公/老婆/…/老板)
  emotion: 20 条 (开心/难过/焦虑/愤怒/…/累)
  event:   13 条 (结婚/工作/吵架/失眠/…/散步)
  place:   4 条 (公司/北京/上海/深圳)
  object:  10 条 (礼物/宠物/咖啡/画画/…/烹饪)

LLM 增强提取 (可选):
  三层过滤: 提示词约束 → 类型白名单+56人名黑名单 → 中文姓名正则
  5s 超时 → 正则兜底
  3min TTL 缓存 (max 200)
```

### Node 10 — L3 表型标注

```
输入: 实体数组, 上下文, selfModel
算法: determinePhenotype()

self 实体:
  negative>0 && positive==0 → conflict
  positive>0 && negative==0 → enhance
  其他                     → neutral

非 self 实体:
  positiveCount > negativeCount  → enhance
  negativeCount > positiveCount  → conflict
  相等 → selfModel.boundaries 命中 → conflict
  相等 → 未命中                    → neutral
```

### Node 11 — L3 知识类型标注

```
算法: determineKnowledgeType()

person + name 匹配家族关键词 (25个) → family
place  + name 匹配世界城市 (7个)    → world
其他                                → private
```

### Node 12 — 场景标签派生 + 最终组装

```
输入: locus_path, entity_genes[]

派生规则:
  1. locusMap[locus_path] → 中文标签数组 (21 条映射)
  2. entity.type='emotion' → 按情绪名追加标签 ("开心"→"快乐", "难过"→"悲伤"…)
  3. entity.type='person'  → 追加 "人际"
  4. entity.type='event'   → 追加 "事件"

最终组装:
  合并 Node 01-12 全部输出 → 完整 DNA 对象 → 海胆诞生
  写入三座底座: 壳肉 → 原始数据层 / 语义向量 → state_spines / 寻址元数据 → atom_address_timeline
```

---

## 第五章 · 寻址流水线——快递式逐站盖章

### 5.1 概念

海胆从 M1 编码车间诞生后，在 M2-M9 各车间逐站经过加工。每经过一个车间，寻址链的 `route_stamp_list` 就新增一条路由戳——记录该车间的标识、操作类型、时间戳。这不仅是一条"哪里处理过"的路径记录，更是一条"这个海胆经历了怎样的生命旅程"的全景追溯。

### 5.2 路由戳格式

```
每个 RouteStamp:
  workshop:   string   // 车间标识, e.g. "M1" / "M2" / "M3" / "M4" / "M5"
  operation:   string   // 操作类型, e.g. "ENCODE" / "WRITE" / "CALCIUM" / "RECALL" / "GENERATE"
  timestamp:   int64    // Unix 毫秒时间戳
  detail:      string   // 操作详情, e.g. "calcium:0.45→0.52, recall_boost:+0.2"
  crc_snap:    string   // 操作前本条寻址链的 CRC 快照 (防篡改)
```

### 5.3 典型路径示例

```
海胆诞生:
  M1.ENCODE  → L0=FAMF, locus=user.family.conflict, global_uid=MM0001A3BF1A0C4DE6F7
  M2.WRITE   → state_spines(32 rows), memories(1 row), atom_address_timeline(1 row)
  M3.CALCIUM → level=1, score=0.45
  [日常闲聊 → 寻址链悬置, 不再追加]

某次被回忆:
  M4.RECALL  → recall_count=3, boost:+0.2, calcium:0.45→0.65
  M2.UPDATE  → strength:0.32→0.38

某次触发梦境:
  M7.DREAM   → module=emotion_radar, pleasure_valence=positive

钙化晋升:
  M2.PROMOTE → lifecycle=candidate→active, calcium:1.2→1.8

进入黑钻:
  M2.DIAMOND → promoted_to_diamond=1, calcium:4.8

长期遗忘:
  M2.DECAY   → strength:0.55→0.50, calcium:2.1→2.08 (24h cycle)
```

### 5.4 路径差异产生分支

不同的海胆因用途不同，走的车间不同：

- **闲聊海胆**：M1 → M2 → M3 → (M5 如用于回复) → 寻址链悬置
- **被反复回忆的海胆**：M1 → M2 → M3 → M4(多次) → M2(多次更新) → 可能晋升
- **代码审查海胆**：M1 → M2 → M4(知识库检索) → 不进 M3(不做体感) → 不进 M7(不做梦境)
- **亲密对话海胆**：M1 → M2 → M3 → M4 → M5 → M6(自我进化) → M7(梦境) → M8(地标)

这就是 DNA 分支的起源——主干编码规则相同，但根据功能不同，海胆经历不同的加工路径，寻址链上留下不同的路由戳序列。

---

## 第六章 · 双螺旋存储架构

### 6.1 三座物理底座

```
底座 1 · 语义向量分片库 (state_spines)
  ├── 存储: 32D float32 稠密向量, 每海胆 32 行 spine 记录
  ├── 索引: HNSW 图索引 (网状, 非线性, 纯语义邻近)
  ├── 用途: 自由联想 / 触发式回忆 / 情感共振匹配
  └── 纪律: 禁止在语义层做时序排序

底座 2 · 寻址治理存储池 (atom_address_timeline + atom_repair_index)
  ├── 存储: 时序骨架 + 藤蔓组拓扑 + 路由戳 + 区位指纹 + 安全校验
  ├── 索引: B+Tree (时序) + 倒排索引 (藤蔓组/实体/时间分片)
  ├── 分片: 按自然月分片 ("2026-07"), 单分片深度 ≤ 3 层
  └── 纪律: 禁止在寻址层存储语义向量

底座 3 · 原始数据层 (memories / conversations 表 — 沿用 M2 schema)
  ├── 存储: 对话原文 / 壳肉语义单元 / L0-L3 编码产出物 / 实体标注
  └── 纪律: 仅兜底溯源, 不建语义索引, 不做直接检索
```

### 6.2 DDL

```sql
-- 底座 1: 语义向量分片库
CREATE TABLE IF NOT EXISTS state_spines (
    global_uid          TEXT NOT NULL,
    dimension_id        INTEGER NOT NULL CHECK(dimension_id BETWEEN 1 AND 32),
    value               REAL NOT NULL,
    consistency_mark    TEXT NOT NULL DEFAULT 'consistent',
    location_fingerprint BLOB,
    timestamp_ms        INTEGER NOT NULL,
    checksum            TEXT,
    dna_branch          BLOB,
    PRIMARY KEY (global_uid, dimension_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_spines_dim ON state_spines(dimension_id, timestamp_ms);

-- 底座 2: 寻址治理存储池
CREATE TABLE IF NOT EXISTS atom_address_timeline (
    global_uid          TEXT PRIMARY KEY,
    global_time_seq     INTEGER NOT NULL,
    absolute_timestamp  INTEGER NOT NULL,
    time_slice_tag      TEXT NOT NULL,       -- "2026-07" (自然月分片)
    vine_group_id       TEXT,
    entity_belong_id    TEXT,
    event_branch_id     TEXT,
    route_stamp_list    BLOB,                 -- Protobuf 编码的路由戳数组
    hot_cold_level      CHAR(1) DEFAULT 'W',  -- H/W/C/A
    crc_checksum        TEXT NOT NULL,        -- CRC32
    state_flag          CHAR(1) DEFAULT 'N',  -- N/I/D/A
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_atl_ts      ON atom_address_timeline(absolute_timestamp);
CREATE INDEX IF NOT EXISTS idx_atl_group   ON atom_address_timeline(vine_group_id);
CREATE INDEX IF NOT EXISTS idx_atl_entity  ON atom_address_timeline(entity_belong_id);
CREATE INDEX IF NOT EXISTS idx_atl_slice   ON atom_address_timeline(time_slice_tag);

-- 底座 2 附加: 修复索引表
CREATE TABLE IF NOT EXISTS atom_repair_index (
    global_uid              TEXT PRIMARY KEY,
    spine_storage_position  TEXT NOT NULL,   -- 32D 向量的物理存储位置
    flesh_storage_position  TEXT NOT NULL,   -- 壳肉的物理存储位置
    last_verified_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    repair_count            INTEGER DEFAULT 0,
    FOREIGN KEY (global_uid) REFERENCES atom_address_timeline(global_uid)
) WITHOUT ROWID;
```

### 6.3 底座隔离纪律

```
🔴 三底座独立维护各自索引, 互不交叉
🔴 关联仅通过 GlobalUID
🔴 state_spines:       仅 HNSW — 禁止时序排序
🔴 atom_address_timeline: 仅 B+Tree + 倒排 — 禁止存储语义向量
🔴 原始数据层:          仅文本 — 禁止直接以此做语义检索
```

---

## 第七章 · 双检索模式

```
SEMANTIC_ONLY (默认常态)
  ├── 寻址链关闭、悬置、隔离
  ├── 仅运行 HNSW 语义搜索
  ├── 思维自由, 不被时间/空间绑架
  └── 用途: 日常闲聊、发散思维、观点复用、创意推理

        ↓ 触发切换 (regex: 昨天|上周|回忆|记得|上次|以前|曾经)

DUAL_CHAIN (主动回忆)
  ├── Step 1: 寻址链先行 → 时间段/VineGroup/Entity 过滤 → B+Tree+倒排 → 亿→百
  ├── Step 2: 语义链后行 → HNSW 在锁定子集内精排
  └── 用途: "昨天说的那个…", "去年夏天…", "和妈妈那次…"

        ↓ 任务完成

SEMANTIC_ONLY (自动回切)
```

---

## 第八章 · 32D 扇区分配

| 扇区 | 大类 | 内容 | 数据来源 |
|------|------|------|---------|
| 00-05 (6D) | 感知用户情绪 | 愉悦/唤醒/亲和/紧张/专注/攻击 | 瑶灵感知通道 × 瑶光人体生理规律 |
| 06-10 (5D) | 肉身实体 | 骨骼肌肉/疼痛/神经触觉/内分泌/信息素 | 瑶灵 D1-D5 × 瑶光生理基线 |
| 11-16 (6D) | 精神内核 | 自我认知/驱力/恐惧倦怠/幸福感/共情/自保 | 瑶灵 D9-D14 × 瑶光人文社会规则 |
| 17-22 (6D) | 圈层人际 | 伴侣依恋/伴侣守护/家庭归属/家庭守护/社交/团队 | 瑶灵 D15-D20 × 瑶光社会关系规则 |
| 23-28 (6D) | 时空环境 | 私人居所/家庭布局/职场/公共空间/时空距离/昼夜节律 | 瑶灵 D21-D26 × 瑶光空间建模规则 |
| 29-31 (3D) | 动态生长 | 微观+自然+人文+精神+耦合(归并) | 瑶灵 D27-D31 × 瑶光资源拓展规则 |
| 32 (1D) | 全身统筹 | 心率/血压/皮质醇/愉悦激素/综合健康 | D32 加权汇总 D1-D31 |

**三体对偶模型（每维度的计算方式）：**
```
瑶光世界模型 → 客观基线 (标准心率120→正常, 标准皮质醇14→正常, …)
                  ↕  偏离度 = 瑶灵主观值 - 瑶光客观基线
瑶灵32通道   → 主观体感 (心率90→偏高, 皮质醇22→偏高, …)
                  ↕  太虚境天权融合仲裁
最终32D值   → 写入海胆语义刺
```
🔴 **32D 由瑶灵 × 瑶光对偶计算产出**, LLM 禁止直接输出浮点值。
🔴 瑶光提供完整世界模型（人体生理规律/空间建模/社会规则/资源拓展），瑶灵基于此计算主观偏离。
🔴 太虚境天权执行双路融合仲裁——同一维度上瑶灵主观值 vs 瑶光客观基线，偏离越大说明主观体感越强烈。
🔴 32D 维度数量永久锁定, 永不扩容。

---

## 第九章 · 海胆的生命周期

```
┌──────────┐   钙化≥1.0   ┌──────────┐   钙化≥4.5   ┌──────────┐
│ 砂金库    │ ──────────→ │ 金库     │ ──────────→ │ 黑钻库    │
│ candidate │  30min检查   │ active   │  2h检查      │ 珍藏      │
│ (候选)    │             │ (活跃)   │             │ max 200   │
└──────────┘              └──────────┘             └──────────┘
                                │                        │
    ┌───────────────────────────┼────────────────────────┤
    │                           │                        │
    ▼                           ▼                        ▼
 遗忘衰减                    冷归档                   永不衰减
 (每24h)                   (30天→冷)                  (免疫衰减)
 (钙化-0.02/-0.05/-0.10)  (2年→归档)
    │
    ▼
 衰减下限 (strength < 0.05)
    │
    ▼
 清理
```

钙化评分是 24D(过渡期)/32D(目标态) 感知向量的 L2 范数归一化值。衰减遵循三级制度——强情感记忆衰减最慢，中性记忆衰减最快。每次被检索回忆时，钙化获得 +0.2 增强（上限 10）。

---

## 第十章 · 全局编解码接口

```typescript
// 1. 完整编码: 用户输入 → 完整海胆 DNA
DNA.encode(rawInput: string, m1BaseData: M1BaseData, branchExts?: BranchExt[]): FullDNA

// 2. 完整解码: 二进制/JSON → 可读结构
DNA.decode(dnaBinary: Buffer | dnaJson: string): ParsedDNA

// 3. 轻量分支读取: 无需解析全部 DNA
DNA.decodeBranch(dna: FullDNA, branchName: string): BranchData

// 4. 合规校验: 写入/传输前强制校验
DNA.validate(dna: FullDNA): ValidationResult
```

| 异常等级 | 条件 | 动作 |
|---------|------|------|
| **FATAL** | 主干缺失/被篡改 | 阻断记忆存储 + 阻断 LLM 认知组装 |
| **ERROR** | 分支编码错位 | 记录告警 + 丢弃异常特征 |
| **WARN** | 版本不匹配 | 降级兼容解析 + 记录兼容性告警 |

---

## 第十一章 · 开发铁律

### 11.1 允许

- ✅ 新增完整独立功能分支
- ✅ 在已有分支末尾追加新字段
- ✅ 增加新 L0 分类码
- ✅ 增加新实体规则

### 11.2 禁止

- ❌ 修改 GlobalUID 生成算法
- ❌ 在 32D 语义向量中增加第 33 维时间特征
- ❌ 将时间字段混入语义向量存储表
- ❌ 对语义向量做线性时序排序
- ❌ 任何模块自建 GlobalUID 生成逻辑
- ❌ 绕过 GlobalUID 做双链关联
- ❌ 任何模块自建 DNA 编解码逻辑替代全局接口
- ❌ 交换主干/分支字段顺序
- ❌ 删除/修改历史字段含义
- ❌ 32D 向量由 LLM 直接输出浮点值

---

## 附录 A · 与现有代码的对应关系

| 节点 | 状态 | 当前位置 |
|------|------|---------|
| Node 01-04 (L0) | ✅ | `src/m1/L0Router.ts` |
| Node 05 (GlobalUID) | ⬜ P3 | 新建 |
| Node 06 (L1) | ✅ | `src/m1/L1Sequencer.ts` |
| Node 07 (L2) | ✅ | `src/m1/L2ContentExtractor.ts` |
| Node 08-09 (分词+匹配) | ✅ | `src/m1/L3EntityAnnotator.ts` |
| Node 10-11 (表型+知识) | ✅ | `src/m1/L3EntityAnnotator.ts` |
| Node 12 (标签+组装) | ✅ | `src/m1/DNAEncoder.ts` |
| state_spines DDL | ⬜ P3 | 规范已定稿, 待建表 |
| atom_address_timeline DDL | ⬜ P3 | 规范已定稿, 待建表 |
| atom_repair_index DDL | ⬜ P3 | 规范已定稿, 待建表 |
| 双检索模式 | ⬜ P3 | 待扩展 M4 MemoryRetriever |
| 5 大分支常量 | ✅ | `common/dna_constants.py` |
| 三套 proto | ✅ | `common/proto/` |

**图例**: ✅ = wenstar-cc 已验证 / ⬜ P3 = 规范已定稿, 待建设

## 附录 B · 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-07-10 | V1.0 | 框架与执行铁律 |
| 2026-07-12 | V2.0 | 完整重写: 海胆细胞模型、五大分支、寻址流水线、双螺旋三底座、生命周期、repair_index |
