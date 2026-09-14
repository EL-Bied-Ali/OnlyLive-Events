import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
if (!e2eDatabaseUrl) {
  throw new Error("E2E_DATABASE_URL is required for Playwright. Refusing to fall back to DATABASE_URL.");
}

// Test files import Prisma directly, so the Playwright runner itself — not
// just the spawned Next.js server — must be pinned to the isolated e2e DB.
process.env.DATABASE_URL = e2eDatabaseUrl;

const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1 || e2ePort > 65535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");
}
// Browser tests always target the isolated server started below. Supporting
// an arbitrary external base URL here would make it possible to prepare one
// DB while accidentally testing a different deployment/database.
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
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
    command: `npm run build && npm run start -- -p ${e2ePort}`,
    url: `${baseURL}/api/health`,
    // Never reuse a developer's existing Next.js process: it may be attached
    // to DATABASE_URL and would defeat the database-isolation guarantee.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: e2eDatabaseUrl,
      NEXTAUTH_URL: baseURL,
      // `next start` always runs with NODE_ENV=production, and the fake
      // payment provider refuses to boot in production without this explicit
      // opt-in. E2E uses an isolated database and no real customer traffic.
      ALLOW_FAKE_PAYMENTS_IN_PRODUCTION: "true",
      // Keep rate limiting enabled in browser tests so the real Auth.js
      // callback path is covered. The IP ceilings are deliberately above
      // this serial suite's normal traffic.
      RATE_LIMIT_KEY_SECRET: "e2e-only-secret-not-for-real-use-4444444444444444",
    },
  },
});
