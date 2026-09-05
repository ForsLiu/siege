import { defineConfig } from 'vitest/config';

// Worker count is shared between parallel lanes via SIEGE_TEST_WORKERS (default 4).
const workers = Number.parseInt(process.env.SIEGE_TEST_WORKERS ?? '4', 10) || 4;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    maxWorkers: workers,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
