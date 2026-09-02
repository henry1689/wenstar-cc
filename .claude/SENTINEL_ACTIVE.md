# ⚠️⚠️⚠️ SENTINEL 哨兵实时拦截通告 ⚠️⚠️⚠️

> 最后更新: 2026-09-02T05:39:06.110Z
> 此文件由 Sentinel 哨兵自动维护，每次拦截后更新。

---

## 🔴 以下文件已被 Sentinel 物理锁定（只读）

- **src/m2/math.ts** — 5 次无令牌修改 — 🔒 已锁定，不可编辑

## 🟠 以下文件已被 Sentinel 多次拦截

*暂无警告文件*

---

## 📢 给 Claude 的通告

**如果你发现以下文件无法编辑，说明 Sentinel 已将它设为只读。原因：你多次绕过 S1-S7 流水线直接修改。**

**正确做法**：
1. 阅读 `CLAUDE.md` 中的 🛡️ Harness 强制约束
2. 调用 MCP 工具 `harness_run_flow` 开始 S1-S7 流水线
3. 流水线通过后获取写入令牌，Sentinel 自动放行

**禁止**：
- ❌ `npx tsx scripts/xxx-patch.ts` — Bash 打补丁
- ❌ `writeFileSync` 直接写文件
- ❌ 用 Edit/Write 工具直接改源码
