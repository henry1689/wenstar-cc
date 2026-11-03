# MemArch Module 6 — 治理与安全（Governance & Security）任务书

> **模块编号**: M6-Governance
> **版本**: v1.0 任务书
> **日期**: 2026-11-03
> **基线溯源**: 基于 **MemArch-v2.0.0-Baseline** (MD5: `C3DCBFC83B96EBE88D06D230F26CF503`) 拆分
>
> ---
> **📊 任务书三级要素**
>
> | 要素 | 内容 |
> |---|---|
> | **P 优先级** | 🔴 **P0** — 最高优先级，横切所有模块的顶层约束 |
> | **交付物清单** | ① 命名空间隔离视图 + CI lint 规则<br>② 敏感度三级分类器（0/1/2）<br>③ 用户主权：suppress 抑制 + forget 遗忘流程<br>④ 遗忘请求级联处理（事务性）<br>⑤ 审计账本（哈希链 + 触发器）<br>⑥ 总开关 + 硬配额<br>⑦ 账本哈希链校验器<br>⑧ 单元测试 + 安全测试 |
> | **依赖关系** | 前置：无（可与 M1 并行启动）<br>并行：M1 存储层（视图随表结构一起建）<br>下游：所有模块都受治理面约束 |
> | **执行权限** | 🤖 **Claude Code 主导**<br>（审计账本哈希链、级联事务、敏感度分类器属于高风险重构）<br>👥 **Pi 辅助**（CI lint 脚本、测试用例、文档、Harness 看板） |
> ---

---

## 一、模块概述与边界

### 1.1 模块定位

治理与安全模块是记忆系统的"宪法与执法机关"，横切所有其他模块。它负责**命名空间隔离、敏感度分级、用户主权、审计账本、总开关与配额**，是所有破坏性操作的最终闸门。

### 1.2 模块边界

**本模块负责**：
- 命名空间隔离（v_conv_real / v_mem_real 视图 + CI lint）
- 敏感度三级分级（0 普通 / 1 私密 / 2 亲密）
- 用户主权：两种请求（suppress 抑制 / forget 遗忘）
- 遗忘请求的级联处理
- 审计账本（哈希链，只追加）
- 总开关（MEMORY_FORGET_ENABLED）
- 硬配额（每日 purge 上限）
- 账本哈希链校验

**本模块不负责**：
- 业务逻辑（→ 其他模块）
- 检索与呈现（→ M4 / M5）

---

## 二、核心功能清单

### 2.1 命名空间隔离

所有业务代码必须通过视图访问，禁止直接查原表：

```sql
CREATE VIEW v_conv_real AS
  SELECT * FROM conversations
  WHERE COALESCE(namespace,'default')='default'
    AND (roleplay_char IS NULL OR roleplay_char='')
    AND COALESCE(lifecycle_state,'fresh') NOT IN ('tombstone','purged');

CREATE VIEW v_mem_real AS
  SELECT * FROM memories
  WHERE COALESCE(namespace,'default')='default'
    AND lifecycle_state NOT IN ('tombstone','purged');
```

**CI 规则**：在 `storage/` 目录之外出现 `FROM conversations` 或 `FROM memories` 原表查询，构建直接失败。

### 2.2 敏感度三级分级

| 级别 | 含义 | 存储 | 检索 | 晋升 |
|---|---|---|---|---|
| 0 | 普通 | 明文 | 正常 | 自动 |
| 1 | 私密（健康、家庭、财务） | 字段级 AES-GCM 加密，密钥放系统钥匙串 | 正常，日志脱敏 | 进黑钻需用户确认 |
| 2 | 亲密 | 同上 | 只在私密会话模式下注入 | 进黑钻需用户确认 |

**敏感度判定**：由分类器判定（VAD + narrative_tag + 关系相关度 + 原关键词表）。原关键词表降级为分类器的一个弱特征，不再直接决定晋升。

