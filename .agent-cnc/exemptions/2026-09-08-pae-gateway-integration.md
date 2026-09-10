# M2-2 PAE Gateway 集成豁免

## 背景
PAE (`ProfileAcquisitionEngine`) 的 `commitField` 方法直接调用 `familyGraph.setDossierField`，绕过 `FGProfileWriteGateway` 的会晤隔离授权检查。这导致会晤模式下，非会晤实体可通过 PAE 写入主 FG 档案。

## 修改内容
1. `ProfileAcquisitionEngine.ts`:
   - 添加 `gateway?: FGProfileWriteGateway` 构造参数
   - `commitField` 中走 gateway（当 gateway 存在时）
   - gateway 拒绝时返回 `committed: false`，不计入 `fieldsWritten`

2. `FGProfileWriteGateway.ts`:
   - 添加 `tryUpdateProfile()` 方法，返回 boolean 表示是否授权写入

## 豁免原因
- PAE 是受管控文件（在 `familygraph_change` workflow 中）
- 需要注入 gateway 依赖，修改构造函数签名
- 这是 M2-2 写侧收口的核心改动

## 风险评估
- 低风险：仅添加可选参数，向后兼容
- 测试已覆盖：`pae-meeting-write-guard.test.ts` 3个用例

## 申请时间
2026-09-08
