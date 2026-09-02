# WenStar 知识库红线文档

> 从 FG 角色隔离铁律扩展至知识库全领域
> 持续更新。每次踩坑后升级。最后固定为规范。
> 最后更新: 2026-07-16
> 版本: V1.0

---

## 一、第二大脑数据红线

### 1. Canonical 不可被绕过

- ❌ 禁止任何代码绕过 `CanonicalStore` 直接写 `projections/knowledge.db`
- ❌ 禁止 `syncToMd()` 方向从 DB 写到 MD（V4.0 反转后 MD→DB）
- ✅ 所有知识写入必须先写 `wiki/*.md`，再触发投影更新

### 2. UUID 身份稳定

- ❌ 禁止用文件名或标题作为跨文件引用的唯一标识
- ❌ 禁止在 entity_relations 中用 name 做主键
- ✅ 所有文件和实体必须用 UUID v4 标识，名字只是显示属性

### 3. 来源追踪不可缺

- ❌ 禁止写入无 source_hash + confidence + claim_type 的知识条目
- ✅ 每条知识必须有 provenance 元数据

---

## 二、第一大脑数据红线

### 1. 砂金库（会话缓存）

- ❌ 禁止跨会话持久化砂金库数据
- ❌ 禁止将砂金库内容混入金库或黑钻库
- ✅ 会话结束 24h 后自动清空

### 2. 金库（中层记忆）

- ❌ 禁止将第二大脑原始文件内容直接存入金库（只存摘要）
- ❌ 禁止在源文件未变更时重复创建金库条目
- ✅ 金库条目必须携带 source_file_uuid + source_hash

### 3. 黑钻库（核心永久记忆）

- ❌ 禁止绕过密码校验的手动准入
- ❌ 禁止超过 10% 配额限制
- ❌ 禁止自动删除黑钻条目（只标记 orphaned）
- ✅ 手动准入和移除必须有审计日志

---

## 三、双脑交互红线

### 1. 单向数据流

- ❌ 禁止金库/黑钻库数据回写到知识库文件
- ❌ 禁止玉瑶在对话中自动修改知识库文件
- ✅ 数据仅从第二大脑→第一大脑，通过前额叶门控

### 2. 前额叶门控

- ❌ 禁止绕过前额叶直接从第二大脑向第一大脑写入
- ✅ 所有知识萃取→金库的路径必须经过 ConstraintValidator 校验

### 3. 级联删除

- ❌ 禁止在源文件删除后保留孤立的金库条目
- ❌ 禁止级联删除黑钻库条目（仅标记 orphaned）
- ✅ 源文件变更→标记金库 expiry，源文件删除→标记 orphaned

---

## 四、调试检查清单

### 启动检查

```sql
-- ① 金库中 source_type 异常值
SELECT source_type, COUNT(*) FROM memories GROUP BY source_type;

-- ② source_tracking 中孤立记录（源文件已删但 status=active）
SELECT * FROM source_tracking WHERE status = 'active'
AND source_path NOT IN (SELECT ...);

-- ③ 黑钻库手动配额是否超限
SELECT
  (SELECT COUNT(*) FROM black_diamond WHERE entry_channel='manual' AND status='active') AS manual,
  (SELECT COUNT(*) FROM black_diamond WHERE status='active') AS total;
```

### 功能验证

1. 在 `data/knowledge-v4/wiki/` 新建 test.md → 夜间同步后 memories 表出现 source_type='knowledge_vault' 条目
2. 修改 test.md 内容 → 再次同步后旧条目标记 suppressed，新条目正常入库
3. 删除 test.md → 关联条目标记 orphaned
4. 黑钻手动准入 → 密码错误拒绝、配额满拒绝、正常密码正确入库
