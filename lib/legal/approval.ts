// Draft legal pages (mentions légales, CGV, confidentialité, remboursement)
// must never become publicly reachable in production until a human
// explicitly confirms the [À COMPLÉTER] placeholders have been resolved and
// the pages reviewed by counsel — flagged by GPT's audit of PR #71 as a real
// deployment-safety gap, not just a cosmetic "brouillon" banner.
//
// This is gated on NODE_ENV, not VERCEL_ENV: `next build`/`next start` set
// NODE_ENV=production for every production-mode build, including Vercel
// Preview deployments (Preview is not the same thing as "local/dev"). So
// this blocks the drafts by default on Preview too, not only on real
// production traffic — deliberately the conservative choice GPT preferred
// (a draft legal document unavailable somewhere it could safely be shown is
// safer than one leaking somewhere it shouldn't). Only genuine
// non-production-mode processes (`next dev`, Vitest, local `tsx` scripts)
// see the drafts automatically; everything else requires the explicit
// LEGAL_DOCUMENTS_APPROVED=true opt-in (see playwright.config.ts for how
// the isolated E2E build opts in deliberately).
export function legalDocumentsApproved(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.LEGAL_DOCUMENTS_APPROVED === "true";
}
