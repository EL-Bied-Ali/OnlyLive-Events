const EVENT_TIME_ZONE = "Africa/Casablanca";

/**
 * Event schedules are stored as instants but shown in the event's Morocco
 * local time. Keeping the timezone explicit prevents Vercel/UTC from
 * shifting customer-facing hours.
 */
export function formatEventDate(date: Date, style: "full" | "long" = "full"): string {
  return new Intl.DateTimeFormat("fr-MA", {
    dateStyle: style,
    timeStyle: "short",
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventDateOnly(date: Date, style: "full" | "long" = "long"): string {
  return new Intl.DateTimeFormat("fr-MA", {
    dateStyle: style,
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventDay(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", {
    day: "2-digit",
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventMonth(date: Date, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat("fr-MA", {
    month: style,
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventMonthNumber(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", {
    month: "2-digit",
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventYear(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", {
    year: "numeric",
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}

export function formatEventTime(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: EVENT_TIME_ZONE,
  }).format(date);
}
