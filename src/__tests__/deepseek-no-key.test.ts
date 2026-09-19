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
    const rawCallMatch = content.match(/async rawCall\([\s\S]{0,300}return result\.text/);
    expect(rawCallMatch).toBeTruthy();
    expect(rawCallMatch![0]).not.toMatch(/!resolveApiKey/);
  });
});
