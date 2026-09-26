export function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat("fr-MA", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
