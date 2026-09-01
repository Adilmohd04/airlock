# Screenshot capture guide

Neither the automated tooling nor a headless browser can produce these — they
need a real browser window. Follow this once and drop the PNGs beside this file.

## Conventions

- **Window:** 1440 × 900, Chrome.
- **Theme:** system dark (the app is dark-only).
- **Data:** load the `compensation.csv` demo first for every shot. The grid shows
  **812 rows · 14 cols** once loaded.
- **File names:** save exactly as `01-empty-state.png` … `09-join.png` in this
  directory. The root `README.md` gallery references `01`–`06`.
- **Dev server:** `npm run dev` → http://localhost:5173.
- **Zero egress:** capture only against the local dev/preview server (`npm run dev`
  / http://localhost:5173) with the Seal reading **Sealed · 0 bytes out** — no
  external or cross-origin requests may be triggered during capture (0 request-body
  bytes, 0 external requests; only same-origin local asset loads are permitted).

### Top bar reference (left → right)

lock glyph + "Airlock" + tagline · green **Sealed · 0 bytes out** pill ·
**WebMCP polyfill · 8 read · 12 staged** pill · (right) `compensation.csv · 812 rows · 14 cols` ·
**Agent console** button.

---

## 01 — `01-empty-state.png`

1. Load http://localhost:5173 on a fresh tab. Do nothing else.

**In frame (full window):** the headline "The agent analyzes your data. / The data
stays in your browser.", the three bullets, the "Query engine ready" line, the
dashed "Drop a CSV or JSON file" zone, and "OR LOAD A DEMO" with the two demo
buttons.

---

## 02 — `02-grid.png`

1. From 01, click **compensation.csv — Compensation review**.
2. Wait ~6s for load + column profiling (numeric sparklines fill in).

**In frame (full window):** the full three-column layout.
- TopBar: green **Sealed · 0 bytes out** + **8 read · 12 staged**.
- LeftRail: "DATASETS / compensation.csv", "COLUMNS · 14" with mini-profiles.
- Center: Grid tab active, the FilterBar row, the table with its sticky header,
  and "Showing 500 of 812 matching rows" at the bottom.
- RightRail: empty "Review queue" and "Activity ledger".

---

## 03 — `03-review-queue.png`

1. With the grid loaded, open the Agent console (**Agent console** button or
   <kbd>Ctrl/Cmd</kbd> + <kbd>`</kbd>).
2. Tool dropdown → `propose_add_filter`. Args:
   ```json
   {"expression": "performance = 'below'", "label": "below-target performance"}
   ```
3. Click **Execute**. Close the console (<kbd>Ctrl/Cmd</kbd> + <kbd>`</kbd>).
   **Do not approve.**

**In frame:** RightRail "Review queue" with a **1** badge and one ProposalCard —
amber left edge + glow, "✦ add_filter" chip, "awaiting you", the summary line, the
typed row-delta diff (`812 → N`, red −delta badge), and **Approve ⏎** / **Reject ⌫**.
Keep some of the grid visible on the left so it reads as one surface (or full window).

---

## 04 — `04-activity-ledger.png`

1. From 03, approve one or two proposals so the ledger has commit entries.
2. In the RightRail, expand **Activity ledger** if collapsed (click its header).

**In frame:** the "The agent has received N rows across M distinct columns. Your
raw file never left this tab." banner with its **export** link, then the entry list
— colored dots (teal read, amber proposed, green applied, red rejected/denied),
mono tool names (`run_sql`, `propose_add_filter`, `commit_add_filter`, …), a ✦ on
agent entries, relative timestamps. Frame the RightRail lower half, or full window.

---

## 05 — `05-seal-popover.png`

1. Any loaded state. Click the green **Sealed · 0 bytes out** pill in the TopBar.

**In frame:** the popover — "Nothing has left this page", the explainer paragraph,
the mono stat rows (Request-body bytes sent: 0 B / External requests: 0 /
Same-origin asset loads: N / Hosts contacted: —), and the footer note that read
tools still return data to the agent. Frame the top-left quarter of the window
(popover + the pill it hangs from).

---

## 06 — `06-agent-console.png`

**Primary — the real WebMCP Inspector** (stronger evidence for judges):

1. In a Chrome with `chrome://flags/#enable-webmcp-testing` enabled and the
   **WebMCP Inspector** extension installed: load :5173, load `compensation.csv`,
   open the Inspector devtools panel.
2. Run `get_dataset_summary`, then `propose_add_derived_column`:
   ```json
   {"name": "comp_ratio", "expression": "round(base_salary::double / market_median, 2)"}
   ```

**In frame:** the Inspector listing Airlock's registered tools (the read/write
split), one tool's schema expanded, a call result — and the Airlock UI beside it
showing the resulting proposal card. Full window.

**Fallback — the built-in Agent console** (if the flag isn't set up):

1. Open the Agent console (<kbd>Ctrl/Cmd</kbd> + <kbd>`</kbd>).
2. Click the **SQL: avg pay by department** quick-call so the result pane is populated.

**In frame:** left "Quick calls" list, middle tool dropdown + JSON args + Execute,
right JSON result pane. The console drawer plus enough of the app above it.

---

## 07 — `07-charts.png`

1. Agent console → run the **Propose: pay-gap chart** quick-call → approve the card.
2. Click the **Charts** tab.

**In frame (full window):** Charts tab active, the "Avg base salary by department"
card — ✦ prefix, the mono SQL subtitle, the teal bar chart, the "+ Add chart" button.

---

## 08 — `08-report.png`

1. Agent console → run the **Propose: insight report** quick-call → approve. The
   Report tab auto-selects.

**In frame (full window):** Report tab, left sidebar with the report title + ✦ +
timestamp, right pane rendering the markdown, the **Export .md** / **Delete**
buttons in the header.

---

## 09 — `09-join.png`

1. With `compensation.csv` loaded, LeftRail → **+ Add dataset** → drop / load
   `headcount.csv`. Set `compensation.csv` active in the DATASETS list.
2. Agent console → `propose_join_datasets`:
   ```json
   {"right": "headcount.csv", "on": [{"left": "manager_id", "right": "manager_id"}], "type": "left"}
   ```
   **Do not approve yet** — capture the diff first.

**In frame (diff):** the `join_datasets` ProposalCard — the
"compensation.csv ⋈ headcount.csv" line, "on manager_id = manager_id", and the
stat row "result rows 812 / columns 20". Optionally a second shot after approving,
showing the new joined entry with a "join" chip in the DATASETS switcher.

---

## After capturing

Tell the other session (or re-run the build) — the PNGs get wired into the
`README.md` gallery table and `npm run build` re-checked.
