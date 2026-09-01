# Screenshots

Drop PNGs here with the file names below. The root `README.md` references
`01`, `02`, `03`, `04`, `05`, `06`. Capture at a 1440-wide window, dark theme
(the app is dark-only), and load the `compensation.csv` demo dataset first so
every shot shows real data.

| File | Shot | Caption |
| --- | --- | --- |
| `01-empty-state.png` | The landing screen: the "The data stays in your browser" headline, the CSV/JSON drop zone, and the two demo-dataset buttons. | Load a spreadsheet you would never paste into a chat window. |
| `02-grid.png` | A loaded dataset — TopBar with the green **Sealed · 0 bytes out** indicator and the `8 read · 11 staged` WebMCP status, LeftRail column list, DataGrid, FilterBar. | The agent and the human share one workspace. |
| `03-review-queue.png` | RightRail **Review queue** with one or more pending `ProposalCard`s showing a typed diff (e.g. a filter's rows-kept-vs-total, or a derived-column preview) in amber. | Every change the agent proposes is staged as a diff you approve or reject. |
| `04-activity-ledger.png` | The **Activity** panel (RightRail, lower) listing read / propose / commit / reject entries, with the "rows disclosed / distinct columns seen" totals visible. | The honest answer to "what did the agent actually see?" |
| `05-seal-popover.png` | The Seal indicator popover open, showing request-body bytes sent, external requests, same-origin asset loads, hosts contacted, and the note that read tools still return data to the agent. | "Data never leaves the browser" — made measurable. |
| `06-agent-console.png` | The Agent console open (Ctrl/Cmd + `` ` ``) with the quick-call list, a tool selected, a JSON argument object, and a result. | Drive the full propose to approve to commit loop without ChatGPT. |

## Optional extras

| File | Shot |
| --- | --- |
| `07-charts.png` | The Charts tab with an agent-added bar chart (e.g. "Avg base salary by department"). |
| `08-report.png` | The Report tab rendering an agent-written markdown insight report. |
| `09-join.png` | A `propose_join_datasets` diff after also loading `headcount.csv`, showing the resulting row count and column list. |
| `10-webmcp-connected.png` | The top bar showing **WebMCP connected** when a native host is driving the page. |
