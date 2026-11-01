/**
 * MemSym 五指标观测（批ε·内存计数器）
 * =====================================
 * 依据：ADR-MEM-002 第四块隐患八——验收哲学：A 拦截率/B 误降级率/元素拾取/钙化分布/串扰检出，
 * 把"渐进、有机、不僵化"变成可观测数字（含元素复用分布熵=防回音室前兆）。
 * v1.0：进程内计数 + 周期快照日志（观测面/面板后续接）。
 */
interface MemSymCounters {
  pathA: number;            // 判定为通路 A（回溯往事）
  pathB: number;            // 判定为通路 B（当下对话）
  bAmbiguityProtected: number; // 歧义保护命中（疑似降级被保护——观测误降级率分母）
  elementPicked: number;    // 元素拾取成功
  boostB: number;           // B 路钙化增强执行
  boostBCooldown: number;   // B 路增强被冷却拦截（防僵化机制在工作）
  crossEntityBlocked: number; // 跨实体拦截（窜台检出）
}

const counters: MemSymCounters = {
  pathA: 0, pathB: 0, bAmbiguityProtected: 0, elementPicked: 0,
  boostB: 0, boostBCooldown: 0, crossEntityBlocked: 0,
};
const contentHistogram = new Map<string, number>(); // 元素复用直方图（分布熵原料）
let lastSnapshot = 0;

export function incMemSym(metric: keyof MemSymCounters, n = 1): void {
  counters[metric] += n;
  maybeSnapshot();
}

/** 元素复用计数（分布熵观测原料：防"少数元素绑架人设"的回音室前兆） */
export function trackElementUse(content: string): void {
  const key = (content || '').slice(0, 12);
  if (!key) return;
  contentHistogram.set(key, (contentHistogram.get(key) || 0) + 1);
}

/** 简易分布熵（香农熵，底2）：熵持续下降=正在模板化（僵化前兆告警面） */
export function elementReuseEntropy(): number {
  const total = [...contentHistogram.values()].reduce((s, v) => s + v, 0);
  if (total <= 1) return 0;
  let h = 0;
  for (const v of contentHistogram.values()) {
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function maybeSnapshot(): void {
  const total = Object.values(counters).reduce((s, v) => s + v, 0);
  if (total > 0 && total % 40 === 0 && Date.now() - lastSnapshot > 300_000) {
    lastSnapshot = Date.now();
    console.log(`[MemSym·指标] A=${counters.pathA} B=${counters.pathB} 保护=${counters.bAmbiguityProtected} ` +
      `拾取=${counters.elementPicked} B增强=${counters.boostB} 冷却拦截=${counters.boostBCooldown} ` +
      `窜台拦截=${counters.crossEntityBlocked} 复用熵=${elementReuseEntropy().toFixed(2)}`);
  }
}
