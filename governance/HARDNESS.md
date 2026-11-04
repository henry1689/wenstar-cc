# HARDNESS.md — M6 治理与安全模块加固说明

> 本文档说明如何对本模块做防篡改加固，分为五个层次。

---

## 1. 内部代码与外接接口分离

### 原则

外部代码**只允许**通过 `index.ts` 的公开 API 访问治理子系统，不允许直接 import 内部模块。

### 目录结构

```
src/
├── index.ts          ← 唯一对外出口（公开 API）
├── accessControl.ts  ← 内部模块，不允许外部直接 import
├── auditLog.ts       ← 内部模块
├── policyEngine.ts   ← 内部模块
├── integrityCheck.ts ← 内部模块
└── securityConfig.ts ← 内部模块
```

### 强制手段

1. **打包时只导出 index.ts 的符号**：TypeScript 编译后，外部只能从 `dist/index.js` 导入
2. **内部模块命名约定**：所有内部模块文件名以驼峰命名，不暴露在 package.json 的 exports 中
3. **ESLint 规则**：禁止从 `src/` 深层路径导入（生产环境启用）

### 允许的公开 API

只有以下函数/类型从 index.ts 导出：

- 初始化：`initGovernance()`
- 访问控制：`checkPermission()`, `issueTempToken()`, `verifyTempToken()`, `revokeTempToken()`
- 审计日志：`log()`, `query()`, `verifyChain()`
- 策略引擎：`evaluatePolicy()`, `upsertRule()`, `removeRule()`
- 完整性巡检：`quickCheck()`, `deepScan()`, `check()`, `onViolation()`
- 安全配置：`getConfig()`, `updateConfig()`, `verifyConfigSignature()`

---

## 2. 源码哈希锁

### 原理

对所有 `src/*.ts` 文件计算 SHA-256 哈希，写入本文件。
运行时启动时重新计算并比对，不匹配则拒绝启动。

### 源码哈希清单

```
# 文件哈希（SHA-256）—— 已锁定
# 格式：filename : sha256_hex

src/accessControl.ts      : a21f0d4ca8b103afd862b9a03914a1286e5709d91c50485af20244f516e09b74
src/auditLog.ts           : 1ee098117ccb3b0e64c09d9c617c158d93fc6c00e34400531ec611268d0a283a
src/policyEngine.ts       : b797f1b8adfba13b11e4d9b5362d1544b56ee024c0b803e5afd55352315a44c8
src/integrityCheck.ts     : 97e1134ebbffeb0e64c78a3eb652e9ea2f3eb9d587fa6abc5dcc3757007f07084
src/securityConfig.ts     : c2887604dae67596cfe2f0806d99e65f121a978b9a1384c122d0ea676cc9a
src/index.ts              : 136ec5ff3679b96d3299dbe806ef2db5d448b146b762a9dc70795a55a83954a7
```

### 全局哈希根

```
global_root : sha256(concatenated_file_hashes)
```

> 修改任何 src/*.ts 文件后，必须重新计算哈希并更新本文件，否则启动自检会失败。
> 计算命令：`Get-FileHash -Algorithm SHA256 src/*.ts`

---

## 3. 运行时自检

### 启动自检流程

```
进程启动
    │
    ▼
1. 读取内置源码哈希清单
    │
    ▼
2. 逐个读取 src/*.ts 文件，计算 SHA-256
    │
    ├─ 哈希全部匹配 → 继续启动
    │
    └─ 有不匹配 → 拒绝启动
         │
         ├─ 正常模式：抛出异常，进程退出
         │
         └─ Owner 覆盖模式：传入授权令牌后可继续
    │
    ▼
3. 校验配置签名（verifyConfigSignature）
    │
    ├─ 签名有效 → 正常运行
    │
    └─ 签名无效 → 告警 + 拒绝修改配置
```

### 自检实现位置

- 自检逻辑内置在 `securityConfig.ts` 的 `verifyConfigSignature()` 扩展中
- 启动时由 `initGovernance()` 自动调用
- 自检失败时抛出 `IntegrityError`

### Owner 紧急覆盖

```typescript
// 紧急情况下，owner 可以用授权令牌覆盖自检失败
initGovernance({
  signingKey: '...',
  ownerOverrideToken: '...', // 必须正确，否则仍然拒绝
});
```

---

## 4. Harness 监管点

本模块向 Harness 引擎暴露以下监管接口：

### 监管点列表

| 监管点 | 触发时机 | 上报内容 |
|--------|----------|----------|
| `startup:self-check` | 进程启动时 | 源码哈希校验结果、配置签名校验结果 |
| `config:signature-valid` | 配置加载时 | 当前配置签名是否有效 |
| `integrity:violation` | 检测到篡改时 | 篡改条目列表、根哈希对比、时间戳 |
| `audit:chain-broken` | 哈希链校验失败时 | 断裂位置、前后哈希对比 |
| `policy:deny-event` | 策略拒绝请求时 | 主体、资源、动作、拒绝原因 |

### Harness 接收方式

- 通过事件总线 emit
- Harness 引擎订阅 `governance:*` 前缀事件
- 监管点是只读的，Harness 不能修改运行时状态

### 监管周期

- **启动自检**：每次进程启动
- **配置签名校验**：每 5 分钟（与巡检周期对齐）
- **完整性巡检**：快速巡检 1 分钟一次，深度巡检 1 小时一次
- **事件实时上报**：违规发生时立即上报

---

## 5. 业主授权（Owner Authorization）

### Owner 令牌生成

**令牌派生公式**：

```
ownerToken = HMAC-SHA256(signingKey, "owner-token")
```

**生成步骤**：

1. 确定签名密钥（signingKey）—— 通过环境变量 `GOVERNANCE_SIGNING_KEY` 注入
2. 计算 HMAC：`HMAC-SHA256(signingKey, "owner-token")`
3. 得到 64 位十六进制字符串，即 owner 令牌

**示例（Node.js）**：

```javascript
const crypto = require('crypto');
const signingKey = process.env.GOVERNANCE_SIGNING_KEY;
const ownerToken = crypto
  .createHmac('sha256', signingKey)
  .update('owner-token')
  .digest('hex');
console.log('Owner Token:', ownerToken);
```

### 令牌使用流程

**场景 1：修改安全配置**

```typescript
import { updateConfig, getOwnerToken } from './src/index';

// 用 owner 令牌更新配置
const newConfig = updateConfig(
  { tokenTTLMs: 10000 },
  ownerToken  // 必须传入正确令牌
);
```

**场景 2：轮换签名密钥**

```typescript
import { rotateOwnerToken } from './src/index';

// 需要旧令牌才能生成新令牌
const newToken = rotateOwnerToken(oldToken);
```

**场景 3：覆盖自检失败**

```typescript
// 仅紧急情况使用
initGovernance({
  signingKey: '...',
  ownerOverrideToken: 'correct-owner-token',
});
```

### 安全原则

1. **令牌不落盘**：owner 令牌只在内存中，不写入文件
2. **最小暴露**：令牌只在启动时生成一次，用完即弃
3. **常量时间比较**：所有令牌校验用 `timingSafeEqual`，防时序攻击
4. **链式轮换**：旧令牌才能换新令牌，防止令牌泄露后被滥用

---

## 加固验收清单

- [x] 只暴露 index.ts 公开 API，内部模块不直接导出
- [x] 源码哈希清单（见上方第 2 节）
- [x] 启动自检流程（见上方第 3 节）
- [x] Harness 监管点列表（见上方第 4 节）
- [x] Owner 令牌生成与使用流程（见上方第 5 节）
