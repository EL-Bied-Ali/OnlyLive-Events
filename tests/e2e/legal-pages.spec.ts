import { test, expect } from "@playwright/test";

const LEGAL_ROUTES = [
  "/legal/mentions-legales",
  "/legal/conditions-generales",
  "/legal/politique-de-confidentialite",
  "/legal/politique-de-remboursement",
] as const;

for (const route of LEGAL_ROUTES) {
  test(`${route} renders and is clearly marked as a draft`, async ({ request }) => {
    const response = await request.get(route);
    expect(response.ok()).toBe(true);

    const body = await response.text();
    expect(body).toContain("Document provisoire");
    expect(body).toContain("avocat");
  });
}

test("the homepage links to all four legal pages", async ({ page }) => {
  await page.goto("/");
  for (const route of LEGAL_ROUTES) {
    await expect(page.locator(`a[href="${route}"]`)).toHaveCount(1);
  }
});
