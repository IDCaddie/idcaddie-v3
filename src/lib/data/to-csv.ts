// Pure CSV serializer (RFC-4180 style). NO DB, no React, no I/O — takes header + already-stringified rows and
// returns the CSV text. Callers must pre-project their data to safe display strings (nulls → "" etc.) BEFORE
// calling this; this helper only quotes/escapes and joins. Header row first; CRLF row endings.

// Quote a field ONLY if it contains a comma, double-quote, or CR/LF; internal double-quotes are doubled.
function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(quoteField).join(",")).join("\r\n");
}

// Neutralize spreadsheet formula/DDE injection: a cell whose FIRST char (or first non-space char) is a formula/command
// trigger (= + - @) or a control char (TAB/CR/LF) is prefixed with a single quote so Excel/Sheets treat it as text.
// Additive helper — callers opt in (toCsv itself is unchanged, so existing client exports keep their behavior).
const FORMULA_TRIGGER = /^[=+\-@\t\r\n]/;      // first char is a formula/command/control trigger
const LEADING_WS_TRIGGER = /^\s+[=+\-@]/;      // a formula trigger hidden behind leading whitespace
export function sanitizeCsvCell(value: string): string {
  return FORMULA_TRIGGER.test(value) || LEADING_WS_TRIGGER.test(value) ? `'${value}` : value;
}
