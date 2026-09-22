// Draft legal pages (mentions légales, CGV, confidentialité, remboursement)
// must never become publicly reachable in production until a human
// explicitly confirms the [À COMPLÉTER] placeholders have been resolved and
// the pages reviewed by counsel — flagged by GPT's audit of PR #71 as a real
// deployment-safety gap, not just a cosmetic "brouillon" banner. Preview and
// local development always show the drafts so they can be reviewed.
export function legalDocumentsApproved(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.LEGAL_DOCUMENTS_APPROVED === "true";
}
