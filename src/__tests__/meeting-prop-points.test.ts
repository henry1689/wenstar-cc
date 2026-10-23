/**
 * V15 `MEETING_PROP_POINTS` 编目 — 防漂移守卫（T013 Phase 2 批A+B）
 *
 * 🔴 为什么要有这个测试（复发三次后才加，成本已经很高）：
 *   chat.ts 的 `_meetingEntityName` 传播点编目是 S4/DS-06 评审的核对基准，
 *   但它**用硬编码行号**记录位置。任何在编目之前的编辑都会把行号整体推偏，
 *   而编目本身不会报错 —— 漂移只能在闸门那一步被发现，且每次都要重新逐点 grep 校准。
 *   本测试把「行号是否还指在正确的代码上」变成 S5 阶段的**秒级失败**，
 *   并给出具体是哪一点偏了。
 *
 * 判据：每一行编目声明的行号，其**源码内容**必须包含该点的特征串（probe）。
 *   另加一条防误判：声明的行号不得落在编目数组自身区间内（编目的 via 字段里
 *   也含特征串，若行号指回编目自身会得到假绿灯）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHAT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'webui', 'chat.ts');
const src = readFileSync(CHAT_PATH, 'utf8').split('\n');

// 🔴 V15 方案A（P059·PI）：编目区间提升到**模块级** —— parseCatalog 与 locateByProbe 都要用，
//   若定义在 describe 内则模块级的 locateByProbe 取不到（作用域 bug，实测 ReferenceError）。
const catalogStart = src.findIndex(l => l.includes('const MEETING_PROP_POINTS'));
const catalogEnd = (() => {
  for (let i = catalogStart + 1; i < src.length; i++) {
    if (src[i].trim().startsWith('];')) return i;
  }
  return src.length;
})();

/**
 * 各传播点的源码特征串。
 * 🔴 与 chat.ts 的 `via` 字段**刻意不同**：`via` 是给人看的描述（如 "meetingEntity param"），
 *   不能用来做字符串断言；probe 是该点真实源码片段，机器可判。
 */
const PROBES: Record<string, string> = {
  'L0-路由': '_meetingEntityName: _activeMeetingName',
  'L1-上下文': 'const _activeMeetingName',
  'L2-档案': 'buildEntityContext(ctx.m4.getFamilyGraph',
  'L3-DNA': 'dna.entity_genes.push',
  'L4-KB过滤': '_meetingEntityUuid: ctx._entityMeeting',
  'L5-记忆门控': 'ctx.m6 && !_isMeeting',
  'L6-注入保留': 'preserveLabels: !!_meetingEntityName',
  'L7-PFC': 'meetingEntity: _meetingEntityName',
  'L8-角色提示': 'roleHint = _meetingEntityName',
  'L9-自问自检': '!knowledgeBaseText && !_meetingEntityName',
  'L10-主人镜像': 'if (ctx.masterProfile && !_meetingEntityName) {',
  'L11-政策选择': 'new ChatPolicy(meetingMode',
  'L12-M5调度': 'orchestrate(ctx_m4',
  'L13-自名检测': '_meetingEntityName && reply && reply.length > 20',
};

/**
 * 从源码里解析 MEETING_PROP_POINTS 数组（不 import chat.ts —— 那会执行重量级模块初始化）。
 * 🔴 V15 方案A（P059·PI）：编目改为 probe 特征串定位，此处解析 `probe` 字段（不再有 line）。
 */
