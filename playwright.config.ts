import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // This environment pre-installs Chromium at a fixed path and
        // pins PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD — our pinned
        // @playwright/test version defaults to looking for a
        // headless-shell build that isn't there, so point at the
        // preinstalled binary explicitly instead of downloading one.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // `next start` always runs with NODE_ENV=production, and the fake
      // payment provider now refuses to boot in production without this
      // explicit opt-in (see lib/payments/index.ts). A local/CI e2e run
      // against `next start` is exactly the deliberate,
      // non-production-traffic case that flag exists for — this is
      // never set for a real deployment.
      ALLOW_FAKE_PAYMENTS_IN_PRODUCTION: "true",
      // This suite performs many distinct logins/registrations that all
      // originate from one local machine with no reverse proxy in front
      // of it, so the server sees them all as one "unknown" IP — see
      // lib/rateLimit.ts. Never set this for a real deployment.
      RATE_LIMITING_DISABLED: "true",
      ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION: "true",
      RATE_LIMIT_KEY_SECRET: "e2e-only-secret-not-for-real-use-4444444444444444",
    },
  },
});
