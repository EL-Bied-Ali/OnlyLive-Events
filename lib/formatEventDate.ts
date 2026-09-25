/**
 * Every event is scheduled in Morocco (Africa/Casablanca). Without an
 * explicit timeZone, Intl.DateTimeFormat renders in the server's own
 * timezone (UTC in production/Vercel), silently showing the wrong local
 * hour to customers -- e.g. a 20:00 Tiakola start rendering as 19:00.
 */
export function formatEventDate(date: Date, style: "full" | "long" = "full"): string {
  return new Intl.DateTimeFormat("fr-MA", {
    dateStyle: style,
    timeStyle: "short",
    timeZone: "Africa/Casablanca",
  }).format(date);
}

export function formatEventDateOnly(date: Date, style: "full" | "long" = "long"): string {
  return new Intl.DateTimeFormat("fr-MA", { dateStyle: style, timeZone: "Africa/Casablanca" }).format(date);
}

export function formatEventDay(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", { day: "2-digit", timeZone: "Africa/Casablanca" }).format(date);
}

export function formatEventMonth(date: Date): string {
  return new Intl.DateTimeFormat("fr-MA", { month: "short", timeZone: "Africa/Casablanca" }).format(date);
}
