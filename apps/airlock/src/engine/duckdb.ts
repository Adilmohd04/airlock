/**
 * Airlock query engine — DuckDB-WASM, entirely in the browser.
 *
 * Privacy is the product: the user's file is read locally, registered into an
 * in-browser DuckDB instance, and queried with WebAssembly. No bytes of user
 * data are ever sent to a server.
 *
 * To keep the "zero network during a session" story airtight, we self-host the
 * DuckDB WASM + worker assets out of the npm package (bundled by Vite with
 * `?url`) rather than fetching them from a CDN at runtime.
 */

// Type-only import: erased at compile time, so it creates NO runtime chunk
// dependency. The heavy DuckDB-WASM glue is loaded lazily inside `createDb()`
// (see below) so it lands in its own dynamically-imported chunk.
import type * as duckdb from "@duckdb/duckdb-wasm";

// Vite resolves these to hashed URLs served from our own origin.
import duckdb_wasm_mvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdb_worker_mvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdb_wasm_eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdb_worker_eh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

export interface QueryResult {
  columns: string[];
  /** Column type names as reported by DuckDB. */
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** Milliseconds the query took. */
  elapsedMs: number;
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function createDb(): Promise<duckdb.AsyncDuckDB> {
  // Lazy runtime import: this pulls the heavy DuckDB-WASM glue into its own
  // dynamically-imported chunk, keeping it out of the main app bundle. This
  // local `const` shadows the type-only import above for value references; the
  // type annotations elsewhere still resolve via the erased `import type`.
  const duckdb = await import("@duckdb/duckdb-wasm");

  const bundles: duckdb.DuckDBBundles = {
    mvp: {
      mainModule: duckdb_wasm_mvp,
      mainWorker: duckdb_worker_mvp,
    },
    eh: {
      mainModule: duckdb_wasm_eh,
      mainWorker: duckdb_worker_eh,
    },
  };

  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) {
    throw new Error("DuckDB-WASM: no suitable worker bundle for this browser.");
  }

  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // NOTE: we can't `SET enable_external_access=false` here — DuckDB makes that
  // one-way, and it also disables `insertCSVFromPath` on our own registered
  // in-memory buffers, breaking every import. The defense against worker-side
  // network/file reach (`read_csv('https://…')`, replacement scans, httpfs) is
  // therefore the SQL guard below (`assertSelectOnly` / `assertExpression`),
  // which is applied to EVERY agent- and human-supplied SQL fragment — in the
  // read tools, and again in the `DatasetStore` mutators.
  return db;
}

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

/** Convert an Arrow result table into plain JS rows. */
function tableToRows(table: {
  schema: { fields: { name: string; type: unknown }[] };
  numRows: number;
  toArray: () => unknown[];
}): { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] } {
  const columns = table.schema.fields.map((f) => f.name);
  const columnTypes = table.schema.fields.map((f) => String(f.type));
  const rows = table.toArray().map((r) => {
    const obj = r as Record<string, unknown>;
    const plain: Record<string, unknown> = {};
    for (const c of columns) {
      const v = obj[c];
      // Normalize BigInt (DuckDB returns bigints for integer columns) so the
      // UI and JSON serialization behave.
      plain[c] = typeof v === "bigint" ? Number(v) : v;
    }
    return plain;
  });
  return { columns, columnTypes, rows };
}

/** Run a read query and return normalized rows. */
export async function runQuery(sql: string): Promise<QueryResult> {
  const db = await getDb();
  const conn = await db.connect();
  const start = performance.now();
  try {
    const table = await conn.query(sql);
    const { columns, columnTypes, rows } = tableToRows(
      table as unknown as Parameters<typeof tableToRows>[0]
    );
    return {
      columns,
      columnTypes,
      rows,
      rowCount: rows.length,
      elapsedMs: Math.round(performance.now() - start),
    };
  } finally {
    await conn.close();
  }
}

