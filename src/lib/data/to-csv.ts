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
