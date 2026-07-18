# WenStar 知识库 Agent 操作规范

> V4.3 双脑架构 — 第二大脑（知识库）治理层
> 最后更新: 2026-07-19
> 最高法律依据：[《太虚境户籍管理法 V2.1》](taixu-household-registration-law.md)

---

## 〇、治理文件索引

在操作知识库之前，Agent 必须了解以下治理文件的层级：

| 层级 | 文件 | 版本 | 效力 |
|:--|------|:--|:--|
| ① | [《太虚境户籍管理法》](taixu-household-registration-law.md) | V2.1 | 最高法律 |
| ② | [fg-kinship-redlines.md](redlines/fg-kinship-redlines.md) | V3.5 | FG 操作铁律 |
| ③ | [household-registration-blueprint.md](household-registration-blueprint.md) | V4.0 | 户籍制蓝皮书 |
| ④ | [pae-profile-acquisition-engine.md](pae-profile-acquisition-engine.md) | V3.3 | PAE 技术文档 |
| ⑤ | [entity-lifecycle-governance.md](entity-lifecycle-governance.md) | V1.0 | 实体生命周期治理 |
| ⑥ | 本文档 | V4.3 | 知识库操作规范 |

下位规范不得与上位规范相抵触。

## 一、核心原则

### 1. 第二大脑是 Canonical，投影是 Projection

- `wiki/*.md` 是知识的权威源（Canonical State）
- `projections/knowledge.db` 是检索投影（可随时从 wiki/ 重建）
- 任何写入操作必须先写 MD 文件，再触发投影更新
- 禁止绕过 MD 文件直接写数据库

### 2. 单向数据流

- 数据仅从第二大脑流向第一大脑（知识库 → 金库/黑钻库）
- 永不反向：金库/黑钻库的内容不回写到知识库文件
- 玉瑶对话中不得主动修改知识库文件（除非用户明确指令）

### 3. 用户权限隔离

- 知识库（第二大脑）：用户全权增删改查
- 砂金库/金库/黑钻库（第一大脑）：用户不可直接操作
- 所有对内部记忆的改造只能通过编辑知识库文件或手动固化指令

---

## 二、MD 文件规范

### frontmatter 必填字段

```yaml
---
uuid: "WK_xxx"       # DNAEncoder GlobalUID
title: "标题"         # 必填
type: "entity"        # entity | topic | relation | insight | daily
tags: ["标签1"]       # 至少一个
created: "ISO"        # 创建时间
updated: "ISO"        # 最后修改时间
---
```

### frontmatter 可选字段

```yaml
aliases: ["别名"]
source_type: "conversation"  # conversation | upload | inference | manual
source_hash: "sha256:xxx"
confidence: "high"           # high | medium | low | uncertain
claim_type: "stated"         # stated | inferred | observed | ambiguous
relations:                   # 关系列表
  - target: "实体名"
    type: "关系类型"
```

### [[wikilink]] 语法

- `[[实体名]]` — 链接到实体页
- `[[路径/文件名]]` — 链接到任意 MD 文件
- `[[实体名|显示文本]]` — 别名链接

---

## 三、操作规则

### 夜间批量处理

1. 仅在凌晨 2:00-6:00 空闲时段执行
2. 白天不占用算力，不影响对话响应
3. 基于 FileID + SHA-256 双重校验，哈希不变则跳过

### 文件变更处理

1. SHA-256 不变 → 跳过，仅巡检
2. SHA-256 变更 → 重新萃取，级联清除金库/黑钻旧条目
3. 文件删除 → 级联清除关联记忆

### 多模态解析

1. 图片/截图 → OCR 提取文字
2. 音频 → STT 语音转文字
3. 视频 → 关键帧 OCR + 音轨 STT
4. 提取后与文本文档走相同萃取流程

---

## 四、禁止操作

- ❌ 禁止直接编辑 `raw/` 目录下的原始文件
- ❌ 禁止修改 `projections/knowledge.db` 中非投影表的数据
- ❌ 禁止在对话中自动删除知识库文件
- ❌ 禁止在对话界面弹出文件管理提醒
- ❌ 禁止将第一大脑的记忆回写到知识库文件
