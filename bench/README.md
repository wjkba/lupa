# Benchmark: Loupe vs other Figma tools

These scripts have an agent (`claude -p`) implement one Figma frame with exactly one Figma tool, then score each result against the design. The results so far are summarized in [`results/README.md`](results/README.md).

## Configs

| Config | Figma tool the agent can use |
|---|---|
| `official` | Official Figma MCP (Claude plugin `figma@claude-plugins-official`), read tools only |
| `framelink` | Framelink MCP (`get_figma_data`, `download_figma_images`) |
| `figwright` | figwright MCP, the 36 read-only tools listed in `figwright-tools.txt`, through `figwright.json` |
| `loupe-read` | `loupe` CLI and the `figma-implement` skill, with `loupe compare` denied |
| `loupe-full` | `loupe` CLI and the skill, including `compare` |

Each run is isolated:
- `--permission-mode dontAsk` with an allow-list, so the agent only gets read-only Figma tools.
- Every other Figma tool and skill is denied.
- The official plugin is disabled outside the `official` config.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false`, otherwise Claude Code hides the plugin's server as a duplicate of the claude.ai Figma connector.
- `disableAllHooks`, so the user's own hooks stay out of the run. A hook that rewrites commands, such as `rtk` turning `curl` into `rtk curl`, makes them miss the allow-list.

## Running

1. **Prerequisites:**
   - The `claude` CLI is logged in.
   - Framelink is set up in your Claude config (with its token).
   - The official Figma plugin is installed and authenticated.
   - `loupe` is linked (`npm link` in the repo).
   - The figma-implement skill is copied to `~/.claude/skills/`.
   - Chromium is available for Playwright, which `compare` already needs.
2. **Run configs × reps on one screen:**
   ```sh
   bench/bench.sh <screen> "<figma url>" <reps> official framelink loupe-read loupe-full
   bench/bench.sh <screen> "<figma url>" <reps> figwright      # after switching the plugin to figwright
   ```
   - Runs go to `$BENCH_OUT` (default `/tmp/loupe-bench`) as `<screen>-<config>-<rep>`, outside the repo so the agent can't read Loupe's code.
   - Keep that path short and plain. Agents misread paths under Claude Code's scratchpad, which contain another path with `/` replaced by `-`.
   - Successful runs are skipped, so running the same command again redoes only failed ones.
   - When a run hits the account's usage limit, no new runs start. The script prints when the limit resets; run the same command after that.
   - Non-Loupe configs run in parallel; Loupe configs run one after another because they share the plugin.
   - Figma runs one plugin at a time per file, so `figwright` can't share an invocation with `loupe-*`. The official server and Framelink don't use a plugin.
   - Keep Figma's window visible while Loupe configs run, or its raster exports stall.
   - `MODEL` (default `claude-opus-5-5`) and `BUDGET` (USD per run, default 10) pass through. `bench/run.sh <config> <dir> "<url>"` runs a single one.
3. **Score the runs** with the Loupe plugin open and Figma visible:
   ```sh
   bench/score.sh "<figma url or node id>" /tmp/loupe-bench/<screen>-*-*
   ```
   For each run this writes:
   - `compare.txt` and `compare.png`: the pixel diff from `loupe compare`;
   - `score-text.json`: the structural score below.

   It then prints a table with every metric, reps grouped as mean (min–max). The table alone is `python3 bench/analyze.py --table <runs…>`, and JSON per run is `python3 bench/analyze.py <runs…>`.

## Metrics

- **Pixel mismatch** comes from `loupe compare` at 2x, split into pixels inside and outside text layers. When the design's fonts aren't installed, the text part mostly measures the fallback font.
- **Structural score** comes from `score-text.mjs` and is mostly independent of fonts.
  - Matching: every visible Figma text layer is matched to page text by content. A match can be a text node, consecutive styled spans, or a substring.
  - Position: compared at the layer's alignment anchor. x is the left, centre or right edge; y is the centre of the first line, where CSS and Figma both centre glyphs.
  - Reported: % matched, median and p90 error, % within 1 px and 4 px (with y on its own), and exact font size, weight, colour and line height.
  - Caveats: x still moves when a fallback font changes the width of text earlier in a hug row. y is the cleaner signal for layout. Text drawn as vectors in Figma isn't counted. Neither are text layers whose content the implementation changed; they show up as unmatched.
  - Caching: the Figma side is cached as `figma-<node>.json` next to the runs (`bench/snapshot.mts`), so re-scoring doesn't need Figma.
- **Cost, turns, context added** (peak context minus the first request's, so Claude Code's own ~36–41k is excluded), **Figma text** (characters returned by Figma tools), **wall time** and **Figma errors** (failed Figma tool calls, such as export timeouts) all come from the transcript.

To list an MCP server's tools and their read-only annotations, run `node bench/listtools.mjs <command> <args…>`. For example, `node bench/listtools.mjs npx -y @figwright/mcp@latest` lists figwright's tools.
