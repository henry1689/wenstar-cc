import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyFragmentTier,
  applyTierFloors,
  runRecallBus,
} from '../../../m4/recall/recall-bus.js';

/**
 * MEM-UNIFY-V1 批2A · 召回总线接线守卫
 * 锁定：V14 默认下线（D1）、casual 不再早退、三出口统一总线、反馈单一实现、other 直通。
 */
const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('RecallBus 接线 · retrieval-stage', () => {
  const src = read('src/webui/chat/retrieval-stage.ts');

  it('V14 普通与会晤两处默认下线（D1）', () => {
    expect(src).toContain("const WS_SEARCH_V14 = process.env.WS_SEARCH_V14 === 'true'");
    expect(src).toContain("const WS_V2_REPLACE_LEGACY = process.env.WS_SEARCH_V14 === 'true'");
  });

  it('casual 轻档接入 Foundation + 总线，不再早退', () => {
    expect(src).toContain('_casualFoundationHits');
    expect(src).toContain("mode: 'casual'");
    expect(src).toContain('tier=bus');
    // 早退日志旧文案必须已消失
    expect(src).not.toContain('轻档：跳过 v11/v2/Foundation/LLM重排');
  });

  it('casual / 会晤 / 普通三个出口都接入 runRecallBus', () => {
    const matches = src.match(/runRecallBus\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("mode: 'deep'");
    expect(src).toContain("'standard' as const");
  });

  it('反馈统一走 applyRecallFeedback，旧就地 UPDATE 已删除', () => {
    expect(src).toContain('applyRecallFeedback(');
    expect(src).not.toContain('UPDATE black_diamond SET recall_count = recall_count + 1, updated_at = ? WHERE id = ?');
  });

  /**
   * MEM-UNIFY-V1 批4 接线守卫：普通（玉瑶）分支此前没有深度收集与结晶令。
   * 锁定：主动触发、深度素材包（含证据层）、结晶令、proactive 总线模式、指令在总线后注入。
   */
  it('批4：普通分支接入主动触发 + 深度素材包 + 结晶令', () => {
    expect(src).toContain("import { detectProactive, buildProactiveDirective } from './proactive-stage.js'");
    expect(src).toContain('collectDeepEvidenceFragments(');
    expect(src).toContain('DEEP_PACKAGE_HEADER');
    expect(src).toContain('[Proactive] normal 触发');
    expect(src).toContain('[DeepSweep] normal');
    expect(src).toContain('_proactiveResult.active ? \'proactive\' as const');
    // 主动指令必须在总线之后（否则会占记忆名额）—— 用出现顺序断言
    const busIdx = src.lastIndexOf('runRecallBus({');
    const dirIdx = src.lastIndexOf('buildProactiveDirective(_proactiveResult)');
    expect(busIdx).toBeGreaterThan(-1);
    expect(dirIdx).toBeGreaterThan(busIdx);
  });

  it('批4：会晤分支同样接入主动触发与证据层', () => {
    expect(src).toContain("detectProactive(message, { sqlite: _sqlite as never, entityUuid: _entityUuid })");
    expect(src).toContain('applyProactiveToPath(classifyMemSymPath(message)');
    expect(src).toContain('[Proactive] meeting 触发');
    expect(src).toContain('[DeepSweep] meeting');
  });
});

describe('RecallBus · other 上下文直通', () => {
  it('用户状态归 other', () => {
    expect(classifyFragmentTier('【用户状态】他现在有点累')).toBe('other');
  });

  it('other 不占记忆名额、不被 total 截断', () => {
    const budget = { total: 1, sand: 1, gold: 0, diamond: 0, group: 0 };
    const out = applyTierFloors([
      { text: '【用户状态】累', tier: 'other', score: 0.1 },
      { text: '📌 一条砂金', tier: 'sand', score: 0.9 },
    ], budget);
    const tiers = out.selected.map(c => c.tier);
    expect(tiers).toContain('other');
    expect(tiers).toContain('sand');
    expect(out.selected.length).toBe(2);
  });

  it('runRecallBus 保留 other', () => {
    const out = runRecallBus({
      mode: 'casual',
      query: '在干嘛',
      candidates: [
        { text: '【用户状态】累', tier: 'other', score: 0.1 },
        { text: '📌 砂金', tier: 'sand', score: 0.9 },
      ],
    });
    expect(out.selected.some(c => c.tier === 'other')).toBe(true);
  });
});
