import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const scannerEmail = `door-scanner-${crypto.randomUUID()}@test.onlylive.ma`;
const supportEmail = `support-${crypto.randomUUID()}@test.onlylive.ma`;
const password = "ScannerE2ETestPassword123!";
let eventId: string;

test.beforeAll(async () => {
  const [passwordHash, event] = await Promise.all([
    hashPassword(password),
    prisma.event.findFirstOrThrow({ where: { status: { in: ["published", "on_sale", "sold_out", "closed"] } } }),
  ]);
  eventId = event.id;
  await prisma.adminUser.createMany({
    data: [
      { email: scannerEmail, passwordHash, name: "Scanner Porte A", role: "scanner" },
      { email: supportEmail, passwordHash, name: "Support E2E", role: "support" },
    ],
  });
});

test.afterAll(async () => {
  await prisma.adminUser.deleteMany({ where: { email: { in: [scannerEmail, supportEmail] } } });
});

test("an unauthenticated visitor cannot call the scanner API", async ({ request }) => {
  const response = await request.post("/api/scanner/scan", {
    data: { eventId, validationToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  });
  expect(response.status()).toBe(401);
});

test("scanner staff can sign in and securely reject an unknown ticket", async ({ page }) => {
  await page.goto("/scanner");
  await page.waitForURL("/scanner/login");
  await page.getByLabel("Email").fill(scannerEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Ouvrir le scanner" }).click();
  await page.waitForURL("/scanner");

  await expect(page.getByText("Événement contrôlé")).toBeVisible();
  await page.getByText("Saisie manuelle").click();
  await page.getByLabel("Code du billet").fill("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await page.getByRole("button", { name: "Vérifier" }).click();

  await expect(page.getByText("Billet invalide", { exact: true })).toBeVisible();
  await expect(page.getByText("Ce QR code ne correspond à aucun billet OnlyLive.")).toBeVisible();

  const scanner = await prisma.adminUser.findUniqueOrThrow({ where: { email: scannerEmail } });
  const scan = await prisma.ticketScan.findFirst({
    where: { scannerAdminUserId: scanner.id, eventId, result: "invalid" },
    orderBy: { scannedAt: "desc" },
  });
  expect(scan).not.toBeNull();
  expect(scan?.scannedToken).toMatch(/^sha256:/);
  expect(scan?.scannedToken).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

test("a support account cannot validate tickets", async ({ page }) => {
  const login = await page.request.post("/api/admin/login", {
    data: { email: supportEmail, password },
  });
  expect(login.status()).toBe(200);

  const response = await page.request.post("/api/scanner/scan", {
    data: { eventId, validationToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  });
  expect(response.status()).toBe(403);
});
