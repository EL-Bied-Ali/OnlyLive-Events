import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const adminEmail = `admin-e2e-${crypto.randomUUID()}@test.onlylive.ma`;
const adminPassword = "AdminE2ETestPassword123!";
const scannerEmail = `scanner-e2e-${crypto.randomUUID()}@test.onlylive.ma`;

test.beforeAll(async () => {
  const passwordHash = await hashPassword(adminPassword);
  await prisma.adminUser.createMany({
    data: [
      { email: adminEmail, passwordHash, name: "Admin E2E", role: "admin" },
      { email: scannerEmail, passwordHash, name: "Scanner E2E", role: "scanner" },
    ],
  });
});

test.afterAll(async () => {
  await prisma.adminUser.deleteMany({ where: { email: { in: [adminEmail, scannerEmail] } } });
});

test("an administrator can sign in and view the operational dashboard", async ({ page }) => {
  await page.goto("/admin");
  await page.waitForURL("/admin/login");

  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Mot de passe").fill(adminPassword);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await expect(page.getByRole("heading", { name: "Vue d’ensemble" })).toBeVisible();
  await expect(page.getByText("Encaissements confirmés")).toBeVisible();
  await expect(page.getByRole("link", { name: "Commandes" })).toBeVisible();

  const overviewResponse = await page.request.get("/api/admin/overview");
  expect(overviewResponse.status()).toBe(200);
});

test("a scanner account cannot enter the administration dashboard", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(scannerEmail);
  await page.getByLabel("Mot de passe").fill(adminPassword);
  await page.getByRole("button", { name: "Se connecter" }).click();

  await page.waitForURL("/");
  await expect(page.getByRole("heading", { name: "OnlyLive" })).toBeVisible();
});
