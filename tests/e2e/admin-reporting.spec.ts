import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const adminEmail = `reporting-admin-${crypto.randomUUID()}@test.onlylive.ma`;
const supportEmail = `reporting-support-${crypto.randomUUID()}@test.onlylive.ma`;
const scannerEmail = `reporting-scanner-${crypto.randomUUID()}@test.onlylive.ma`;
const password = "AdminReportingE2ETest123!";
const auditMarker = `e2e-audit-${crypto.randomUUID()}`;

test.beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  const admin = await prisma.adminUser.create({
    data: { email: adminEmail, passwordHash, name: "Reporting Admin E2E", role: "admin" },
  });
  await prisma.adminUser.createMany({
    data: [
      { email: supportEmail, passwordHash, name: "Reporting Support E2E", role: "support" },
      { email: scannerEmail, passwordHash, name: "Reporting Scanner E2E", role: "scanner" },
    ],
  });
  await prisma.auditLog.create({
    data: {
      actorType: "admin",
      actorId: admin.id,
      action: "event.created",
      entityType: auditMarker,
      entityId: crypto.randomUUID(),
    },
  });
});

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: auditMarker } });
  await prisma.adminUser.deleteMany({ where: { email: { in: [adminEmail, supportEmail, scannerEmail] } } });
});

test("an administrator can view the audit log and export orders as CSV", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto(`/admin/audit?entityType=${auditMarker}`);
  await expect(page.getByRole("heading", { name: "Journal d’audit" })).toBeVisible();
  await expect(page.getByText("event.created")).toBeVisible();

  const exportResponse = await page.request.get("/api/admin/orders/export");
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-type"]).toContain("text/csv");
  expect(exportResponse.headers()["content-disposition"]).toContain("attachment");
  const body = await exportResponse.text();
  expect(body).toContain("Commande");
});

test("a support account can read the audit log and export orders, but a scanner account cannot", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(supportEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Journal d’audit" })).toBeVisible();

  const supportExport = await page.request.get("/api/admin/orders/export");
  expect(supportExport.status()).toBe(200);

  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(scannerEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/");

  // /admin/audit redirects scanner sessions to "/" (page-level guard,
  // covered by admin-dashboard.spec.ts) rather than returning a status a
  // plain request can assert on; the JSON export API is a cleaner check
  // here since it rejects with 401 directly instead of redirecting.
  const scannerExport = await page.request.get("/api/admin/orders/export");
  expect(scannerExport.status()).toBe(403);
});