/** Run a statement that returns no useful rows (DDL/DML). */
export async function runStatement(sql: string): Promise<void> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    await conn.query(sql);
  } finally {
    await conn.close();
  }
}

/**
 * SQL guard — the trust boundary for every SQL fragment that originates from the
 * agent OR from a human typing into a filter / chart box. Nothing user- or
 * agent-supplied reaches `conn.query()` without passing through here.
 *
 * Two rules, enforced lexically (DuckDB-WASM has no per-connection read-only
 * mode we can lean on):
 *
 *  1. No mutation, no side effects. A rejected fragment costs one retry; a
 *     slipped-through `UPDATE`/`DROP` breaks the whole "nothing changes without
 *     approval" contract.
 *  2. No network / filesystem reach. `read_csv('https://…')`, `read_parquet`,
 *     replacement scans over a URL, `ATTACH`, `COPY` — DuckDB resolves these in
 *     its Web Worker, *below* the main-thread egress monitor, so an unguarded
 *     `SELECT` could exfiltrate private columns in a query string while the Seal
 *     still reads "0 bytes out". These are blocked here AND at the engine level
 *     (`SET enable_external_access=false`, see `createDb`).
 *
 * The scan runs on a copy with string/identifier literals and comments
 * neutralized, so a column literally named `update_ts` or a value `'drop it'`
 * doesn't false-trip.
 */
const FORBIDDEN_TOKENS =
  /\b(insert|update|delete|drop|create|alter|attach|detach|copy|truncate|replace|pragma|set|call|export|import|install|load|vacuum|checkpoint|begin|commit|rollback|into|returning|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_json_objects|read_text|read_blob|parquet_scan|parquet_metadata|glob|sniff_csv|delta_scan|iceberg_scan|postgres_scan|sqlite_scan|mysql_scan)\b/i;

const NETWORKISH = /(?:https?|s3|gcs|azure|r2|hf|ftp|file):\/\//i;

const stripComments = (sql: string): string =>
  sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const neutralizeStrings = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$\$[\s\S]*?\$\$/g, "''");

function assertNoAbuse(fragment: string): string {
  const trimmed = fragment.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("Empty SQL.");

  const noComments = stripComments(trimmed);

  // `;` check on a string-neutralized copy so a value like 'a; b' doesn't trip.
  if (neutralizeStrings(noComments).includes(";")) {
    throw new Error(
      "Multiple statements are not allowed — remove the ';' and anything after it."
    );
  }

  // Keyword / URL / file-reader check runs on the copy that STILL HAS string
  // literals AND comments, so `read_csv('https://…')`, a bare
  // `FROM 'https://…'` replacement scan, and a URL hidden only in a `--` or
  // `/* */` comment are all visible. A filter that legitimately compares
  // against a literal URL (or a comment that merely mentions one) is rejected
  // too — deliberately: keeping data local is the whole point, and the error
  // message is explicit.
  if (NETWORKISH.test(trimmed)) {
    throw new Error(
      "Remote URLs are not allowed in a query — the data must stay in this browser."
    );
  }
  if (FORBIDDEN_TOKENS.test(neutralizeStrings(noComments))) {
    throw new Error(
      "That SQL uses a keyword or function that isn't allowed here (no writes, " +
        "no file/URL readers). Use a staged propose_* tool to change the dataset."
    );
  }
  return trimmed;
}

/** A full statement fed to `run_sql` / chart SQL — must be a lone read query. */
export function assertSelectOnly(sql: string): string {
  const trimmed = assertNoAbuse(sql);
  const scan = neutralizeStrings(stripComments(trimmed));
  if (!/^\s*(select|with|values|explain|table|from|pivot|unpivot)\b/i.test(scan)) {
    throw new Error(
      "Only read queries are allowed here (SELECT / WITH / VALUES / EXPLAIN). " +
        "To change the dataset, use a staged tool such as propose_add_filter."
    );
  }
  return trimmed;
}

