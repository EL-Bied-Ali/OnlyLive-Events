import { z } from "zod";
import { MAX_QUANTITY_PER_HOLD } from "@/lib/inventory";

export const createHoldSchema = z.object({
  ticketCategoryId: z.string().uuid(),
  salesPhaseId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_HOLD),
});

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
