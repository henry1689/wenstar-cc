// Minimal Jest-compatible test runner (since jest/ts-jest not installed locally)
// Provides global describe/it/expect, executes all tests sequentially, reports results.

const suites = [];
let current = null;

global.describe = (name, fn) => {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
};
global.it = (name, fn) => {
  if (!current) throw new Error('it() outside describe()');
  current.tests.push({ name, fn });
};
global.test = global.it;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function makeExpect(actual) {
  const api = {
    toBe: (e) => { if (actual !== e) throw new Error(`expected ${JSON.stringify(actual)} toBe ${JSON.stringify(e)}`); },
    toEqual: (e) => { if (!deepEqual(actual, e)) throw new Error(`expected ${JSON.stringify(actual)} toEqual ${JSON.stringify(e)}`); },
    toBeCloseTo: (e, digits = 2) => {
      const diff = Math.abs(actual - e);
      if (diff > Math.pow(10, -digits) / 2) throw new Error(`expected ${actual} toBeCloseTo ${e} (digits=${digits})`);
    },
    toBeGreaterThan: (e) => { if (!(actual > e)) throw new Error(`expected ${actual} > ${e}`); },
    toBeGreaterThanOrEqual: (e) => { if (!(actual >= e)) throw new Error(`expected ${actual} >= ${e}`); },
    toBeLessThan: (e) => { if (!(actual < e)) throw new Error(`expected ${actual} < ${e}`); },
    toBeLessThanOrEqual: (e) => { if (!(actual <= e)) throw new Error(`expected ${actual} <= ${e}`); },
    toContain: (e) => {
      if (typeof actual === 'string') { if (!actual.includes(e)) throw new Error(`expected string to contain ${e}`); }
      else if (Array.isArray(actual)) { if (!actual.some((x) => deepEqual(x, e))) throw new Error(`expected array to contain ${JSON.stringify(e)}`); }
      else throw new Error('toContain on non-string/array');
    },
    toBeTruthy: () => { if (!actual) throw new Error(`expected ${JSON.stringify(actual)} toBeTruthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`expected ${JSON.stringify(actual)} toBeFalsy`); },
    toBeNull: () => { if (actual !== null) throw new Error(`expected ${JSON.stringify(actual)} toBeNull`); },
    toBeUndefined: () => { if (actual !== undefined) throw new Error(`expected ${JSON.stringify(actual)} toBeUndefined`); },
    toMatch: (re) => {
      if (re instanceof RegExp) { if (!re.test(actual)) throw new Error(`expected ${actual} toMatch ${re}`); }
      else { if (!String(actual).includes(re)) throw new Error(`expected ${actual} toMatch ${re}`); }
    },
  };
  api.not = {
    toBe: (e) => { if (actual === e) throw new Error(`expected ${JSON.stringify(actual)} not.toBe ${JSON.stringify(e)}`); },
    toEqual: (e) => { if (deepEqual(actual, e)) throw new Error(`expected not.toEqual`); },
    toContain: (e) => {
      if (Array.isArray(actual) && actual.some((x) => deepEqual(x, e))) throw new Error(`expected array not.toContain ${JSON.stringify(e)}`);
    },
    toBeNull: () => { if (actual === null) throw new Error(`expected not.toBeNull`); },
  };
  return api;
}
global.expect = makeExpect;

// Load compiled test file
require('../dist/__tests__/test_pipeline.test.js');

async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  for (const s of suites) {
    console.log(`\n  ${s.name}`);
    for (const t of s.tests) {
      try {
        await t.fn();
        console.log(`    \u2713 ${t.name}`);
        pass++;
      } catch (e) {
        console.log(`    \u2717 ${t.name}`);
        console.log(`      ${e.message}`);
        fail++;
        failures.push({ suite: s.name, test: t.name, err: e });
      }
    }
  }
  console.log(`\n========================================`);
  console.log(`  Total: ${pass + fail}  Passed: ${pass}  Failed: ${fail}`);
  console.log(`========================================`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  [${f.suite}] ${f.test}: ${f.err.message}`);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
