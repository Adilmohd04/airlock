# Airlock Demo Video Script

**Total read time: ~2:40**

> **Recording notes.** The demo dataset (`compensation.csv`) is **812 rows**. Row
> counts inside the proposal-card mockups below (e.g. "keeps 127 of 800") are
> illustrative — read the real on-screen numbers when you record and match the
> voiceover to them. The exact filtered count depends on the filter expression the
> agent proposes on the day.

---

## Shot 1: Intro (0:00–0:08)

**Visual:** Airlock landing page. Wordmark in top bar. Empty grid. "Load demo" button visible. Seal indicator shows "0 bytes sent."

**Voiceover:**
"Airlock is an agent-native data workspace where you can ask an AI to analyze your sensitive data—without it ever leaving your browser. Every change the agent proposes, you approve. Let me show you how."

---

## Shot 2: Load Demo Data (0:08–0:18)

**Visual:** Click "Load demo." Progress bar fills. After ~2 seconds, grid appears with HR compensation data (800 rows). Columns visible: `employee_id`, `department`, `base_salary`, `bonus`, `market_median`, `region`.

Simultaneously, left rail populates: column list with mini-profiles (type icons, null %, sparklines for numerics).

**Voiceover:**
"I'll load a sample HR dataset: 800 employees across five departments. Each row has salary, bonus, and market benchmark data. The data stays right here in this tab—no server, no uploads."

---

## Shot 3: Chat with Agent (0:18–0:35)

**Visual:** Chrome's native WebMCP chat interface (or Agent Console in-app). Prompt box shows:

```
"Analyze this compensation data. Look for equity issues — people paid significantly below market. Flag them and show me the pattern by department."
```

User submits. Agent starts running tools.

**On-screen activity log shows:**
- `→ list_columns` (reading)
- `→ profile_column base_salary` (reading)
- `→ run_sql SELECT department, COUNT(*), AVG(base_salary / market_median) ... ` (reading)

**Voiceover:**
"I ask the agent to find compensation gaps. It reads the column names, profiles the salary data, and runs a query to calculate the ratio of actual pay to market median—all in-browser, instantly."

---

## Shot 4: Proposals Arrive (0:35–0:55)

**Visual:** Review panel (right rail) now shows three pending proposals (amber `pending` left edge, with glow):

**Proposal 1:**
```
Tool: add_filter
Summary: "Base salary below 80% of market" — keeps 127 of 800 rows
Preview:
  WHERE base_salary < market_median * 0.8
  Rows: 800 → 127
```

**Proposal 2:**
```
Tool: add_derived_column
Summary: "New column comp_ratio = base_salary / market_median"
Preview:
  Name: comp_ratio
  Expression: base_salary / market_median
  Samples:
    Row 1: [Employee_A, IT] → 0.78
    Row 2: [Employee_B, Sales] → 0.82
    Row 3: [Employee_C, HR] → 0.75
```

**Proposal 3:**
```
Tool: add_chart
Summary: "bar chart: Underpaid by Department (23 data points)"
Preview:
  Chart renders live, showing avg comp_ratio per department
  Departments sorted by ratio, lowest first
```

**Voiceover:**
"Three proposals just arrived. First: filter to only underpaid employees. Second: add a computed column showing the comp ratio. Third: a bar chart to visualize the gap by department. Each one shows a preview—I can see the impact before I approve."

---

## Shot 5: Approve Filter (0:55–1:05)

**Visual:** Reviewer hovers over Proposal 1. Keyboard shortcut visible: "(Press ⏎ to approve, ⌫ to reject)." Click Approve (or press ⏎).

**Effect:** Proposal card flashes green (`commit` color) and slides out. Grid updates in real-time: row count drops from 800 to 127. Header shows "Filtered: 127 / 800 rows." The pending-edge amber glow disappears.

Activity log (bottom of right rail) now shows:
```
Agent → propose_add_filter [base_salary < market_median * 0.8]
Human → commit_add_filter ✓
```

**Voiceover:**
"I approve the filter with one key press. The grid instantly updates. Now I'm only seeing the 127 underpaid employees. Notice the activity log below—it shows every action, who did it, and when."

---

## Shot 6: Approve Derived Column (1:05–1:15)

**Visual:** Second proposal (add_derived_column) is now at the top. Reviewer presses ⏎.

**Effect:** Card flashes green, slides out. Grid re-renders. A new column `comp_ratio` appears on the right, tinted teal (`airlock` token color) to highlight it's agent-created. Values show 0.75, 0.82, 0.78, etc.

**Voiceover:**
"The derived column is approved. You can see it's tinted in teal—that's how the UI tells you what the agent added. This new column lets me easily sort by comp gap."

---

## Shot 7: Approve Chart (1:15–1:28)

**Visual:** Third proposal (add_chart) is now at the top. Reviewer presses ⏎.

**Effect:** Card flashes green, slides out. UI auto-switches to the *Charts* tab (center panel). A bar chart renders: X-axis = departments (IT, Finance, Sales, Marketing, HR), Y-axis = average comp_ratio, sorted ascending. IT bars lowest (~0.78), Finance highest (~0.91).

