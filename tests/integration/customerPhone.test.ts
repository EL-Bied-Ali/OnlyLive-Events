import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createTestUser } from "../helpers/fixtures";

// requireCustomer() reads the session via next/headers, which needs a real
// Next.js request context a plain Vitest/Node process doesn't provide (see
// tests/integration/access-control.test.ts). Mocking it here lets this test
// exercise the route's real validation/update/audit logic directly, rather
// than re-testing next-auth's own session plumbing (already covered by the
// e2e suite's real login flows).
vi.mock("@/lib/auth/customer", () => ({
  requireCustomer: vi.fn(),
}));

async function importRoute() {
  return import("@/app/api/customers/phone/route");
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/customers/phone", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/customers/phone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an unauthenticated request", async () => {
    const { requireCustomer } = await import("@/lib/auth/customer");
    const { ApiError } = await import("@/lib/http/errors");
    vi.mocked(requireCustomer).mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign-in required"));

    const { PATCH } = await importRoute();
    const response = await PATCH(request({ phone: "0612345678" }));
    expect(response.status).toBe(401);
  });

  it("rejects an invalid phone without touching the database", async () => {
    const user = await createTestUser("phone-invalid");
    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    const { PATCH } = await importRoute();
    const response = await PATCH(request({ phone: "abc" }));
    expect(response.status).toBe(400);

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ phone: user.phone });
  });

  it("updates the signed-in customer's own phone (stored in canonical E.164) and writes an audit log entry", async () => {
    const user = await createTestUser("phone-update");
    await prisma.user.update({ where: { id: user.id }, data: { phone: null } });
    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    const { PATCH } = await importRoute();
    const response = await PATCH(request({ phone: "0612345678" }));
    expect(response.status).toBe(200);

    // Stored as canonical E.164, not the raw local-format input — this is
    // exactly what lib/payments/charipayProvider.ts's own normalizer
    // produces, so a value this endpoint accepts can never later be rejected
    // by the ChariPay adapter at checkout time (see lib/validation/phone.ts).
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ phone: "+212612345678" });

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "customer.phone_updated", entityType: "User", entityId: user.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorId).toBe(user.id);
  });

  it("never updates a different customer's phone", async () => {
    const owner = await createTestUser(`phone-owner-${crypto.randomUUID()}`);
    const other = await createTestUser(`phone-other-${crypto.randomUUID()}`);
    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: owner.id, email: owner.email, name: owner.name });

    const { PATCH } = await importRoute();
    const response = await PATCH(request({ phone: "0699999999" }));
    expect(response.status).toBe(200);

    await expect(prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).resolves.toMatchObject({ phone: "+212699999999" });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: other.id } })).resolves.toMatchObject({ phone: other.phone });
  });

  it("rejects a value the loose old rule would have accepted but ChariPay's adapter would reject", async () => {
    // Regression test for a real finding from an independent audit (GPT):
    // the schema and the ChariPay adapter used to be two separately
    // maintained regexes. "1234567890" has 10 digits and only allowed
    // characters, so the old character/digit-count-only rule accepted it —
    // but it is neither a recognized Moroccan local number nor a
    // country-coded one, so ChariPay's adapter would reject it at payment
    // time with no way for the customer to fix it (the form disappears once
    // phone is non-null). It must be rejected here too, now that both share
    // lib/validation/phone.ts's normalizePhone.
    const user = await createTestUser("phone-would-have-passed-old-rule");
    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    const { PATCH } = await importRoute();
    const response = await PATCH(request({ phone: "1234567890" }));
    expect(response.status).toBe(400);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({ phone: user.phone });
  });

  it("rate-limits repeated updates for one account", async () => {
    const user = await createTestUser("phone-rate-limited");
    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: user.id, email: user.email, name: user.name });

    const { PATCH } = await importRoute();
    for (let i = 0; i < 10; i += 1) {
      const response = await PATCH(request({ phone: `06${(10000000 + i).toString().slice(0, 8)}` }));
      expect(response.status).toBe(200);
    }

    const eleventh = await PATCH(request({ phone: "0611111199" }));
    expect(eleventh.status).toBe(429);
    const body = await eleventh.json();
    expect(body.error).toBe("RATE_LIMITED");
  });
});
