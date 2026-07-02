# 质量改进工作流与防复发体系

## 核心理念

修复一个问题只是治标，真正治本是建立一套**改法→防复发→验证→监控**的完整闭环。

```
发现缺陷
   ↓
① 怎么改 ← 根因分析 + 影响面评估 + 改法选择
   ↓
② 防复发 ← 自动化门禁 + lint规则 + 设计模式
   ↓
③ 验证 ← 烟雾测试 + 回归测试 + 灰度验证
   ↓
④ 监控检测 ← 运行时自检 + 健康指标 + 告警
   ↓
（回到发现缺陷，闭环）
```

---

## 一、怎么改：四步改法

每次修复必须经过以下四个步骤，缺一不可。

### Step 1: 根因分析（5 Why）

问至少三遍"为什么"，找到真正的根因而非表面现象。

**例：空 catch 块**
```
现象：备份失败无日志
第一问：为什么没日志？→ catch {} 没打
第二问：为什么 catch {} 没打？→ 开发者图省事/觉得不会失败
第三问：为什么允许这种写法？→ 没有 lint 规则禁止空 catch
第四问：为什么没有 lint 规则？→ 项目没有配置 eslint 的 no-empty 规则
→ 根因：eslint/no-empty 规则缺失
```

### Step 2: 影响面评估

| 问题类型 | 需要检查的方面 |
|---------|--------------|
| 空 catch | 附近是否有其他 catch、是否有 try 嵌套 |
| 事件泄漏 | 该模块的 destroy() 是否存在、是否被调用 |
| 类型逃逸 | 被 as any 的位置能否定义正确的类型 |
| 大文件 | 拆分的函数之间是否有循环依赖 |

### Step 3: 改法选择

| 缺陷类型 | 首选改法 | 备选改法 |
|---------|---------|---------|
| 空 catch | 添加至少 `console.error` | 提取统一错误处理函数 |
| 事件泄漏 | `destroy()` 中加 `bus.off()` | 改用 WeakRef 自动清理 |
| 类型逃逸 | 补全类型定义 | 类型断言 `as` 替代 `as any` |
| 大文件 | 按职责拆分 | 先抽离纯函数 |

### Step 4: 写测试证明修复

修复完成后必须有一个可以证明修复有效的测试。

```
修复空 catch → 把 catch 块改成抛出错误 → 运行测试 → 确认不抛出 → 确认日志输出
修复事件泄漏 → 创建 → destroy → 检查事件订阅数 → 确认归零
```

---

## 二、防复发：三层门禁

### 第一层：代码门禁（提交前）

建立 `scripts/pre-commit.ts`，每次 commit 前自动检查：

```bash
# 1. 编译门禁
npx tsc --noEmit
if [ $? -ne 0 ]; then echo "❌ 编译错误"; exit 1; fi

# 2. 空 catch 门禁
grep -rn "catch\s*{}\|catch\s*(_\s*)\s*{}" src/ | grep -v node_modules
if [ $? -eq 0 ]; then echo "❌ 发现空catch块"; exit 1; fi

# 3. 新增 as any 门禁（对比上次 commit）
# 通过 git diff 检查新增的 as any
git diff --cached -- src/ | grep '^+\s*.*as any'
if [ $? -eq 0 ]; then echo "❌ 新增 as any"; exit 1; fi

# 4. 浏览器端 no-empty 规则
npx eslint src/ --rule '{ "no-empty": "error" }'
```

### 第二层：CI 门禁（推送后）

在 GitHub Actions / CI 中运行：

```yaml
steps:
  - run: npx tsc --noEmit           # 编译检查
  - run: npx vitest run src/__tests__/roleplay-smoke.test.ts  # 角色扮演烟雾测试
  - run: npx vitest run src/__tests__/smoke.test.ts            # 全量烟雾测试
  - run: bash scripts/lint-empty-catch.sh                      # 空catch检查
```

### 第三层：架构门禁（设计阶段）

编写 `CLAUD.md` 补充规则：

```markdown
## 代码质量铁律

1. 禁止空 catch — 必须至少 console.error()
2. 禁止模块级 process.env — 统一用 ConfigService
3. 禁止新增 as any — 必须定义正确类型
4. bus.on() 必须有对应的 bus.off() — 在 destroy() 中
5. as any 写入路径必须走公共 API（如 writeMemory()）
6. 角色扮演规则必须走 buildRoleplayRules()，不内联
```

---

## 三、验证：三级验证体系

### 第一级：改后立验（开发者自测）

每次修改后立即执行：

```bash
# 空 catch 修复后
node -e "require('./src/xxx')"  # 确认不崩溃
grep 'catch.*console.error' src/xxx.ts  # 确认有日志

# 事件泄漏修复后
# 在测试中调用 init() + destroy()，确认订阅者数为 0

# 数据写入修复后
# 写一条记录 → 立即 SELECT 确认落盘
```

### 第二级：烟雾测试（自动化）

目前已有 2 个烟雾测试文件，补充到覆盖所有 P0 风险：

