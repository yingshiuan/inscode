#!/usr/bin/env python3
"""Command-line QR generation, on the same core the web tool and API use.

Keeps the interface of the original scripts/qr_logo.py so existing invocations
keep working:

  python -m inscode.cli "https://insdash.ch" logo/Logo-circle.png menu-qr.png
  python -m inscode.cli "https://insdash.ch" logo/Logo-circle.png art.png --art --mark cross
"""
import argparse
import base64
import mimetypes
import sys
from pathlib import Path

from .render import render_spec
from .spec import FINDER_SHAPES, MARK_SHAPES, MODULE_SHAPES, QRSpec
from .validate import report

TRANSPARENT = {"none", "transparent", "clear"}


def _data_uri(path: str) -> str:
    mime = mimetypes.guess_type(path)[0] or "image/png"
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


def build_spec(a) -> QRSpec:
    bg = None if str(a.bg).strip().lower() in TRANSPARENT else a.bg
    spec = {
        "content": {"text": a.data, "ecLevel": a.ec},
        "mode": "art" if a.art else "classic",
        "canvas": {"quietZone": a.border, "moduleSize": a.box_size, "bg": bg},
        "modules": {"shape": a.style, "gap": a.gap, "color": a.fg},
        "finders": {"shape": a.finder},
        "art": {"mark": a.mark, "markSize": a.dot, "loose": a.loose, "clearFinders": a.clear_finders},
    }
    if a.logo:
        spec["logo"] = {
            "src": _data_uri(a.logo),
            "x": a.x,
            "y": a.y,
            # One placement model for both modes: art mode defaults to full bleed.
            "scale": a.art_scale if a.art else a.scale,
            "rotation": a.rotation,
            "plate": {"enabled": not a.no_plate, "pad": a.pad, "radius": a.radius},
        }
    return QRSpec.model_validate(spec)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("data")
    p.add_argument("logo", nargs="?", help="image to place on the code (optional)")
    p.add_argument("out")
    p.add_argument("--scale", type=float, default=0.22, help="centre logo size, fraction of width")
    p.add_argument("--fg", default="#000000")
    p.add_argument("--bg", default="#ffffff", help='background colour, or "none" for transparent')
    p.add_argument("--style", default="square", choices=MODULE_SHAPES, help="module shape")
    p.add_argument("--finder", default="square", choices=FINDER_SHAPES, help="finder shape")
    p.add_argument("--gap", type=float, default=0.0, help="gap between modules, fraction of a module")
    p.add_argument("--ec", default="H", choices=("L", "M", "Q", "H"))
    p.add_argument("--box-size", type=int, default=20)
    p.add_argument("--border", type=int, default=4, help="quiet zone, in modules")
    p.add_argument("--px", type=int, default=None, help="output width in pixels (default box-size x modules)")
    p.add_argument("--x", type=float, default=0.5, help="logo centre across the code, 0..1")
    p.add_argument("--y", type=float, default=0.5, help="logo centre down the code, 0..1")
    p.add_argument("--rotation", type=float, default=0.0)
    p.add_argument("--pad", type=float, default=0.7, help="plate padding, in modules")
    p.add_argument("--radius", type=float, default=0.18, help="plate corner radius")
    p.add_argument("--no-plate", action="store_true", help="do not clear modules behind the logo")
    p.add_argument("--art", action="store_true", help="full-bleed artwork behind the modules")
    p.add_argument("--mark", default="cross", choices=MARK_SHAPES, help="module mark in --art mode")
    p.add_argument("--dot", type=float, default=0.6, help="mark size, fraction of a module")
    p.add_argument("--art-scale", type=float, default=1.0, help="artwork size within the code")
    p.add_argument("--clear-finders", action="store_true",
                   help="shrink the artwork so it never touches the three corner circles")
    p.add_argument("--loose", action="store_true",
                   help="leave timing/alignment patterns as marks too (prettier, less robust)")
    p.add_argument("--check", action="store_true", help="stress-test the result and report scannability")
    size = p.add_mutually_exclusive_group()
    size.add_argument("--print-mm", type=float, default=None,
                      help="finished print width in mm, to check the result against")
    size.add_argument("--screen-px", type=int, default=None,
                      help="finished on-screen width in px, to check the result against")
    a = p.parse_args(argv)

    fmt = Path(a.out).suffix.lstrip(".").lower() or "png"
    if fmt not in ("svg", "png", "jpg", "jpeg"):
        p.error(f"unsupported output format '{fmt}' (use .svg, .png or .jpg)")

    spec = build_spec(a)
    transparent = spec.canvas.bg is None
    if transparent and fmt in ("jpg", "jpeg"):
        # JPEG has no alpha channel; refusing beats silently flattening onto black.
        p.error("transparent output needs .png or .svg (jpg has no alpha channel)")

    modules = (spec.encoded.size if spec.encoded else 0) or 0
    px = a.px or 0
    if not px:
        # Match the original: box_size pixels per module, quiet zone included.
        from .encode import matrix_for
        modules = matrix_for(spec).size + 2 * spec.canvas.quiet_zone
        px = int(modules * a.box_size)

    data, _ = render_spec(spec, fmt, px=px)
    Path(a.out).write_bytes(data)
    print(f"wrote {a.out} ({px}x{px})")

    if a.check:
        output = None
        if a.print_mm:
            output = {"kind": "print", "mm": a.print_mm}
        elif a.screen_px:
            output = {"kind": "screen", "px": a.screen_px}
        r = report(spec, output)
        integrity, optical = r["integrity"], r["optical"]
        print(f"\n{r['grade']}: {r['message']}")

        print("\ndata integrity (modelled from the design)")
        print(f"  finder patterns readable : {3 - integrity['brokenFinders']}/3"
              "  (by the 1:1:3:1:1 run through each centre)")
        kinds = ", ".join(f"{n} {k}" for k, n in sorted(integrity["gridKinds"].items()))
        print(f"  grid modules wrong       : {integrity['gridFlips']}"
              f"    (timing/alignment — uncorrected, but survivable)"
              f"{'  ' + kinds if kinds else ''}")
        budget = integrity["functionBchCorrects"]
        fmt = integrity["formatErrors"]
        print(f"  format information       : {fmt[0]} and {fmt[1]} wrong of 15"
              f"    (BCH corrects {budget} per copy, either copy will do)")
        if integrity["versionErrors"]:
            ver = integrity["versionErrors"]
            print(f"  version information      : {ver[0]} and {ver[1]} wrong of 18"
                  f"    (BCH corrects {budget} per copy)")
        for b in integrity["blocks"]:
            bar = "#" * b["corrupted"] + "." * max(0, b["correctable"] - b["corrupted"])
            print(f"  block {b['index']}: {b['corrupted']:>2}/{b['correctable']} correctable used  [{bar}]")
        if integrity["logoScale"] is not None:
            estimated = integrity["estimatedSafeScale"]
            verified = integrity["verifiedSafeScale"]
            print(f"  logo scale, now            : {integrity['logoScale']:.2f}")
            print(f"    estimated safe (model)   : "
                  f"{'—' if estimated is None else f'{estimated:.2f}'}")
            print(f"    verified safe (decoder)  : "
                  f"{'not verified' if verified is None else f'{verified:.2f}'}")

        print("\noptical legibility (measured)")
        for c in optical["conditions"]:
            print(f"  {'ok  ' if c['ok'] else 'FAIL'} {c['condition']:<13}"
                  f" {c['pxPerModule']:>4} px/module")
        if optical["minWidthMm"]:
            print(f"  print at least {optical['minWidthMm']} mm wide")

        ink = r["logo"]
        if ink and ink["message"]:
            # Advisory, and printed as one: it is about the file the user supplied,
            # not about the symbol, and it never moves the exit code.
            print("\nabout the logo file (does not affect the verdict above)")
            print(f"  {ink['message']}")

        if r["fit"]:
            f = r["fit"]
            print(f"\nat the size you asked for ({f['size']:g} {f['unit']})")
            print(f"  {'ok  ' if f['ok'] else 'FAIL'} {f['message']}")

        if r["grade"] in ("fail", "fragile"):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
