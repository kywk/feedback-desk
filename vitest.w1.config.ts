import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Explicitly invoked W1 QA suite; it is excluded from the baseline npm test.
export default defineConfig(async () => ({
    plugins: [cloudflareTest({
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')) } },
    })],
    test: { include: ['test/w1/*.worker.ts'], setupFiles: ['./test/worker/apply-migrations.ts'], testTimeout: 30_000 },
}));
