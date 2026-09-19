/**
 * Single source of truth for what OnlyLive considers a payable phone number.
 * Used by registration, the post-registration "complete your phone" flow,
 * checkout gating, and ChariPay's adapter (lib/payments/charipayProvider.ts)
 * so none of them can drift out of sync with what the real PSP will accept.
 *
 * Returns the canonical E.164 form, or null when the input can't be turned
 * into one — never throws, so callers decide how to surface the failure
 * (a Zod issue, a fail-closed checkout gate, a ProviderInputError, etc).
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  let value = phone?.trim().replace(/[\s().-]/g, "") ?? "";
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  else if (/^0[5-7]\d{8}$/.test(value)) value = `+212${value.slice(1)}`;
  else if (/^212[5-7]\d{8}$/.test(value)) value = `+${value}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  return value;
}