### 2.3 用户主权：两种请求

| 用户说 | 模式 | 执行 |
|---|---|---|
| "别再提这件事了" | suppress（抑制） | 置 suppressed = 1；通路 B 完全排除；通路 A 只在用户明确问起时可用 |
| "把这件事忘掉" | forget（遗忘） | 先检索候选，向用户确认范围 → 进入墓碑（reason = user_request），跳过 expiring 和萃取 → 级联处理 |

**遗忘请求的级联处理**：
1. 只以这条记忆为来源的 L4 事实：设置 invalidated_at
2. 有多个来源的 L4 事实：移除这个来源，置信度下调
3. 引用它的黑钻指针：状态改为 revoked
4. 实体边：删除这条痕迹贡献的边
5. 账本：只记 id、内容哈希和原因
6. 恢复：墓碑期内只有用户本人可以恢复

### 2.4 审计账本（哈希链，只追加）

```sql
CREATE TABLE audit_ledger (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc        INTEGER NOT NULL,
  actor        TEXT NOT NULL,           -- system / sleep_run:<id> / user / owner
  action       TEXT NOT NULL,           -- promote / tombstone / purge / restore / migrate ...
  target_type  TEXT, target_id TEXT,
  meta         TEXT,                     -- JSON：只放元数据，绝不放内容原文
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL            -- sha256(prev_hash || 本行规范化序列)
);

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON audit_ledger BEGIN
  SELECT RAISE(ABORT,'append-only');
END;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON audit_ledger BEGIN
  SELECT RAISE(ABORT,'append-only');
END;
```

**设计要点**：账本只记元数据（id、内容哈希、原因），不记原文。这样"账本永久"和"用户要求忘掉"不冲突：内容被物理删除后，账本里只剩"某个 id 在某时因用户请求被删除"。

### 2.5 总开关与硬配额

| 控制项 | 实现 |
|---|---|
| 总开关 | MEMORY_FORGET_ENABLED=0 时，M3 步骤 9-10 只计算不执行（影子模式），状态全部冻结 |
| 日配额 | 每日 purge 计数存在 kv_counters，达到 500 条即停 |
| 用户请求豁免 | 用户主动请求不占配额，但单次请求超过 200 条需二次确认 |

### 2.6 账本哈希链校验

- 每个睡眠周期结束时校验哈希链
- 从上次校验点到当前末尾，逐行重算哈希
- 断链就告警，同时冻结遗忘模块（自动执行 MEMORY_FORGET_ENABLED=0）
- 磁盘压力大时，超过 1 年的账本段导出为带签名的离线归档，主库只保留锚点哈希

---

## 三、技术实现要点

### 3.1 加密实现

- 敏感度 ≥ 1 的字段使用 AES-GCM 加密
- 密钥放在系统钥匙串（macOS Keychain / Windows Credential Manager）
- 不允许硬编码密钥
- 检索时先解密再匹配，或用盲索引（如需密文检索）

### 3.2 级联处理的事务性

- 遗忘请求的级联处理必须在一个事务内完成
- 任何一步失败 → 全部回滚
- 保证数据一致性

### 3.3 账本校验的性能

- 哈希链校验每睡眠周期跑一次
- 万级条目下，校验耗时 < 1 秒
- 增量校验：只校验上次校验点之后的新行

---

## 四、验收标准

### 4.1 功能验收

| 验收项 | 通过标准 |
|---|---|
| 命名空间视图 | v_conv_real / v_mem_real 正确过滤测试数据和墓碑数据 |
| CI lint 生效 | storage/ 目录外直接查原表，构建失败 |
| 敏感度分级 | 测试 20 条数据，分级准确率 ≥ 85% |
| suppress 抑制 | 置 suppressed=1 后，通路 B 完全排除 |
| forget 遗忘 | 用户确认后，记忆正确进入墓碑，reason='user_request' |
| 级联处理 | 遗忘记忆后，关联的 L4 事实/黑钻指针/实体边正确处理 |
| 审计账本 | 所有 promote/tombstone/purge/restore 操作都有记录 |
| 账本只读 | 触发器禁止 UPDATE/DELETE 生效 |
| 总开关 | MEMORY_FORGET_ENABLED=0 时，遗忘只计算不执行 |
| 硬配额 | 每日 purge 达 500 条后自动停止 |
| 哈希链校验 | 篡改一行后，校验能发现并告警 |

