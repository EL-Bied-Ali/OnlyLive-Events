import { describe, expect, it } from "vitest";
import { createHold, releaseHold } from "@/lib/inventory";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

/**
 * HTTP-level ownership checks (a customer fetching another customer's
 * order returns 404, an unauthenticated request is rejected with 401) are
 * covered end-to-end against a real running server in
 * tests/e2e/access-control.spec.ts, because requireCustomer() reads the
 * session via next/headers, which needs a real Next.js request context
 * that a plain Vitest/Node process doesn't provide. This file covers the
 * ownership logic that lives below the HTTP layer.
 */
describe("access control — ownership checks below the HTTP layer", () => {
  it("refuses to release a hold that belongs to a different customer", async () => {
    const { category, phase } = await createTestCategory(1);
    const owner = await createTestUser("owner");
    const attacker = await createTestUser("attacker");

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: owner.id,
      quantity: 1,
      unitPriceCents: phase.priceCents,
    });

    await expect(releaseHold(hold.reservationId, attacker.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets the actual owner release their own hold", async () => {
    const { category, phase } = await createTestCategory(1);
    const owner = await createTestUser("owner2");

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: owner.id,
      quantity: 1,
      unitPriceCents: phase.priceCents,
    });

    await expect(releaseHold(hold.reservationId, owner.id)).resolves.toBeUndefined();
  });
});
