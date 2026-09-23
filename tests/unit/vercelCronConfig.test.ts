import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vercel housekeeping cron configuration", () => {
  it("schedules the authenticated housekeeping endpoint", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
    ) as { crons?: Array<{ path?: string; schedule?: string }> };

    expect(config.crons).toContainEqual({
      path: "/api/internal/sweep-expired-holds",
      schedule: "0 3 * * *",
    });
  });
});