function parseCatalog(): Array<{ probe: string; stage: string; occurrence?: number }> {
  const start = src.findIndex(l => l.includes('const MEETING_PROP_POINTS'));
  expect(start, 'chat.ts 中找不到 MEETING_PROP_POINTS（编目被删除或改名？）').toBeGreaterThanOrEqual(0);

  const out: Array<{ probe: string; stage: string; occurrence?: number }> = [];
  for (let i = start + 1; i < src.length; i++) {
    const l = src[i];
    if (l.trim().startsWith('];') || l.trim() === ']') break;
    // probe 是字符串字面量（可能含括号/空格），用非贪婪引号捕获
    const m = l.match(/\{\s*probe:\s*'([^']+)\s*'\s*,\s*stage:\s*'([^']+)'/);
    if (m) {
      // occurrence 显式消歧（P062 问题4）：编目可选声明 `occurrence: N`（第 N 次出现，1-based）
      const occ = l.match(/occurrence:\s*(\d+)/);
      out.push({ probe: m[1], stage: m[2], occurrence: occ ? Number(occ[1]) : undefined });
    }
  }
  return out;
}

/**
 * 用 probe 在源码里定位**全部**命中行号（1-based 升序）。
 * 🔴 搜索区间限定在编目数组**之后**（catalogEnd 起）：编目 via/desc 字段本身含特征串，
 *   若全文件搜索会命中编目自身得到假绿灯（旧行号时代的同一误判，这里前置排除）。
 * 🔴 P062 问题4：原实现「找到第一个就返回」且测试名宣称「唯一」——
 *   但没验证唯一性，将来加注释含 probe 会静默定位错误（自校验是 tautology）。现返回全部命中，
 *   由调用方断言唯一性（或按 occurrence 显式消歧）。
 * @returns 命中行号数组（可能为空）；空 = probe 失效（代码重构改了特征串）。
 */
function collectProbeHits(probe: string, source: string[] = src): number[] {
  const hits: number[] = [];
  for (let i = catalogEnd; i < source.length; i++) {
    if (source[i].includes(probe)) hits.push(i + 1); // 转 1-based
  }
  return hits;
}

/**
 * 定位单个编目点：命中数=0 → -1（probe 失效）；命中数=1 → 该行；
 * 命中数>1 且无 occurrence → -2（二义，需在编目里显式消歧）；有 occurrence → 取第 N 次出现。
 */
function locateByProbe(entry: { probe: string; occurrence?: number }, source: string[] = src): number {
  const hits = collectProbeHits(entry.probe, source);
  if (hits.length === 0) return -1;
  if (hits.length === 1) return hits[0];
  if (entry.occurrence && entry.occurrence >= 1 && entry.occurrence <= hits.length) {
    return hits[entry.occurrence - 1];
  }
  return -2; // 二义且未声明 occurrence
}

describe('[V15] MEETING_PROP_POINTS — probe 特征串防漂移守卫（方案A）', () => {
  const catalog = parseCatalog();

  it('编目点齐全（L0-L13 共 14 点，一个都不能少）', () => {
    expect(catalog.length).toBe(14);
    const stages = catalog.map(c => c.stage);
    for (const stage of Object.keys(PROBES)) {
      expect(stages, `编目缺 ${stage}`).toContain(stage);
    }
  });

  it('每个 probe 都能在源码唯一定位（V15 方案A：特征串定位，编辑推偏后自动重定位）', () => {
    const broken: string[] = [];
    for (const entry of catalog) {
      const hits = collectProbeHits(entry.probe);
      if (hits.length === 0) {
        broken.push(`${entry.stage}: probe 失效（源码里找不到 "${entry.probe}"）—— 代码重构改了特征串，需更新编目`);
        continue;
      }
      // 🔴 P062 问题4：断言**唯一性**（原实现只找第一个、不验证唯一，将来加注释含 probe 会静默错位）
      if (hits.length > 1 && !entry.occurrence) {
        broken.push(`${entry.stage}: probe 二义（命中 ${hits.length} 处：${hits.join(', ')}）——请加长 probe 或在编目声明 occurrence 消歧`);
        continue;
      }
      const lineNo = locateByProbe(entry);
      if (lineNo < 0) {
        broken.push(`${entry.stage}: occurrence 越界或二义未消歧`);
        continue;
      }
      // 定位后自校验：命中的那行确实含该 probe
      if (!src[lineNo - 1].includes(entry.probe)) {
        broken.push(`${entry.stage}: locateByProbe 定位行 ${lineNo} 内容与 probe 不符`);
      }
    }
    expect(broken, `🔴 V15 probe 定位失败 ${broken.length} 处 —— 特征串已失效/二义/编目损坏`).toEqual([]);
  });

  it('P062 问题4：二义 probe（未声明 occurrence）必须报错，唯一 probe 正常定位', () => {
    // 二义 probe：同一特征串出现两次且未声明 occurrence → locateByProbe 返回 -2
    const ambiguous = { probe: '_meetingEntityName' }; // 全文必然多处命中
    expect(collectProbeHits(ambiguous.probe).length).toBeGreaterThan(1);
    expect(locateByProbe(ambiguous)).toBe(-2);
    // occurrence 显式消歧：声明第 1 次出现 → 定位到首个命中且内容含 probe
    const disambiguated = { probe: '_meetingEntityName', occurrence: 1 };
    const lineNo = locateByProbe(disambiguated);
    expect(lineNo).toBe(collectProbeHits(ambiguous.probe)[0]);
    expect(src[lineNo - 1]).toContain(ambiguous.probe);
    // probe 失效：不存在的特征串 → -1
    expect(locateByProbe({ probe: '__NO_SUCH_PROBE_XYZ__' })).toBe(-1);
  });

  it('P062 问题5：编目前插入行后 probe 自动重定位（不漂移，验收判据秒级断言）', () => {
    // 模拟在 catalogEnd 之后、所有真实点之前虚拟插入 3 行，所有 probe 定位应 +3 而非固定原值
    const SHIFT = 3;
    const virtual: string[] = [
      ...src.slice(0, catalogEnd),
      '// 漂移模拟行 1',
      '// 漂移模拟行 2',
      '// 漂移模拟行 3',
      ...src.slice(catalogEnd),
    ];
    let driftChecked = 0;
    for (const entry of catalog) {
      const orig = locateByProbe(entry);
      if (orig < 0) continue; // 二义点跳过（上面已断言）
      const shifted = locateByProbe(entry, virtual);
      expect(shifted, `${entry.stage}: 插入 ${SHIFT} 行后应重定位到原行+${SHIFT}`).toBe(orig + SHIFT);
      // 重定位行在虚拟源码里仍是同一语义点（内容含 probe）
      expect(virtual[shifted - 1]).toContain(entry.probe);
      driftChecked++;
    }
    // 至少 12 个唯一点被验证（当前 14 点全唯一点）
    expect(driftChecked).toBeGreaterThanOrEqual(12);
  });

  it('probe 与守卫 PROBES 定义一致（防两处定义分叉）', () => {
    const mismatched: string[] = [];
    for (const entry of catalog) {
      const guardProbe = PROBES[entry.stage];
      if (guardProbe !== entry.probe) {
        mismatched.push(`${entry.stage}: 编目 probe="${entry.probe}" ≠ 守卫 PROBES="${guardProbe}"`);
      }
    }
    expect(mismatched, '🔴 编目与守卫 PROBES 两处 probe 定义分叉').toEqual([]);
  });

  it('批B 接入点也在编目覆盖内（身份解析新增的分支不得脱离编目）', () => {
    // B3 让 L12 出现两条身份路径；两条都必须落在 L12 probe 定位行附近
    const l12 = catalog.find(c => c.stage === 'L12-M5调度')!;
    const l12Line = locateByProbe(l12);
    expect(l12Line, 'L12 probe 无法定位').toBeGreaterThan(0);
    // 🔴 身份解析发生在 orchestrate **之前**，故向上取窗口
    const near = src.slice(l12Line - 12, l12Line + 1).join('\n');
    expect(near, 'L12 上方找不到原路径 resolveIdentity（批B 回退分支丢失）').toContain('_resolveIdentity({');
    expect(near, 'L12 上方找不到批B 状态路径 resolveIdentityFromState').toContain('resolveIdentityFromState');
  });
});
