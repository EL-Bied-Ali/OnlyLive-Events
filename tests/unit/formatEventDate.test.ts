import { describe, expect, it } from "vitest";
import {
  formatEventDay,
  formatEventMonthNumber,
  formatEventTime,
  formatEventYear,
} from "@/lib/formatEventDate";

describe("Morocco event date formatting", () => {
  it("renders the Tiakola start in Africa/Casablanca instead of the server timezone", () => {
    // 20:00 in Casablanca on 5 Dec 2026 is 19:00 UTC.
    const startsAt = new Date("2026-12-05T19:00:00.000Z");

    expect(formatEventDay(startsAt)).toBe("05");
    expect(formatEventMonthNumber(startsAt)).toBe("12");
    expect(formatEventYear(startsAt)).toBe("2026");
    expect(formatEventTime(startsAt)).toBe("20:00");
  });
});
