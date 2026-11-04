import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
