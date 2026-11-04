# @wenstar/memarch-bridge

MemArch v2 接入适配层 —— 把旧记忆系统的 7 个调用面，结构级桥接到新 M1-M6。

## 快速开始

```typescript
// 主系统启动时初始化一次
import { initBridge, NamespaceContext, globalFeatureFlag } from '@wenstar/memarch-bridge';
import Database from 'better-sqlite3';

initBridge({
  v2Db: new Database('data/memarch-v2.db'),
  legacyConfig: MemoryConfig,
  // ... 旧实例引用（可选）
});

// 对话入口包裹命名空间
await NamespaceContext.run({
  namespace: 'ns_yuyao',
  roleplayChar: '玉瑶',
  sessionId: 'xxx',
  subject: { id: 'system', role: 'system' },
}, async () => {
  const bridge = getBridge();
  await bridge.write.write({ messageId, role: 'user', content: '...' });
  const r = await bridge.retrieve.retrieve('...', { namespace: 'ns_yuyao' });
  const p = bridge.present.present({ evidences: r.evidence, userQuery: '...', namespace: 'ns_yuyao' });
});
```

## 灰度切流

```typescript
import { globalFeatureFlag } from '@wenstar/memarch-bridge';

globalFeatureFlag.setNamespaceRatio('ns_yuyao', 10);  // 玉瑶 10% 走新
globalFeatureFlag.promoteNamespaceToV2('ns_shiyu');   // 诗雨全量走新
globalFeatureFlag.rollback();                          // 一键全回旧
```

## 目录结构

```
memarch-bridge/
├── src/
│   ├── core/          # 端口接口 + 灰度开关 + 聚合根
│   ├── namespace/     # 命名空间隔离（物理级）
│   ├── adapters/      # 7 个旧调用面适配器
│   ├── router/        # 入口改造清单
│   ├── migration/     # 数据迁移
│   └── verification/  # 端到端验证
├── scripts/
├── tests/
└── docs/INTEGRATION-PLAN.md   # 完整改造方案
```
