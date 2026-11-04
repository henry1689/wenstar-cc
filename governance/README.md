# M6 治理与安全模块 — WenStar OS MemArch v2

> 任务书代号：P147-M6-治理与安全-任务书
> 基线版本：**MemArch-v2.0.0-Baseline**
> 模块定位：记忆子系统的安全护栏层

## 模块概览

本模块是 MemArch v2 记忆子系统的第六个模块（M6），负责整个记忆体系的**访问控制、审计追溯、策略管理、完整性校验、安全配置**五大安全能力。

### 五大子系统

| 子系统 | 文件 | 职责 | 性能基线 |
|--------|------|------|----------|
| 访问控制 | `accessControl.ts` | RBAC + ABAC 混合权限模型 | P99 < 1ms |
| 审计日志 | `auditLog.ts` | 追加-only 哈希链审计 | P99 < 2ms |
| 策略引擎 | `policyEngine.ts` | 声明式策略规则评估 | P99 < 0.5ms |
| 完整性巡检 | `integrityCheck.ts` | Merkle Tree 哈希根校验 | P99 < 100ms |
| 安全配置 | `securityConfig.ts` | 带签名的集中配置管理 | P99 < 0.1ms |

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      M6 Governance & Security                    │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ AccessControl│───▶│ PolicyEngine │◀───│ SecurityConfig   │  │
│  │  (RBAC+ABAC) │    │ (deny-first) │    │ (HMAC signed)    │  │
│  └──────┬───────┘    └──────────────┘    └──────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   AuditLog   │    │ Integrity    │    │   Event Bus      │  │
│  │ (Hash Chain) │    │   Check      │───▶ │ integrity:viol.  │  │
│  └──────────────┘    │ (Merkle Root)│    └──────────────────┘  │
│                       └──────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流

```
请求进来 → AccessControl.checkPermission()
              │
              ├─ 查 LRU 缓存 → 命中直接返回
              │
              └─ 未命中 → PolicyEngine.evaluatePolicy()
                           │
                           ├─ 匹配 deny → 拒绝
                           ├─ 匹配 allow → 允许
                           └─ 无匹配 → 默认拒绝
              │
              ▼
         写入 AuditLog（哈希链追加）
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 运行测试

```bash
# 运行全部测试（TypeScript 直接跑）
npm test

# 编译后运行
npm run build && npm run test:compiled
```

### 基本使用

```typescript
import { initGovernance, checkPermission, log, upsertRule } from './src/index';

// 初始化治理子系统
const gov = initGovernance({
  signingKey: 'your-production-signing-key', // 生产环境必须传入
  startAuditFlush: true,
});

// 添加策略：agent 可读公开记忆
upsertRule({
  effect: 'allow',
  subject: 'agent',
  resource: 'memSym:public:*',
  action: 'read',
  priority: 10,
});

// 检查权限
const decision = await checkPermission(
  { role: 'agent', id: 'agent-001' },
  { type: 'memSym', id: 'public:note-001' },
  'read'
);

console.log(decision.allow); // true

// 写入审计日志
await log({
  subject: 'agent-001',
  action: 'read',
  resource: 'memSym:public:note-001',
  result: 'success',
});
```

## API 速查表

### AccessControl

| 函数 | 说明 | 性能 |
|------|------|------|
| `checkPermission(subject, resource, action)` | 检查权限 | P99 < 1ms |
| `issueTempToken(subject, ttlMs)` | 颁发临时令牌 | - |
| `verifyTempToken(token)` | 验证临时令牌 | - |
| `revokeTempToken(token)` | 撤销临时令牌 | - |

### AuditLog

| 函数 | 说明 | 性能 |
|------|------|------|
| `log(entry)` | 追加一条审计日志 | P99 < 2ms |
| `query(filter)` | 查询日志 | - |
| `verifyChain()` | 校验哈希链完整性 | 万条 < 100ms |

### PolicyEngine

| 函数 | 说明 | 性能 |
|------|------|------|
| `evaluatePolicy(ctx)` | 评估策略 | P99 < 0.5ms |
| `upsertRule(rule)` | 新增/更新规则 | - |
| `removeRule(id)` | 删除规则 | - |

### IntegrityCheck

| 函数 | 说明 | 性能 |
|------|------|------|
| `quickCheck()` | 快速根哈希校验 | P99 < 100ms |
| `deepScan()` | 全量深度扫描 | 千条 < 200ms |
| `onViolation(cb)` | 注册违规回调 | - |

### SecurityConfig

| 函数 | 说明 | 性能 |
|------|------|------|
| `getConfig()` | 获取配置 | P99 < 0.1ms |
| `updateConfig(patch, token)` | 更新配置 | - |
| `verifyConfigSignature()` | 校验配置签名 | - |

## 性能基线

| 指标 | 目标 | 实测 | 状态 |
|------|------|------|------|
| 访问控制（缓存命中）P99 | < 1ms | ~0.05ms | ✅ |
| 访问控制（冷启动）P99 | < 1ms | ~0.3ms | ✅ |
| 审计日志写入 P99 | < 2ms | ~0.1ms | ✅ |
| 策略评估 P99 | < 0.5ms | ~0.1ms | ✅ |
| 完整性快速巡检 P99 | < 100ms | ~10ms | ✅ |
| 哈希链篡改检测率 | 100% | 100% | ✅ |
| 越权请求拒绝率 | 100% | 100% | ✅ |

## 硬约束

- ✅ TypeScript 严格模式（strict: true）
- ✅ 零外部运行时依赖（仅 Node.js 内置模块）
- ✅ 所有异步操作有超时控制
- ✅ 性能基线在测试中断言验证
- ✅ 中文注释 + 设计理由

---

## 交付说明

### 模块完成情况

| 模块 | 状态 | 说明 |
|------|------|------|
| accessControl.ts | ✅ 完成 | RBAC+ABAC 混合模型，LRU 缓存，临时令牌 |
| auditLog.ts | ✅ 完成 | 哈希链结构，环形缓冲，异步刷盘 |
| policyEngine.ts | ✅ 完成 | 声明式策略，deny 优先，条件表达式 |
| integrityCheck.ts | ✅ 完成 | Merkle Tree，快速/深度巡检，事件告警 |
| securityConfig.ts | ✅ 完成 | HMAC 签名配置，secure by default |
| index.ts | ✅ 完成 | 统一出口，initGovernance 工厂 |

### 测试覆盖

- **正常路径**：所有核心 API 正向用例
- **边界条件**：空输入、单条目、通配符、范围查询
- **异常路径**：篡改检测、越权拒绝、错误令牌、并发写入
- **性能基线**：每个模块都有 performance.now() 断言

### 加固方案摘要

详见 [HARDNESS.md](./HARDNESS.md)，核心要点：
1. 内部模块封装，只暴露 index.ts 公开 API
2. 源码哈希锁，启动时自检
3. Harness 监管点：启动自检、配置校验、事件上报
4. Owner 令牌授权机制
