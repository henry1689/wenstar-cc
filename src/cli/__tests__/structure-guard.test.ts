import { describe, it, expect } from 'vitest';
describe('[cli] 文件存在', () => {
  it('health-check.ts 存在', () => {
    const fs = require('fs');
    expect(fs.existsSync(__dirname + '/../health-check.ts')).toBe(true);
  });
  it('sandbox.ts 存在', () => {
    const fs = require('fs');
    expect(fs.existsSync(__dirname + '/../sandbox.ts')).toBe(true);
  });
});
