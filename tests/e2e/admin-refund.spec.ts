import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const adminEmail = `refund-admin-${crypto.randomUUID()}@test.onlylive.ma`;
const supportEmail = `refund-support-${crypto.randomUUID()}@test.onlylive.ma`;
const password = "AdminRefundE2ETest123!";

test.beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  await prisma.adminUser.createMany({
    data: [
      { email: adminEmail, passwordHash, name: "Refund Admin E2E", role: "admin" },
      { email: supportEmail, passwordHash, name: "Refund Support E2E", role: "support" },
    ],
  });
});

test.afterAll(async () => {
  const admins = await prisma.adminUser.findMany({ where: { email: { in: [adminEmail, supportEmail] } }, select: { id: true } });
  await prisma.refund.deleteMany({ where: { initiatedByAdminUserId: { in: admins.map((a) => a.id) } } });
  await prisma.adminUser.deleteMany({ where: { email: { in: [adminEmail, supportEmail] } } });
});

async function purchaseTicket(page: import("@playwright/test").Page) {
  const suffix = crypto.randomUUID();
  await page.goto("/register");
  await page.getByPlaceholder("Nom").fill("Refund E2E Buyer");
  await page.getByPlaceholder("Email").fill(`refund-buyer-${suffix}@test.onlylive.ma`);
  await page.getByPlaceholder(/Mot de passe/).fill("RefundBuyerPassword123!");
  await page.getByPlaceholder(/Téléphone/).fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("/");

  await page.getByRole("link", { name: /Tiakola/ }).click();
  await page.waitForURL(/\/events\//);
  await page.getByRole("button", { name: "Réserver" }).first().click();
  await page.waitForURL(/\/checkout\/hold\//);
  await page.getByRole("button", { name: "Payer" }).click();
  await page.waitForURL(/\/pay\/fake\//);
  await page.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await page.waitForURL(/\/orders\/([^/]+)$/);

  const match = /\/orders\/([^/]+)$/.exec(page.url());
  return match![1]!;
}

test("an administrator can fully refund a paid order, cancelling its ticket", async ({ page }) => {
  const orderId = await purchaseTicket(page);

  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto(`/admin/orders/${orderId}`);
  await expect(page.getByRole("button", { name: "Rembourser" })).toBeVisible();

  await page.getByLabel("Motif").fill("Remboursement E2E");
  await page.getByRole("button", { name: "Rembourser" }).click();

  // The success toast lives inside the per-payment refund form, which
  // unmounts once the page revalidates with remainingRefundableCents at
  // 0 (the form only renders while a balance remains) — so assert on
  // the resulting page state instead of that transient message.
  await expect(page.getByText("Remboursée", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Annulé", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rembourser" })).toHaveCount(0);

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.status).toBe("refunded");
  const tickets = await prisma.ticket.findMany({ where: { orderItem: { orderId } } });
  expect(tickets.every((t) => t.status === "cancelled")).toBe(true);
});

test("a support account can view an order but has no refund form", async ({ page }) => {
  const orderId = await purchaseTicket(page);

  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(supportEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto(`/admin/orders/${orderId}`);
  await expect(page.getByRole("heading", { name: "Paiements et remboursements" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rembourser" })).toHaveCount(0);
});
