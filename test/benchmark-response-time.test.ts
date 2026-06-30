import { describe, it, expect } from 'vitest';
import { PerceptionAnalyzer } from '../src/m3/PerceptionAnalyzer.js';

const SHORT = '在干嘛';
const MEDIUM = '今天心情不错，出去散步看到一只橘猫好可爱';
const LONG = '我跟你说今天我遇到一件特别有意思的事情。早上出门的时候碰到了一只橘猫，它蹲在楼梯口看着我，然后我就蹲下来摸了它一下，它居然蹭了蹭我的手。然后我去坐地铁，地铁上人特别多，我站着看手机，突然一个刹车我没站稳差点摔倒，旁边的姑娘扶了我一下。到了公司发现今天食堂做了我最爱的红烧肉，太幸福了。一天下来虽然累但是挺开心的。';

function measure(fn: () => void, iterations = 10): number {
  const start = Date.now();
  for (let i = 0; i < iterations; i++) fn();
  return (Date.now() - start) / iterations;
}

describe('[基准] M3 感知分析响应时间', () => {
  const a = new PerceptionAnalyzer();

  it('短文本应在 2ms 内完成', () => {
    const ms = measure(() => a.analyzeText(SHORT), 50);
    expect(ms, `${ms.toFixed(2)}ms/次`).toBeLessThan(2);
  });

  it('中文本应在 5ms 内完成', () => {
    const ms = measure(() => a.analyzeText(MEDIUM), 50);
    expect(ms, `${ms.toFixed(2)}ms/次`).toBeLessThan(5);
  });

  it('长文本应在 10ms 内完成', () => {
    const ms = measure(() => a.analyzeText(LONG), 30);
    expect(ms, `${ms.toFixed(2)}ms/次`).toBeLessThan(10);
  });

  it('批量 10 条应在 20ms 内完成', () => {
    const texts = ['在干嘛','想你了','好难过','今天开心','帮我写个方案','妈妈在ICU','生病了','我爱你','晚安','早上好'];
    const ms = measure(() => texts.forEach(t => a.analyzeText(t)), 20);
    expect(ms, `${ms.toFixed(2)}ms/批`).toBeLessThan(20);
  });
});

describe('[基准] 感知分析稳定性', () => {
  it('相同输入 100 次返回相同钙化分', () => {
    const a = new PerceptionAnalyzer();
    const first = a.analyzeText('想你了').calcium_score;
    for (let i = 0; i < 100; i++) {
      expect(a.analyzeText('想你了').calcium_score).toBe(first);
    }
  });
});
