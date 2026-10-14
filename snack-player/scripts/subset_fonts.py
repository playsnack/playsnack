"""Subset the shipped fonts to the characters snackapp actually renders.

    uv run --with "fonttools[woff]==4.60.1" python -I snack-player/scripts/subset_fonts.py          # rebuild
    uv run --with "fonttools[woff]==4.60.1" python -I snack-player/scripts/subset_fonts.py --check  # gate

Inputs (unmodified originals, SIL OFL 1.1, kept in public/fonts):
    pretendard-{500,700}-full.woff2, galmuri11-full.woff2, galmuri11-bold-full.woff2
Outputs (public/fonts):
    snackbody-{500,700}.woff2   Pretendard subset. Pretendard has the Reserved Font
                                Name "Pretendard", so the modified (subset) fonts are
                                renamed "Snack Body" (OFL condition 3).
    galmuri11.woff2, galmuri11-bold.woff2   Galmuri11 subset (no reserved name).
The *-full files stay as a fallback for characters outside the subset; the
player only fetches them when such a character is drawn (see
packages/bite-pixi/src/fonts.js, which this script also updates with the full
faces' unicode-range).

Character set:
    both families: ASCII + Latin-1 + common punctuation/symbols + compatibility
        jamo + every character in the app data and player source (templates,
        content bank, pools, round packs, shell strings, nickname words).
        Anything else (e.g. a typed nickname) comes from the *-full fallback.
    display (Galmuri11) leaves out Hangul (syllables and jamo): the pixel face
        draws only text with no Korean — scores, counters, the logo (#84;
        snack-player/test/displayFont.test.ts keeps the templates to it). A
        Korean character in display text would still draw, from the full face.
--check exits 1 when any character in that text (that the full font can draw)
is missing from a subset — rerun without --check to rebuild.
"""
import glob
import io
import os
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FONTS = os.path.join(ROOT, "snack-player", "public", "fonts")
FONTS_JS = os.path.join(ROOT, "packages", "bite-pixi", "src", "fonts.js")

# Text the app can show. Globs are relative to the repo root.
TEXT_SOURCES = [
    "snack-server/data/bite/*.json",
    "snack-server/data/seed-content/*.json",
    "snack-server/data/pools/*.json",
    "snack-server/data/multi-content/*.json",
    "snack-player/src/**/*.ts",
    "snack-player/src/**/*.tsx",
    "snack-player/index.html",
    "packages/content/src/**/*.js",
    "packages/snack-room/src/**/*.js",
]

BASE_RANGES = [
    (0x20, 0x7E),      # ASCII
    (0xA0, 0xFF),      # Latin-1
    (0x2010, 0x2027),  # dashes, quotes, bullets, ellipsis
    (0x2030, 0x203A),  # per mille, primes, angle quotes
    (0x2190, 0x2199),  # arrows
    (0x2460, 0x2473),  # circled numbers
    (0x25A0, 0x25CF),  # squares, triangles, circles
    (0x3000, 0x3011),  # CJK punctuation and brackets
    (0x3131, 0x318E),  # Hangul compatibility jamo (ㅋㅋ, ㅠㅠ, 초성)
    (0xFF01, 0xFF5E),  # fullwidth forms
]

FACES = [
    # (source, output, kind, rename-to family or None, canvas)
    # canvas=False: the shell declares the face (index.html) but the canvas does not
    # (packages/bite-pixi/src/fonts.js keeps 500/700, matching the engine's metrics).
    ("pretendard-500-full.woff2", "snackbody-500.woff2", "body", "Snack Body", True),
    ("pretendard-600-full.woff2", "snackbody-600.woff2", "body", "Snack Body", False),  # shell headings (#102)
    ("pretendard-700-full.woff2", "snackbody-700.woff2", "body", "Snack Body", True),
    ("galmuri11-full.woff2", "galmuri11.woff2", "display", None, True),
    ("galmuri11-bold-full.woff2", "galmuri11-bold.woff2", "display", None, True),
]


def source_text_chars():
    chars = set()
    for pattern in TEXT_SOURCES:
        for path in sorted(glob.glob(os.path.join(ROOT, pattern), recursive=True)):
            with open(path, encoding="utf-8") as f:
                text = f.read()
            # JSON escapes (\uXXXX) count too.
            text += "".join(chr(int(h, 16)) for h in re.findall(r"\\u([0-9a-fA-F]{4})", text))
            chars.update(ord(c) for c in text)
    return {c for c in chars if c >= 0x20}


HANGUL = [(0x1100, 0x11FF), (0x3130, 0x318F), (0xA960, 0xA97F), (0xAC00, 0xD7AF), (0xD7B0, 0xD7FF)]


