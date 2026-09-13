import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const adminEmail = `catalog-admin-${crypto.randomUUID()}@test.onlylive.ma`;
const supportEmail = `catalog-support-${crypto.randomUUID()}@test.onlylive.ma`;
const password = "AdminCatalogE2ETest123!";
const eventSlug = `catalog-e2e-${crypto.randomUUID()}`;

test.beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  await prisma.adminUser.createMany({
    data: [
      { email: adminEmail, passwordHash, name: "Catalogue Admin E2E", role: "admin" },
      { email: supportEmail, passwordHash, name: "Catalogue Support E2E", role: "support" },
    ],
  });
});

test.afterAll(async () => {
  await prisma.event.deleteMany({ where: { slug: eventSlug } });
  await prisma.adminUser.deleteMany({ where: { email: { in: [adminEmail, supportEmail] } } });
});

test("an administrator can create an event from the catalogue UI", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto("/admin/events/new");
  await page.getByLabel("Titre").fill("Concert Catalogue E2E");
  await page.getByLabel("URL courte").fill(eventSlug);
  await page.getByLabel("Description").fill("Événement créé par le parcours navigateur automatisé.");
  await page.getByRole("button", { name: "Créer l’événement" }).click();

  await expect(page.getByText("Événement créé", { exact: true })).toBeVisible();

  const publicDraftResponse = await page.request.get(`/events/${eventSlug}`);
  expect(publicDraftResponse.status()).toBe(404);

  await page.goto("/admin/events");
  await expect(page.getByRole("heading", { name: "Concert Catalogue E2E" })).toBeVisible();

  await expect(prisma.event.findUnique({ where: { slug: eventSlug } })).resolves.toMatchObject({
    title: "Concert Catalogue E2E",
  });
});

test("a support account remains read-only", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(supportEmail);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL("/admin");

  await page.goto("/admin/events/new");
  await page.waitForURL("/admin/events");
  await expect(page.getByRole("link", { name: "Créer un événement" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Gérer" })).toHaveCount(0);
});
