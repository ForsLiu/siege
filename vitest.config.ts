import { defineConfig } from 'vitest/config';
import { resolveTestWorkers } from './tools/testWorkers.ts';

// Worker count is shared between parallel lanes via SIEGE_TEST_WORKERS (default 4). An invalid
// value throws here, which fails the run: vitest used to accept a negative count, collect no
// test file and still exit 0 (P0-B3).
const workers = resolveTestWorkers(process.env);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    maxWorkers: workers,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
