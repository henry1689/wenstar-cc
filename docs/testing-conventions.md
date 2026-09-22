# 测试约定（2026-09-20 起）

> 本文回答一个问题：**这套测试的红绿，能不能信？**
> 背景：本仓库出现过多次"红灯被当成绿灯"和"绿灯其实什么都没测"。以下约定就是为了让红绿可信。

---

## 一、三条硬规则

### 规则 1：**禁止静默跳过**（`if (!夹具) return;`）

```ts
// ❌ 禁止：夹具缺失时用例零断言"通过"（假绿）
it('xxx', async () => { if (!fg) return; /* ... */ });

// ✅ 正确 A：夹具缺失 ⇒ 硬失败（推荐，用于本地夹具）
beforeEach(() => { if (!fg) throw new Error('[测试] 夹具未就绪 —— 不允许静默通过'); });

// ✅ 正确 B：外部依赖缺失 ⇒ **显式跳过**并说明原因（用于依赖 live 服务的用例）
if (!reachable) return ctx.skip('服务未启动（live 冒烟需要 localhost:3000）');
```

**判据**：跑完必须能回答"这个用例到底测了没有"。`passed` 与 `skipped` 是两件事，前者是断言通过，后者是**没测**。

### 规则 2：**碰真实库必须用受控复制**

生产服务在运行时会周期性全量导出 `data/webui/**/*.db`（`export → tmp → fsync → rename`）。
此时裸 `copyFileSync(真库, tmp)` 会复制到**半写文件**（torn read）⇒ 夹具坏 ⇒ 同一个用例时红时绿。

```ts
import { copyRealDbForTest, cleanupSafeDbCopy } from '../../../__tests__/helpers/safe-db-copy.js';

const copied = await copyRealDbForTest(FG_SRC, { prefix: 'my-fixture-' }); // 校验 + 重试 + 失败即抛
try { /* 用 copied.path */ } finally { cleanupSafeDbCopy(copied.dir); }
```

**契约**：校验（SQLite 魔数 + 页大小合法 + 长度是页大小整数倍）→ 失败重试 → **仍失败则抛错**；
**绝不**返回"看起来能打开"的坏夹具，更不静默跳过。

### 规则 3：**live 冒烟必须走统一判据**

```ts
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

beforeAll(async () => {
  const r = await apiGet('/api/health');
  serverAvailable = r.status === 200;
  guardLiveServerOrSkip('API-SMOKE', serverAvailable, 'localhost:3000'); // 三态：proceed/skip/fail
});
```

| 服务可达 | `REQUIRE_LIVE_SERVER=1` | 动作 |
|:--|:--|:--|
| 是 | 任意 | `proceed` |
| 否 | **是** | **抛错 ⇒ 运行红**（既然声称在检查服务，服务就必须在） |
| 否 | 否 | `skip`（显式跳过，报告里计入 skipped） |

`npm run smoke:checkpoint` / `npm run smoke:api` 已设 `REQUIRE_LIVE_SERVER=1`（fail-closed）。

---

## 二、怎么跑、怎么看

| 目的 | 命令 | 期望 | 注意 |
|:--|:--|:--|:--|
| 单测 / 集成 | `node ./node_modules/vitest/vitest.mjs run src` | 全绿 | 已知例外：`e2e.test.ts Case 4` 依赖 LLM 延迟 |
| live 冒烟 | `npm run smoke:checkpoint` | 全绿 | 必须在服务**启动重活期之后**（约 3–4 分钟）跑，否则整批假失败 |
| 全量 | `npm test` | 见下 | **不要**把 live 冒烟与 2000+ 单测的"混跑红绿"当作判据 |

**读红绿的唯一正确姿势**：看**退出码**（0 = 绿，非 0 = 红）。

⚠️ 实测坑：`beforeAll`/`beforeEach` 抛错时，Vitest 会把该组用例显示为 **skipped**（看起来"跳过而已"），
但**退出码是 1 = 红**。只看 `Tests x skipped` 会误判为"没事"。

---

### 规则 4：**测试流量必须带 `test_mode: true`（否则污主库）**

对 `/api/chat` 的**测试**请求必须带 **`test_mode: true`**（`server-chat-routes.ts` 已支持）。
它会让本轮写入的 **`namespace='test'`**（memories / conversations），而：
- **检索侧硬门**：`MemoryRetriever` 的 3 条候选查询均排 `COALESCE(namespace,'default') <> 'test'`
  ⇒ 测试记忆**永不进入她的上下文**；
- **不参与黑钻晋升**：`autoPromoteCandidatesV2` 预筛同样排 test；
- **可批量清理**：`SELECT ... WHERE namespace='test'` 一网打尽。

反例（已发生过）：另一会话的测试直投主库 ⇒ 产生「你好」×427、「帮我记个事」×124、「徐诗雨」×103 等，
其中 656 条一度处于 active/promoted、**正在参与检索**，于 2026-09-22 被批量隔离（`lifecycle_state='suppressed'`，
见 `docs/data-storage-reference.md` 「⑩」节）。

> 两个筛子彼此不替代：本规则防**污主库**；规则 1（禁静默跳过）防**假绿**。

## 三、为什么这些约定值得守

这套系统的核心风险不是"测试不够多"，而是**结论的可信度与实际覆盖不匹配**：

- 用例静默跳过 ⇒ 报告全绿但**零验证**；
- 服务挂了却全绿 ⇒ 运维以为一切正常；
- 夹具复制到半写文件 ⇒ 同一份代码时红时绿 ⇒ **没人再相信红灯**（真正的缺陷被当成噪声）。

三条规则对应的正是这三条。同类教训（"未验证 ≠ 已验证"）也写在
`docs/data-storage-reference.md`「九·二」与 Harness 移交单里。

---

## 四、改动记录

| 日期 | 内容 |
|:--|:--|
| 2026-09-20 | 新增 `src/__tests__/helpers/safe-db-copy.ts`（受控复制 + 能力单测 7 例）；新增 `src/__tests__/helpers/live-server-guard.ts`（三态判据 + 单测 6 例）；10 个 live 冒烟文件接入统一判据；`candidate-zone.test.ts` 去掉静默跳过路径并改用受控复制；`package.json` 的两个 smoke 脚本设 `REQUIRE_LIVE_SERVER=1` |
