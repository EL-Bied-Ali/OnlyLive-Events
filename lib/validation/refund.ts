import { z } from "zod";
import { parseMadPrice } from "@/lib/validation/catalog";

export const refundMutationSchema = z.object({
  paymentId: z.string().min(1),
  amountCents: z.unknown().transform(parseMadPrice),
  reason: z.string().trim().min(3).max(500),
});

export type RefundMutationInput = z.infer<typeof refundMutationSchema>;
