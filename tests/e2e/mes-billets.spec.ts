import { test, expect } from "@playwright/test";

/**
 * /mes-billets ownership: mirrors tests/e2e/access-control.spec.ts's
 * pattern (two real browser contexts, real accounts) since Prisma's
 * orderItem->order->userId filter needs to be proven at the HTTP/page
 * level, not just asserted as a query shape.
 */
test("a customer sees only their own purchased tickets in Mes billets", async ({ browser }) => {
  const suffix = Date.now();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto("/register");
  await pageA.getByLabel("Nom").fill("Wallet Owner");
  await pageA.getByLabel("Email").fill(`wallet-owner-${suffix}@test.onlylive.ma`);
  await pageA.getByLabel("Mot de passe").fill("WalletOwnerPassword123!");
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
  await pageA.waitForURL(/\/orders\//);

  await pageA.goto("/mes-billets");
  await expect(pageA.getByRole("heading", { name: "Mes billets" })).toBeVisible();
  await expect(pageA.getByRole("heading", { name: /Tiakola/ })).toBeVisible();
  await expect(pageA.getByText("Valide")).toBeVisible();

  // Capture A's own ticket URL (the wallet card links straight to it) so we
  // can prove B is rejected from it directly, not just absent from B's list.
  await pageA.getByRole("heading", { name: /Tiakola/ }).click();
  await pageA.waitForURL(/\/orders\/.+\/tickets\/.+/);
  const ticketUrl = pageA.url();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto("/register");
  await pageB.getByLabel("Nom").fill("Wallet Other");
  await pageB.getByLabel("Email").fill(`wallet-other-${suffix}@test.onlylive.ma`);
  await pageB.getByLabel("Mot de passe").fill("WalletOtherPassword123!");
  await pageB.getByLabel("Téléphone").fill("0612345679");
  await pageB.getByRole("button", { name: "Créer mon compte" }).click();
  await pageB.waitForURL("/");

  await pageB.goto("/mes-billets");
  await expect(pageB.getByRole("heading", { name: "Mes billets" })).toBeVisible();
  await expect(pageB.getByText("Vous n’avez pas encore de billet.")).toBeVisible();
  await expect(pageB.getByRole("heading", { name: /Tiakola/ })).toHaveCount(0);

  // Adversarial case: B doesn't just fail to see A's ticket in a list, B is
  // rejected even when it types A's exact ticket URL directly.
  const crossAccessResponse = await pageB.request.get(ticketUrl);
  expect(crossAccessResponse.status()).toBe(404);

  await contextA.close();
  await contextB.close();
});

test("an unauthenticated visit to Mes billets redirects to login", async ({ page }) => {
  await page.goto("/mes-billets");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmes-billets/);
});
