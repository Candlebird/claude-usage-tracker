import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));

export default defineConfig({
  resolve: {
    // Test against shared sources, not a possibly stale dist build.
    alias: { '@ccu/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Synthetic test-only tokens.
          READ_TOKEN: 'test-read-token',
          WRITE_TOKEN: 'test-write-token',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
