import { z } from "zod";

// Required at registration: a real PSP (ChariPay's hosted checkout) rejects
// a payment session whose customer has no phone number. Only loosely
// validated here (plausible phone-like characters, plus a real-digit-count
// check so punctuation-only input like "++++++++" can't satisfy min(8) on
// character count alone) — the provider adapter is responsible for its own
// stricter format/country normalization at checkout time. Shared with
// updatePhoneSchema below so a customer who registered before this
// requirement existed validates against the exact same rule when adding one.
export const phoneSchema = z
  .string()
  .trim()
  .min(8)
  .max(30)
  .regex(/^[0-9+()\-.\s]+$/, "Numéro de téléphone invalide")
  .refine((value) => {
    const digitCount = value.replace(/\D/g, "").length;
    return digitCount >= 8 && digitCount <= 15;
  }, "Numéro de téléphone invalide");

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
