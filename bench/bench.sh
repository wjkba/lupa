#!/usr/bin/env bash
# Run configs × reps on one screen: bench/bench.sh <screen-name> <figma-url> <reps> <config>...
#   e.g. bench/bench.sh settings "https://www.figma.com/design/KEY/x?node-id=1-2" 3 official framelink lupa-read lupa-full
# Runs land in $BENCH_OUT (default /tmp/lupa-bench)/<screen>-<config>-<rep>; successful runs are
# skipped, so re-running resumes (and redoes failed ones). Non-Lupa configs run in parallel. Lupa configs run one after
# another, because they share the plugin (and alongside the parallel ones).
# Figma runs one plugin per file: figwright can't share an invocation with lupa-* configs.
# MODEL and BUDGET are passed through to run.sh.
set -uo pipefail
B=$(cd "$(dirname "$0")" && pwd)
if [ $# -lt 4 ]; then sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
SCREEN=$1; URL=$2; REPS=$3; shift 3
OUT=${BENCH_OUT:-/tmp/lupa-bench}
LUPA=(); OTHER=()
for c in "$@"; do
  case "$c" in
    lupa-read|lupa-full) LUPA+=("$c") ;;
    official|framelink|figwright) OTHER+=("$c") ;;
    *) echo "unknown config: $c (official framelink figwright lupa-read lupa-full)" >&2; exit 2 ;;
  esac
done
if [ ${#LUPA[@]} -gt 0 ] && [[ " ${OTHER[*]} " == *" figwright "* ]]; then
  echo "figwright needs its own plugin open, Lupa configs need Lupa's: run them in separate invocations." >&2; exit 2
fi
if [ ${#LUPA[@]} -gt 0 ]; then
  KEY=$(sed -nE 's#.*/(design|file|proto)/([A-Za-z0-9]+).*#\2#p' <<< "$URL")
  if ! lupa status 2>&1 | grep -q "key ${KEY:-?})"; then
    echo "The Lupa plugin is not connected to file ${KEY:-?}. Open it in Figma: Plugins → Development → Lupa." >&2; exit 1
  fi
  echo "Lupa configs: keep Figma's window visible (not minimized), or its raster exports stall."
fi
[[ " ${OTHER[*]} " == *" figwright "* ]] && echo "figwright: the figwright plugin must be running in the file."
mkdir -p "$OUT"

LIMIT="$OUT/.usage-limit-$$"
run_one() { # <config> <rep>
  local d="$OUT/$SCREEN-$1-$2"
  if grep -s '"type":"result"' "$d/transcript.jsonl" | grep -q '"is_error":false'; then echo "skip $1 #$2 (done)"; return; fi
  if [ -e "$LIMIT" ]; then echo "not started $1 #$2: usage limit"; return; fi
  rm -rf "$d"
  "$B/run.sh" "$1" "$d" "$URL" ${MODEL:+"$MODEL"}
  echo "done $1 #$2: $(cat "$d/wall_seconds" 2>/dev/null)s $( [ -f "$d/index.html" ] || echo '(no index.html)') $(tail -1 "$d/stderr.log" 2>/dev/null)"
  # A usage limit ends every later run within seconds too: stop starting new ones and say so.
  if grep -s '"type":"result"' "$d/transcript.jsonl" | grep -q '"api_error_status":429'; then
    touch "$LIMIT"
    echo "USAGE LIMIT: $(grep -s '"type":"result"' "$d/transcript.jsonl" | sed -nE 's/.*"result":"([^"]*)".*/\1/p')" >&2
  fi
}

START=$(date +%s)
for rep in $(seq 1 "$REPS"); do
  for c in "${OTHER[@]}"; do run_one "$c" "$rep" & done
done
if [ ${#LUPA[@]} -gt 0 ]; then
  ( for rep in $(seq 1 "$REPS"); do for c in "${LUPA[@]}"; do run_one "$c" "$rep"; done; done ) &
fi
wait
if [ -e "$LIMIT" ]; then rm -f "$LIMIT"; echo "Stopped at a usage limit. Re-run the same command after it resets: failed runs are redone." >&2; exit 3; fi
echo "all runs finished in $(( $(date +%s) - START ))s → $OUT"
cat <<EOF

Score (Lupa plugin open on the file, Figma visible):
  $B/score.sh "$URL" $OUT/$SCREEN-*-*
Table only (after scoring):
  python3 $B/analyze.py --table $OUT/$SCREEN-*-*
Metrics as JSON lines (keep them out of the repo: runs contain the design):
  python3 $B/analyze.py $OUT/$SCREEN-*-* > $OUT/$SCREEN-metrics.jsonl
EOF
