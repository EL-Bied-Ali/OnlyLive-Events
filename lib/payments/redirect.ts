export type CheckoutNavigation =
  | { kind: "internal"; url: string }
  | { kind: "external"; url: string };

/**
 * Classify a server-returned checkout destination. Relative app routes remain
 * Next.js navigations; hosted PSP destinations must be absolute HTTPS URLs and
 * use a browser-level navigation rather than the App Router.
 */
export function classifyCheckoutNavigation(value: string): CheckoutNavigation {
  if (value.startsWith("/")) return { kind: "internal", url: value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid checkout redirect URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("External checkout redirect must use HTTPS without embedded credentials");
  }
  return { kind: "external", url: url.toString() };
}
