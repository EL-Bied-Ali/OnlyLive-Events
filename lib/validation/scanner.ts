import { z } from "zod";

export const scanTicketSchema = z.object({
  eventId: z.uuid(),
  validationToken: z
    .string()
    .trim()
    .min(16)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, "Invalid ticket token format"),
});
