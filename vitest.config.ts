import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') };

export default defineConfig({
  resolve: { alias },
  test: {
    testTimeout: 20000,
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          // One shared database: run files one at a time.
          fileParallelism: false,
          testTimeout: 30000,
        },
      },
    ],
  },
});
