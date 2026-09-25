import { test, expect } from "@playwright/test";

/**
 * /mes-commandes ownership: same pattern as tests/e2e/mes-billets.spec.ts --
 * two real accounts, proving Prisma's `where: { userId }` filter actually
 * holds at the HTTP/page level, not just as a query shape.
 */
test("a customer sees only their own orders in Mes commandes", async ({ browser }) => {
  const suffix = Date.now();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto("/register");
  await pageA.getByLabel("Nom").fill("Orders Owner");
  await pageA.getByLabel("Email").fill(`orders-owner-${suffix}@test.onlylive.ma`);
  await pageA.getByLabel("Mot de passe").fill("OrdersOwnerPassword123!");
  await pageA.getByLabel("Téléphone").fill("0612345678");
  await pageA.getByRole("button", { name: "Créer mon compte" }).click();
  await pageA.waitForURL("/");

  await pageA.getByRole("link", { name: /Tiakola/ }).click();
  await pageA.waitForURL(/\/events\//);
  await pageA.getByRole("button", { name: "Réserver" }).first().click();
  await pageA.waitForURL(/\/checkout\/hold\//);
  await pageA.getByRole("button", { name: /Continuer vers le paiement sécurisé/ }).click();
  await pageA.waitForURL(/\/pay\/fake\//);
  await pageA.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await pageA.waitForURL(/\/orders\/([^/]+)$/);
  const orderNumber = await pageA.getByText(/^Commande /).first().innerText();

  await pageA.goto("/mes-commandes");
  await expect(pageA.getByRole("heading", { name: "Mes commandes" })).toBeVisible();
  await expect(pageA.getByText(orderNumber)).toBeVisible();
  await expect(pageA.getByText(/Payée/)).toBeVisible();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto("/register");
  await pageB.getByLabel("Nom").fill("Orders Other");
  await pageB.getByLabel("Email").fill(`orders-other-${suffix}@test.onlylive.ma`);
  await pageB.getByLabel("Mot de passe").fill("OrdersOtherPassword123!");
  await pageB.getByLabel("Téléphone").fill("0612345679");
  await pageB.getByRole("button", { name: "Créer mon compte" }).click();
  await pageB.waitForURL("/");

  await pageB.goto("/mes-commandes");
  await expect(pageB.getByRole("heading", { name: "Mes commandes" })).toBeVisible();
  await expect(pageB.getByText("Vous n’avez pas encore de commande.")).toBeVisible();
  await expect(pageB.getByText(orderNumber)).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test("an unauthenticated visit to Mes commandes redirects to login", async ({ page }) => {
  await page.goto("/mes-commandes");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmes-commandes/);
});
