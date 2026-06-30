# chat.ts 拆分计划

## 目标
将 2734 行的 chat.ts 按功能阶段拆分为 6 个独立文件，
每拆一块立即对比原版验证，完全一致才算合格。

## 拆分顺序（从易到难）

### 第一阶段：dialog-group-stage.ts（对话组管理）
提取内容：L2490-L2581 的对话组轮次管理逻辑
  - flushDialogGroup() 函数
  - _dg / _dgTimer 模块级状态
  - 对话组关闭/自动关闭逻辑
难度：⭐⭐ 最低——纯工具函数，依赖最少
验证：调用前后 _dg 状态一致

### 第二阶段：persistence-stage.ts（对话持久化）
提取内容：对话保存到 SQLite 的 writeRaw 调用
  - conversationHistory push
  - saveConversationHistory 调用
  - conversationDB write
难度：⭐⭐ 低——纯写操作
验证：SQLite 中对话记录一致

### 第三阶段：post-response-stage.ts（后处理）
提取内容：L2140-L2581 的 M5 回复后处理
  - M6 反馈信号注入
  - M8 年轮写入
  - M7 梦境触发
  - 记忆自动提升
  - 歌单存储
  - 秘书工具执行
  - 对话摄入知识库
难度：⭐⭐⭐ 中——多步异步，但每一步独立
验证：每步输出一致

### 第四阶段：retrieval-stage.ts（记忆检索）
提取内容：L604-L870 的记忆检索逻辑
  - 话题漂移检测（isTopicShift / isFollowUp）
  - 轻量检索 vs 全量检索
  - 实体扩展检索
  - 黑钻检索
  - 情感相似度排序
难度：⭐⭐⭐⭐ 高——逻辑分支多
验证：同输入下检索结果一致

### 第五阶段：prompt-stage.ts（编码+决策+角色）
提取内容：L280-L530 的输入处理
  - M1 DNA 编码
  - LLM 实体提取
  - FamilyGraph 回填
  - M3 决策
  - 角色分类
难度：⭐⭐⭐⭐ 高——M1/M3调用链
验证：DNA/决策/角色输出一致

### 第六阶段：response-stage.ts（回复生成+校验）
提取内容：L1763-L2140 的 M5 回复生成
  - finalKnowledgeText 组装
  - guard 链构建
  - M5 orchestrate 调用
  - 幻觉校验
  - 候选回复生成
难度：⭐⭐⭐⭐⭐ 最高——最复杂的逻辑
验证：回复内容一致

## 实施原则
1. 每阶段只创建一个新文件 + 修改 chat.ts 引入
2. 旧代码保留为注释，不删除
3. 每阶段用 diff 对比 chat.ts 的修改前后
4. 每阶段跑 npm test
5. 全部完成后再跑完整回归
