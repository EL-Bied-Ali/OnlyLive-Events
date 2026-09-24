You are acting as an independent security/correctness auditor for OnlyLive, a real commercial live-events ticketing platform in Morocco (money + tickets, not a demo). This repo has a house rule: every non-trivial change gets an independent audit before merge, and past audits from you have caught real P1 issues (webhook atomicity, amount/currency checks, checkout idempotency, sales-eligibility races, etc — see TASKS.md history).

Please review the diff below as that same kind of audit. It's a small, self-contained feature: letting an existing customer whose account predates mandatory-phone registration (phone: null) add a phone number, surfaced at the start of checkout, since the real PSP (ChariPay) now rejects a payment session without one.

Context you need:
- Auth: customer sessions are NextAuth v4 JWT (no CSRF token layer beyond NextAuth's own — see requireCustomer() in lib/auth/customer.ts, same pattern as the existing POST /api/checkout/[holdId]/start route).
- Rate limiting: lib/rateLimit.ts, a Postgres fixed-window limiter keyed by an HMAC of the identity (buildRateLimitKey(scope, identity)).
- Errors: lib/http/errors.ts (ApiError / apiErrorResponse).
- Audit log: lib/audit.ts (writeAuditLog), actorType enum is admin/system/customer.
- Convention: HTTP-level auth checks (401/403) are tested in Playwright e2e, not Vitest, because requireCustomer() needs a real Next.js request context — see tests/integration/access-control.test.ts's own comment on this. Business logic below the HTTP layer is tested directly against a real test Postgres via Vitest integration tests.
- I could NOT actually run the new tests in my environment (no local Postgres/TEST_DATABASE_URL available) — typecheck and lint passed, but the tests are unverified. Please review test correctness by reading them, not by assuming they pass.

Please check specifically for:
1. Auth/authorization bugs — can this leak or modify another customer's data?
2. Input validation gaps — could a malicious phone value cause harm (injection, mass assignment, etc)?
3. Rate-limiting correctness and whether the chosen limit is sane for an authenticated endpoint.
4. Whether the audit log entry is correct and non-sensitive (no raw PII beyond what's already stored).
5. The checkout page's new gating logic — does it correctly and safely gate the payment step behind having a phone, without breaking existing customers who already have one, without an open redirect, and without leaking whether a reservation exists to the wrong user?
6. Test quality — do the new tests actually assert what they claim, and do they cover the realistic failure modes (not just the happy path)?
7. Anything that violates this repo's CLAUDE.md rules (attached in spirit above): no secrets, no mass assignment, minimum PII, server-side authorization on every sensitive operation.

Give me a verdict per issue found: severity (P1/P2/P3), the concrete failure scenario, and the fix. If you find nothing, say so plainly — don't invent issues to seem thorough. Here is the full diff:

diff --git a/app/(customer)/checkout/hold/[holdId]/CompletePhoneClient.tsx b/app/(customer)/checkout/hold/[holdId]/CompletePhoneClient.tsx
new file mode 100644
index 0000000..d8fda34
--- /dev/null
+++ b/app/(customer)/checkout/hold/[holdId]/CompletePhoneClient.tsx
@@ -0,0 +1,68 @@
+"use client";
+
+import { useState } from "react";
+import { useRouter } from "next/navigation";
+
+export function CompletePhoneClient() {
+  const router = useRouter();
+  const [phone, setPhone] = useState("");
+  const [error, setError] = useState<string | null>(null);
+  const [submitting, setSubmitting] = useState(false);
+
+  async function handleSubmit(event: React.FormEvent) {
+    event.preventDefault();
+    setError(null);
+    setSubmitting(true);
+    try {
+      const response = await fetch("/api/customers/phone", {
+        method: "POST",
+        headers: { "content-type": "application/json" },
+        body: JSON.stringify({ phone }),
+      });
+      const data = await response.json();
+      if (!response.ok) {
+        setError(data.message ?? "Numéro de téléphone invalide");
+        return;
+      }
+      // The server component re-reads the (now non-null) phone from the
+      // database and renders the checkout step instead of this form.
+      router.refresh();
+    } catch {
+      setError("Erreur réseau, réessayez");
+    } finally {
+      setSubmitting(false);
+    }
+  }
+
+  return (
+    <main style={{ maxWidth: 480, margin: "0 auto", padding: "48px 16px" }}>
+      <h1 style={{ fontSize: 26, marginBottom: 16 }}>Un dernier détail</h1>
+      <p style={{ marginBottom: 24, opacity: 0.8 }}>
+        Un numéro de téléphone est requis pour finaliser un paiement. Ajoutez le vôtre pour continuer.
+      </p>
+
+      <form onSubmit={handleSubmit}>
+        <label style={{ display: "block", marginBottom: 8 }} htmlFor="phone">
+          Numéro de téléphone
+        </label>
+        <input
+          id="phone"
+          name="phone"
+          type="tel"
+          autoComplete="tel"
+          required
+          value={phone}
+          onChange={(event) => setPhone(event.target.value)}
+          placeholder="06 12 34 56 78"
+          style={{ width: "100%", padding: 12, marginBottom: 16, boxSizing: "border-box" }}
+        />
+
+        {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}
+
+        <button type="submit" disabled={submitting} style={{ padding: 14, width: "100%" }}>
+          {submitting ? "..." : "Continuer"}
+        </button>
+      </form>
+    </main>
+  );
+}
diff --git a/app/(customer)/checkout/hold/[holdId]/page.tsx b/app/(customer)/checkout/hold/[holdId]/page.tsx
index c49b154..0438173 100644
--- a/app/(customer)/checkout/hold/[holdId]/page.tsx
+++ b/app/(customer)/checkout/hold/[holdId]/page.tsx
@@ -2,6 +2,7 @@ import { notFound } from "next/navigation";
 import { prisma } from "@/lib/db";
 import { requireCustomerForPage } from "@/lib/auth/customer";
 import { CheckoutClient } from "./CheckoutClient";
+import { CompletePhoneClient } from "./CompletePhoneClient";
 
 export const dynamic = "force-dynamic";
 
@@ -21,6 +22,14 @@ export default async function CheckoutHoldPage({ params }: { params: Promise<{ h
     notFound();
   }
 
+  // Accounts created before phone became required at registration (PR #18)
+  // have phone: null and would otherwise only discover the problem when the
+  // real PSP rejects checkout — collect it here, before that happens.
+  const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.id }, select: { phone: true } });
+  if (!user.phone) {
+    return <CompletePhoneClient />;
+  }
+
   return (
     <CheckoutClient
       reservationId={reservation.id}
diff --git a/app/api/customers/phone/route.ts b/app/api/customers/phone/route.ts
new file mode 100644
index 0000000..1ac7b1d
--- /dev/null
+++ b/app/api/customers/phone/route.ts
@@ -0,0 +1,40 @@
+import { NextRequest, NextResponse } from "next/server";
+import { requireCustomer } from "@/lib/auth/customer";
+import { updatePhoneSchema } from "@/lib/validation/auth";
+import { updateCustomerPhone } from "@/lib/customers/phone";
+import { apiErrorResponse, ApiError } from "@/lib/http/errors";
+import { buildRateLimitKey, consumeRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
+
+export const runtime = "nodejs";
+
+// Already-authenticated abuse (repeatedly hammering the update endpoint) is
+// the concern here, not credential guessing — a generous per-account allowance.
+const PHONE_UPDATE_ACCOUNT_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
+
+export async function POST(request: NextRequest) {
+  try {
+    const customer = await requireCustomer();
+
+    const limit = await consumeRateLimit(
+      buildRateLimitKey("phone_update_account", customer.id),
+      PHONE_UPDATE_ACCOUNT_RATE_LIMIT,
+    );
+    if (!limit.allowed) {
+      return NextResponse.json(
+        { error: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
+        { status: 429, headers: rateLimitHeaders(limit) },
+      );
+    }
+
+    const body = await request.json();
+    const parsed = updatePhoneSchema.safeParse(body);
+    if (!parsed.success) {
+      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
+    }
+
+    const user = await updateCustomerPhone(customer.id, parsed.data.phone);
+    return NextResponse.json({ user });
+  } catch (error) {
+    return apiErrorResponse(error);
+  }
+}
diff --git a/lib/customers/phone.ts b/lib/customers/phone.ts
new file mode 100644
index 0000000..d3d12af
--- /dev/null
+++ b/lib/customers/phone.ts
@@ -0,0 +1,27 @@
+import { prisma } from "@/lib/db";
+import { writeAuditLog } from "@/lib/audit";
+
+/**
+ * Lets an already-authenticated customer add or correct their phone number
+ * post-registration. Needed for accounts created before phone became
+ * required at registration (PR #18) — those rows have `phone: null` and
+ * would otherwise only discover the problem when ChariPay's adapter rejects
+ * checkout with PAYMENT_CUSTOMER_DETAILS_REQUIRED.
+ */
+export async function updateCustomerPhone(userId: string, phone: string): Promise<{ id: string; phone: string }> {
+  const user = await prisma.user.update({
+    where: { id: userId },
+    data: { phone },
+    select: { id: true, phone: true },
+  });
+
+  await writeAuditLog({
+    actorType: "customer",
+    actorId: user.id,
+    action: "customer.phone_updated",
+    entityType: "User",
+    entityId: user.id,
+  });
+
+  return { id: user.id, phone: user.phone! };
+}
diff --git a/lib/validation/auth.ts b/lib/validation/auth.ts
index a7eeb37..d0112fe 100644
--- a/lib/validation/auth.ts
+++ b/lib/validation/auth.ts
@@ -1,29 +1,38 @@
 import { z } from "zod";
 
+// A real PSP (ChariPay's hosted checkout) rejects a payment session whose
+// customer has no phone number. Only loosely validated here (plausible
+// phone-like characters, plus a real-digit-count check so punctuation-only
+// input like "++++++++" can't satisfy min(8) on character count alone) — the
+// provider adapter is responsible for its own stricter format/country
+// normalization at checkout time. Shared by registration and the
+// post-registration "complete your phone" flow so both enforce the same rule.
+export const phoneSchema = z
+  .string()
+  .trim()
+  .min(8)
+  .max(30)
+  .regex(/^[0-9+()\-.\s]+$/, "Numéro de téléphone invalide")
+  .refine((value) => {
+    const digitCount = value.replace(/\D/g, "").length;
+    return digitCount >= 8 && digitCount <= 15;
+  }, "Numéro de téléphone invalide");
+
 export const registerSchema = z.object({
   email: z.string().trim().toLowerCase().email().max(254),
   password: z.string().min(10).max(200),
   name: z.string().trim().min(1).max(120),
-  // Required: a real PSP (ChariPay's hosted checkout) rejects a payment
-  // session whose customer has no phone number. Only loosely validated here
-  // (plausible phone-like characters, plus a real-digit-count check so
-  // punctuation-only input like "++++++++" can't satisfy min(8) on
-  // character count alone) — the provider adapter is responsible for its
-  // own stricter format/country normalization at checkout time.
-  phone: z
-    .string()
-    .trim()
-    .min(8)
-    .max(30)
-    .regex(/^[0-9+()\-.\s]+$/, "Numéro de téléphone invalide")
-    .refine((value) => {
-      const digitCount = value.replace(/\D/g, "").length;
-      return digitCount >= 8 && digitCount <= 15;
-    }, "Numéro de téléphone invalide"),
+  phone: phoneSchema,
 });
 
 export type RegisterInput = z.infer<typeof registerSchema>;
 
+export const updatePhoneSchema = z.object({
+  phone: phoneSchema,
+});
+
+export type UpdatePhoneInput = z.infer<typeof updatePhoneSchema>;
+
 export const loginSchema = z.object({
   email: z.string().trim().toLowerCase().email().max(254),
   password: z.string().min(1).max(200),
diff --git a/tests/integration/customer-phone-update.test.ts b/tests/integration/customer-phone-update.test.ts
new file mode 100644
index 0000000..b2a7d4f
--- /dev/null
+++ b/tests/integration/customer-phone-update.test.ts
@@ -0,0 +1,54 @@
+import { describe, expect, it } from "vitest";
+import { prisma } from "@/lib/db";
+import { updateCustomerPhone } from "@/lib/customers/phone";
+import { createTestUser } from "../helpers/fixtures";
+
+/**
+ * HTTP-level auth (POST /api/customers/phone requires a signed-in customer)
+ * is covered end-to-end in Playwright, because requireCustomer() needs a
+ * real Next.js request context — see tests/integration/access-control.test.ts
+ * for the same convention. This covers the update logic below the HTTP layer.
+ */
+describe("updateCustomerPhone", () => {
+  it("adds a phone number to an account that registered before it was required", async () => {
+    const user = await createTestUser("nophone");
+    expect(user.phone).toBeNull();
+
+    const result = await updateCustomerPhone(user.id, "0612345678");
+    expect(result.phone).toBe("0612345678");
+
+    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
+    expect(stored.phone).toBe("0612345678");
+  });
+
+  it("lets a customer correct an existing phone number", async () => {
+    const user = await createTestUser("existingphone");
+    await updateCustomerPhone(user.id, "0600000000");
+
+    const result = await updateCustomerPhone(user.id, "0611111111");
+    expect(result.phone).toBe("0611111111");
+
+    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
+    expect(stored.phone).toBe("0611111111");
+  });
+
+  it("writes an audit log row for the update", async () => {
+    const user = await createTestUser("audited");
+    await updateCustomerPhone(user.id, "0612345678");
+
+    const log = await prisma.auditLog.findFirst({
+      where: { actorType: "customer", actorId: user.id, action: "customer.phone_updated", entityId: user.id },
+    });
+    expect(log).not.toBeNull();
+  });
+
+  it("only updates the targeted user, not other accounts", async () => {
+    const target = await createTestUser("target");
+    const other = await createTestUser("other");
+
+    await updateCustomerPhone(target.id, "0612345678");
+
+    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
+    expect(untouched.phone).toBeNull();
+  });
+});
diff --git a/tests/unit/validation/auth.test.ts b/tests/unit/validation/auth.test.ts
index 10f552f..852ec35 100644
--- a/tests/unit/validation/auth.test.ts
+++ b/tests/unit/validation/auth.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { registerSchema } from "@/lib/validation/auth";
+import { registerSchema, updatePhoneSchema } from "@/lib/validation/auth";
 
 function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
   return {
@@ -66,3 +66,21 @@ describe("registerSchema", () => {
     expect(registerSchema.safeParse(validPayload({ name: "" })).success).toBe(false);
   });
 });
+
+describe("updatePhoneSchema", () => {
+  it("accepts the same plausible phone numbers registerSchema accepts", () => {
+    expect(updatePhoneSchema.safeParse({ phone: "0612345678" }).success).toBe(true);
+    expect(updatePhoneSchema.safeParse({ phone: "+212 6 12 34 56 78" }).success).toBe(true);
+  });
+
+  it("rejects the same implausible input registerSchema rejects", () => {
+    expect(updatePhoneSchema.safeParse({ phone: "" }).success).toBe(false);
+    expect(updatePhoneSchema.safeParse({ phone: "123" }).success).toBe(false);
+    expect(updatePhoneSchema.safeParse({ phone: "++++++++" }).success).toBe(false);
+    expect(updatePhoneSchema.safeParse({ phone: "call-me-maybe" }).success).toBe(false);
+  });
+
+  it("rejects a missing phone field", () => {
+    expect(updatePhoneSchema.safeParse({}).success).toBe(false);
+  });
+});
