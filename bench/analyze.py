"""Metrics for benchmark runs.

    python3 bench/analyze.py <run-dir>...           one JSON line per run
    python3 bench/analyze.py --table <run-dir>...   markdown table, reps of a config grouped (mean, min–max)

Reads each run's transcript.jsonl (claude -p stream-json), wall_seconds, and, when the run has been
scored, compare.txt (bench/score.sh) and score-text.json (bench/score-text.mjs).
Run dirs are named <screen>-<config>-<rep>, or just <config>.
"""
import base64, json, re, struct, sys
from collections import Counter, defaultdict
from pathlib import Path

CONFIGS = ["official", "framelink", "figwright", "loupe-read", "loupe-full"]


def png_tokens(b64: str) -> int:
    """Approximate Claude image tokens: (w*h)/750 after the API's resize to a 1568px long edge."""
    try:
        head = base64.b64decode(b64[:64])
        w, h = struct.unpack(">II", head[16:24])
    except Exception:
        return 1600
    s = min(1.0, 1568 / max(w, h))
    return int(w * s * h * s / 750)


def figma_tool(key: str) -> bool:
    return "figma" in key.lower() or "figwright" in key.lower() or key.startswith("loupe")


def context_of(usage: dict) -> int:
    return usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)


def parse_name(name: str) -> tuple[str, str, str]:
    """(screen, config, rep) from <screen>-<config>-<rep> or <config>."""
    for c in sorted(CONFIGS, key=len, reverse=True):
        if name == c:
            return "", c, "1"
        m = re.fullmatch(rf"(.*)-{re.escape(c)}-(\w+)", name)
        if m:
            return m.group(1), c, m.group(2)
    return "", name, "1"


def transcript_metrics(path: Path) -> dict:
    names, keys = {}, {}
    calls = Counter()
    out_chars = defaultdict(int)
    img_tokens = 0
    figma_errors = 0
    first = peak = 0
    result = {}
    for line in path.read_text().splitlines():
        m = json.loads(line)
        if m.get("type") == "assistant":
            ctx = context_of(m["message"].get("usage", {}))
            first = first or ctx
            peak = max(peak, ctx)
            for c in m["message"].get("content", []):
                if c.get("type") != "tool_use":
                    continue
                name = c["name"]
                if name == "Bash":
                    words = ((c.get("input") or {}).get("command") or "").split()
                    # Agents chain commands (`ls -la && loupe design …`): name the call after the loupe part.
                    at = next((i for i, w in enumerate(words[:-1]) if w == "loupe" and (i == 0 or words[i - 1] in ("&&", ";", "||", "|"))), None)
                    name = f"loupe {words[at + 1]}" if at is not None else f"Bash:{words[0] if words else ''}"
                names[c["id"]] = name
                calls[name] += 1
        elif m.get("type") == "user":
            content = m["message"].get("content")
            for c in content if isinstance(content, list) else []:
                if c.get("type") != "tool_result":
                    continue
                key = names.get(c.get("tool_use_id"), "?")
                parts = c.get("content")
                parts = [{"type": "text", "text": parts}] if isinstance(parts, str) else (parts or [])
                denied = any(p.get("type") == "text" and p.get("text", "").startswith("Permission to use") for p in parts)
                if c.get("is_error") and not denied and figma_tool(key):
                    figma_errors += 1
                for p in parts:
                    if p.get("type") == "text" and not denied:
                        out_chars[key] += len(p.get("text", ""))
                    elif p.get("type") == "image":
                        img_tokens += png_tokens(p.get("source", {}).get("data", ""))
        elif m.get("type") == "result":
            result = m
    figma_chars = sum(v for k, v in out_chars.items() if figma_tool(k))
    u = result.get("usage", {})
    return {
        "turns": result.get("num_turns"),
        "cost_usd": round(result.get("total_cost_usd") or 0, 2),
        "output_tokens": u.get("output_tokens"),
        "first_context": first,
        "peak_context": peak,
        "context_added": peak - first,
        "figma_text_chars": figma_chars,
        "figma_text_tokens_est": figma_chars // 3,
        # Loupe writes screenshots to files that the agent opens with Read, so every image counts.
        "image_tokens_est": img_tokens,
        "figma_errors": figma_errors,
        "calls": dict(calls),
        "tool_text_chars": dict(out_chars),
        # An API error (e.g. a usage limit) ends the run with subtype "success" but is_error set.
        "error": result.get("result") if result.get("is_error") else (result.get("subtype") if result.get("subtype") != "success" else None),
    }


