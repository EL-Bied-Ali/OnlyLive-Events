import { test, expect } from "@playwright/test";

/**
 * The full happy path (actually consuming the emailed link) is covered at
 * the integration level (tests/integration/passwordReset.test.ts), where
 * the email provider is mocked so the raw token can be captured -- by
 * design, nothing durable (DB, logs) ever holds the raw token, so an E2E
 * test against a real running server has no way to recover it either.
 * What's actually observable here is the neutral response and the pages.
 */
test("forgot-password gives the same neutral response for a real and a nonexistent account", async ({ page }) => {
  const suffix = Date.now();
  const email = `reset-e2e-${suffix}@test.onlylive.ma`;

  await page.goto("/register");
  await page.getByLabel("Nom").fill("Reset E2E Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill("ResetE2EPassword123!");
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("/");

  const realAccountResponse = await page.request.post("/api/auth/forgot-password", { data: { email } });
  const missingAccountResponse = await page.request.post("/api/auth/forgot-password", {
    data: { email: `no-such-account-${suffix}@test.onlylive.ma` },
  });

  expect(realAccountResponse.status()).toBe(missingAccountResponse.status());
  expect(await realAccountResponse.json()).toEqual(await missingAccountResponse.json());
});

test("the forgot-password page always shows the same confirmation, regardless of the email typed", async ({
  page,
}) => {
  await page.goto("/mot-de-passe-oublie");
  await page.getByLabel("Email").fill("whatever-was-typed@test.onlylive.ma");
  await page.getByRole("button", { name: "Envoyer le lien" }).click();
  await expect(page.getByText(/Si un compte existe avec cette adresse/)).toBeVisible();
});

test("visiting the reset-password page without a token shows an invalid-link message", async ({ page }) => {
  await page.goto("/reinitialiser-mot-de-passe");
  await expect(page.getByText(/invalide ou a expiré/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Demander un nouveau lien" })).toBeVisible();
});

test("submitting a bogus token to reset-password is rejected without revealing why", async ({ page }) => {
  const response = await page.request.post("/api/auth/reset-password", {
    data: { token: "this-token-was-never-issued", password: "SomeNewPassword123!" },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toBe("INVALID_OR_EXPIRED_TOKEN");
});
