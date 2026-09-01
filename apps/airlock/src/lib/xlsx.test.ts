/**
 * .xlsx wrapper — the binary source-capture round trip. Persistence keeps the
 * original workbook bytes; a restore must re-derive the identical sheet CSV from
 * them. Also pins the honest failure states: multi-sheet (which one?), empty
 * sheet, and not-a-spreadsheet.
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { readSheetNames, sheetToCsv, viewToXlsx } from "./xlsx";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

describe("viewToXlsx <-> sheetToCsv round trip", () => {
  it("re-derives the exact CSV from captured workbook bytes", async () => {
    const columns = ["id", "name", "base_salary"];
    const rows = [
      { id: 1, name: "Ada", base_salary: 120000 },
      { id: 2, name: "Bob, Jr.", base_salary: 98000 },
      { id: 3, name: "Cy", base_salary: null },
    ];
    const bytes = await viewToXlsx(columns, rows);

    // Survives a structuredClone the way IndexedDB would store/return it.
    const restored = structuredClone(bytes);
    expect(restored).toEqual(bytes);

    const first = await sheetToCsv(restored);
    const again = await sheetToCsv(structuredClone(restored));
    expect(again.csv).toBe(first.csv);

    expect(first.sheet).toBe("Airlock export");
    expect(first.csv.split("\n")[0]).toBe("id,name,base_salary");
    expect(first.csv).toContain('"Bob, Jr."');
  });

  it("normalizes bigint cells (DuckDB integer columns)", async () => {
    const bytes = await viewToXlsx(["n"], [{ n: 42n }, { n: 7n }]);
    const { csv } = await sheetToCsv(bytes);
    expect(csv).toBe("n\n42\n7");
  });
});

describe("readSheetNames", () => {
  it("lists sheets in workbook order", async () => {
    const bytes = workbook({ Summary: [["x"]], Raw: [["y"]], Notes: [["z"]] });
    expect(await readSheetNames(bytes)).toEqual(["Summary", "Raw", "Notes"]);
  });
});

describe("sheetToCsv failure states", () => {
  it("imports the sole sheet without a name", async () => {
    const bytes = workbook({ OnlySheet: [["a", "b"], [1, 2]] });
    const { sheet, csv } = await sheetToCsv(bytes);
    expect(sheet).toBe("OnlySheet");
    expect(csv).toBe("a,b\n1,2");
  });

  it("refuses a multi-sheet workbook with no sheet chosen, and names them", async () => {
    const bytes = workbook({ Q1: [["a"], [1]], Q2: [["a"], [2]] });
    await expect(sheetToCsv(bytes)).rejects.toThrow(/2 sheets \(Q1, Q2\)/);
  });

  it("imports the named sheet from a multi-sheet workbook", async () => {
    const bytes = workbook({ Q1: [["a"], [1]], Q2: [["a"], [2]] });
    const { sheet, csv } = await sheetToCsv(bytes, "Q2");
    expect(sheet).toBe("Q2");
    expect(csv).toBe("a\n2");
  });

  it("rejects a sheet name that is not in the workbook", async () => {
    const bytes = workbook({ Q1: [["a"], [1]] });
    await expect(sheetToCsv(bytes, "Nope")).rejects.toThrow(/No sheet named "Nope"/);
  });

  it("rejects an empty sheet", async () => {
    const bytes = workbook({ Empty: [[]] });
    await expect(sheetToCsv(bytes)).rejects.toThrow(/empty/i);
  });

  it("rejects bytes that are not a spreadsheet (wrong container magic)", async () => {
    const notXlsx = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(sheetToCsv(notXlsx)).rejects.toThrow(/isn't a spreadsheet/);
    await expect(readSheetNames(notXlsx)).rejects.toThrow(/isn't a spreadsheet/);
  });

  it("rejects a CSV that was renamed to .xlsx", async () => {
    const csvBytes = new TextEncoder().encode("a,b,c\n1,2,3\n");
    await expect(sheetToCsv(csvBytes)).rejects.toThrow(/isn't a spreadsheet/);
  });
});
