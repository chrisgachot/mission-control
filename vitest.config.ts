import { defineConfig } from 'vitest/config';
import { cloudflare } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflare({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Tests run against an in-memory D1; migrations are applied in test/setup.ts.
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