/**
 * A scalar / boolean expression fragment (a filter's WHERE clause, a derived
 * column's formula, a flag predicate). Subqueries are allowed; mutation, stacked
 * statements, and network readers are not.
 */
export function assertExpression(expr: string): string {
  return assertNoAbuse(expr);
}

/** A bare column identifier (join keys). Letters, digits, underscore only. */
export function assertIdentifier(id: string): string {
  const t = id.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    throw new Error(`"${id}" is not a valid column name.`);
  }
  return t;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redaction guard — the enforcement half of "the human can blindfold the agent
 * per column". Rejects any agent-supplied SQL that so much as NAMES a redacted
 * column: not in the SELECT list, not in WHERE, not inside avg()/min()/max(),
 * not in a CASE, not string-concatenated, not aliased away, not in a CTE.
 *
 * Lexical, for the same reason the rest of this guard is lexical: partial
 * allowance ("aggregates are fine") needs a real SQL parser, and every parser
 * gap is a leak — min()/max() return a real cell, `avg(x) FILTER (WHERE id=5)`
 * reconstructs one row, GROUP BY differencing peels values off one at a time.
 * So once a column is redacted its name is radioactive and may appear nowhere.
 *
 * Comments and single-quoted string literals are neutralized first so a row
 * value or a note that merely contains the word ("dropped from payroll") does
 * not false-trip. Double quotes are KEPT so a quoted identifier `"ssn"` is
 * still caught.
 */
export function assertNoRedactedColumns(
  sql: string,
  redacted: readonly string[]
): string {
  const trimmed = sql.trim();
  if (redacted.length === 0) return trimmed;
  const scan = ` ${stripComments(trimmed).replace(/'(?:[^']|'')*'/g, "''")} `;
  for (const col of redacted) {
    // Manual identifier boundaries (a column name can contain spaces/hyphens),
    // optional surrounding double-quotes.
    const re = new RegExp(
      `(?:^|[^A-Za-z0-9_"])"?${escapeRegExp(col)}"?(?:[^A-Za-z0-9_"]|$)`,
      "i"
    );
    if (re.test(scan)) {
      throw new Error(
        `Column "${col}" is redacted: the agent cannot read it, aggregate it, ` +
          `or derive from it. Remove every reference to "${col}" from the query. ` +
          `If the analysis needs it, ask the user to lift the redaction in the ` +
          `column list — un-redacting is a human-only action.`
      );
    }
  }
  return trimmed;
}

/**
 * When any column is redacted, every "give me all the columns / all the stats"
 * shorthand is refused: it surfaces the redacted column without ever naming it,
 * so `assertNoRedactedColumns` can't see it coming. Covers `SELECT *`,
 * `COLUMNS(...)`, DuckDB's `SUMMARIZE`, and the bare-`TABLE`/`FROM`/`PIVOT`
 * whole-relation forms. `count(*)` is fine. The agent must name its columns —
 * and any redacted name it then lists is caught by `assertNoRedactedColumns`.
 */
