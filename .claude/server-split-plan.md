# server.ts 拆分计划

## 目标
将 2275 行的 server.ts 按路由类别拆分为独立文件。
server.ts 保留：import + 模块级状态 + initPipeline + 速率限制 + 路由注册骨架
每个路由文件：独立 if 块，通过函数参数注入依赖

## 拆分顺序（从易到难）

### 第一阶段：observability-routes（可观测性路由）
路由：/api/status, /api/health, /api/modules, /api/events, /api/alignment
       /api/landscape, /api/inductions, /api/mirror
特点：只读，无副作用，依赖最少
验证：调用前后返回数据一致

### 第二阶段：memory-routes（记忆路由）
路由：/api/memory/* (CRUD + reminders + search)
特点：读写都有，但逻辑独立
验证：CRUD 操作结果一致

### 第三阶段：family-routes（家族图谱路由）
路由：/api/family/* (11个路由, 含 backup/restore)
特点：逻辑复杂但独立，部分有文件操作
验证：图谱数据一致

### 第四阶段：knowledge-routes（知识库路由）
路由：/api/knowledge/* (8个路由, 含 upload)
特点：含文件上传，依赖 busboy
验证：知识库 CRUD 一致

### 第五阶段：ops-routes（运维路由）
路由：/api/maintenance, /api/vault, /api/aqc, /api/keys, /api/admin
       /api/reset, /api/m3, /api/dream, /api/assessor, /api/chat/clear
特点：操作密集，但调用链独立
验证：运维操作前后状态一致

### 第六阶段：chat-routes（聊天路由）
路由：/api/chat, /api/chat/recall, /api/chat/purge-test, /api/chat/prefer-candidate
       /api/chat/stream, /api/conversation, /api/search, /api/emotion-search
       /api/reset, /api/dialog-group
特点：最核心、最复杂，放在最后
验证：chat 回复一致

## 实施原则
1. 每段只拆一个路由文件
2. 路由签名统一：handler(req, res, url, deps) 形式
3. 依赖通过参数注入，不走全局变量
4. 每拆完一块对比原版 + 跑测试
5. 旧代码保留为注释，不删除
