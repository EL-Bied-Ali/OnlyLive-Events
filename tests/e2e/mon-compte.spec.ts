import { test, expect } from "@playwright/test";

test("a customer can view and update their account phone number", async ({ page }) => {
  const suffix = Date.now();
  const email = `account-${suffix}@test.onlylive.ma`;

  await page.goto("/register");
  await page.getByLabel("Nom").fill("Account Holder");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill("AccountHolderPassword123!");
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("/");

  await page.goto("/mon-compte");
  await expect(page.getByRole("heading", { name: "Mon compte" })).toBeVisible();
  await expect(page.getByText("Account Holder")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("+212612345678")).toBeVisible();

  await page.getByRole("button", { name: "Modifier" }).click();
  await page.getByLabel("Téléphone").fill("0698765432");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  await expect(page.getByText("+212698765432")).toBeVisible();
});

test("an unauthenticated visit to Mon compte redirects to login", async ({ page }) => {
  await page.goto("/mon-compte");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmon-compte/);
});