### 4.2 安全验收

| 验收项 | 通过标准 |
|---|---|
| 测试数据零泄露 | namespace='test' 的数据在视图中完全不可见 |
| 墓碑数据不可见 | tombstone 的数据在视图中完全不可见 |
| 密钥安全 | 密钥不出现在代码/日志/配置文件中 |
| 账本无原文 | 审计账本中不包含记忆内容原文 |
| 级联事务 | 级联处理失败时全部回滚，无残留 |

### 4.3 性能验收

| 验收项 | 通过标准 |
|---|---|
| 账本写入 p95 | ≤ 5ms |
| 哈希链校验 | 万级条目 < 1 秒 |
| 级联处理 | 单条记忆的级联处理 < 500ms |

---

## 五、⚠️ 加固防篡改要求（验收合格后强制执行）

### 5.1 加固时机

**本模块全部验收通过后**，由模块负责人执行加固，加固完成前不得交付给其他模块作为横切约束。

### 5.2 加固内容

#### 5.2.1 治理规则冻结

- 对外只暴露 `GovernanceGuard.check(action, target)` 单一入口
- 内部的命名空间隔离、敏感度分级、用户主权、审计账本、总开关全部**私有**
- 所有治理规则（视图定义、敏感度分级、suppress/forget 流程、总开关）**冻结**
- 修改必须走 ADR 评审 + 业主授权

#### 5.2.2 内部代码保护

- 模块核心文件（GovernanceGuard.ts / SensitivityClassifier.ts / UserSovereignty.ts / AuditLedger.ts / LedgerVerifier.ts）标记为只读
- 提交时强制要求：commit message 中必须包含 `[M6-Governance-改动说明]`
- 所有阈值（daily_purge_quota / sensitivity_thresholds）只能通过配置文件改，不能硬编码
- 密钥管理代码绝对禁止修改

#### 5.2.3 外接部分预留

- 保留以下必要外接点：
  - `onGovernanceEvent` 钩子：治理事件回调（供监控/审计扩展）
  - `onUserRequest` 钩子：用户主权请求回调（供通知扩展）
  - 自定义敏感度分类器注册接口：允许其他模块添加自定义分类规则
- 除上述预留外接点外，**模块内部逻辑不允许外部直接修改**

#### 5.2.4 Harness 监管接入

- 模块状态上报到 Harness：审计日志条数、哈希链校验状态、遗忘请求次数、配额使用情况
- 哈希链校验结果写入 Harness
- Harness 定期校验：账本完整性、配额是否被突破、总开关状态
- 发现篡改或异常 → 自动告警 + 冻结整个记忆系统

### 5.3 修改权限

| 操作 | 权限要求 |
|---|---|
| 正常治理检查 | 所有模块可用 |
| 配额参数调整 | 必须业主授权 |
| 敏感度分级规则修改 | 必须业主授权 + ADR 评审 |
| 用户主权流程修改 | 必须业主授权 + ADR 评审 |
| 审计账本结构修改 | 必须业主授权 + ADR 评审 |
| 内部代码修改 | 必须业主授权，否则视为篡改 |

---

## 六、依赖与协作

- **前置**：无（治理是顶层约束，可与其他模块并行开发）
- **并行**：与 M1 同步启动，命名空间视图随表结构一起建
- **下游**：所有模块都受治理面约束，治理模块的任何变更都需要全链路回归
