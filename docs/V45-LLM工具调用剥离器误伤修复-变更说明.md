# V45 — LLM 工具型调用被思维链剥离器误伤（修复说明）

- **日期**: 2026-10-09
- **范围**: `src/m5/DeepSeekLLMProvider.ts`（唯一改动源文件）
- **性质**: bugfix（`problem_nature=specific_bug`，`final_approved_plan=patch`）
- **任务单**: `ck_975d38dc6468c6b3`
- **运行**: `run_mv06wbgy_3f2c`

---

## 一、症状

实体离线终审（`EntityTriageService`）自建成起**连续 66 次运行零提升**：

```
err.log  ×66: [EntityTriage] 判定响应无法解析（可能被截断）… raw 前120字: [{
stdout   ×66: [Maintenance] 实体终审: 扫描30 提升0 标注0 观察30
```

`raw` 实际内容仅 **3 个字符** `[{"`。

---

## 二、根因（三代探针实测确证）

**不是** token 预算不足，**不是** API 异常，**不是**网络问题 —— 是**系统把自己的正确输出丢弃了**。

`_callDeepSeekApiInner:1319` 的 `resolveReplyFromFields(msg.content, reasoning)` 是**所有 LLM 出口的唯一收口**。该方法在 **content 非空**时也**不直接返回**，而是先过思维链剥离器；**只要剥离结果比原文短 >10 字就采用剥离结果**：

```ts
const ex = extractAnswerFromReasoning(c).trim();
if (ex && ex.length < c.length - 10)
    return (isDraftShapedReply(ex) || hasSelfInjectedMarker(ex)) ? '' : ex;   // ← 返回剥离结果
```

该剥离器是为**自然语言回复**设计的，遇到**纯 JSON 输出**会误判。**纯函数级实测**：

| 输入 | 输出 |
|---|---|
| 完整的 1010 字符判定 JSON | `extractAnswerFromReasoning` → **`[{"`（3 字符）** |
| 同上，走生产调用 | `resolveReplyFromFields` → **`[{"`（3 字符）**，**削掉 1007 字** |

与生产日志逐字吻合。

### 为什么藏了 66 次

剥离器「成功剥离」→ 返回**非空串** → `resolveReplyFromFields` 不抛错 → 外层记 `status=success` → 维护日志打印 `扫描30 提升0 标注0 观察30` ——**与「LLM 判全 unknown」在日志上完全同形**，故障无法被察觉。

### 探针排除过程（为什么不是别的原因）

| 探针 | 内容 | 结果 |
|---|---|---|
| 1 | 构造数据，8000/low、8000/不传、16000/low | **三组全成功**，`finish_reason=stop`，content ~1100 字符 |
| 1b | 大 prompt（4463 字符）+ 完整生产参数（`top_p`/`presence_penalty`） | **成功** —— 排除 prompt 规模与 API 参数 |
| 2 | **真实候选数据**（只读生产 FG 库），与生产同参数 | **成功**，耗时 **7896ms** |
| — | 生产实际调用 | 耗时 **6756ms**，content **3 字符** |

**同参数、同数据、同耗时量级，唯生产拿到 3 字符** ⇒ 问题在**生产代码路径**，不在 API 侧。三代探针共同锁定剥离器。

---

## 三、影响面（S1 全仓核对）

`rawCall` 是「工具型调用」通道，全仓共 **7 个调用方**（含 1 个 mock）：

| # | 调用方 | 期望输出 | 判定 |
|:--:|---|---|---|
| 1 | `EntityTriageService:135` 实体终审 | JSON 数组 | 🔴 **已确证受害**（66 次） |
| 2 | `FGRelationExtractor:67` FG 关系抽取 | JSON 对象 | 🔴 **已确证**：`match(/\{[\s\S]*\}/)` → `JSON.parse` 抛错 → `{valid:false}` 静默失败 |
| 3 | `retrieval-stage:102` 记忆检索编号 | JSON 数组 `[0,3]` | 🔴 同判据 → `!m` → **返回空数组 = 静默判「无相关记忆」** |
| 4 | `server.ts:747` PAE 档案采集 | JSON `{persons:[]}` | 🟠 同形态，高度疑似 |
| 5 | `FGRelationExtractor:129` 垃圾名判定 | `true`/`false` | 🟡 待实测 |
| 6 | `server.ts:362` 对话压缩摘要 | 自然语言 | ✅ **无害**，剥离器本就该作用于此 |

### 横向关联模块清单

| 文件 | 与本次改动的关系 |
|---|---|
| `src/m5/DeepSeekLLMProvider.ts` | **唯一改动源文件** —— 剥离器本体 + 唯一收口 `resolveReplyFromFields` |
| `src/app/entity/EntityTriageService.ts` | 受害方（本批**不改代码**，见 §七 遗留） |
| `src/app/fg/FGRelationExtractor.ts` | 受害方（本批不改） |
| `src/webui/chat/retrieval-stage.ts` | 受害方（本批不改） |
| `src/webui/server.ts` | 受害方（本批不改） |

**受影响文件清单已全量核对**：`rawCall` 调用方 7 处（含 1 mock），`resolveReplyFromFields` 调用点 1 处（`_callDeepSeekApiInner:1319`，唯一收口）。

