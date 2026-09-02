# 系统健康防御体系

> 版本：V1.0 | 生效日期：2026-07-19
>
> 法律依据：《太虚境户籍管理法 V2.1》§十一 系统完整性守护

---

## 一、为什么需要这个体系

2026-07-19 发现系统在"健康"状态下失去了 90% 的后台能力：

| 问题 | 根因 |
|------|------|
| 海马体 13 个任务全部停摆 | `WS_DEBUG_MODE=true` 在 .env 中未切回 |
| M6 演化/备份/质检/巡检全部停摆 | `WS_LAZY_TIMERS=true` 硬编码在代码中 |
| `/api/health` 返回 `status=ok` | 健康检查只检查 HTTP 是否响应，不检查模块是否存活 |
| 无人察觉 | 模块跳过只有一句 `[调试] 已跳过`，淹没在启动日志中 |

**核心教训**：临时调试开关 + 没有自检机制 + 健康检查说谎 = 系统无声腐烂。

---

## 二、三重防护

### 第一重：开关防护

| 机制 | 说明 |
|------|------|
| `WS_LAZY_TIMERS` | 改为读 `.env` 环境变量，默认 `false`（正常运行）|
| `WS_DEBUG_MODE` | 增加 `WS_DEBUG_EXPIRES_AT` 过期时间，过期自动切回 `false` |
| 启动横幅 | 调试模式启动时打印醒目的红色横幅，正常模式静默 |

### 第二重：启动完整性校验

系统维护一个模块健康注册表 `MODULE_HEALTH`，包含：

- **必选模块**（20 个中的 9 个）：FG、PAE、门阀、维护引擎、海马体、M6、记忆仓、每日维护等。未启动 → 健康状态 `unhealthy`。
- **可选模块**：会晤、热力追踪、事件总线、前额叶、新皮层、备份、质检等。未启动 → 健康状态 `degraded`。

启动完成后执行 `verifyStartupIntegrity()`，打印结果。结果同步到 `/api/health` 响应。

### 第三重：运行时心跳

Hook 探针体系（`http://localhost:3000/monitor`）已有 13 个探针，每 30 秒扫描一次超时检测。关键探针新增 `H14-H17` 覆盖海马体/维护/备份/梦境。

---

## 三、健康检查 API

### `GET /api/health`

```json
{
  "status": "ok",          // ok | degraded | unhealthy
  "score": 85,             // 0-100 综合健康分（对齐度 + 模块分 / 2）
  "alignment": { "score": 81, "status": "healthy" },
  "flags": {
    "debug_mode": false,   // 调试模式是否激活
    "lazy_timers": false   // Token 节省模式是否激活
  },
  "modules": {
    "total": 20,
    "alive": 20,
    "score": 100,
    "dead": [],            // 必选但未启动
    "degraded": [],        // 可选但未启动
    "list": [{"name":"FG·户籍数据层","required":true,"alive":true}]
  }
}
```

### 状态判定规则

| status | 条件 |
|--------|------|
| `ok` | 所有必选模块存活 + 综合分 ≥ 80 |
| `degraded` | 有可选模块缺失 或 综合分 50-79 |
| `unhealthy` | 有必选模块缺失 或 综合分 < 50 |

---

## 四、运维检查清单

每次调试/部署完成后，执行以下检查：

```
□ .env 中 WS_DEBUG_MODE=false
□ .env 中无 WS_LAZY_TIMERS=true（如不需要）
□ 启动日志中无 "⚠️ 调试模式" / "⚠️ Token节省模式" / "已跳过"
□ 启动日志中无 "🔴 关键模块未启动"
□ /api/health 返回 status=ok, score≥80
□ /api/health 返回 flags.debug_mode=false, flags.lazy_timers=false
□ /api/health 返回 modules.dead=[], modules.score=100
□ /monitor 页面所有探针绿色（无红/黄）
□ tsc --noEmit 零错误
```

---

## 五、恢复流程

如果发现系统处于降级状态：

1. **检查 `/api/health`** → 看 `flags` 和 `modules.dead`
2. **如果 `debug_mode=true`** → 编辑 `.env`，设 `WS_DEBUG_MODE=false`，重启
3. **如果 `lazy_timers=true`** → 编辑 `.env`，设 `WS_LAZY_TIMERS=false`，重启
4. **如果 `dead` 列表非空** → 查看启动日志中对应模块的错误信息
5. **重启后再次检查** → `/api/health` 应返回 `status=ok`

---

## 六、防御原则（铁律）

> 🔴 **任何调试开关必须有明确的过期时间。**
>
> 🔴 **健康检查必须说实话——宁可报红，不可粉饰。**
>
> 🔴 **启动必须做完整性校验——"看起来正常"不等于"真的正常"。**
>
> 🔴 **每次发现新问题，更新此文档和检查清单。**
