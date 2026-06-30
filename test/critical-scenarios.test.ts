/**
 * 关键场景守卫测试 — 极端情况验证
 *
 * 用途：确保系统在核心场景下的行为符合预期。
 * 每次改完代码后运行此测试，确认没有破坏关键路径。
 *
 * Ref: wenstar-cx test/scenarios/critical.json
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PerceptionAnalyzer } from '../src/m3/PerceptionAnalyzer.js';
import scenarios from './scenarios/critical.json';

interface ScenarioExpectation {
  calcium_range?: [number, number];
  pleasure_range?: [number, number];
  arousal_range?: [number, number];
  intimacy_range?: [number, number];
  factual_range?: [number, number];
  aggression_range?: [number, number];
  temporal_focus_range?: [number, number];
}

interface Scenario {
  id: string;
  input: string;
  description: string;
  expected: ScenarioExpectation;
}

describe('[关键场景] M3 感知验证', () => {
  const analyzer = new PerceptionAnalyzer();

  for (const scenario of scenarios as Scenario[]) {
    it(`[${scenario.id}] ${scenario.description}`, () => {
      const enhanced = analyzer.analyzeText(scenario.input);

      // 验证钙化范围
      const cal = enhanced.calcium_score;
      if (scenario.expected.calcium_range) {
        expect(cal, `钙化分应在 [${scenario.expected.calcium_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.calcium_range[0]);
        expect(cal, `钙化分应在 [${scenario.expected.calcium_range}]`)
          .toBeLessThanOrEqual(scenario.expected.calcium_range[1]);
      }

      // 验证感知维度范围
      const p = enhanced.perception;

      if (scenario.expected.pleasure_range) {
        expect(p.pleasure, `pleasure 应在 [${scenario.expected.pleasure_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.pleasure_range[0]);
        expect(p.pleasure, `pleasure 应在 [${scenario.expected.pleasure_range}]`)
          .toBeLessThanOrEqual(scenario.expected.pleasure_range[1]);
      }

      if (scenario.expected.arousal_range) {
        expect(p.arousal, `arousal 应在 [${scenario.expected.arousal_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.arousal_range[0]);
        expect(p.arousal, `arousal 应在 [${scenario.expected.arousal_range}]`)
          .toBeLessThanOrEqual(scenario.expected.arousal_range[1]);
      }

      if (scenario.expected.intimacy_range) {
        expect(p.intimacy, `intimacy 应在 [${scenario.expected.intimacy_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.intimacy_range[0]);
        expect(p.intimacy, `intimacy 应在 [${scenario.expected.intimacy_range}]`)
          .toBeLessThanOrEqual(scenario.expected.intimacy_range[1]);
      }

      if (scenario.expected.factual_range) {
        expect(p.factual, `factual 应在 [${scenario.expected.factual_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.factual_range[0]);
        expect(p.factual, `factual 应在 [${scenario.expected.factual_range}]`)
          .toBeLessThanOrEqual(scenario.expected.factual_range[1]);
      }

      if (scenario.expected.aggression_range) {
        expect(p.aggression, `aggression 应在 [${scenario.expected.aggression_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.aggression_range[0]);
      }

      if (scenario.expected.temporal_focus_range) {
        expect(p.temporal_focus, `temporal_focus 应在 [${scenario.expected.temporal_focus_range}]`)
          .toBeGreaterThanOrEqual(scenario.expected.temporal_focus_range[0]);
        expect(p.temporal_focus, `temporal_focus 应在 [${scenario.expected.temporal_focus_range}]`)
          .toBeLessThanOrEqual(scenario.expected.temporal_focus_range[1]);
      }

      // 验证 24 维感知向量完整性
      const dimCount = Object.keys(p).length;
      expect(dimCount, `感知维度应为 24，实际为 ${dimCount}`).toBe(24);
    });
  }
});

describe('[关键场景] 边界情况', () => {
  it('空文本不崩溃', () => {
    const analyzer = new PerceptionAnalyzer();
    expect(() => analyzer.analyzeText('')).not.toThrow();
  });

  it('超长文本不崩溃（2000字符）', () => {
    const analyzer = new PerceptionAnalyzer();
    expect(() => analyzer.analyzeText('测试'.repeat(1000))).not.toThrow();
  });

  it('纯特殊字符不崩溃', () => {
    const analyzer = new PerceptionAnalyzer();
    expect(() => analyzer.analyzeText('！！！？？？…………！！！')).not.toThrow();
  });
});
