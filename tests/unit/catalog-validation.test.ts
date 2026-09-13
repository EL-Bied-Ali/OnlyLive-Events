import { describe, expect, it } from "vitest";
import {
  eventMutationSchema,
  formatMoroccoDateTime,
  parseMoroccoDateTime,
  salesPhaseMutationSchema,
} from "@/lib/validation/catalog";

describe("admin catalogue validation", () => {
  it("converts Morocco wall-clock times with the correct seasonal offset", () => {
    expect(parseMoroccoDateTime("2026-03-01T12:00").toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(parseMoroccoDateTime("2026-12-05T20:00").toISOString()).toBe("2026-12-05T19:00:00.000Z");
    expect(formatMoroccoDateTime(new Date("2026-12-05T19:00:00.000Z"))).toBe("2026-12-05T20:00");
  });

  it("rejects incoherent event dates", () => {
    const result = eventMutationSchema.safeParse({
      slug: "test-event",
      title: "Test Event",
      description: "A sufficiently long event description",
      venueId: "venue-test",
      startsAt: "2027-01-10T20:00",
      salesOpenAt: "2027-01-11T10:00",
      salesCloseAt: "2027-01-10T21:00",
      status: "draft",
      coverImageUrl: "",
    });
    expect(result.success).toBe(false);
  });

  it("parses MAD prices exactly into cents", () => {
    const result = salesPhaseMutationSchema.safeParse({
      ticketCategoryId: "category-test",
      name: "Phase 1",
      priceCents: "700,50",
      startsAt: "2026-09-01T10:00",
      endsAt: "2026-10-01T10:00",
      phaseQuantityLimit: "100",
      sortOrder: "0",
      isActive: "on",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priceCents).toBe(70_050);
  });

  it("rejects prices with more than two decimal places", () => {
    const result = salesPhaseMutationSchema.safeParse({
      ticketCategoryId: "category-test",
      name: "Phase 1",
      priceCents: "700.001",
      startsAt: "2026-09-01T10:00",
      sortOrder: "0",
      isActive: "on",
    });
    expect(result.success).toBe(false);
  });
});
