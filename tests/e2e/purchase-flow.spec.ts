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
  await page.getByLabel("Nom").fill("E2E Test Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();

  await page.waitForURL("/");

  await page.getByRole("link", { name: /Tiakola/ }).click();
  await page.waitForURL(/\/events\//);

  await page.getByRole("button", { name: "Réserver" }).first().click();
  await page.waitForURL(/\/checkout\/hold\//);

  await expect(page.getByRole("list", { name: "Progression de la commande" })).toBeVisible();
  await expect(page.getByText(/Billets réservés encore/)).toBeVisible();
  await expect(page.getByText(/revenez ici pour la confirmation/i)).toBeVisible();

  await page.getByRole("button", { name: /Continuer vers le paiement sécurisé/ }).click();
  await page.waitForURL(/\/pay\/fake\//);

  await page.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await page.waitForURL(/\/orders\//);

  await expect(page.getByRole("heading", { name: "Paiement confirmé" })).toBeVisible();
  await expect(page.getByText(/vos billets sont disponibles/i)).toBeVisible();

  await page.getByRole("link", { name: /Voir le billet/ }).click();
  await page.waitForURL(/\/tickets\//);
  await expect(page.getByAltText("QR code du billet")).toBeVisible();
  await expect(page.getByText("Billet valide")).toBeVisible();
});


test("account creation preserves the event return path", async ({ page }) => {
  const uniqueSuffix = Date.now();
  const email = `e2e-return-${uniqueSuffix}@test.onlylive.ma`;
  const password = "E2ETestPassword123!";

  await page.goto("/");
  await page.getByRole("link", { name: /Tiakola/ }).click();
  await page.waitForURL(/\/events\//);
  const eventUrl = page.url();

  await page.getByRole("button", { name: "Réserver" }).first().click();
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);

  await page.getByRole("link", { name: "Créer un compte" }).click();
  await expect(page).toHaveURL(/\/register\?callbackUrl=/);

  await page.getByLabel("Nom").fill("E2E Return Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();

  await expect(page).toHaveURL(eventUrl);
  await expect(page.getByRole("heading", { name: /Tiakola/ })).toBeVisible();
});