def compare_metrics(path: Path) -> dict:
    text = path.read_text()
    m = re.search(r"mismatch: ([\d.]+)%", text)
    t = re.search(r"(\d+) px inside text layers.*?; (\d+) px elsewhere", text)
    return {
        "mismatch_pct": float(m.group(1)) if m else None,
        "text_px": int(t.group(1)) if t else None,
        "non_text_px": int(t.group(2)) if t else None,
    }


def analyze(run: Path) -> dict:
    screen, config, rep = parse_name(run.name)
    out = {"run": run.name, "screen": screen, "config": config, "rep": rep, "ok": (run / "index.html").exists()}
    out["wall_s"] = int((run / "wall_seconds").read_text()) if (run / "wall_seconds").exists() else None
    if (run / "transcript.jsonl").exists():
        out.update(transcript_metrics(run / "transcript.jsonl"))
    if (run / "compare.txt").exists():
        out.update(compare_metrics(run / "compare.txt"))
    if (run / "score-text.json").exists():
        s = json.loads((run / "score-text.json").read_text())
        out.update({k: s.get(k) for k in ("matched_pct", "pos_median_px", "pos_p90_px", "within_1px_pct", "within_4px_pct", "y_within_1px_pct", "font_size_pct", "color_pct")})
    return out


# (column, metric key, format)
COLUMNS = [
    ("Pixel mismatch", "mismatch_pct", "{:.2f}%"),
    ("Outside text", "non_text_px", "{:,.0f} px"),
    ("Text ≤1px", "within_1px_pct", "{:.0f}%"),
    ("Text y ≤1px", "y_within_1px_pct", "{:.0f}%"),
    ("Text pos median", "pos_median_px", "{:.1f} px"),
    ("Cost", "cost_usd", "${:.2f}"),
    ("Context added", "context_added", "{:,.0f}"),
    ("Figma text", "figma_text_chars", "{:,.0f} ch"),
    ("Wall", "wall_s", "{:.0f} s"),
    ("Turns", "turns", "{:.0f}"),
    ("Figma errors", "figma_errors", "{:.0f}"),
]


def cell(values: list, fmt: str) -> str:
    vals = [v for v in values if v is not None]
    if not vals:
        return "–"
    mean = sum(vals) / len(vals)
    if len(vals) == 1 or min(vals) == max(vals):
        return fmt.format(mean)
    return f"{fmt.format(mean)} ({fmt.format(min(vals))}–{fmt.format(max(vals))})"


def table(rows: list[dict]) -> str:
    groups = defaultdict(list)
    for r in rows:
        groups[(r["screen"], r["config"])].append(r)
    order = sorted(groups, key=lambda k: (k[0], CONFIGS.index(k[1]) if k[1] in CONFIGS else 99, k[1]))
    lines = ["| Config | n | " + " | ".join(c for c, _, _ in COLUMNS) + " |", "|---|---|" + "---|" * len(COLUMNS)]
    for key in order:
        rs = groups[key]
        name = f"{key[0]} {key[1]}".strip()
        lines.append(f"| {name} | {len(rs)} | " + " | ".join(cell([r.get(k) for r in rs], f) for _, k, f in COLUMNS) + " |")
    return "\n".join(lines)


if __name__ == "__main__":
    args = sys.argv[1:]
    as_table = "--table" in args
    rows = [analyze(Path(d)) for d in args if d != "--table"]
    if as_table:
        print(table(rows))
    else:
        for r in rows:
            print(json.dumps(r, ensure_ascii=False))
