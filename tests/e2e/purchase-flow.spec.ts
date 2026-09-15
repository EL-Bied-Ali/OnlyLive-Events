import { test, expect } from "@playwright/test";

/**
 * End-to-end happy path: register -> browse the seeded event -> reserve a
 * ticket -> checkout -> simulate a successful fake payment -> land on a
 * paid order with a ticket page rendering a QR code.
 *
 * Runs against the dev database (see playwright.config.ts's webServer) —
 * `npm run seed` must have populated the Tiakola event beforehand, which
 * `npm run test:e2e` assumes has already been done in this environment.
 */
test("customer can browse, reserve, pay, and receive a ticket", async ({ page }) => {
  const uniqueSuffix = Date.now();
  const email = `e2e-${uniqueSuffix}@test.onlylive.ma`;
  const password = "E2ETestPassword123!";

  await page.goto("/register");
  await page.getByPlaceholder("Nom").fill("E2E Test Buyer");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder(/Mot de passe/).fill(password);
  await page.getByPlaceholder(/Téléphone/).fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();

  await page.waitForURL("/");

  await page.getByRole("link", { name: /Tiakola/ }).click();
  await page.waitForURL(/\/events\//);

  await page.getByRole("button", { name: "Réserver" }).first().click();
  await page.waitForURL(/\/checkout\/hold\//);

  await expect(page.getByText(/expire dans/)).toBeVisible();

  await page.getByRole("button", { name: "Payer" }).click();
  await page.waitForURL(/\/pay\/fake\//);

  await page.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await page.waitForURL(/\/orders\//);

  await expect(page.getByText("Payée")).toBeVisible();

  await page.getByRole("link", { name: "Voir le billet" }).click();
  await page.waitForURL(/\/tickets\//);
  await expect(page.getByAltText("QR code du billet")).toBeVisible();
  await expect(page.getByText("Valide")).toBeVisible();
});
