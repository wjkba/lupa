#!/usr/bin/env bash
# One isolated benchmark run: bench/run.sh <config> <run-dir> <figma-url> [model]
# config: official | framelink | figwright | loupe-read | loupe-full
# Each run sees exactly one Figma tool, read-only tools only (dontAsk + allow-list),
# and works in an empty directory outside the Loupe repo.
set -euo pipefail
CONFIG=$1; DIR=$2; URL=$3; MODEL=${4:-claude-opus-5-5}
B=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$DIR"; cd "$DIR"

BASE=(Read Write Edit Glob Grep ToolSearch "Bash(mkdir *)" "Bash(ls *)" "Bash(curl *)" "Bash(file *)")
# No user hooks: a hook that rewrites commands (e.g. rtk turning `curl` into `rtk curl`) makes them miss the allow-list.
SETTINGS='{"disableAllHooks":true}'
NO_OFFICIAL='{"disableAllHooks":true,"enabledPlugins":{"figma@claude-plugins-official":false}}'
ALLOW=(); DENY=(); EXTRA=(); TOOLNAME=""
case "$CONFIG" in
  official)
    TOOLNAME="the official Figma MCP server (mcp__plugin_figma_figma__*)"
    for t in get_design_context get_screenshot get_metadata get_variable_defs get_code_connect_map get_context_for_code_connect \
             search_design_system get_libraries download_assets whoami get_motion_context; do ALLOW+=("mcp__plugin_figma_figma__$t"); done
    ALLOW+=(Skill)
    DENY+=(mcp__Framelink_Figma_MCP "Skill(figma-implement)" "Bash(loupe *)")
    EXTRA+=(--settings "$SETTINGS")
    ;;
  framelink)
    TOOLNAME="the Framelink Figma MCP server (mcp__Framelink_Figma_MCP__*)"
    ALLOW+=(mcp__Framelink_Figma_MCP__get_figma_data mcp__Framelink_Figma_MCP__download_figma_images)
    DENY+=("Skill(figma-implement)" "Bash(loupe *)")
    EXTRA+=(--settings "$NO_OFFICIAL")
    ;;
  figwright)
    TOOLNAME="the Figwright MCP server (mcp__figwright__*), connected to the Figwright plugin in the open Figma file"
    while IFS=$'\t' read -r name ro _; do [ "$ro" = RO ] && ALLOW+=("mcp__figwright__$name"); done < "$B/figwright-tools.txt"
    DENY+=(mcp__Framelink_Figma_MCP "Skill(figma-implement)" "Bash(loupe *)")
    EXTRA+=(--settings "$NO_OFFICIAL" --mcp-config "$B/figwright.json")
    ;;
  loupe-read|loupe-full)
    TOOLNAME="the loupe CLI (see the figma-implement skill)"
    ALLOW+=("Bash(loupe *)" "Skill(figma-implement)")
    DENY+=(mcp__Framelink_Figma_MCP)
    [ "$CONFIG" = loupe-read ] && DENY+=("Bash(loupe compare *)")
    EXTRA+=(--settings "$NO_OFFICIAL")
    ;;
  *) echo "unknown config $CONFIG" >&2; exit 2 ;;
esac

PROMPT="Implement the Figma frame at $URL as a static web page, as faithfully as you can: exact layout, sizes, spacing, colours, typography and icons.
Write it to ./index.html (plain HTML + CSS, no build step; put any downloaded assets under ./assets/). The frame's root element must have id=\"root\" and exactly the frame's size.
Read the design only with $TOOLNAME. Stay inside the current directory. Work autonomously and finish with the single line: DONE."

[ -n "${SMOKE:-}" ] && PROMPT="Do not implement anything. 1) Use ToolSearch with query \"figma\" (max_results 50) and list every tool name it returns. 2) Say which skills you have whose names contain figma. 3) Try to call the Skill tool with skill figma-implement and report whether it was allowed. 4) Try running the shell command: loupe status, and report whether it was allowed. Keep the answer short."
export ENABLE_CLAUDEAI_MCP_SERVERS=false
START=$(date +%s)
claude -p "$PROMPT" --model "$MODEL" --permission-mode dontAsk --output-format stream-json --verbose \
  --allowedTools "${BASE[@]}" "${ALLOW[@]}" --disallowedTools "${DENY[@]}" "${EXTRA[@]}" \
  --max-budget-usd "${BUDGET:-10}" > transcript.jsonl 2> stderr.log || echo "claude exited $?" >> stderr.log
echo "$(( $(date +%s) - START ))" > wall_seconds
