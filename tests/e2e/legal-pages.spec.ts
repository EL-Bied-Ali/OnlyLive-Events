import { test, expect } from "@playwright/test";

// These pages are hidden (404, unlinked footer) whenever NODE_ENV=production
// and LEGAL_DOCUMENTS_APPROVED is not "true" — see lib/legal/approval.ts.
// `next start` always runs with NODE_ENV=production (see playwright.config.ts),
// so this suite explicitly opts in via LEGAL_DOCUMENTS_APPROVED=true in that
// config, matching the sibling ALLOW_*_IN_PRODUCTION flags, to verify the
// real page content. The gate-blocking logic itself (default-off in
// production) is covered by tests/unit/legal/approval.test.ts, not here.
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
