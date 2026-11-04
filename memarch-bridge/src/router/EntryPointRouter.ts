/**
 * EntryPointRouter.ts — 主系统入口路由改造清单
 *
 * 【这不是一个运行时模块，而是一份「改造点清单」的可执行版本】
 *
 * 主系统所有旧记忆调用点，按文件列出改造方式。
 * 每个改造点：
 *   - 旧：直接 import 旧实现
 *   - 新：import { getBridge, NamespaceContext } from '@wenstar/memarch-bridge'
 *
 * 【红线】
 *   改造完成后，src/ 下不允许出现直接 import 旧 m2/m4/m5 记忆模块的业务代码，
 *   所有记忆调用必须经 bridge。旧代码保留在原地不删，只是不再被业务引用。
 */

// ============================================================
// 改造点清单（按文件级 diff 组织）
// ============================================================

export const ENTRY_POINT_CHANGES = [
  // ── 1. 对话主循环（最高优先级，用户实测串台就在这里） ──
  {
    file: 'src/app/conversation/chat.ts',
    priority: 'P0',
    oldPattern: `
      import { MemoryWriteGateway } from '../m2/MemoryWriteGateway.js';
      import { MemoryRetriever } from '../m4/MemoryRetriever.js';
      import { decideMode, buildGuard } from './MemoryGate.js';
      import { updateAfterReply, buildContextPrompt } from '../m5/ContextMemory.js';
    `,
    newPattern: `
      import { getBridge, NamespaceContext } from '@wenstar/memarch-bridge';
      const bridge = getBridge();
      // 对话入口包裹命名空间作用域
      await NamespaceContext.run({
        namespace: currentRole.namespace,       // ns_yuyao / ns_shiyu ...
        roleplayChar: currentRole.name,
        sessionId: session.id,
        subject: { id: 'system', role: 'system' },
      }, async () => {
        // 写用户消息
        await bridge.write.write({ messageId, role: 'user', content: userMsg });
        // 门控判定
        const gate = bridge.gate.decideMode({ message: userMsg, namespace: currentRole.namespace });
        // 检索
        let evidence = [];
        if (gate.needsMemorySearch) {
          const r = await bridge.retrieve.retrieve(userMsg, { namespace: currentRole.namespace });
          evidence = r.evidence;
        }
        // 呈现
        const p = bridge.present.present({ evidences: evidence, userQuery: userMsg, namespace: currentRole.namespace });
        // 用 p.utterance / LLM 生成回复...
        // 写助手消息
        await bridge.write.write({ messageId: replyId, role: 'assistant', content: replyText });
        bridge.present.updateAfterReply({ draft: replyText, userMessage: userMsg, tone: 'warm', namespace: currentRole.namespace });
      });
    `,
  },

  // ── 2. 角色切换点（关键！切角色时必须 resetScene） ──
  {
    file: 'src/app/conversation/RoleSwitcher.ts',
    priority: 'P0',
    oldPattern: `resetContext(); // 旧 ContextMemory 模块级 reset`,
    newPattern: `
      const bridge = getBridge();
      bridge.present.resetScene(newRole.namespace);  // 按 namespace 物理 reset
      // 切角色时，把旧 namespace 的写入流量全部切走（可选：demote 旧角色到 legacy）
    `,
  },

  // ── 3. 旧 MemoryGate 的所有调用方 ──
  {
    file: 'src/**/*.ts 中调用 decideMode / buildGuard 的位置',
    priority: 'P0',
    oldPattern: `import { decideMode, buildGuard } from '../app/conversation/MemoryGate.js'`,
    newPattern: `import { getBridge } from '@wenstar/memarch-bridge'; getBridge().gate.decideMode(...)`,
  },

  // ── 4. 旧 MemoryRetriever 的所有调用方 ──
  {
    file: 'src/**/*.ts 中 import MemoryRetriever 的位置',
    priority: 'P0',
    oldPattern: `import { MemoryRetriever } from '../m4/MemoryRetriever.js'`,
    newPattern: `import { getBridge } from '@wenstar/memarch-bridge'; getBridge().retrieve.retrieve(...)`,
  },

  // ── 5. 旧 ContextMemory 的所有调用方 ──
  {
    file: 'src/**/*.ts 中 import ContextMemory 的位置',
    priority: 'P1',
    oldPattern: `import { updateAfterReply, buildContextPrompt, getSceneSnapshot } from '../m5/ContextMemory.js'`,
    newPattern: `import { getBridge } from '@wenstar/memarch-bridge'; getBridge().present.*`,
  },

  // ── 6. 旧 MemoryWriteGateway 的所有调用方 ──
  {
    file: 'src/**/*.ts 中 import MemoryWriteGateway / DualHelixWriter 的位置',
    priority: 'P0',
    oldPattern: `import { MemoryWriteGateway } from '../m2/MemoryWriteGateway.js'`,
    newPattern: `import { getBridge } from '@wenstar/memarch-bridge'; getBridge().write.write(...)`,
  },

  // ── 7. 旧 MemoryVault / MemoryAssessor ──
  {
    file: 'src/app/memory-vault/**/*.ts, src/app/vault/**/*.ts',
    priority: 'P1',
    oldPattern: `直接操作 SQLite / VaultManager`,
    newPattern: `import { getBridge } from '@wenstar/memarch-bridge'; getBridge().storage.* / getBridge().assess.*`,
  },

  // ── 8. 主系统启动入口（初始化 bridge） ──
  {
    file: 'src/app/bootstrap.ts 或 server 启动文件',
    priority: 'P0',
    oldPattern: `// 旧记忆系统初始化`,
    newPattern: `
      import { initBridge, globalFeatureFlag } from '@wenstar/memarch-bridge';
      import Database from 'better-sqlite3';
      import { MemoryConfig } from './config/MemoryConfig.js';

      const v2Db = new Database('data/memarch-v2.db');  // 新库
      initBridge({
        v2Db,
        legacyConfig: MemoryConfig,
        legacyWriteGateway: legacyM2Gateway,   // 保留旧实例引用
        legacyRetriever: legacyM4Retriever,
        legacyAssessor: legacyAssessor,
      });
      // 默认全旧（globalRatio=0），灰度从这里开始调
      globalFeatureFlag.setNamespaceRatio('ns_yuyao', 10); // 玉瑶先切 10%
    `,
  },
] as const;
