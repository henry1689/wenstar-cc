// 🔴 2026-11-04：原先这里有一份手写的 `declare module 'better-sqlite3'`，
//   与 node_modules/@types/better-sqlite3 同时存在时两个声明会合并，导致
//   `import type Database` 拿到的是纯 namespace —— 全仓报
//   TS2709 "Cannot use namespace 'Database' as a type"。
//   现统一以官方 @types 为唯一来源；类型标注请用 `Database.Database`
//   （`export = Database` 模式下，namespace 成员才是数据库实例类型）。

// Minimal Jest globals shim (for ts-jest; actual run via our own runner)
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare const expect: {
  (actual: any): {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toBeCloseTo(expected: number, digits?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: any): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toMatch(expected: RegExp | string): void;
    not: {
      toBe(expected: any): void;
      toEqual(expected: any): void;
      toContain(expected: any): void;
      toBeNull(): void;
    };
  };
};