def is_hangul(c):
    return any(a <= c <= b for a, b in HANGUL)


def text_for(kind, text_chars):
    """The app text a face must cover: the pixel face has no Korean to draw (#84)."""
    return {c for c in text_chars if not is_hangul(c)} if kind == "display" else set(text_chars)


def wanted(kind, text_chars):
    cps = set(text_chars)
    for a, b in BASE_RANGES:
        cps.update(range(a, b + 1))
    return text_for(kind, cps)


def cmap_of(path):
    font = TTFont(path)
    return set(font.getBestCmap().keys())


def rename(font, family):
    """Give a modified Pretendard its own name (OFL Reserved Font Name)."""
    name = font["name"]
    weight = {500: "Medium", 600: "SemiBold", 700: "Bold"}.get(font["OS/2"].usWeightClass, "Regular")
    full = f"{family} {weight}"
    ps = f"{family.replace(' ', '')}-{weight}"
    for rec in list(name.names):
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID in (2, 17):
            rec.string = weight
        elif rec.nameID == 3:
            rec.string = f"{ps};snackapp-subset"
        elif rec.nameID == 4:
            rec.string = full
        elif rec.nameID == 6:
            rec.string = ps
    if "CFF " in font:
        cff = font["CFF "].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        for key in ("FullName", "FamilyName"):
            if hasattr(top, key):
                setattr(top, key, full if key == "FullName" else family)


def build_subset(src, dst, cps, family):
    options = subset.Options()
    options.flavor = "woff2"
    # Default OpenType features only (kerning, ligatures, mark positioning…):
    # "*" would keep every stylistic alternate and pull in their glyphs.
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.drop_tables += ["DSIG"]
    font = subset.load_font(src, options)
    sub = subset.Subsetter(options)
    sub.populate(unicodes=sorted(cps))
    sub.subset(font)
    if family:
        rename(font, family)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    with open(dst, "wb") as f:
        f.write(buf.getvalue())


def coarse_ranges(cps, gap=128):
    """Merge code points into few ranges (gaps < `gap` are bridged)."""
    out = []
    for c in sorted(cps):
        if out and c - out[-1][1] <= gap:
            out[-1][1] = c
        else:
            out.append([c, c])
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in out)


def update_fonts_js(full_ranges):
    with open(FONTS_JS, encoding="utf-8") as f:
        js = f.read()
    block = "\n".join(f'  {k}: "{v}",' for k, v in full_ranges.items())
    pattern = r"(// <full-ranges>\n).*?(  // </full-ranges>)"
    if not re.search(pattern, js, flags=re.S):
        sys.exit("fonts.js: <full-ranges> markers not found")
    new = re.sub(pattern, lambda m: m.group(1) + block + "\n" + m.group(2), js, flags=re.S)
    with open(FONTS_JS, "w", encoding="utf-8") as f:
        f.write(new)


def main():
    check = "--check" in sys.argv
    text = source_text_chars()
    failed = False
    full_ranges = {}
    for src_name, dst_name, kind, family, canvas in FACES:
        src = os.path.join(FONTS, src_name)
        dst = os.path.join(FONTS, dst_name)
        full = cmap_of(src)
        cps = wanted(kind, text) & full
        if check:
            have = cmap_of(dst) if os.path.exists(dst) else set()
            missing = sorted((text_for(kind, text) & full) - have)
            status = "ok" if not missing else f"MISSING {len(missing)}: " + "".join(chr(c) for c in missing[:40])
            print(f"{dst_name:24} {os.path.getsize(dst) // 1024 if os.path.exists(dst) else 0:4d} KB  {status}")
            failed |= bool(missing)
            continue
        build_subset(src, dst, cps, family)
        print(f"{src_name:28} {os.path.getsize(src) // 1024:4d} KB → {dst_name:22} {os.path.getsize(dst) // 1024:4d} KB  ({len(cps)} chars)")
        if not canvas:
            continue
        m = re.search(r"-(\d{3})-full", src_name)
        key = f"{kind}{m.group(1) if m else ('700' if 'bold' in src_name else '400')}"
        # The full face only needs to answer for what the subset lacks.
        full_ranges[key] = coarse_ranges(full - cmap_of(dst))
    if check:
        if failed:
            print("\nNew text needs glyphs the font subsets lack. Rebuild:\n  uv run --with \"fonttools[woff]==4.60.1\" python -I snack-player/scripts/subset_fonts.py")
            sys.exit(1)
        print("font subsets cover all app text")
        return
    update_fonts_js(full_ranges)
    print("updated", os.path.relpath(FONTS_JS, ROOT))


if __name__ == "__main__":
    main()