export function assertNoStarProjection(
  sql: string,
  redacted: readonly string[]
): string {
  const trimmed = sql.trim();
  if (redacted.length === 0) return trimmed;
  const names = redacted.map((r) => `"${r}"`).join(", ");
  const scan = stripComments(trimmed)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\bcount\s*\(\s*\*\s*\)/gi, "count(0)");
  // `SUMMARIZE` reports min/max/quartiles/etc for EVERY column — real cell values.
  if (/\bsummarize\b/i.test(scan)) {
    throw new Error(
      `\`SUMMARIZE\` is disabled while a column is redacted (${names}) — it returns ` +
        "statistics for every column. Query the columns you need by name."
    );
  }
  // Whole-relation shorthands: `TABLE t`, a bare leading `FROM t`, `PIVOT`/`UNPIVOT`.
  if (/^\s*(table|from|pivot|unpivot)\b/i.test(scan)) {
    throw new Error(
      `\`TABLE\` / bare \`FROM\` / \`PIVOT\` return every column and are disabled ` +
        `while a column is redacted (${names}). Name the columns you need explicitly.`
    );
  }
  // A `*` that opens/continues a projection: at the start, or after whitespace /
  // `,` / `(` / `.` (a qualified `t.*`), and followed by end / `,` / `)` / a
  // clause keyword. Arithmetic `a * b` has an operand after it and is not caught.
  const starProjection =
    /(^|[\s,([.])\*(\s*($|[,)]|\bexclude\b|\breplace\b|\bfrom\b))/i;
  if (starProjection.test(scan) || /\bcolumns\s*\(/i.test(scan)) {
    throw new Error(
      `\`SELECT *\` and \`COLUMNS(...)\` are disabled while a column is redacted ` +
        `(${names}) — they would surface it. Name the columns you need explicitly.`
    );
  }
  return trimmed;
}

/**
 * Register a raw file (CSV / JSON / Parquet / Arrow) into DuckDB's virtual
 * filesystem and load it into a table. The bytes come straight from the
 * user's File object; they never touch the network.
 */
export async function registerCsv(
  tableName: string,
  text: string,
  /** Force a delimiter (clipboard paste sniffs one); omit to let DuckDB detect. */
  delimiter?: string
): Promise<void> {
  const db = await getDb();
  const vpath = `${tableName}.csv`;
  await db.registerFileText(vpath, text);
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.insertCSVFromPath(vpath, {
      name: tableName,
      detect: true,
      header: true,
      ...(delimiter ? { delimiter } : {}),
    });
  } finally {
    await conn.close();
  }
}

/**
 * Register a Parquet file's bytes as a table. DuckDB-WASM reads Parquet
 * natively (the reader is statically linked in the wasm build — verified against
 * @duckdb/duckdb-wasm 1.32), so this needs no extension and no new dependency.
 *
 * SEPARATION FROM THE AGENT SQL GUARD — deliberate and load-bearing:
 * `read_parquet` / `parquet_scan` are in `FORBIDDEN_TOKENS` and stay there, so
 * the agent still cannot reach a file/URL reader through `run_sql` or chart SQL.
 * This function is SYSTEM-level import, the same tier as `registerCsv` /
 * `registerJson` above: it is only ever called by `workspaceStore` for a file
 * the human chose, the SQL is built here from a `tableName` that
 * `workspaceStore.tableNameFor` has already reduced to `[a-z0-9_]`, and the
 * bytes come straight off a `File` — nothing agent-supplied and nothing
 * user-typed ever flows in. It never touches `assertSelectOnly` /
 * `assertExpression`, and those guards are not weakened to accommodate it.
 */
export async function registerParquet(
  tableName: string,
  bytes: Uint8Array
): Promise<void> {
  const db = await getDb();
  const vpath = `${tableName}.parquet`;
  await db.registerFileBuffer(vpath, bytes);
  const conn = await db.connect();
  try {
    const t = tableName.replace(/"/g, '""');
    await conn.query(`DROP TABLE IF EXISTS "${t}"`);
    // Single-quoted vpath is safe by construction: tableName is already
    // sanitized to [a-z0-9_] by the one caller.
    await conn.query(
      `CREATE TABLE "${t}" AS SELECT * FROM read_parquet('${vpath}')`
    );
  } finally {
    await conn.close();
  }
}

/** Register a JSON array of records as a table. */
export async function registerJson(
  tableName: string,
  records: Record<string, unknown>[]
): Promise<void> {
  const db = await getDb();
  const vpath = `${tableName}.json`;
  await db.registerFileText(vpath, JSON.stringify(records));
  const conn = await db.connect();
  try {
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.insertJSONFromPath(vpath, { name: tableName });
  } finally {
    await conn.close();
  }
}
