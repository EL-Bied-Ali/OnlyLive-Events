import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";

/**
 * HTTP-level ownership checks against a real running server — these
 * can't be exercised from Vitest because requireCustomer() reads the
 * session via next/headers, which needs a real Next.js request context.
 * See tests/integration/access-control.test.ts for the ownership logic
 * that lives below the HTTP layer.
 */
test("an unauthenticated request to create a hold is rejected", async ({ request }) => {
  const response = await request.post("/api/holds", {
    data: { ticketCategoryId: "00000000-0000-0000-0000-000000000000", salesPhaseId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
  });
  expect(response.status()).toBe(401);
});

test("an unauthenticated request to update a customer's phone is rejected", async ({ request }) => {
  // The service-level logic (only the caller's own row can ever be
  // targeted, since the id comes from requireCustomer() and never from the
  // request body) is covered in tests/integration/customerPhone.test.ts.
  // requireCustomer() itself needs a real Next.js request context, so the
  // 401 path is only exercisable here, against a real running server.
  const response = await request.patch("/api/customers/phone", {
    data: { phone: "0612345678" },
  });
  expect(response.status()).toBe(401);
});

test("a customer can only ever update their own phone number, never another customer's", async ({ browser }) => {
  const suffix = Date.now();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto("/register");
  await pageA.getByPlaceholder("Nom").fill("Phone Owner");
  await pageA.getByPlaceholder("Email").fill(`phone-owner-${suffix}@test.onlylive.ma`);
  await pageA.getByPlaceholder(/Mot de passe/).fill("PhoneOwnerPassword123!");
  await pageA.getByPlaceholder(/Téléphone/).fill("0611111111");
  await pageA.getByRole("button", { name: "Créer mon compte" }).click();
  await pageA.waitForURL("/");

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto("/register");
  await pageB.getByPlaceholder("Nom").fill("Phone Other");
  await pageB.getByPlaceholder("Email").fill(`phone-other-${suffix}@test.onlylive.ma`);
  await pageB.getByPlaceholder(/Mot de passe/).fill("PhoneOtherPassword123!");
  await pageB.getByPlaceholder(/Téléphone/).fill("0622222222");
  await pageB.getByRole("button", { name: "Créer mon compte" }).click();
  await pageB.waitForURL("/");

  // The request body carries only a phone value, never a target user id —
  // requireCustomer() derives the id to update solely from B's own session.
  // Confirm directly against the database that this can only ever change
  // the caller's own row, never A's.
  const ownUpdate = await pageB.request.patch("/api/customers/phone", {
    data: { phone: "0633333333" },
  });
  expect(ownUpdate.ok()).toBe(true);

  const owner = await prisma.user.findFirstOrThrow({ where: { email: `phone-owner-${suffix}@test.onlylive.ma` } });
  const other = await prisma.user.findFirstOrThrow({ where: { email: `phone-other-${suffix}@test.onlylive.ma` } });
  expect(other.phone).toBe("+212633333333");
  expect(owner.phone).toBe("+212611111111");

  await contextA.close();
  await contextB.close();
});

test("a customer cannot fetch another customer's order", async ({ browser }) => {
  const suffix = Date.now();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto("/register");
  await pageA.getByPlaceholder("Nom").fill("Customer A");
  await pageA.getByPlaceholder("Email").fill(`access-a-${suffix}@test.onlylive.ma`);
  await pageA.getByPlaceholder(/Mot de passe/).fill("CustomerAPassword123!");
  await pageA.getByPlaceholder(/Téléphone/).fill("0612345678");
  await pageA.getByRole("button", { name: "Créer mon compte" }).click();
  await pageA.waitForURL("/");

  await pageA.getByRole("link", { name: /Tiakola/ }).click();
  await pageA.waitForURL(/\/events\//);
  await pageA.getByRole("button", { name: "Réserver" }).first().click();
  await pageA.waitForURL(/\/checkout\/hold\//);
  const holdUrl = pageA.url();
  const holdId = holdUrl.split("/").pop()!;

  const startResponse = await pageA.request.post(`/api/checkout/${holdId}/start`);
  expect(startResponse.ok()).toBe(true);
  const { orderId } = await startResponse.json();

  // Customer A can see their own order.
  const ownOrderResponse = await pageA.request.get(`/api/orders/${orderId}`);
  expect(ownOrderResponse.status()).toBe(200);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto("/register");
  await pageB.getByPlaceholder("Nom").fill("Customer B");
  await pageB.getByPlaceholder("Email").fill(`access-b-${suffix}@test.onlylive.ma`);
  await pageB.getByPlaceholder(/Mot de passe/).fill("CustomerBPassword123!");
  await pageB.getByPlaceholder(/Téléphone/).fill("0612345679");
  await pageB.getByRole("button", { name: "Créer mon compte" }).click();
  await pageB.waitForURL("/");

  const crossAccessResponse = await pageB.request.get(`/api/orders/${orderId}`);
  expect(crossAccessResponse.status()).toBe(404);

  // Customer authentication is deliberately isolated from the admin
  // session mechanism. A valid customer cookie grants no back-office API
  // access, even when the request is made manually.
  const adminOverviewResponse = await pageB.request.get("/api/admin/overview");
  expect(adminOverviewResponse.status()).toBe(401);

  const scannerResponse = await pageB.request.post("/api/scanner/scan", {
    data: {
      eventId: "00000000-0000-0000-0000-000000000000",
      validationToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  expect(scannerResponse.status()).toBe(401);

  await contextA.close();
  await contextB.close();
});