---

## 四、改动（A+B）

### A · `rawCall` 走原始通道（修根）

`_callDeepSeekApiInner` / `callDeepSeekApi` 返回值新增 `rawContent?: string`（**未经剥离的原始 content**）；`rawCall` 优先取它：

```ts
const _raw = String(result.rawContent ?? '').trim();
return _raw ? result.rawContent! : result.text;   // 空值回落，保留 fail-closed
```

**理由**：`rawCall` 语义即「原始调用」，6 个真实调用方全是任务型 prompt（非角色扮演）。剥离器属「回复语义」，不应作用于工具调用。

### B · 剥离器入口加 JSON 短路（兜底）

```ts
if (c[0] === '[' || c[0] === '{') {
    try { JSON.parse(c); return c; } catch { /* 非合法 JSON → 继续走原剥离逻辑 */ }
}
```

**保护所有路径**（含会晤），不只 `rawCall`。

### 为什么 B 不削弱思维链泄漏防护（V22/V31/V34 三次根治的成果）

- 泄漏形态是**自然语言散文**（中文元指令 / 英文起草稿），**不可能是合法 JSON** ⇒ `JSON.parse` 必然抛错 ⇒ 走原逻辑，**防护原样保留**
- 判据是**结构性的**（能否 parse），与 V31 已转向的「结构判据」路线一致，**不引入新的关键词枚举**
- 短路**只在模型确实输出了合法 JSON 时**生效 —— 那正是「被要求输出 JSON」的任务场景

---

## 五、11 条 FG 红线判定表

| # | 红线 | 触碰 |
|:--:|---|:--:|
| 1 | 双库一致性 / 不写「我」的姐妹关系 | ❌ 不动写入路径 |
| 2 | `entity_relations` 不写关系词作 name | ❌ |
| 3 | 改写入路径后验证 FG→entity_relations 同步 | ❌ 不改写入路径 |
| 4 | `extractRelations()` 必须走 `isName()` | ❌ 不改该文件 |
| 5 | 平辈关系不关联「我」 | ❌ |
| 6 | 改 `RelationshipExtractor.ts` 后测家庭关系词 | ❌ 不改该文件 |
| 7 | `roleplay_forbidden` 计算逻辑 | ❌ |
| 8 | 新增角色扮演入口须检查 `roleplay_forbidden` | ❌ 不新增入口 |
| 9 | CoreMemory persona 块前置注入 | ❌ |
| 10 | M6 `!_currentRoleplay` 守卫 | ❌ |
| 11 | `conversations` 查询 `roleplay_char` 过滤 | ❌ |

**外加思维链泄漏自查**：`resolveReplyFromFields` 的 fail-closed 语义、`noUsableAnswer`、reasoning strip 逻辑**均不改**，只在入口加一条 JSON 短路。

---

## 六、验证判据

**机械**
- `npx tsc --noEmit` → `exit 0` ✅
- `src/m5` + `src/app/entity` 测试全绿

**纯函数级**（复用 `D:\tmp\probe-strip.ts`）
- 完整 JSON 经 `resolveReplyFromFields` 后**长度不变**（1010 → 1010）

**端到端**（重启 webui 后等首轮终审，约 5 分钟）
- 🔴 **关键**：日志 `[Maintenance] 实体终审: 扫描15 提升N 标注M 观察K`，**N+M > 0**
- `rawLength` 为完整长度（~1000+），不再出现 `raw长度=3`

---

## 七、遗留（未在本批处理）

1. **`EntityTriageService.ts` 的注释订正未能落地**。
   该文件不在豁免范围内，Edit 被 Sentinel 回滚（`src/m5` 有豁免故保住）。其文件头 `JUDGE_MAX_TOKENS` 处仍写着**已被证伪的归因**：
   > 「模型先把 token 花在 reasoning_content 上，轮到 content 时预算已耗尽」——**错误**。已证伪：8000 下 `finish_reason=stop`、content 完整、峰值仅用 2338 tokens；16k/32k 同样正常。
   **真根因是剥离器误伤**（见 §二）。`rawLength` 字段的注释「截断故障的特征是它极短」同样应订正为「剥离器误伤的特征」。
   ⇒ **待该文件获得豁免时一并订正**。`JUDGE_MAX_TOKENS=8000` 与 `DEFAULT_TRIAGE_BATCH=15` 本身**无需回滚**（宽裕且无副作用）。

2. **FG 关系抽取行为将突变**（预期效果，需观察）：该路径此前一直静默失败，修复后会**首次真正写入关系**，`entity_relations` 增量可能明显。按红线 #3 核对 FG→entity_relations 同步条数；建议修复后**先观察一轮**，暂不批量导入历史对话。

3. **PAE 档案采集**可能一并「苏醒」（同属工具型调用）。

---

## 八、附：探针复现命令

```bash
node D:/tmp/probe-strip.ts        # 纯函数级：完整 JSON 经剥离器后是否被削短
node D:/tmp/probe-triage-real.mjs # 真实候选：只读生产 FG 库，复现终审 LLM 调用
```

> 探针均为只读（`readOnly: true` 打开 DB / 不发写请求 / 不打印密钥），用完即清。
