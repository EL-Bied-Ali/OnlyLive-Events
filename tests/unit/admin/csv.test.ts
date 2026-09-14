import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/admin/csv";

describe("admin CSV export encoding", () => {
  it("joins plain cells with commas and CRLF line endings, prefixed with a UTF-8 BOM", () => {
    const csv = toCsv(["Nom", "Ville"], [["Amine", "Casablanca"]]);
    expect(csv).toBe("﻿Nom,Ville\r\nAmine,Casablanca\r\n");
  });

  it("quotes cells containing a comma, quote, or newline, doubling embedded quotes", () => {
    const csv = toCsv(["Champ"], [['He said "hi", then left'], ["multi\nline"]]);
    expect(csv).toContain('"He said ""hi"", then left"');
    expect(csv).toContain('"multi\nline"');
  });

  it("neutralizes formula-injection prefixes (=, +, -, @) so spreadsheet apps never execute them", () => {
    const csv = toCsv(["Champ"], [["=1+1"], ["+cmd"], ["-2"], ["@SUM(A1)"], ["-2 tickets"]]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-2\r\n");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain("'-2 tickets");
  });

  it("leaves ordinary numeric and text cells untouched", () => {
    const csv = toCsv(["Total"], [[42], ["Gradins"]]);
    expect(csv).toContain("42");
    expect(csv).toContain("Gradins");
    expect(csv).not.toContain("'42");
  });
});
