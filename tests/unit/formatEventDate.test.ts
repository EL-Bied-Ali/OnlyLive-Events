import { describe, expect, it } from "vitest";
import {
  formatEventDay,
  formatEventMonthNumber,
  formatEventTime,
  formatEventYear,
} from "@/lib/formatEventDate";

describe("Morocco event date formatting", () => {
  it("renders Morocco local time independently of the server timezone", () => {
    // Use a historical instant whose Casablanca offset is settled in tzdata,
    // rather than a future date whose rules can change between ICU releases.
    const startsAt = new Date("2025-07-05T19:00:00.000Z");

    expect(formatEventDay(startsAt)).toBe("05");
    expect(formatEventMonthNumber(startsAt)).toBe("07");
    expect(formatEventYear(startsAt)).toBe("2025");
    expect(formatEventTime(startsAt)).toBe("20:00");
  });
});
