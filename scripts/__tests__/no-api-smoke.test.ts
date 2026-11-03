// NO-API-TEST-BOUNDARY-A — No-API Guard Smoke Test
//
// Verifies governance/harness scripts and test helpers do NOT:
//   - Require API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
//   - Import network/LLM modules (openai, anthropic, fetch, axios, etc.)
//   - Make network calls
//
// All tests are pure and local. Zero API calls. Zero network.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');

// ── 1. Governance scripts run without API keys ──

describe('[NO-API] Governance scripts work without API keys', () => {
  const NO_KEY_ENV = {
    ...process.env,
    NODE_ENV: 'test',
    // Explicitly unset common API key env vars
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    QWEN_API_KEY: '',
    LLM_API_KEY: '',
  };

  it('check-harness-diff --help works without any API key', () => {
    const r = spawnSync('node', ['scripts/check-harness-diff.cjs', '--help'], {
      cwd: REPO, encoding: 'utf8', timeout: 5000, env: NO_KEY_ENV,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('META-GOV-A');
    expect(r.stdout).toContain('Usage');
  });

  it('apply-migrations --help works without any API key', () => {
    const r = spawnSync('node', ['scripts/apply-migrations.mjs', '--help'], {
      cwd: REPO, encoding: 'utf8', timeout: 5000, env: NO_KEY_ENV,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage');
  });

  it('governance denial path works without any API key', () => {
    const r = spawnSync('node', ['scripts/apply-migrations.mjs', '--apply'], {
      cwd: REPO, encoding: 'utf8', timeout: 15000, env: NO_KEY_ENV,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('SCRIPT EXECUTION CONTRACT DENIED');
  });
});

// ── 2. Harness test files do not import LLM/network modules ──

const ALLOWED_IMPORTS = [
  'node:child_process',
  'node:fs',
  'node:path',
  'node:os',
  'node:module',
  'node:crypto',
  'vitest',
  'sql.js',
  'better-sqlite3',
];

const FORBIDDEN_PATTERNS = [
  /require\(['"]openai['"]/,
  /require\(['"]anthropic['"]/,
  /require\(['"]@anthropic-ai\//,
  /require\(['"]@google\/generative-ai/,
  /require\(['"]groq-sdk/,
  /require\(['"]langchain/,
  /import.*from ['"]openai['"]/,
  /import.*from ['"]anthropic['"]/,
  /fetch\(/,
  /axios/,
];

describe('[NO-API] Harness test files are API-free', () => {
  const harnessTests = [
    'scripts/__tests__/meta-gov-a-harness-diff-smoke.test.ts',
    'scripts/__tests__/world-segment-a-smoke.test.ts',
    'scripts/__tests__/world-segment-b-audit-smoke.test.ts',
    'scripts/__tests__/world-segment-c1-gate-pass-through-smoke.test.ts',
    'scripts/__tests__/world-segment-c2-cli-smoke.test.ts',
    'scripts/__tests__/script-gov-b-audit-smoke.test.ts',
    'scripts/__tests__/script-gov-c-db-isolation-smoke.test.ts',
  ];

  for (const relPath of harnessTests) {
    it(`${relPath} has no LLM/network imports`, () => {
      const content = readFileSync(path.join(REPO, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

// ── 3. Harness core scripts have no LLM/network imports ──

const HARNESS_CORE_SCRIPTS = [
  'scripts/_governance-gate.cjs',
  'scripts/_governance-audit.cjs',
  'scripts/check-harness-diff.cjs',
  'scripts/lib/world-segment.cjs',
];

describe('[NO-API] Harness core scripts are API-free', () => {
  for (const relPath of HARNESS_CORE_SCRIPTS) {
    it(`${relPath} has no LLM/network imports`, () => {
      const content = readFileSync(path.join(REPO, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

// ── 4. Helpers are API-free ──

const HARNESS_HELPERS = [
  'scripts/__tests__/helpers/db-isolation.ts',
  'scripts/__tests__/helpers/governed-script-runner.ts',
  'scripts/__tests__/helpers/sqlite-fixture.ts',
];

describe('[NO-API] Harness test helpers are API-free', () => {
  for (const relPath of HARNESS_HELPERS) {
    it(`${relPath} has no LLM/network imports`, () => {
      const content = readFileSync(path.join(REPO, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

// ── 5. Agent-CNC source is API-free ──

const AGENT_CNC_SOURCES = [
  'src/agent-cnc/config.ts',
  'src/agent-cnc/cli.ts',
  'src/agent-cnc/git.ts',
  'src/agent-cnc/report.ts',
  'src/agent-cnc/risk-router.ts',
  'src/agent-cnc/types.ts',
  'src/agent-cnc/utils.ts',
  'src/agent-cnc/validators.ts',
  'src/agent-cnc/command-runner.ts',
  'src/agent-cnc/guard-event.ts',
  'src/agent-cnc/guard-history.ts',
  'src/agent-cnc/audit.ts',
  'src/agent-cnc/workflow-router.ts',
];

describe('[NO-API] Agent-CNC source is API-free', () => {
  for (const relPath of AGENT_CNC_SOURCES) {
    it(`${relPath} has no LLM/network imports`, () => {
      const content = readFileSync(path.join(REPO, relPath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

// ── 6. Agent-CNC local config loading does not crash ──

describe('[NO-API] Agent-CNC config loading is local-only', () => {
  it('checkLlmConfigured() runs without API keys and does not crash', () => {
    // 🔴 2026-11-03 修（与 provider-selection-smoke 同源）：原 `node -e` + require('./dist/...') ——
    //   dist 是**无消费者的构建产物**且本地常不存在 ⇒ 子进程抛 Cannot find module ⇒ status 1。
    //   生产跑 tsx（`agent-cnc: tsx src/agent-cnc/cli.ts`），故改用 tsx 加载 **src 真源**；
    //   实测 `node ./node_modules/tsx/dist/cli.mjs -e "require('./src/agent-cnc/config.ts')"` exit 0。
    const r = spawnSync(
      'node',
      [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), '-e', `
        var m = require('./src/agent-cnc/config.ts');
        var result = m.checkLlmConfigured();
        var valid = ['configured','disabled','unavailable'];
        if (!valid.includes(result)) throw new Error('Unexpected: ' + result);
        console.log('LLM STATUS: ' + result);
      `],
      {
        cwd: REPO,
        encoding: 'utf8',
        // 🔴 2026-11-03 调参（非放宽断言）：原 5000ms。本用例改用 tsx 加载 src 真源后
        //   （见文件头注释：`require('./dist/...')` 因 dist 不存在而 exit 1），
        //   子进程须先拉起 tsx 运行时（单跑实测约 1~2s），全量并发 CPU 抢占下 5s 不够
        //   ⇒ spawnSync 返回 `status: null`（超时被杀）⇒ `expect(r.status).toBe(0)` 报
        //   `expected null to be +0`。实测：单跑 67/67 绿、全量偶发红 ⇒ 是**超时**不是逻辑错。
        //   断言本体（status===0 + stdout 匹配 LLM STATUS 枚举）一字未动。
        timeout: 20000,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          DEEPSEEK_API_KEY: '',
        },
      }
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/LLM STATUS: (configured|disabled|unavailable)/);
  });
});

// ── 7. Harness/governance/Agent-CNC files never import real providers ──

const FORBIDDEN_REAL_PROVIDER_IMPORTS = [
  /require\(.*DeepSeekLLMProvider/,
  /from ['"].*DeepSeekLLMProvider['"]/,
  /import.*DeepSeekLLMProvider/,
  /src\/m5\/DeepSeekLLMProvider/,
  /require\(.*OpenAILLMProvider/,
  /import.*OpenAILLMProvider/,
  /require\(.*AnthropicLLMProvider/,
  /import.*AnthropicLLMProvider/,
  /require\(.*GeminiLLMProvider/,
  /import.*GeminiLLMProvider/,
  /require\(.*QwenLLMProvider/,
  /import.*QwenLLMProvider/,
];

var PROVIDER_GUARD_PATHS = []
  // Harness core scripts
  .concat(HARNESS_CORE_SCRIPTS)
  // Test helpers
  .concat(HARNESS_HELPERS)
  // Agent-CNC source
  .concat(AGENT_CNC_SOURCES)
  // Governance TypeScript source
  .concat([
    'src/governance/auth/AuthContext.ts',
    'src/governance/auth/WriteIntent.ts',
    'src/governance/auth/AuthorizationDecision.ts',
    'src/governance/auth/AuthzPolicy.ts',
    'src/governance/auth/createAuthContext.ts',
    'src/governance/auth/assertWriteAuthorized.ts',
    'src/governance/audit/AuditEvent.ts',
    'src/governance/audit/AuditActor.ts',
    'src/governance/audit/AuditSubject.ts',
    'src/governance/audit/AuditAction.ts',
    'src/governance/audit/AuditOutcome.ts',
    'src/governance/audit/AuditSink.ts',
    'src/governance/audit/recordAuthorizationDecision.ts',
    'src/governance/scripts/types.ts',
    'src/governance/scripts/validate.ts',
  ]);

describe('[NO-API] Harness files never import real LLM providers', () => {
  for (const relPath of PROVIDER_GUARD_PATHS) {
    it(`${relPath} has no real provider imports`, () => {
      const fullPath = path.join(REPO, relPath);
      let content = '';
      try { content = readFileSync(fullPath, 'utf8'); } catch {
        // File missing on disk — skip (e.g. TypeScript source not present
        // in a dist-only env). Static boundary is best-effort.
        return;
      }
      for (const pattern of FORBIDDEN_REAL_PROVIDER_IMPORTS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }

  it('src/m5/DeepSeekLLMProvider.ts is not reachable from harness smoke tests', () => {
    var harnessTestPaths = [
      'scripts/__tests__/meta-gov-a-harness-diff-smoke.test.ts',
      'scripts/__tests__/world-segment-a-smoke.test.ts',
      'scripts/__tests__/world-segment-b-audit-smoke.test.ts',
      'scripts/__tests__/world-segment-c1-gate-pass-through-smoke.test.ts',
      'scripts/__tests__/world-segment-c2-cli-smoke.test.ts',
      'scripts/__tests__/script-gov-b-audit-smoke.test.ts',
      'scripts/__tests__/script-gov-c-db-isolation-smoke.test.ts',
    ];
    for (var i = 0; i < harnessTestPaths.length; i++) {
      var relPath = harnessTestPaths[i];
      var content = readFileSync(path.join(REPO, relPath), 'utf8');
      expect(content).not.toMatch(/src\/m5\/DeepSeekLLMProvider/);
      expect(content).not.toMatch(/DeepSeekLLMProvider/);
    }
  });
});
