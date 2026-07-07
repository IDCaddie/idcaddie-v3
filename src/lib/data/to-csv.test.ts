import { describe, it, expect } from "vitest";
import { toCsv } from "./to-csv";

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
