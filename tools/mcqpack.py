#!/usr/bin/env python3
"""mcqpack: extract, merge and validate mcqpack v1.0 question packs.

  mcqpack.py extract --profile P --paper paper.pdf --scheme scheme.pdf --id ID --title T --out DIR
  mcqpack.py merge pack.json partial.json [-o out.json]
  mcqpack.py validate DIR [--json]

Standard library only, plus poppler (pdftoppm, pdftotext) for extract.
Pillow is used if installed to trim blank space under each clip.
The validation rules mirror js/validator.js; see docs/PACK_FORMAT.md.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from html import unescape

PACK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
QUESTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
FORMAT_VERSION = re.compile(r"^1\.[0-9]+$")
SVG_UNSAFE = re.compile(r"<script|\son[a-z]+\s*=|<foreignObject|href\s*=\s*(?![\"']#)", re.I)
LAYERS = {"explanations": "explanation", "topics": "topics", "answers": "answer"}


# ---------------------------------------------------------------- validation

def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def bad_path(p):
    return (not isinstance(p, str) or p == "" or p.startswith("/") or "\\" in p or ":" in p
            or any(seg in ("", ".", "..") for seg in p.split("/")))


def validate(pack, assets):
    """Return (errors, warnings), each a list of {code, where, message}.
    assets: dict path -> SVG text (or None for other files), or None to skip asset checks."""
    errors, warnings = [], []

    def err(code, where, msg):
        errors.append({"code": code, "where": where, "message": msg})

    def warn(code, where, msg):
        warnings.append({"code": code, "where": where, "message": msg})

    if not isinstance(pack, dict):
        err("json", "pack", "pack.json is not a JSON object")
        return errors, warnings
    fv = pack.get("formatVersion")
    if pack.get("format") != "mcqpack" or not isinstance(fv, str) or not FORMAT_VERSION.match(fv):
        err("format", "pack", "not an mcqpack 1.x file (check \"format\" and \"formatVersion\")")
    for f in ("version", "title"):
        if not isinstance(pack.get(f), str) or not pack.get(f):
            err("field", "pack", f"\"{f}\" must be a non-empty string")
    pid = pack.get("id")
    if not isinstance(pid, str):
        err("field", "pack", "\"id\" must be a string")
    elif not PACK_ID.match(pid):
        err("id", "pack", f"pack id \"{pid}\" must be 2-64 lowercase letters, digits or hyphens")
    keys = pack.get("optionKeys")
    if not (isinstance(keys, list) and 2 <= len(keys) <= 10 and all(isinstance(k, str) and 1 <= len(k) <= 3 for k in keys)
            and len(set(keys)) == len(keys)):
        err("option-keys", "pack", "\"optionKeys\" must be 2-10 unique keys of 1-3 characters")
        keys = None
    if "timeLimitSec" in pack and not (is_int(pack["timeLimitSec"]) and pack["timeLimitSec"] > 0):
        err("field", "pack", "\"timeLimitSec\" must be a positive whole number")
    if "overlays" in pack and not is_str_list(pack["overlays"]):
        err("field", "pack", "\"overlays\" must be a list of file paths")
    questions = pack.get("questions")
    if not isinstance(questions, list) or not questions:
        err("field", "pack", "\"questions\" must be a non-empty list")
        return errors, warnings

    def image(item, where, what):
        if not isinstance(item, dict) or not isinstance(item.get("src"), str):
            err("field", where, f"{what} needs a \"src\" path")
            return
        src = item["src"]
        if bad_path(src):
            err("path", where, f"{what} path \"{src}\" points outside the pack")
        elif assets is not None and src not in assets:
            err("asset-missing", where, f"{what} file \"{src}\" is not in the pack")
        elif assets is not None and src.lower().endswith(".svg") and SVG_UNSAFE.search(assets[src] or ""):
            err("svg-unsafe", where, f"SVG \"{src}\" contains scripts, event handlers, foreignObject or external links")
        if "clip" in item:
            c = item["clip"]
            if not (isinstance(c, list) and len(c) == 4 and all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in c)
                    and c[0] >= 0 and c[1] >= 0 and c[2] > 0 and c[3] > 0):
                err("clip", where, f"{what} clip must be [x, y, width, height] with width and height above 0")

    def block(b, where):
        if not isinstance(b, dict) or not isinstance(b.get("type"), str):
            err("field", where, "a block needs a \"type\"")
            return
        t = b["type"]
        if t == "text" and not isinstance(b.get("text"), str):
            err("field", where, "a text block needs \"text\"")
        elif t == "math" and not isinstance(b.get("tex"), str):
            err("field", where, "a math block needs \"tex\"")
        elif t == "fig":
            image(b, where, "figure")
            if not isinstance(b.get("alt"), str) or not b["alt"].strip():
                err("alt", where, "a figure has no alt text (describe it for screen readers)")
        elif t == "table" and not (isinstance(b.get("rows"), list) and all(is_str_list(r) for r in b["rows"])):
            err("field", where, "a table block needs \"rows\" as lists of text")
        elif t not in ("text", "math", "fig", "table"):
            warn("unsupported-block", where, f"block type \"{t}\" is not supported and will show a placeholder")

    seen = set()
    for i, q in enumerate(questions):
        where = q["id"] if isinstance(q, dict) and isinstance(q.get("id"), str) else f"#{i + 1}"
        if not isinstance(q, dict):
            err("field", where, "question is not an object")
            continue
        qid = q.get("id")
        if not isinstance(qid, str):
            err("field", where, "question has no \"id\"")
        elif not QUESTION_ID.match(qid):
            err("id", where, f"question id \"{qid}\" may only use letters, digits, _ and - (max 32)")
        elif qid in seen:
            err("duplicate-id", where, f"question id \"{qid}\" is used more than once")
        seen.add(qid)
        if not isinstance(q.get("type"), str):
            err("field", where, "question has no \"type\"")
            continue
        if q["type"] != "single":
            warn("unsupported-type", where, f"question type \"{q['type']}\" is not supported and will be skipped")
            continue
        if not (is_int(q.get("rev")) and q["rev"] >= 1):
            err("field", where, "\"rev\" must be a whole number of 1 or more")
        if keys is not None and q.get("answer") not in keys:
            err("answer", where, f"answer {json.dumps(q.get('answer'))} is not one of the option keys {', '.join(keys)}")
        for f in ("snapshot", "stem", "options"):
            if f in q and not isinstance(q[f], list):
                err("field", where, f"\"{f}\" must be a list")
        snap = q.get("snapshot") if isinstance(q.get("snapshot"), list) else []
        stem = q.get("stem") if isinstance(q.get("stem"), list) else None
        opts = q.get("options") if isinstance(q.get("options"), list) else None
        if (stem is None) != (opts is None) or (not snap and stem is None):
            err("content", where, "needs a snapshot, or both a stem and options")
        for item in snap:
            image(item, where, "snapshot")
        for b in stem or []:
            block(b, where)
        if opts is not None:
            for o in opts:
                if not isinstance(o, dict) or not isinstance(o.get("blocks"), list):
                    err("field", where, "each option needs \"key\" and \"blocks\"")
                    continue
                for b in o["blocks"]:
                    block(b, where)
            if keys is not None and [o.get("key") if isinstance(o, dict) else None for o in opts] != keys:
                err("option-keys", where, f"options must be exactly {', '.join(keys)} in that order")
        if "explanation" in q and not isinstance(q["explanation"], str):
            err("field", where, "\"explanation\" must be text")
        if "topics" in q and not is_str_list(q["topics"]):
            err("field", where, "\"topics\" must be a list of text")
    return errors, warnings


def apply_overlay(pack, ov, name, warnings):
    def warn(msg):
        warnings.append({"code": "overlay", "where": "pack", "message": f"overlay {name}: {msg}"})

    if not isinstance(ov, dict) or ov.get("format") != "mcqpack-overlay":
        return warn("is not an mcqpack-overlay file")
    if ov.get("pack") != pack.get("id"):
        return warn(f"is for pack {json.dumps(ov.get('pack'))}, not this one")
    field = LAYERS.get(ov.get("layer"))
    if not field or not isinstance(ov.get("items"), dict):
        return warn("has an unknown layer or no items")
    by_id = {q.get("id"): q for q in pack["questions"] if isinstance(q, dict)}
    for qid, value in ov["items"].items():
        ok = is_str_list(value) if field == "topics" else isinstance(value, str)
        if qid not in by_id or not ok:
            warn(f"item {qid} skipped (unknown question or wrong value type)")
        else:
            by_id[qid][field] = value


def load_dir(root):
    """Load, overlay and validate a pack folder. Returns (pack, errors, warnings)."""
    files = {}
    for d, _, names in os.walk(root):
        for n in names:
            full = os.path.join(d, n)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            text = None
            if n.lower().endswith((".svg", ".json")):
                with open(full, encoding="utf-8", errors="replace") as f:
                    text = f.read()
            files[rel] = text
    return load_files(files)


def load_files(files):
    """files: dict relative path -> text for .json/.svg files, None for others."""
    errors, warnings = [], []
    try:
        pack = json.loads(files["pack.json"])
    except (KeyError, TypeError, ValueError):
        return None, [{"code": "json", "where": "pack", "message": "pack.json is missing or is not valid JSON"}], []
    if isinstance(pack, dict) and isinstance(pack.get("questions"), list):
        listed = pack.get("overlays") if is_str_list(pack.get("overlays")) else []
        for p in listed:
            if bad_path(p):
                errors.append({"code": "path", "where": "pack", "message": f"overlay path \"{p}\" points outside the pack"})
            elif p not in files:
                errors.append({"code": "asset-missing", "where": "pack", "message": f"overlay file \"{p}\" is not in the pack"})
            else:
                apply_overlay(pack, parse(files[p]), p, warnings)
        for p in sorted(files):
            if "/" not in p and p.endswith(".json") and p != "pack.json" and p not in listed:
                ov = parse(files[p])
                if isinstance(ov, dict) and ov.get("format") == "mcqpack-overlay":
                    apply_overlay(pack, ov, p, warnings)
    e, w = validate(pack, files)
    return pack, errors + e, warnings + w


def parse(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------- extract

def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def words_by_page(pdf):
    """[(width, height, [(xMin, yMin, xMax, yMax, text)])] in PDF points, from pdftotext -bbox."""
    html = run("pdftotext", "-bbox", pdf, "-")
    pages = []
    for m in re.finditer(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', html, re.S):
        words = [(float(a), float(b), float(c), float(d), unescape(t)) for a, b, c, d, t in re.findall(
            r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', m.group(3))]
        pages.append((float(m.group(1)), float(m.group(2)), words))
    return pages


def trim_bottom(png, clip, step):
    """Shrink clip height to the last non-white pixel row (needs Pillow; no-op without it)."""
    try:
        from PIL import Image
    except ImportError:
        return clip
    x, y, w, h = clip
    with Image.open(png) as im:
        box = im.convert("L").crop((x, y, x + w, y + h)).point(lambda v: 255 if v < 200 else 0).getbbox()
    return [x, y, w, min(h, box[3] + step)] if box else clip


def extract(a):
    prof = json.load(open(a.profile))
    dpi, s = prof["dpi"], prof["dpi"] / 72
    os.makedirs(os.path.join(a.out, "assets"), exist_ok=True)
    pages = words_by_page(a.paper)
    number = re.compile(prof["numberPattern"])
    found, expected = [], 1  # found: (question number, page index, y top in points)
    for pi, (_, _, words) in enumerate(pages):
        text = " ".join(w[4] for w in words)
        if pi + 1 in prof["skipPages"] or any(t in text for t in prof["skipPagesContaining"]):
            continue
        for w in sorted(words, key=lambda w: w[1]):
            if w[0] < prof["numberMaxX"] and number.match(w[4]) and int(w[4]) == expected:
                found.append((expected, pi, w[1]))
                expected += 1
    if not found:
        sys.exit("extract: no question numbers found; check the profile")
    with tempfile.TemporaryDirectory() as tmp:
        run("pdftoppm", "-r", str(dpi), "-png", a.paper, os.path.join(tmp, "p"))
        rendered = sorted(os.listdir(tmp))
        used = {}
        for i, (n, pi, top) in enumerate(found):
            pw, _, _ = pages[pi]
            nxt = found[i + 1] if i + 1 < len(found) else None
            bottom = nxt[2] if nxt and nxt[1] == pi else prof["contentBottom"]
            spans = [(pi, top - prof["padAbove"], bottom - prof["padAbove"])]
            if nxt and nxt[1] == pi + 1:  # words above the next question on the next page belong to this one
                if any(prof["contentTop"] < w[1] < nxt[2] - prof["padAbove"] for w in pages[pi + 1][2]):
                    spans.append((pi + 1, prof["contentTop"], nxt[2] - prof["padAbove"]))
            snap = []
            for p, y0, y1 in spans:
                src = f"assets/page-{p + 1:02d}.png"
                used[src] = os.path.join(tmp, rendered[p])
                clip = [round(prof["clipLeft"] * s), round(y0 * s),
                        round((pages[p][0] - prof["clipLeft"] - prof["clipRight"]) * s), round((y1 - y0) * s)]
                snap.append({"src": src, "clip": trim_bottom(used[src], clip, round(6 * s))})
            found[i] = (n, snap)
        for src, path in used.items():
            os.replace(path, os.path.join(a.out, src))
    answers = {}
    for line in run("pdftotext", "-layout", a.scheme, "-").splitlines():
        m = re.match(prof["answerPattern"], line)
        if m:
            answers[int(m.group(1))] = m.group(2)
    questions = [{"id": f"q{n:02d}", "number": n, "type": "single", "rev": 1, "answer": answers.get(n), "snapshot": snap}
                 for n, snap in found]
    pack = {"format": "mcqpack", "formatVersion": "1.0", "id": a.id, "version": "1.0.0", "title": a.title,
            "optionKeys": prof["optionKeys"], "timeLimitSec": round(len(questions) * prof["secondsPerQuestion"]),
            "questions": questions}
    write_json(os.path.join(a.out, "pack.json"), pack)
    missing = [q["id"] for q in questions if not q["answer"]]
    print(f"extract: {len(questions)} questions, {len(used)} page images"
          + (f"; no answer found for {', '.join(missing)}" if missing else ""))


# --------------------------------------------------------------------- merge

def deep_merge(base, extra):
    for k, v in extra.items():
        base[k] = deep_merge(base[k], v) if isinstance(base.get(k), dict) and isinstance(v, dict) else v
    return base


def merge(a):
    pack, extra = json.load(open(a.pack)), json.load(open(a.partial))
    if extra.get("format") == "mcqpack-overlay":
        warnings = []
        apply_overlay(pack, extra, a.partial, warnings)
        for w in warnings:
            print("warning:", w["message"])
    else:
        by_id = {q["id"]: q for q in pack["questions"]}
        for q in extra.pop("questions", []):
            if q.get("id") in by_id:
                deep_merge(by_id[q["id"]], q)
            else:
                print(f"warning: question {q.get('id')} not in pack, skipped")
        deep_merge(pack, extra)
    write_json(a.o or a.pack, pack)


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    for f in ("--profile", "--paper", "--scheme", "--id", "--title", "--out"):
        e.add_argument(f, required=True)
    m = sub.add_parser("merge")
    m.add_argument("pack")
    m.add_argument("partial")
    m.add_argument("-o")
    v = sub.add_parser("validate")
    v.add_argument("dir")
    v.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.cmd == "extract":
        extract(a)
    elif a.cmd == "merge":
        merge(a)
    else:
        _, errors, warnings = load_dir(a.dir)
        if a.json:
            print(json.dumps({"errors": errors, "warnings": warnings}, indent=1))
        else:
            for x in errors:
                print(f"ERROR [{x['code']}] {x['where']}: {x['message']}")
            for x in warnings:
                print(f"warning [{x['code']}] {x['where']}: {x['message']}")
            print(f"{len(errors)} error(s), {len(warnings)} warning(s)")
        sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
