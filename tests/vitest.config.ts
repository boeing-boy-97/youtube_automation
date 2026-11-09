import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@clipforge/shared-types': fileURLToPath(new URL('../packages/shared-types/src/index.ts', import.meta.url)),
      '@clipforge/validation': fileURLToPath(new URL('../packages/validation/src/index.ts', import.meta.url)),
      '@clipforge/platform-connectors': fileURLToPath(new URL('../packages/platform-connectors/src/index.ts', import.meta.url)),
      '@clipforge/database': fileURLToPath(new URL('../packages/database/src/index.ts', import.meta.url)),
    },
  },
});
