// DEEPSEEK-PREFETCH-GUARD-A
// Verifies DeepSeekLLMProvider no-key behavior is safe.
// No real LLM API calls. No network requests. Zero credential inspection.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');

const KEYS = ['DEEPSEEK_API_KEY', 'LLM_API_KEY', 'DOUBAO_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'QWEN_API_KEY'];
const SAVED: Record<string, string | undefined> = {};

function saveKeys() { KEYS.forEach(k => SAVED[k] = process.env[k]); }
function unsetKeys() { KEYS.forEach(k => delete process.env[k]); }
function restoreKeys() { KEYS.forEach(k => SAVED[k] === undefined ? delete process.env[k] : process.env[k] = SAVED[k]); }

const savedFetch: typeof fetch | undefined = globalThis.fetch;

function mockCognition() {
  return {
    current: {
      raw_input: 'hello test',
      perception_snapshot: {
        pleasure: 0, intimacy: 0, sexual_attraction: 0, sensory_craving: 0,
        energy_merge: 0, possessiveness: 0, ecstasy: 0, arousal: 0,
        aggression: 0, sincerity: 0, dominance: 0,
      },
      key_entities: [],
    },
    vad: { pleasure: 0, arousal: 0, intimacy: 0 },
    keywords: [], sentiment: 'neutral', needs: [], valence: 0,
  };
}

describe('[NO-KEY] DeepSeekLLMProvider — pre-fetch key guard', () => {
  beforeEach(() => {
    saveKeys();
    unsetKeys();
    (globalThis as any).fetch = async () => {
      throw new Error('FETCH_TRAP: fetch must not be called when no API key is configured');
    };
  });

  afterEach(() => {
    restoreKeys();
    delete (globalThis as any).fetch;
    if (savedFetch) (globalThis as any).fetch = savedFetch;
  });

  // Test 1: isAvailable correctly detects no env API keys
  it('isAvailable() returns false when API keys are unset from env', async () => {
    const mod = await import('../../src/m5/DeepSeekLLMProvider.js');
    expect(mod.isAvailable()).toBe(false);
  });

  // Test 2: generate() always returns safe text without secret patterns
  it('generate() returns safe fallback text with no secret patterns', async () => {
    const mod = await import('../../src/m5/DeepSeekLLMProvider.js');
    const p = new mod.DeepSeekLLMProvider();
    const r = await p.generate({
      strategy: { promptLevel: 0 } as any,
      cognition: mockCognition() as any,
    });

    // Safe fallback text returned
    expect(typeof r.text).toBe('string');
    expect(r.text.length).toBeGreaterThan(0);

    // No secret patterns in result (regardless of guard or catch path)
    expect(r.text).not.toContain('Bearer');
    expect(r.text).not.toContain('sk-');
    expect(r.text).not.toMatch(/api\.deepseek/);
  }, 20000);

  // Test 3: safe fallback is repeatable
  it('generate() returns safe text for multiple calls', async () => {
    const mod = await import('../../src/m5/DeepSeekLLMProvider.js');
    const p = new mod.DeepSeekLLMProvider();
    for (let i = 0; i < 3; i++) {
      const r = await p.generate({
        strategy: { promptLevel: 0 } as any,
        cognition: mockCognition() as any,
      });
      expect(typeof r.text).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).not.toContain('Bearer');
    }
  }, 30000);

  // Test 4: 守卫存在于**生产真源 src**（V27批3 修订）
  //   原实现读 `dist/m5/DeepSeekLLMProvider.js` 并自称 "authoritative runtime source" ——
  //   该说法现在是**假的**：生产跑 `tsx src/webui/server.ts`（start.cjs），且 vitest 的
  //   dist alias 已于批3 移除（双源分叉收口）。原实现还有“文件不存在就静默 return”
  //   的蜜罐——dist 未构建时该断言根本不跑。现改为直接校验 src。
  it('src 生产真源包含 resolveApiKey 降级守卫', () => {
    const srcPath = path.join(REPO, 'src/m5/DeepSeekLLMProvider.ts');
    const content = readFileSync(srcPath, 'utf8');
    const guardCount = (content.match(/!resolveApiKey\(\)/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(1);
  });

  // Test 5: rawCall has no guard — remains explicit API caller
  it('rawCall has no guard — remains explicit API caller', () => {
    const srcPath = path.join(REPO, 'src/m5/DeepSeekLLMProvider.ts');
    const content = readFileSync(srcPath, 'utf8');
    // 🔴 2026-11-03 修测量（非放松判据）：原正则 `async rawCall\([\s\S]{0,300}return result\.text`
    //   是**写死 300 字符窗口**去够函数体，而 rawCall 的入参区与函数体之间已堆了两段注释
    //   （丙1 2026-10-09 的 opts 说明 + V45 2026-10-09 的原始 content 兜底说明），
    //   实测 `async rawCall(` → `return` 远超 300 ⇒ 恒 null ⇒ 断言必红。
    //   另 V45 把返回改写成 `return _raw ? result.rawContent! : result.text`（三元），
    //   字面 `return result.text` 也已不存在。
    //   现改为**界定函数体**再断言，判据本体（rawCall 内无 resolveApiKey 降级守卫）一字不改：
    const fnStart = content.indexOf('async rawCall(');
    expect(fnStart, 'src 中找不到 async rawCall —— 方法被改名/删除？请同步修订本守卫').toBeGreaterThanOrEqual(0);
    // 函数结束 = 行首 `  }`（函数体内部最浅缩进为 4 空格，不会提前命中）
    const fnEnd = content.indexOf('\n  }', fnStart);
    expect(fnEnd, '无法界定 rawCall 函数体边界').toBeGreaterThan(fnStart);
    const fnBody = content.slice(fnStart, fnEnd);
    // 原判据的「真的返回结果」一层（三元形态亦算）
    expect(fnBody, 'rawCall 必须返回结果').toMatch(/\breturn\s+[^;]+;/);
    // 核心判据：rawCall 内不得有 resolveApiKey 降级守卫（它是显式 API 调用方）
    expect(fnBody, 'rawCall 不得带 resolveApiKey 守卫').not.toMatch(/!resolveApiKey/);
  });
});
