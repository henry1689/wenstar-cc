# 🏛️ 太虚境·CC版 检索架构基线存档 v4.0

**存档日期**: 2026-07-05
**状态**: ✅ 已锁定，冻结为基建基线
**范围**: 全系统检索管线（M2/M4/角色扮演域）
**后续**: 模型幻觉问题属于上层生成层调优，与底层检索基建解耦

---

## 一、本次改造核心成果

### 1. 五层串行截断检索管线（替代并行7路采集）

```
L1: 实时上下文 → 命中直接截断
L2: 砂金→金库→黑钻 逐层 → 有亲属结果截断
L3: 实体拓扑递归 → 顺藤摸瓜3级深度
L4: 知识库 → 标准化称谓润色
L5: LLM门控 → hasValidRelation控制编造
```

### 2. 全局实体拓扑表

| 指标 | 数据 |
|------|------|
| 表名 | `entity_topology` |
| 双向边 | 264条 |
| 递归深度 | 最多3层（防循环） |
| 关系枚举 | 标准化28种（mother/sister/colleague等） |
| 反向关系 | 自动计算（mother↔daughter, sister↔sister） |

### 3. 已根除的架构顽疾

| 问题 | 前 | 后 |
|------|----|----|
| 王全芬幻觉 | ❌ LLM编造 | ✅ 拓扑+门控拦截 |
| 吴波数据串扰 | ❌ 跨角色回忆泄漏 | ✅ roleplay_char隔离 |
| 亲属信息补丁 | ❌ 每人物硬编码 | ✅ 拓扑递归自动化 |
| 检索并行浪费 | ❌ 全库扫描 | ✅ 串行命中截断 |
| 记忆无角色隔离 | ❌ findMemoriesByEntityNames全局 | ✅ roleplay_char过滤 |

---

## 二、关键代码变更清单

| 文件 | 变更 | 类型 |
|------|------|------|
| `src/m4/EntityTopologyManager.ts` | 新增：拓扑双向管理+递归检索+存量迁移 | 🆕 新建 |
| `src/m4/MemoryRetriever.ts` | 新增：`retrieveFullClue()`五层串行管线 | 📝 改造 |
| `src/app/roleplay/FourLayerDataCollector.ts` | 重写：从并行7路改为串行5层 | 📝 重写 |
| `src/app/roleplay/PromptAssembler.ts` | 新增：L5门控+认知框架 | 📝 重写 |
| `src/app/roleplay/types.ts` | 新增：`hasValidRelation`字段 | 📝 改造 |
| `src/webui/server.ts` | 新增：拓扑表初始化 | 📝 改造 |
| `src/webui/chat.ts` | 新增：debug日志（待清理） | 📝 改造 |
| `src/app/roleplay/RoleplayDomain.ts` | 无改动 | — |
| `src/m4/entity-topology-schema.sql` | DDL定义 | 🆕 新建 |

---

## 三、基线锁定规则

1. **检索管线不得回退到并行模式**
2. **家族类提问自动触发拓扑递归，不得加人物硬编码**
3. **`hasValidRelation`门控必须始终传递到Prompt层**
4. **所有新人物关系录入必须走拓扑双向写入，不得独立维护**
5. **后续模型优化不得修改M2/M4/roleplay检索层代码**

---

## 四、后续迭代方向（独立于检索基建）

### 短期：M5后置事实校验重生成
详见 `docs/architecture-improvement-blueprint-v2.md` Phase3c

### 中期：模型灰度对比
DeepSeek-V4 flash vs 完整版 对比测试

### 长期：天权底座接入
EntityTopology作为全局实体关系底座，多维度寻址复用

---

*本基线由太虚境·文曲星 CC 团队锁定于 2026-07-05，后续所有模型层优化不得破坏检索架构层完整性。*
