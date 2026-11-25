import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "~": path.join(root, "app") };

export default defineConfig({
  test: {
    projects: [
      // Pure modules, run in Node without the React Router or Cloudflare plugins.
      {
        resolve: { alias },
        test: { name: "unit", include: ["app/**/*.test.ts", "scripts/**/*.test.ts"] },
      },
      // The data layer, the API and the bot, run inside the Workers runtime
      // against a real D1 database with the project's migrations applied.
      {
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: "2026-10-06",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              r2Buckets: ["MEDIA"],
              images: { binding: "IMAGING" },
              ratelimits: {},
              bindings: {
                ENVIRONMENT: "test",
                APP_ORIGIN: "https://neat.link",
                MEDIA_ORIGIN: "",
                DOMAIN_TARGET: "byo.neat.link",
                CF_ZONE_ID: "",
                // A real test-mode key only for test/db/stripe-live.test.ts, given
                // for one run: NEAT_STRIPE_TEST_KEY=sk_test_… npx vitest run stripe-live
                STRIPE_SECRET_KEY: process.env.NEAT_STRIPE_TEST_KEY?.startsWith("sk_test_") ? process.env.NEAT_STRIPE_TEST_KEY : "sk_test_not_a_real_key",
                STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
                TELEGRAM_BOT_USERNAME: "neatlink_test_bot",
                TELEGRAM_BOT_TOKEN: "123456:test-token",
                TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
                BETTER_AUTH_SECRET: "a-test-secret-for-the-database-tests",
                GOOGLE_CLIENT_ID: "test-client",
                GOOGLE_CLIENT_SECRET: "test-secret",
                TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
              },
            },
          })),
        ],
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          setupFiles: ["./test/db/apply-migrations.ts"],
        },
      },
    ],
    // The Workers runtime cannot read Vitest 5's on-disk module cache; with it
    // on, every database test file fails before it starts (as in aionly).
    fsModuleCache: false,
  },
});