**Voiceover:**
"The chart is approved. The app automatically switches to show it. Now we can see the story: IT and Sales are underpaid relative to market, while Finance and HR are closer to fair market value. This is the kind of insight an AI can surface fast."

---

## Shot 8: Agent Writes Report (1:28–1:45)

**Visual:** Chat shows agent prompt:

```
"Based on your approval, write a findings report summarizing the equity gaps."
```

Agent calls `write_report` tool. Review panel shows one more proposal:

```
Tool: write_report
Summary: "Insight report: Compensation Equity Analysis (287 words)"
Preview:
  [Markdown renders here]
  ## Compensation Equity Analysis
  
  ### Key Findings
  - IT department: average 78% of market value
  - Sales department: average 81% of market value
  - Finance department: average 91% (closest to market)
  
  ### Recommendation
  IT and Sales require targeted salary adjustments...
```

**Voiceover:**
"The agent drafts a findings report—markdown with headings, bullet points, concrete numbers pulled from the data. I can review it before approving."

---

## Shot 9: Approve Report (1:45–1:53)

**Visual:** Reviewer presses ⏎ to approve. Proposal card flashes green. UI switches to *Report* tab. Markdown renders beautifully: headings, bold, bullet points, clean typography.

**Voiceover:**
"Approved. The report now lives in the workspace. I can export it, share it with stakeholders, or keep it for my records. Everything happened right here—no data left my machine."

---

## ⭐ Shot 9b: Click a claim (OPTIONAL — +12s) — RECOMMENDED

> **Why record this.** It is the strongest 12 seconds available. Every judge has
> the same private worry about agent-written analysis: *is this number real, or
> did it make it up?* This beat answers that on camera. If you cut anything to
> fit, cut from Shot 11's outro, not from here.
>
> **Requires** `feat/citations` merged. Skip this shot if it isn't in the build
> you record — do not fake it.

**Visual:** The rendered report is on screen. A sentence reads *"Engineering is paid 8% below market"* with a small teal footnote chip after it. Cursor clicks the chip. A panel expands inline showing the exact ledger entry: the `run_sql` query, its arguments, the row count returned, the timestamp.

Optionally pan up to the approval card still visible in the ledger, showing the `4 cited · 1 uncited` badge from before approval.

**Voiceover:**
"Every claim in this report is a link. Click it and you see the exact query the agent ran to produce that number, and what came back. And before I approved it, the card told me how many claims were backed by evidence and how many weren't. I'm not trusting the prose—I'm checking the receipts."

---

## Shot 10: Export (1:53–2:05)

**Visual:** Review panel shows one final proposal:

```
Tool: export_view
Summary: "Export 127 rows × 18 columns to CSV"
Preview:
  Filename: compensation-airlock.csv
  Applied transforms:
    - filter: base_salary < market_median * 0.8
    - +column: comp_ratio
  ⚠️ This action downloads data to your Downloads folder.
```

Reviewer approves. A download notification appears. File saves as `compensation-airlock.csv`.

**Voiceover:**
"Finally, I export the filtered, enriched dataset—all 127 underpaid employees with the new comp_ratio column baked in. The proposal reminds me what transforms are applied. The data now leaves the browser only because I explicitly approved it."

---

## Shot 11: Outro (2:05–2:40)

**Visual:** Pan out to show the full three-column workspace:
- Left: column list, filters active
- Center: grid showing filtered rows + `comp_ratio` column
- Right: review panel (empty now, all proposals approved) + activity log showing the full history

Top bar: Seal indicator still "0 bytes sent" (post-load).

**Voiceover:**
"That's Airlock. You get AI-powered analysis without uploading sensitive data. Every change is staged for your approval. The activity log is a complete audit trail. The honest WebMCP split—read-only hints on the tools the agent uses, staged approval for mutations—is what makes this trustworthy.

Use it for HR comp audits, financial data review, medical cohort analysis—any scenario where you want AI help but data has to stay local. Airlock is the airlock between your data and the outside world."

**[FADE]**

---

## Timing Notes

- Intro: 8s
- Load demo: 10s (include actual load time)
- Chat with agent: 17s (fast-forward through tool execution if needed)
- Proposals arrive: 20s (show full card transitions)
- Approve filter: 10s
- Approve derived column: 10s
- Approve chart: 13s
- Agent writes report: 17s
- Approve report: 8s
- ⭐ Click a claim (9b, optional): 12s
- Export: 12s
- Outro: 35s

**Total without 9b: 160s (~2:40). With 9b: 172s (~2:52).**

2:52 is inside the 3-minute limit but leaves no margin for a slow DuckDB load or
a fumbled take. Recommended cut to buy room: **trim the outro from 35s to 23s**
(→ ~2:40 with 9b included). The outro is the most compressible thing in the
script; shot 9b is the least. If you must choose one, keep 9b.

Other trims if still tight: intro 8s → 5s; show 2 proposals instead of 3 (−10s).

**Closing line to use if the later features are in the recorded build** — say it
over the outro, don't add a shot:
> "Sessions persist, so this workspace is still here tomorrow. The whole
> transform sequence exports as a recipe you can replay on next quarter's file.
> And any column you mark sensitive, the agent simply cannot read."
