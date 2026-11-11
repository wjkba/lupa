"""How much of an existing project a run reused: python3 -I bench/reuse.py --seed <project> <run-dir>...

For runs made with SEED=<project>, compares each run with the project it started from:
  colours   colour literals the run wrote in CSS, HTML and JS (inline SVG markup aside) vs var(--…) uses
  tokens    distinct project custom properties the run used, of those the project defines
  classes   project CSS classes the run's markup uses (by component: btn, badge, …)
  icons     project icons the run used (by file or by inlining the same drawing) and new SVGs it wrote
  changed   project files the run edited
"""
import argparse
import os
import re

TEXT_EXT = (".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".svelte", ".vue")
COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)")
SVG_BLOCK = re.compile(r"<svg\b.*?</svg>", re.S)
DATA_URI = re.compile(r"url\(\s*['\"]?data:[^)]*\)")
VAR_USE = re.compile(r"var\(\s*(--[\w-]+)")
VAR_DEF = re.compile(r"(--[\w-]+)\s*:")
CLASS_DEF = re.compile(r"\.(-?[_a-zA-Z][\w-]*)")
CLASS_ATTR = re.compile(r"class(?:Name)?\s*=\s*[\"'`]([^\"'`]*)[\"'`]")
PATH_D = re.compile(r'\bd="([^"]+)"')


def files(root):
    out = {}
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"]
        for n in names:
            p = os.path.join(d, n)
            out[os.path.relpath(p, root)] = p
    return out


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except (UnicodeDecodeError, OSError):
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", required=True)
    ap.add_argument("runs", nargs="+")
    a = ap.parse_args()

    seed = files(a.seed)
    seed_text = {k: read(p) for k, p in seed.items() if k.endswith(TEXT_EXT)}
    seed_css = "\n".join(t for k, t in seed_text.items() if k.endswith(".css"))
    tokens = set(VAR_DEF.findall(seed_css))
    classes = {c for c in CLASS_DEF.findall(re.sub(r"/\*.*?\*/", "", seed_css, flags=re.S)) if not re.fullmatch(r"\d.*", c)}
    icons = {k: read(p) for k, p in seed.items() if k.endswith(".svg")}
    icon_paths = {k: set(PATH_D.findall(t)) for k, t in icons.items()}

    for run in a.runs:
        mine = files(run)
        skip = ("transcript.jsonl", "stderr.log", "wall_seconds", "compare", "score-text")
        new = {k: p for k, p in mine.items() if k not in seed and not k.startswith(skip)}
        changed = [k for k, p in mine.items() if k in seed and k.endswith(TEXT_EXT) and read(p) != seed_text.get(k, read(seed[k]))]
        code = "\n".join(read(mine[k]) for k in list(new) + changed if k.endswith(TEXT_EXT))
        plain = DATA_URI.sub("", SVG_BLOCK.sub("", code))
        literals = COLOR.findall(plain)
        uses = VAR_USE.findall(code)
        used_tokens = {u for u in uses if u in tokens}
        markup_classes = {c for attr in CLASS_ATTR.findall(code) for c in attr.split()}
        used_classes = sorted(markup_classes & classes)
        roots = sorted({c.split("__")[0].split("--")[0] for c in used_classes})
        drawn = set(PATH_D.findall(code))
        used_icons = sorted(k for k, ps in icon_paths.items() if os.path.basename(k) in code or (ps and ps <= drawn))
        new_svgs = sorted(k for k in new if k.endswith(".svg"))
        print(f"== {os.path.basename(os.path.normpath(run))}")
        print(f"  colours: {len(literals)} literals, {len(uses)} var() uses")
        print(f"  tokens:  {len(used_tokens)}/{len(tokens)} project tokens used")
        print(f"  classes: {len(used_classes)} project classes ({', '.join(roots) or 'none'})")
        print(f"  icons:   {len(used_icons)}/{len(icons)} project icons used; {len(new_svgs)} new SVG files")
        print(f"  changed: {', '.join(changed) or 'no project files'}; new: {', '.join(sorted(k for k in new if not k.startswith('assets/'))) or '-'}")


if __name__ == "__main__":
    main()
