/**
 * Generate the bundled demo datasets — synthetic, no real people.
 * Run: node apps/airlock/scripts/gen-demo.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "demo");
mkdirSync(outDir, { recursive: true });

let seed = 20260903;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const gauss = (m, sd) => {
  const u = 1 - rand(), v = rand();
  return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clampRound = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n / 500) * 500));

const departments = [
  ["Engineering", 165000, 1.0],
  ["Product", 150000, 0.9],
  ["Design", 138000, 0.85],
  ["Data", 158000, 0.95],
  ["Sales", 120000, 0.8],
  ["Marketing", 115000, 0.78],
  ["Customer Success", 98000, 0.72],
  ["People", 108000, 0.75],
  ["Finance", 125000, 0.82],
  ["Legal", 155000, 0.9],
];
const levels = [
  ["L2", 0.72], ["L3", 0.9], ["L4", 1.0], ["L5", 1.28], ["L6", 1.62], ["L7", 2.1],
];
const locations = [
  ["San Francisco", 1.0], ["New York", 0.97], ["Austin", 0.88],
  ["Remote US", 0.9], ["London", 0.85], ["Berlin", 0.8], ["Bangalore", 0.42],
];
const genders = ["female", "male", "non-binary", "undisclosed"];
const firstNames = ["Ada","Kai","Mira","Jon","Sana","Leo","Noa","Ivan","Priya","Tom","Yuki","Ana","Sam","Wei","Omar","Lena","Raj","Ella","Nia","Ben"];
const lastNames = ["Okafor","Lindqvist","Haddad","Nguyen","Costa","Bauer","Ivanova","Park","Mensah","Rossi","Kapoor","Silva","Cohen","Zhang","Ali","Novak","Reyes","Fischer","Larsen","Yamada"];

const N = 812;
const rows = [];
for (let i = 0; i < N; i++) {
  const [dept, base, mult] = pick(departments);
  const [level, lvlMult] = pick(levels);
  const [loc, locMult] = pick(locations);
  const gender = pick(genders);
  const yearsTenure = Math.max(0, Math.round(gauss(2.6, 2.0) * 10) / 10);
  const marketMedian = clampRound(base * lvlMult * locMult, 45000, 400000);

  // introduce a mild, deliberate systemic gap for the demo narrative
  let equityPenalty = 1;
  if (gender === "female" && rand() < 0.35) equityPenalty = 0.9 + rand() * 0.06;
  if (gender === "non-binary" && rand() < 0.4) equityPenalty = 0.88 + rand() * 0.07;

  const noise = gauss(1, 0.07);
  const baseSalary = clampRound(marketMedian * equityPenalty * noise, 40000, 450000);
  const bonusTarget = Math.round((dept === "Sales" ? 0.35 : 0.12) * 100) / 100;
  const equityUnits = Math.round(lvlMult * mult * gauss(4000, 1200));
  const lastRaise = ["2025-01", "2025-04", "2025-07", "2024-10", "2024-07"][Math.floor(rand() * 5)];
  const perf = pick(["exceeds", "exceeds", "meets", "meets", "meets", "below"]);

  rows.push({
    employee_id: `E${(1000 + i).toString()}`,
    name: `${pick(firstNames)} ${pick(lastNames)}`,
    department: dept,
    level,
    location: loc,
    gender,
    years_tenure: yearsTenure,
    manager_id: `M${100 + Math.floor(rand() * 40)}`,
    base_salary: baseSalary,
    bonus_target_pct: bonusTarget,
    equity_units: Math.max(0, equityUnits),
    market_median: marketMedian,
    last_raise: lastRaise,
    performance: perf,
  });
}

const headcount = [];
const seenMgr = new Set(rows.map((r) => r.manager_id));
for (const mid of seenMgr) {
  const [dept] = pick(departments);
  headcount.push({
    manager_id: mid,
    manager_name: `${pick(firstNames)} ${pick(lastNames)}`,
    org: dept,
    span_of_control: 3 + Math.floor(rand() * 9),
    budget_band: pick(["A", "B", "C", "D"]),
    is_backfilling: rand() < 0.3 ? "yes" : "no",
  });
}

function toCsv(records) {
  const cols = Object.keys(records[0]);
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...records.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

writeFileSync(join(outDir, "compensation.csv"), toCsv(rows));
writeFileSync(join(outDir, "headcount.csv"), toCsv(headcount));
console.log(`wrote ${rows.length} compensation rows, ${headcount.length} headcount rows to ${outDir}`);
