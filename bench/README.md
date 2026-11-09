# Benchmark

An agent (Claude Opus 5.5 through `claude -p`) builds one Figma frame as static HTML and CSS, reading the design with exactly one Figma tool. The result is then scored against Figma.

## Results

**Card grid:** a header, a title row with a dropdown and icon buttons, and a grid of cards from one component in three variants. Mean of 3 runs, min–max where the runs differ.

| | Lupa | Official Figma MCP | Framelink | figwright |
|---|---|---|---|---|
| Pixel mismatch | **0.40%** | 0.42% | 2.12% (0.41–3.86%) | 0.41% |
| Text layers within 1 px vertically | **100%** | 100% | 66% (15–100%) | 100% |
| Context added | **28k** | 63k | 30k | 82k |
| Text returned by Figma tools | **28k chars** | 80k | 29k | 110k |
| Turns | **10** | 25 | **10** | 24 |
| Wall time | **96 s** | 158 s | 106 s | 110 s |

**Table page:** navigation, tabs and a table. One run per tool.

| | Lupa¹ | Official Figma MCP | Framelink | figwright |
|---|---|---|---|---|
| Pixel mismatch | 1.08% | **1.04%** | 1.06% | 1.23% |
| Text layers within 1 px vertically | **100%** | **100%** | **100%** | 33% |
| Context added | **23k** | 62k | 26k | 70k |
| Text returned by Figma tools | **14k chars** | 44k | 25k | 91k |
| Turns | 18 | 18 | **9** | 18 |

¹ This run predates `lupa design -d … --screenshot`. That single call cut Lupa's card-grid runs from 17–18 turns to 10.

**What this shows:**
- **Quality.** On the card grid, Lupa, the official MCP and figwright produce the same result. Framelink's layout drifted in 2 of 3 runs. In the worst one each card row came out about 1.5 px too tall, so the last row was 6 px off. On the table page, figwright placed two thirds of the text at the wrong height.
- **Consistency.** All 6 card-grid runs of the current Lupa version rendered pixel-identically.
- **Size.** Lupa returns about as much text as Framelink and adds less than half the context of the official MCP or figwright.
  - The official MCP returns generated React and Tailwind, up to 93k characters in a single call.
  - figwright's node tree went over its own result limit, so it took 8–15 calls.
- **Read-only.** The agent using the official MCP tried its write tools (`create_session`, `use_figma`) in every run. Only the benchmark's allow-list stopped them. Lupa has no write operations.
- **Visual check.** Agents with `lupa compare` compared once, saw a match and stopped. With `compare` denied, Lupa scored the same.

## Method

| Config | Figma tool | Version |
|---|---|---|
| `lupa-full` | `lupa` CLI and the `figma-implement` skill. These are the Lupa results above. | 0.2.0+ |
| `lupa-read` | The same, with `lupa compare` denied | 0.2.0+ |
| `official` | Official Figma MCP (Claude plugin `figma@claude-plugins-official`), read tools only | remote |
| `framelink` | Framelink `figma-developer-mcp` (REST API, personal access token) | 0.13.2 |
| `figwright` | `@figwright/mcp` with its plugin, the 36 read-only tools in `figwright-tools.txt` | 0.7.0 |

- **Isolation.** Each run starts in an empty directory with `--permission-mode dontAsk`. An allow-list admits only read-only Figma tools, and every other Figma tool and skill is denied. User hooks are disabled with `disableAllHooks`.
- **Pixel mismatch** comes from `lupa compare` at 2×.
- **Text placement** comes from [`score-text.mjs`](score-text.mjs). It matches every visible Figma text layer to page text and compares the vertical position of its first line.
- **Context added** is peak context minus the first request's, so Claude Code's own 36–41k tokens aren't counted. Turns and time come from the transcript ([`analyze.py`](analyze.py)).
- **Caveats.**
  - There were 1–3 runs per tool.
  - The judge is Lupa's own `compare`, though it is a plain pixel diff.
  - Lupa's card-grid runs are a day newer than the other tools' runs.

## Running it

You need:
- a logged-in `claude` CLI;
- Framelink configured with its token;
- the official Figma plugin authenticated;
- `lupa` linked, with the figma-implement skill in `~/.claude/skills/`;
- Chromium for Playwright.

```sh
bench/bench.sh <name> "<figma url>" <reps> official framelink lupa-read lupa-full
bench/bench.sh <name> "<figma url>" <reps> figwright       # with the figwright plugin open instead of Lupa
bench/score.sh "<figma url>" /tmp/lupa-bench/<name>-*-*   # with the Lupa plugin open and Figma visible
```

- **Where runs go.** Runs go to `$BENCH_OUT` (default `/tmp/lupa-bench`), outside the repo, so agents can't read Lupa's code. Don't commit them: they contain the design.
- **Re-running.** Running the same command again redoes only the failed runs. At the account's usage limit, no new runs start and the script prints when to retry.
- **Order.** Lupa configs run one after another because they share the plugin. Keep Figma's window visible, or its PNG exports stall.
- **Options.** `MODEL` (default `claude-opus-5-5`) and `BUDGET` (USD per run, default 10) pass through. `bench/run.sh <config> <dir> "<url>"` runs a single config.
- **Scoring output.** `score.sh` writes `compare.txt`, `compare.png` and `score-text.json` into each run and prints the table. To print it again, run `python3 bench/analyze.py --table <runs…>`. Without `--table`, `analyze.py` prints JSON per run.
- **Tool lists.** `node bench/listtools.mjs <command> <args…>` lists an MCP server's tools with their read-only annotations.
