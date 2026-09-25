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
  // aria-live="polite" + role="status" announces the mutation to
  // screen-reader users, not just sighted ones inferring it from the new
  // value having replaced the old one.
  await expect(page.getByRole("status")).toHaveText("Numéro mis à jour.");

  // Re-opening the editor clears the previous save's announcement, so it
  // can't be mistaken for confirmation of a not-yet-submitted edit.
  await page.getByRole("button", { name: "Modifier" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("an unauthenticated visit to Mon compte redirects to login", async ({ page }) => {
  await page.goto("/mon-compte");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmon-compte/);
});

test("an invalid phone number shows a mapped French message, never the raw API error", async ({ page }) => {
  const suffix = Date.now();
  const email = `account-invalid-phone-${suffix}@test.onlylive.ma`;

  await page.goto("/register");
  await page.getByLabel("Nom").fill("Invalid Phone Holder");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill("InvalidPhonePassword123!");
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("/");

  await page.goto("/mon-compte");
  await page.getByRole("button", { name: "Modifier" }).click();
  // Passes the input's own minLength=8 so the request actually reaches the
  // server -- normalizePhone() still rejects it (no valid prefix/shape).
  await page.getByLabel("Téléphone").fill("11111111");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  await expect(page.locator("#account-phone-error")).toHaveText("Numéro de téléphone invalide.");
});
