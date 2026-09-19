import { z } from "zod";
import { normalizePhone } from "@/lib/validation/phone";

// Required at registration: a real PSP (ChariPay's hosted checkout) rejects
// a payment session whose customer has no phone number. This is the exact
// same acceptance rule ChariPay's adapter itself uses to normalize a phone
// at payment time (lib/validation/phone.ts) — the previous version of this
// schema only loosely checked for phone-like characters and a plausible
// digit count, which let values through that ChariPay's adapter rejected at
// checkout with no way for the customer to correct them. Storing the
// transformed E.164 value (not the raw input) means what's saved is always
// exactly what the adapter will accept later. Shared with updatePhoneSchema
// below so a customer who registered before this requirement existed
// validates against the exact same rule when adding one.
export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Numéro de téléphone invalide")
  .max(40, "Numéro de téléphone invalide")
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Numéro de téléphone invalide" });
      return z.NEVER;
    }
    return normalized;
  });

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const updatePhoneSchema = z.object({
  phone: phoneSchema,
});

export type UpdatePhoneInput = z.infer<typeof updatePhoneSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
