import { z } from "zod";

const MOROCCO_TIME_ZONE = "Africa/Casablanca";
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const moroccoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MOROCCO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function zonedParts(date: Date) {
  const parts = Object.fromEntries(
    moroccoFormatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  } as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

/** Converts a wall-clock time in Morocco to an unambiguous UTC instant. */
export function parseMoroccoDateTime(value: string): Date {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) {
    throw new Error("Invalid local date/time format");
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const desired = {
    year: Number(yearRaw),
    month: Number(monthRaw),
    day: Number(dayRaw),
    hour: Number(hourRaw),
    minute: Number(minuteRaw),
  };
  const desiredEpoch = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
  let instant = desiredEpoch;

  // Resolve the IANA-zone offset at this date. Repeating handles an
  // offset transition between the initial UTC guess and the final instant.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = zonedParts(new Date(instant));
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    instant += desiredEpoch - shownAsUtc;
  }

  const result = new Date(instant);
  const shown = zonedParts(result);
  if (
    shown.year !== desired.year ||
    shown.month !== desired.month ||
    shown.day !== desired.day ||
    shown.hour !== desired.hour ||
    shown.minute !== desired.minute
  ) {
    throw new Error("This local time does not exist in Morocco");
  }
  return result;
}

export function formatMoroccoDateTime(date: Date): string {
  const parts = zonedParts(date);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

const localDateTimeSchema = z.string().transform((value, context) => {
  try {
    return parseMoroccoDateTime(value);
  } catch {
    context.addIssue({ code: "custom", message: "Date/heure du Maroc invalide" });
    return z.NEVER;
  }
});

const optionalLocalDateTimeSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  localDateTimeSchema.optional(),
);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const checkbox = z.preprocess((value) => value === "on" || value === "true" || value === true, z.boolean());
const integer = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

export const venueMutationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  addressLine1: z.string().trim().min(2).max(200),
  addressLine2: optionalText(200),
  city: z.string().trim().min(2).max(100),
  country: z.string().trim().toUpperCase().length(2).default("MA"),
  capacity: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    integer(1, 10_000_000).optional(),
  ),
});

export const eventMutationSchema = z
  .object({
    eventId: z.string().min(1).optional(),
    slug: z.string().trim().toLowerCase().min(3).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().min(10).max(10_000),
    venueId: z.string().min(1).max(100),
    startsAt: localDateTimeSchema,
    doorsOpenAt: optionalLocalDateTimeSchema,
    salesOpenAt: localDateTimeSchema,
    salesCloseAt: localDateTimeSchema,
    status: z.enum(["draft", "published", "on_sale", "sold_out", "closed", "cancelled"]),
    coverImageUrl: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.url().max(2_000).optional(),
    ),
  })
  .superRefine((data, context) => {
    if (data.salesOpenAt >= data.salesCloseAt) {
      context.addIssue({ code: "custom", path: ["salesCloseAt"], message: "La clôture doit suivre l’ouverture" });
    }
    if (data.salesCloseAt > data.startsAt) {
      context.addIssue({ code: "custom", path: ["salesCloseAt"], message: "Les ventes doivent fermer avant le début" });
    }
    if (data.doorsOpenAt && data.doorsOpenAt > data.startsAt) {
      context.addIssue({ code: "custom", path: ["doorsOpenAt"], message: "L’ouverture des portes doit précéder le début" });
    }
  });

export const categoryMutationSchema = z.object({
  categoryId: z.string().min(1).optional(),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: optionalText(500),
  totalQuantity: integer(0, 10_000_000),
  sortOrder: integer(0, 10_000),
  isActive: checkbox,
});

function parseMadPrice(value: unknown, context: z.RefinementCtx): number | typeof z.NEVER {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(normalized)) {
    context.addIssue({ code: "custom", message: "Prix MAD invalide (deux décimales maximum)" });
    return z.NEVER;
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000_000) {
    context.addIssue({ code: "custom", message: "Prix hors limites" });
    return z.NEVER;
  }
  return cents;
}

export const salesPhaseMutationSchema = z
  .object({
    phaseId: z.string().min(1).optional(),
    ticketCategoryId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    priceCents: z.unknown().transform(parseMadPrice),
    startsAt: localDateTimeSchema,
    endsAt: optionalLocalDateTimeSchema,
    phaseQuantityLimit: z.preprocess(
      (value) => (value === "" || value === undefined ? undefined : value),
      integer(1, 10_000_000).optional(),
    ),
    sortOrder: integer(0, 10_000),
    isActive: checkbox,
  })
  .superRefine((data, context) => {
    if (data.endsAt && data.endsAt <= data.startsAt) {
      context.addIssue({ code: "custom", path: ["endsAt"], message: "La fin doit suivre le début" });
    }
  });

export type VenueMutationInput = z.infer<typeof venueMutationSchema>;
export type EventMutationInput = z.infer<typeof eventMutationSchema>;
export type CategoryMutationInput = z.infer<typeof categoryMutationSchema>;
export type SalesPhaseMutationInput = z.infer<typeof salesPhaseMutationSchema>;
