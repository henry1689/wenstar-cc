/**
 * MemWen OS · hash-chain —— 分段哈希链 + 墓碑（ADR-024 附录 v2 §6.1 唯一实现）
 *
 * 🔴 两层验证设计（守卫10 的数学基础）：
 *   ① 链完整性：c_i = SHA256(c_{i-1} ‖ h_i) —— 防「存储的 h 被篡改」，断点可定位；
 *   ② 内容一致：非墓碑项 hashCore(x_i) === h_i —— 防「正文 x 被篡改」；
 *      **墓碑项豁免②** —— 合法删除只清正文、保留历史 h 与墓碑标记，链仍可验证，
 *      消灭 v1 单链「删一条 = 全链失配 = 把合法删除检出为篡改」的致命问题。
 *
 * 分段：调用方按 段键（日期 / belong）分组，各自独立成链（段间互不影响）。
 * 外部锚定：段头链值 c 须定期写库外（本库只提供段头读取接口，落库由接线方负责）。
 *
 * 纯函数（build/verify 不读时钟、不碰 I/O）。
 */
import { createHash } from 'node:crypto';
import { canon, type MwImmutableCore } from './canon.js';

/** 段首创世值（全零；换算法/换代时升版并留档） */
export const MW_GENESIS = '0'.repeat(64);

/** SHA256 十六进制（本库唯一哈希原语） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 内容指纹：H = SHA256(canon(不可变核)) */
export function hashCore(core: MwImmutableCore): string {
  return sha256Hex(canon(core));
}

/** 链步进：C_i = SHA256(C_{i-1} ‖ '|' ‖ H_i)（分隔符防拼接歧义） */
export function chainHash(prev: string, h: string): string {
  if (!/^[0-9a-f]{64}$/.test(prev)) throw new TypeError('chainHash: prev 必须是 64 位十六进制');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new TypeError('chainHash: h 必须是 64 位十六进制');
  return sha256Hex(`${prev}|${h}`);
}

/** 链条目（tombstone=true 表示合法删除：正文已清、历史 h 保留） */
export interface MwChainLink {
  readonly id: string;
  readonly h: string;
  readonly c: string;
  readonly tombstone?: boolean;
}

/** 待入链的原始条目 */
export interface MwChainEntry {
  readonly id: string;
  readonly core?: MwImmutableCore;
  /** 已有历史指纹（墓碑迁移场景：正文不在，h 从既有记录带入） */
  readonly existingH?: string;
}

/**
 * 构建（或重建）一条分段链。
 * - 正常项：h = hashCore(core)；
 * - 墓碑项（existingH 带入、core 缺失）：h = existingH，链步进照常 —— 合法删除不断链。
 */
export function buildChain(entries: readonly MwChainEntry[], genesis: string = MW_GENESIS): MwChainLink[] {
  const links: MwChainLink[] = [];
  let prev = genesis;
  for (const e of entries) {
    if (e.existingH !== undefined) {
      if (e.core !== undefined) throw new TypeError('buildChain: core 与 existingH 互斥');
      const h = e.existingH;
      const c = chainHash(prev, h);
      links.push({ id: e.id, h, c, tombstone: true });
      prev = c;
      continue;
    }
    if (e.core === undefined) throw new TypeError(`buildChain: 条目 ${e.id} 缺 core 或 existingH`);
    const h = hashCore(e.core);
    const c = chainHash(prev, h);
    links.push({ id: e.id, h, c });
    prev = c;
  }
  return links;
}

/** 段头链值（供外部锚定：定期把该值写库外） */
export function segmentHead(links: readonly MwChainLink[], genesis: string = MW_GENESIS): string {
  return links.length === 0 ? genesis : links[links.length - 1]!.c;
}

/** 验证结果 */
export type MwVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly type: 'chain' | 'content'; readonly index: number; readonly id: string };

/**
 * 两层验证 + 断点定位。
 * 返回第一个失配位置；ok=true 表示整链完好（含墓碑项 —— 合法删除不报篡改）。
 */
export function verifyChain(
  links: readonly MwChainLink[],
  cores: ReadonlyMap<string, MwImmutableCore>,
  genesis: string = MW_GENESIS,
): MwVerifyResult {
  let prev = genesis;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    // ① 链完整性
    const expectC = chainHash(prev, link.h);
    if (expectC !== link.c) return { ok: false, type: 'chain', index: i, id: link.id };
    // ② 内容一致（墓碑豁免 —— 合法删除）
    if (!link.tombstone) {
      const core = cores.get(link.id);
      if (core === undefined) return { ok: false, type: 'content', index: i, id: link.id };
      if (hashCore(core) !== link.h) return { ok: false, type: 'content', index: i, id: link.id };
    }
    prev = link.c;
  }
  return { ok: true };
}
