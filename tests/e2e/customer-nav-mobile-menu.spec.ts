import { test, expect } from "@playwright/test";

/**
 * Below 640px, CustomerNav collapses its auth-aware links behind a single
 * "Menu" toggle (see components/CustomerNavMobileMenu.tsx) instead of
 * letting five-plus links wrap across several rows and push the header
 * past 200px tall. Page-specific `trailing` content (e.g. the event page's
 * back link) stays visible outside the toggle either way.
 */
test.use({ viewport: { width: 320, height: 900 } });

test("logged-out nav: links are collapsed by default and reachable after opening the menu", async ({ page }) => {
  await page.goto("/");

  const toggle = page.getByRole("button", { name: "Menu" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("link", { name: "Connexion" })).toBeHidden();

  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Aide" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inscription" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page.getByRole("heading", { name: /le live commence/i }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("logged-in nav: all authenticated links are reachable after opening the menu", async ({ page }) => {
  const email = `nav-menu-e2e-${Date.now()}@test.onlylive.ma`;
  await page.goto("/register");
  await page.getByLabel("Nom").fill("Nav Menu E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill("NavMenuE2EPassword123!");
  await page.getByLabel("Téléphone").fill("0612345678");
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.waitForURL("/");

  await page.goto("/mes-billets");
  await expect(page.getByRole("link", { name: "Mes commandes" })).toBeHidden();

  await page.getByRole("button", { name: "Menu" }).click();

  await expect(page.getByRole("link", { name: "Mes billets" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mes commandes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Compte" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Aide" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Déconnexion" })).toBeVisible();
});

test("event page: the back-link stays visible and reachable while the menu is collapsed", async ({ page }) => {
  await page.goto("/events/tiakola-casablanca-2026");

  const backLink = page.getByRole("link", { name: /tous les événements/i });
  await expect(backLink).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  // The collapsed menu must not visually consume most of the viewport --
  // regression guard for the >200px header GPT's review flagged.
  const navHeight = await page.locator("nav.live-nav").evaluate((el) => el.getBoundingClientRect().height);
  expect(navHeight).toBeLessThan(180);
});
