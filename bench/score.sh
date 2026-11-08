#!/usr/bin/env bash
# Score finished runs against the Figma frame: bench/score.sh <node-id | figma url> <run-dir>...
# Needs the Loupe plugin open on the file (Figma in front, for the raster export).
# Per run: compare.txt + compare.png (pixel diff, `loupe compare`) and score-text.json (text layer
# positions and styles, bench/score-text.mjs). The frame's snapshot is cached next to the runs as
# figma-<node>.json, so re-scoring the text structure needs no Figma (delete it to refetch).
set -uo pipefail
B=$(cd "$(dirname "$0")" && pwd)
TARGET=$1; shift
NODE=$(sed -nE 's/.*node-id=([0-9]+)[-:]([0-9]+).*/\1:\2/p' <<< "$TARGET"); NODE=${NODE:-$TARGET}
DIRS=(); for d in "$@"; do DIRS+=("$(cd "$d" && pwd)"); done
SNAP="$(dirname "${DIRS[0]}")/figma-${NODE/:/-}.json"

# Score against Figma's own PNG: wait for it rather than fall back to the SVG render, whose
# missing effects or strokes would make scores incomparable between runs.
export LOUPE_RASTER_WAIT_MS=${LOUPE_RASTER_WAIT_MS:-90000}
for d in "${DIRS[@]}"; do
  loupe compare "$NODE" --url "file://$d/index.html" --selector "#root" -o "$d/compare.png" > "$d/compare.txt" 2>&1
  echo "== $(basename "$d"): $(grep -m1 -iE 'mismatch|error' "$d/compare.txt")"
  grep -q "SVG export rendered in Chromium" "$d/compare.txt" && echo "   WARNING: scored against the SVG fallback, not Figma's PNG. Bring Figma to the front and re-score this run."
done
node "$B/score-text.mjs" --snapshot "$SNAP" --node "$NODE" "${DIRS[@]}" | grep -v '^{'
echo
python3 -I "$B/analyze.py" --table "${DIRS[@]}"
