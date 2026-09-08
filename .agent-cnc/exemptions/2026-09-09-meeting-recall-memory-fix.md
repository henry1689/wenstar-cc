# 豁免申请：会晤记忆召回修复（徐诗雨续聊失忆）—— 4 个源文件放宽 S4.5_complexity

- date: 2026-09-09
- requested_by: Agnes(pi) @ 用户对话确认方案D
- approved_by: Owner 2026-09-09 harness-cli exempt add 签名（240min × 4 文件）
- scope:
  - src/webui/chat/retrieval-stage.ts
  - src/m4/retrieval/adapters/MeetingWallAdapter.ts
  - src/webui/chat/dialog-group-stage.ts
  - src/m4/retrieval/meeting-recall.ts
- kind: relaxed_S45_complexity
- machine_record_id: harness data/exemptions.json 4 条目（240min，relaxed_checks=[S4.5_complexity]，2026-09-09 生效）
- flow_run_id: run_mtsywsfc_llj0（S1-S7 completed，token_issued 5 files）
- expires_at: 2026-09-09T~06:00Z（签发起 240min）
- 生效证据: harness-cli exempt list 显示 4 文件 剩240min | ["S4.5_complexity"] ✓

## 背景（根因）
用户与徐诗雨 09-08 04:38–06:10 深聊"诗韵的事"（《诗经·蒹葭》引诗、诗韵16岁、寒假团圆约定等 40+ 条，全部落库）。17:03 续聊"还是徐诗韵的事"时徐诗雨接不上细节。DB 实证：
- 会晤模式记忆召回 = 纯 `calcium_score DESC TOP8`（retrieval-stage.ts 隔离墙 / MeetingWallAdapter.ts 同构）；
- 6:05–6:10《蒹葭》对话固化记忆钙化 0.68–0.70，当天 257 条排 55–94 名 → 被 4:45–5:14 高钙 ANCHOR（1.6–2.05）挤出 TOP8，永不召回；
- 对话原文带 `is_compacted = 0` 过滤（EntityContextStore）→ 压缩标记后原文从所有取回通道消失；
- 触发词 `记得|聊过|上次…` 不匹配"还是X的事"续聊引导 → 关键词 LIKE 兜底不触发。

## 为什么不能简化（DS-23 全仓扫描必然误报）
1. `retrieval-stage.ts` 会晤隔离墙是 895 行检索编排的既有大函数，本次只在其会晤分支**插入**共享工具调用点（关键词相关召回合并 + 续聊触发时压缩原文取回），函数整体复杂度无法拆分（拆分 = 重构既有检索编排，爆炸半径不可控，属独立任务）；
2. `MeetingWallAdapter.ts` 与 `retrieval-stage.ts` 同构，需同步接入共享模块消除漂移（共性修复的横向闭环），单文件改动本身简单但横向成对出现；
3. `dialog-group-stage.ts` ANCHOR 特征轮补充为既有闭组写入函数内小改，不宜为此拆函数；
4. `meeting-recall.ts` 为新公共模块，包含关键词抽取 + 双轨召回 + 原文取回多能力聚合（为跨调用方复用而聚合，单一职责粒度刻意保持"召回域"级）。

## review
- next_review: 2026-10-09
- 仍必要？到期复查（理想态：会晤检索远期收敛 SearchOrchestrator + extended registry 后，三槽位双实现移除，本豁免随之失效）
