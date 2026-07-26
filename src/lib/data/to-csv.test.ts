import { describe, it, expect } from "vitest";
import { toCsv, sanitizeCsvCell } from "./to-csv";

describe("toCsv", () => {
  it("puts the header row first with CRLF row endings", () => {
    expect(toCsv(["A", "B"], [["1", "2"], ["3", "4"]])).toBe("A,B\r\n1,2\r\n3,4");
  });
  it("empty rows → header only", () => {
    expect(toCsv(["A", "B"], [])).toBe("A,B");
  });
  it("does not quote plain fields", () => {
    expect(toCsv(["A"], [["plain"]])).toBe("A\r\nplain");
  });
  it("quotes a field containing a comma", () => {
    expect(toCsv(["A"], [["x,y"]])).toBe('A\r\n"x,y"');
  });
  it("escapes internal double-quotes by doubling them and quoting the field", () => {
    expect(toCsv(["A"], [['he said "hi"']])).toBe('A\r\n"he said ""hi"""');
  });
  it("quotes a field containing a newline or CRLF", () => {
    expect(toCsv(["A"], [["line1\nline2"]])).toBe('A\r\n"line1\nline2"');
    expect(toCsv(["A"], [["a\r\nb"]])).toBe('A\r\n"a\r\nb"');
  });
});

describe("sanitizeCsvCell — spreadsheet formula-injection neutralization", () => {
  it("prefixes a single quote when a cell starts with a formula/command trigger", () => {
    for (const c of ["=cmd()", "+1+1", "-2+3", "@SUM(A1)", "=HYPERLINK(\"http://x\")", "=1+1|cmd"]) {
      expect(sanitizeCsvCell(c)).toBe(`'${c}`);
    }
  });
  it("neutralizes control-char leads (TAB/CR/LF) and triggers hidden behind leading whitespace", () => {
    expect(sanitizeCsvCell("\t=cmd")).toBe("'\t=cmd");
    expect(sanitizeCsvCell("\r=cmd")).toBe("'\r=cmd");
    expect(sanitizeCsvCell("\n=cmd")).toBe("'\n=cmd");
    expect(sanitizeCsvCell("   =1+1")).toBe("'   =1+1"); // leading spaces then trigger
    expect(sanitizeCsvCell("   @evil")).toBe("'   @evil");
  });
  it("leaves safe cells untouched", () => {
    for (const c of ["Ada Lovelace", "Salesforce", "DIRECT", "12", "okta", "a=b later", "", "user@example.com"]) {
      // note: "user@example.com" does NOT start with @, so it is safe; a bare "@evil" would be prefixed
      expect(sanitizeCsvCell(c)).toBe(c);
    }
  });
  it("composes with toCsv: a formula cell is both neutralized and (if needed) quoted", () => {
    expect(toCsv(["A"], [[sanitizeCsvCell("=1,2")]])).toBe(`A\r\n"'=1,2"`); // prefixed then quoted (contains comma)
  });
});
