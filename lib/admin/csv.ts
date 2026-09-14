import "server-only";

/**
 * Guards against CSV/formula injection: a cell opened by Excel or Google
 * Sheets that starts with =, +, -, or @ can execute as a formula. Several
 * exported fields (customer name, event title) ultimately trace back to
 * user-supplied input, so every cell is neutralized, not just the ones we
 * currently believe are attacker-reachable.
 */
function escapeCsvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map((cell) => escapeCsvCell(String(cell))).join(","));
  // CRLF and a UTF-8 BOM: Excel on Windows otherwise mis-detects the
  // encoding and garbles accented characters (client/event names are
  // frequently French/Arabic-transliterated).
  return "﻿" + lines.join("\r\n") + "\r\n";
}
