/**
 * Pre-flight PII heuristic tests. The heuristic only ever *suggests* — these
 * pin what it recognises (by name and by value shape) and confirm it stays
 * quiet on ordinary analytical columns.
 */
import { describe, it, expect } from "vitest";
import { suggestPiiColumns, type PiiCandidate } from "./pii";

const col = (name: string, samples: string[] = [], type = "VARCHAR"): PiiCandidate => ({
  name,
  type,
  samples,
});

describe("suggestPiiColumns — name-based signals", () => {
  it.each([
    "name",
    "full_name",
    "first_name",
    "last name",
    "employee_email",
    "e-mail",
    "ssn",
    "social_security_number",
    "home_address",
    "phone",
    "mobile_number",
    "date_of_birth",
    "dob",
    "bank_account_number",
    "iban",
    "credit_card",
    "passport_no",
  ])("flags a column named %j", (name) => {
    expect(suggestPiiColumns([col(name)])).toContain(name);
  });

  it.each([
    "department",
    "level",
    "base_salary",
    "years_tenure",
    "performance",
    "manager_id",
    "org",
    "span_of_control",
    "region",
    "start_year",
  ])("stays quiet on the analytical column %j", (name) => {
    expect(suggestPiiColumns([col(name)])).not.toContain(name);
  });
});

describe("suggestPiiColumns — value-shape signals (name gives nothing away)", () => {
  it("flags a column of email-shaped values", () => {
    const c = col("contact", ["a@b.com", "priya@corp.io", "jon.snow@x.co.uk"]);
    expect(suggestPiiColumns([c])).toContain("contact");
  });

  it("flags a column of SSN-shaped values", () => {
    const c = col("ref", ["123-45-6789", "987-65-4321", "111-22-3333"]);
    expect(suggestPiiColumns([c])).toContain("ref");
  });

  it("flags a column of phone-shaped values", () => {
    const c = col("col9", ["+1 (415) 555-2671", "+44 20 7946 0958", "212-555-0143"]);
    expect(suggestPiiColumns([c])).toContain("col9");
  });

  it("does not flag on a single stray match in an otherwise numeric column", () => {
    const c = col("score", ["12", "45", "123-45-6789", "88", "91"]);
    expect(suggestPiiColumns([c])).not.toContain("score");
  });

  it("does not flag ordinary short codes / ids", () => {
    const c = col("code", ["A1", "B2", "C3"]);
    expect(suggestPiiColumns([c])).not.toContain("code");
  });
});

describe("suggestPiiColumns — contract", () => {
  it("returns names in input order and never throws on odd input", () => {
    const cols = [col("id"), col("name"), col("dob"), col("]([garbage")];
    expect(suggestPiiColumns(cols)).toEqual(["name", "dob"]);
  });

  it("returns [] for an empty schema", () => {
    expect(suggestPiiColumns([])).toEqual([]);
  });
});
