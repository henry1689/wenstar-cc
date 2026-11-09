/**
 * MemWen OS 核心库（src/memwen）—— 纯函数 · 零业务依赖 · 依赖单向
 *
 * 🔴 ADR-024 附录 v2 立法：
 *   - 依赖单向：本库 **不 import 任何业务模块**（数据库/服务/配置一概不碰）；
 *     业务侧后续 `import { ... } from '../memwen/index.js'`，方向不可反转。
 *   - 公式唯一实现：附录 §八 16 条守卫对应的函数只在本库出现一次；
 *     公式与代码漂移即守卫失明，属 ADR 修订流程管辖。
 *   - 守卫即规格：`__tests__/` 下的守卫测试是这些函数的可执行规格。
 *
 * M1 期已落地（附录 §八 第 9/10/14 条）：
 *   - canon / chainHash / buildChain / verifyChain —— 哈希链（篡改断点 + 合法删除不误报）
 *   - foldApply / reconcileIndex / shouldAlert        —— 事件流重建（Δ=0 不变量）
 *   - wilsonCI / pairedDiffCI / gateDecision          —— 配对三态门禁
 *
 * 后续各期（M2-M5）函数按 ADR-024 路线图逐批加入，每批走 Harness。
 */

export { canon, type MwImmutableCore } from './canon.js';
export {
  MW_GENESIS,
  sha256Hex,
  hashCore,
  chainHash,
  buildChain,
  segmentHead,
  verifyChain,
  type MwChainLink,
  type MwChainEntry,
  type MwVerifyResult,
} from './hash-chain.js';
export {
  foldApply,
  reconcileIndex,
  shouldAlert,
  type MwEvent,
  type MwApply,
  type MwIndexSnapshot,
  type MwReconcileResult,
} from './event-rebuild.js';
export {
  wilsonCI,
  pairedDiffCI,
  gateDecision,
  type MwCI,
  type MwPaired,
  type MwGateVerdict,
} from './gate-stats.js';
export {
  type MwIdentityPort,
  type MwResolveResult,
  type MwContextView,
  type MwRenderResult,
} from './identity-port.js';
