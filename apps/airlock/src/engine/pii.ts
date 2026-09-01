/**
 * Pre-flight PII heuristic — run once, on load, over the schema + a handful of
 * sample values. It flags columns that LOOK sensitive (by name or by value
 * shape) as *suggested* for redaction.
 *
 * This is a nudge, not a policy: nothing is redacted automatically, and the set
 * is deliberately not exhaustive. A column being absent from this list means
 * "the heuristic didn't recognise it", never "this column is safe". The human
 * still owns every redaction decision (see `ColumnList`).
 *
 * Note: salary / compensation is intentionally NOT flagged — in the HR demo it
 * is the analytical subject, and the aggregate story ("avg pay by department")
 * depends on it staying readable until the human chooses otherwise.
 */

export interface PiiCandidate {
  name: string;
  type: string;
  /** A few raw sample values (already stringified). */
  samples: string[];
}

/** Single-token names that imply personal / sensitive data. */
const SENSITIVE_TOKENS = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "surname",
  "givenname",
  "maidenname",
  "email",
  "mail",
  "ssn",
  "sin",
  "nino",
  "phone",
  "mobile",
  "cell",
  "telephone",
  "tel",
  "fax",
  "dob",
  "birthdate",
  "birthday",
  "birth",
  "address",
  "street",
  "zip",
  "zipcode",
  "postal",
  "postcode",
  "account",
  "acct",
  "iban",
  "routing",
  "sortcode",
  "swift",
  "bic",
  "card",
  "creditcard",
  "ccnum",
  "cvv",
  "cvc",
  "passport",
  "license",
  "licence",
  "nationalid",
  "taxid",
]);

/** Adjacent-token phrases that imply the same. */
const SENSITIVE_PHRASES: string[][] = [
  ["social", "security"],
  ["national", "id"],
  ["tax", "id"],
  ["date", "of", "birth"],
  ["first", "name"],
  ["last", "name"],
  ["full", "name"],
  ["given", "name"],
  ["home", "address"],
  ["email", "address"],
  ["phone", "number"],
  ["account", "number"],
  ["credit", "card"],
  ["bank", "account"],
  ["driver", "license"],
  ["drivers", "license"],
];

/** Value-shape tests — a match on most sampled values is a strong signal. */
const VALUE_SHAPES: RegExp[] = [
  /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/, // email
  /^\d{3}-?\d{2}-?\d{4}$/, // US SSN
  /^\d{13,19}$/, // bare card number
  /^\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}$/, // grouped card number
];

const isPhoneish = (v: string): boolean =>
  /^\+?\d[\d\s().-]{6,}\d$/.test(v) && v.replace(/\D/g, "").length >= 8;

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function nameLooksSensitive(name: string): boolean {
  const t = tokenize(name);
  if (t.some((tok) => SENSITIVE_TOKENS.has(tok))) return true;
  if (SENSITIVE_TOKENS.has(t.join(""))) return true; // "fullname" written solid
  return SENSITIVE_PHRASES.some((phrase) => {
    for (let i = 0; i + phrase.length <= t.length; i += 1) {
      if (phrase.every((w, k) => t[i + k] === w)) return true;
    }
    return false;
  });
}

function valueLooksSensitive(samples: string[]): boolean {
  const vals = samples.map((s) => s.trim()).filter(Boolean);
  if (vals.length === 0) return false;
  const hits = vals.filter(
    (v) => isPhoneish(v) || VALUE_SHAPES.some((re) => re.test(v))
  ).length;
  // Require a clear majority so a lone stray match doesn't flag a whole column.
  return hits / vals.length >= 0.6;
}

/**
 * Return the names of columns the heuristic suggests redacting. Order follows
 * the input. Never throws.
 */
export function suggestPiiColumns(columns: PiiCandidate[]): string[] {
  const out: string[] = [];
  for (const c of columns) {
    try {
      if (nameLooksSensitive(c.name) || valueLooksSensitive(c.samples)) {
        out.push(c.name);
      }
    } catch {
      /* a pathological column is simply not suggested */
    }
  }
  return out;
}
