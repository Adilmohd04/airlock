# Airlock Demo Video Script

**Target read time: ~2:42.** Hard limit is 3:00 (Devpost rule). This leaves about
18 seconds of margin for a slow DuckDB cold start or a fumbled take.

> **Recording notes, read before you shoot.**
> - The bundled demo dataset is `compensation.csv`, **812 rows** (confirmed in
>   `apps/airlock/public/demo/` and `README.md`). Say 812, not 800, in the
>   voiceover, and read the real on-screen row counts in the proposal cards
>   rather than the placeholder numbers written into this script; the exact
>   filtered count depends on the expression the agent writes on the day.
> - Drive the whole session from the built-in **Agent Console**
>   (Ctrl/Cmd + `` ` ``), not a live ChatGPT connection. That's what's actually
>   been exercised in this build, and its "quick calls" walk the full
>   propose → approve → commit loop without depending on an external host being
>   configured correctly on recording day. If you do have a working WebMCP host
>   connected when you record, that's a bonus, but don't block the recording on
>   it or claim a host connection that isn't shown on screen.
> - Do not record a shot that isn't actually in the checked-out build. If a
>   beat below (redaction, citations) isn't present when you sit down to
>   record, cut that shot rather than fake it.

---

## Shot 1: Intro (0:00-0:07)

**Visual:** Airlock landing screen. Wordmark in the top bar, empty state with
the drop zone and "Load demo" button, Seal indicator reading "0 bytes sent."

**Voiceover:**
"This is Airlock. You hand an AI agent your spreadsheet, it analyzes it, and
the file never leaves this browser tab. Nothing it proposes takes effect until
you approve it."

---

## Shot 2: Load demo data (0:07-0:16)

**Visual:** Click "Load demo." Brief loading indicator while DuckDB-WASM spins
up. Grid appears: 812 rows, columns including `employee_id`, `name`,
`department`, `level`, `base_salary`, `bonus_target_pct`, `market_median`.
Left rail populates with the column list and mini-profiles.

**Voiceover:**
"I'll load a sample HR dataset. 812 employees, salary data, a market
benchmark column. It's read straight off my disk into an in-browser database.
No upload."

---

## Shot 3: Ask the agent to analyze (0:16-0:30)

**Visual:** Open the Agent Console. Type or select a prompt:

```
"Analyze this compensation data for pay-equity issues. Filter to people paid
well below market, add a comp-ratio column, and chart the gap by department."
```

Activity log (right rail) starts filling as the agent calls read tools:

- `list_columns`
- `profile_column base_salary`
- `run_sql SELECT department, avg(base_salary / market_median) ...`

**Voiceover:**
"I ask it to find pay gaps. It reads the column list, profiles the salary
column, runs a query to compute pay-to-market ratios by department. All of
that is read-only, so it runs immediately and just logs what it saw."

---

## Shot 4: Proposals arrive (0:30-0:47)

**Visual:** Three pending proposals stack in the review panel, amber left edge,
pulsing "awaiting approval" label:

1. `add_filter` — "Base salary below 80% of market" — preview shows rows kept
   vs. total (read the real number on screen).
2. `add_derived_column` — `comp_ratio = base_salary / market_median` — preview
   shows three sample rows with the computed value.
3. `add_chart` — bar chart, average `comp_ratio` by department.

**Voiceover:**
"Three proposals came back. A filter, a derived column, a chart. Each one
shows me exactly what it will do before I touch anything. This filter keeps
this many of 812 rows. This is what the new column looks like on real data."

---

## Shot 5: Approve the filter (0:47-0:55)

**Visual:** Press Enter on the top proposal. Card flashes green, slides out.
Grid row count updates live. Activity log gains two lines:
`Agent → propose_add_filter` / `Human → commit_add_filter ✓`.

**Voiceover:**
"Enter approves it. The grid updates immediately, and the activity log shows
exactly who did what, and when."

---

## Shot 6: Approve the derived column (0:55-1:03)

**Visual:** Next proposal is now on top. Enter again. New `comp_ratio` column
appears in the grid, marked with the same "derived" tag the grid uses for any
computed column, whether a person added it or the agent did.

**Voiceover:**
"Same shortcut for the derived column. Notice the grid marks it as derived,
the same marker it would use if I'd typed that formula myself. The agent and I
are editing the same workspace, not two different ones."

---

## Shot 7: Approve the chart (1:03-1:13)

**Visual:** Enter on the chart proposal. UI switches to the Charts tab
automatically. Bar chart renders: departments on the x-axis, average
comp_ratio on the y-axis, sorted low to high.

**Voiceover:**
"Approved, and the app jumps to the chart. Now I can see it: a couple of
departments are running meaningfully below market, and I've got a number for
each."

---

## Shot 8: Agent writes a cited report (1:13-1:27)

**Visual:** Console prompt: "Write a findings report on this. Cite your
numbers." Agent calls `write_report`. Review panel shows the proposal:

```
write_report — "Compensation Equity Analysis" (N words,
X cited / Y uncited claims)
```

Markdown preview visible in the card: headings, a couple of bullet points,
each concrete number followed by a small citation marker.

**Voiceover:**
"I ask for a written report with sources. Before I even approve it, the card
tells me how many claims are backed by a real query and how many aren't."

---

## Shot 9: Approve the report and check a citation (1:27-1:43)

**Visual:** Enter approves. UI switches to the Report tab, markdown renders.
Cursor clicks a citation chip next to a sentence like "Engineering is paid 8%
below market." A panel expands inline: the exact `run_sql` query, its
arguments, the row count it returned.

**Voiceover:**
"That's the report, approved. Click any cited number and you see the actual
query the agent ran and what came back. I'm not trusting the sentence, I'm
checking the receipt behind it."

---

## Shot 10: Redact a column, watch the agent get refused (1:43-2:00)

**Visual:** Left rail, ColumnList. The `name` column (employee full name) is
already flagged by the built-in heuristic: "⚠ redact (looks like PII)." Click
the "redact" control next to it. Column greys out in the grid, marked
redacted. Switch to the Agent Console, run `run_sql("SELECT name FROM
dataset")`. Result: an error, and a new red "denied" line appears in the
activity log.

**Voiceover:**
"One more thing. I can mark any column off-limits to the agent, by hand, or it
can suggest one itself if it looks like personal data. Watch what happens when
I ask it to read that column anyway."

*(pause on the refusal, ~2s)*

"Refused, and logged. Not hidden from the UI, blocked at the query. Only I can
undo that."

---

## Shot 11: Export (2:00-2:10)

**Visual:** Console prompt: "Export the filtered view." Proposal card shows
filename, row/column counts, and the list of applied transforms (filter,
derived column, redacted column excluded). Approve. Download notification.

**Voiceover:**
"Last step, export. The card tells me exactly what's in the file before it
downloads. This is the one action that actually moves data out of the tab, and
only because I said so."

---

## Shot 12: Outro (2:10-2:42)

**Visual:** Pull back to the full three-column workspace: left rail with the
column list and one redacted column, center grid with the filter and
comp_ratio column applied, right rail with an empty review queue and the full
activity log scrolled to show the session's history. Seal indicator still
reads "0 bytes sent."

**Voiceover:**
"That's Airlock. Close this tab and come back tomorrow, the whole session is
still here, filters, charts, the report, the ledger, restored from what's
saved locally in the browser. Save the sequence of changes I just approved as
a recipe, and I can replay it on next quarter's file in one click, restaged
for approval, never applied blind.

None of this works without the read/write split underneath it. Tools the
agent can call on its own are read-only and say so. Anything that changes the
workspace stops and waits for a person. That's what makes it safe to point
this at data you'd never paste into a chat window."

**[FADE]**

---

## Timing budget

| Shot | Beat | Seconds |
| --- | --- | --- |
| 1 | Intro | 7 |
| 2 | Load demo | 9 |
| 3 | Ask agent to analyze | 14 |
| 4 | Proposals arrive | 17 |
| 5 | Approve filter | 8 |
| 6 | Approve derived column | 8 |
| 7 | Approve chart | 10 |
| 8 | Agent writes cited report | 14 |
| 9 | Approve report, check a citation | 16 |
| 10 | Redact a column, watch the refusal | 17 |
| 11 | Export | 10 |
| 12 | Outro | 32 |
| **Total** | | **162s (~2:42)** |

**If you're running long:** cut from shot 12 first, it's written with slack
(trim the recipe sentence, land straight on the read/write-split line). Second
cut: shorten shot 4 to two proposals shown in detail instead of three, with
the chart proposal approved off-screen in a quick cut. Do not cut shot 9 or
shot 10; they're the two beats that answer a judge's actual skepticism ("is
the number real" and "is the privacy claim enforced or just claimed"), and
they're the shortest, highest-value seconds in the script.

**If a shot doesn't match the recorded build:** cut the shot, don't rewrite
the voiceover to describe something that isn't on screen. Shot 10 in
particular depends on `redact_column` and the PII heuristic being present and
working in whatever commit gets deployed; verify it live before recording,
not from this document.
