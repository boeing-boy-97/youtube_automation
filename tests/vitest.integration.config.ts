import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@clipforge/shared-types': fileURLToPath(new URL('../packages/shared-types/src/index.ts', import.meta.url)),
      '@clipforge/database': fileURLToPath(new URL('../packages/database/src/index.ts', import.meta.url)),
    },
  },
});