| 测试文件 | 覆盖范围 | 运行方式 |
|---------|---------|---------|
| `src/__tests__/smoke.test.ts` | API 端点 + 基础链路 | `npx vitest run` |
| `src/__tests__/roleplay-smoke.test.ts` | 角色扮演 6 场景 | `npx vitest run` |
| **新增** `src/__tests__/quality-guard.test.ts` | 空catch/事件泄漏/类型安全 | `npx vitest run` |

**新增质量守卫测试示例**：
```typescript
describe('质量守卫', () => {
  it('不应有空 catch 块', async () => {
    const { execSync } = require('child_process');
    const result = execSync('grep -rn "catch\\s*{}" src/ --include="*.ts" | grep -v node_modules | wc -l');
    expect(Number(result.toString())).toBe(0);
  });
  
  it('事件总线订阅应有对称清理', async () => {
    // 检查所有 bus.on 是否有对应的 bus.off
    const { execSync } = require('child_process');
    const onCount = execSync('grep -rn "bus\\.on(" src/ | wc -l').toString();
    const offCount = execSync('grep -rn "bus\\.off(" src/ | wc -l').toString();
    expect(Number(offCount)).toBeGreaterThanOrEqual(Number(onCount) * 0.5);
  });
});
```

### 第三级：灰度验证（生产环境）

对风险较高的改动（如拆分大文件、重构事件总线）：

```
1. 先在测试对话中验证基本功能
2. 观察 /api/health 指标是否正常
3. 观察探针是否全部绿色
4. 24 小时后无异常才视为通过
```

---

## 四、监控检测：运行时三层监控

### 第一层：运行时自检（每轮对话）

已实现 `RoleplayHealthGuard`，扩展到通用：

```typescript
// src/app/health/SystemHealthGuard.ts
export class SystemHealthGuard {
  static checkEventBusLeaks(bus: EventBus): HealthReport {
    const subscriberCount = bus.getSubscriberCount();
    const warnings = [];
    // 如果订阅者超过 10 秒前的 2 倍，告警泄漏
    if (subscriberCount > this._lastCount * 2) {
      warnings.push(`事件订阅者异常增长: ${this._lastCount}→${subscriberCount}`);
    }
    return { healthy: warnings.length === 0, warnings };
  }
  
  static checkUncaughtErrors(): void {
    process.on('unhandledRejection', (reason) => {
      console.error('[HealthGuard] ❌ 未捕获Promise拒绝:', reason);
    });
  }
}
```

### 第二层：健康检查指标（API 可查询）

在 `/api/health` 中增加：

```json
{
  "codeQuality": {
    "emptyCatches": 0,
    "eventLeaks": 0,
    "typeEscapes": 0
  },
  "errors": {
    "unhandledRejections": 0,
    "uncaughtExceptions": 0
  }
}
```

### 第三层：告警阈值（自动告警）

| 指标 | 警告线 | 告警线 | 动作 |
|------|:------:|:------:|------|
| 空 catch 数 | >50 | >80 | PR 必须修复 |
| 事件订阅者数 | >预期2倍 | >预期5倍 | 自动触发泄漏诊断 |
| 探针红色数 | >2 | >5 | 自动重启 |
| 新引入 as any | >0 | — | PR 不通过 |
| 编译错误数 | >0 | >5 | 立即修复 |

---

## 五、本次扫描结果的改进方案

### 第一批：空 catch 块的改法

**怎么改**：
```
所有 catch {} → catch (e) { console.error('[模块名] 失败:', e?.message); }
server.ts 的 17 处 + chat.ts 的 9 处优先
```

**防复发**：
```
在 pre-commit 中添加 grep 检查：新增 catch {} 禁止提交
```

**验证**：
```
故意触发错误路径 → 确认日志输出 → 确认不崩溃
```

**监控**：
```
在 /api/health 中统计并暴露空 catch 数
```

### 第二批：事件监听泄漏的改法

**怎么改**：
```
每个有 bus.on() 的类添加 destroy() 方法 → 在 server.ts 关闭时统一调用
```

**防复发**：
```
代码审查必须检查：有 on 必须有 off
```

**验证**：
```
创建模块 → destroy → bus.getSubscriberCount() === 0
```

**监控**：
```
SystemHealthGuard.checkEventBusLeaks() 定期检查订阅者数量
```

### 第三批：Hook 数据失真的改法

**怎么改**：
```
分三步走：
1. 移除 10 秒保活循环（先观察 24h 看看 14 个探针的真实状态）
2. 移除聊天请求的全勾选伪造
3. 给 H02/H06/H09/H12/H14 添加真实 ingest 路由
```

**防复发**：
```
每次添加新探针必须有对应的 ingest 路由，否则不加
```

**验证**：
```
H02 的 callCount 应该 ≈ 对话次数（之前是无限增长）
```

---

## 六、执行检查清单

每批修复完成后对照：

```
□ 编译通过（npx tsc --noEmit = 0 error）
□ 空 catch 数量减少到目标值
□ 受影响的模块烟雾测试通过
□ CI 门禁更新（如有新增）
□ 健康检查返回新指标
□ 角色扮演烟雾测试通过（6 场景）
□ 至少观察 30 分钟无异常日志
```
