import { z } from "zod";

export const createHoldSchema = z.object({
  ticketCategoryId: z.string().uuid(),
  salesPhaseId: z.string().uuid(),
  quantity: z.number().int().min(1).max(10),
});

export type CreateHoldInput = z.infer<typeof createHoldSchema>;
