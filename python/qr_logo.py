#!/usr/bin/env python3
"""Generate a QR code with a logo.

Two modes:
  center plate  -- logo sits in the middle of a normal QR (default)
  art / full bleed -- artwork fills the whole code and modules become small
                      marks drawn on top of it (--art)

Usage:
  python scripts/qr_logo.py "https://insdash.ch" logo/Logo-circle.png menu-qr.png
  python scripts/qr_logo.py "https://insdash.ch" logo/Logo-circle.png art.png --art --mark cross
"""
import argparse
import qrcode
from qrcode.constants import ERROR_CORRECT_H
from qrcode.util import pattern_position
from PIL import Image, ImageChops, ImageColor, ImageDraw

TRANSPARENT = {"none", "transparent", "clear"}
STYLES = ("square", "circle", "rounded")
MARKS = ("cross", "dot", "square")

# A dark module is already fine if the art under it is darker than this; a light
# module is fine if the art is lighter than LIGHT_OK. Anything in between gets a
# mark painted on so the scanner reads the right value.
DARK_OK, LIGHT_OK = 90, 165


def _rgba(color):
    return (0, 0, 0, 0) if str(color).strip().lower() in TRANSPARENT else ImageColor.getcolor(color, "RGBA")


def _finder_boxes(matrix, border):
    """Top-left corners of the three 7x7 finder patterns, in module coords."""
    n = len(matrix)
    return [(border, border), (border, n - border - 7), (n - border - 7, border)]


def _finder_cells(matrix, border):
    return {(r, c) for r0, c0 in _finder_boxes(matrix, border)
            for r in range(r0, r0 + 7) for c in range(c0, c0 + 7)}


def _structural_cells(matrix, border, version):
    """Timing and alignment patterns.

    These are how a scanner works out the module grid before it reads any data.
    Rendered as loose marks over artwork they stop resolving, so art mode paints
    them as solid modules.
    """
    n = len(matrix)
    cells = set()
    for i in range(border + 7, n - border - 7):          # timing lines
        cells.add((border + 6, i))
        cells.add((i, border + 6))
    finders = {(border, border), (border, n - border - 7), (n - border - 7, border)}
    for a in pattern_position(version):                   # alignment patterns
        for b in pattern_position(version):
            r0, c0 = border + a - 2, border + b - 2
            if (r0 - 2, c0 - 2) in finders or (r0, c0) in finders:
                continue
            if any(abs(r0 - fr) < 7 and abs(c0 - fc) < 7 for fr, fc in finders):
                continue
            for r in range(r0, r0 + 5):
                for c in range(c0, c0 + 5):
                    cells.add((r, c))
    return cells


def _fit_clear_of_finders(art_path, matrix, box, border, gap=0.5, res=3):
    """Largest artwork scale whose opaque pixels stay clear of the finder discs.

    Binary search on scale, testing the artwork's alpha channel against the three
    finder circles -- so a round logo can stay large while a square one shrinks.
    """
    n = len(matrix)
    code = (n - 2 * border) * box
    discs = [((c0 + 3.5) * res, (r0 + 3.5) * res, ((3.5 + gap) * res) ** 2)
             for r0, c0 in _finder_boxes(matrix, border)]
    art = Image.open(art_path).convert("RGBA")

    def hits(scale):
        a = art.copy()
        a.thumbnail((int(code * scale),) * 2, Image.LANCZOS)
        gw = max(1, round(a.size[0] * res / box))
        gh = max(1, round(a.size[1] * res / box))
        alpha = a.getchannel("A").resize((gw, gh), Image.BOX).tobytes()
        ox = border * res + ((n - 2 * border) * res - gw) / 2
        oy = border * res + ((n - 2 * border) * res - gh) / 2
        for i, av in enumerate(alpha):
            if av <= 16:
                continue
            px, py = ox + i % gw + 0.5, oy + i // gw + 0.5
            for cx, cy, r2 in discs:
                if (px - cx) ** 2 + (py - cy) ** 2 <= r2:
                    return True
        return False

    if not hits(1.0):
        return 1.0
    lo, hi = 0.05, 1.0
    for _ in range(14):
        mid = (lo + hi) / 2
        hi, lo = (mid, lo) if hits(mid) else (hi, mid)
    return lo


def _mark(d, cx, cy, r, shape, fill, target=None):
    d = target or d
    if shape == "dot":
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    elif shape == "square":
        d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=fill)
    else:  # four-pointed star
        w = r * 0.4
        d.polygon([(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
                   (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)], fill=fill)


def _render(matrix, box, border, fg, bg, style, ss=4):
    """Plain QR, drawn per-module so each one can be a square, dot or rounded square."""
    n = len(matrix)
    size = n * box
    img = Image.new("RGBA", (size * ss, size * ss), bg)
    d = ImageDraw.Draw(img)
    b = box * ss

    # Finder patterns stay solid -- scanners lock onto these, and turning them
    # into loose dots is the main reason "fancy" QR codes fail to read.
    skip = _finder_cells(matrix, border)
    for r0, c0 in _finder_boxes(matrix, border):
        x, y = c0 * b, r0 * b
        rad = b * 0.9 if style != "square" else 0
        d.rounded_rectangle([x, y, x + 7 * b - 1, y + 7 * b - 1], radius=rad, fill=fg)
        d.rounded_rectangle([x + b, y + b, x + 6 * b - 1, y + 6 * b - 1], radius=rad * 0.7, fill=bg)
        d.rounded_rectangle([x + 2 * b, y + 2 * b, x + 5 * b - 1, y + 5 * b - 1], radius=rad * 0.5, fill=fg)

    for r, row in enumerate(matrix):
        for c, on in enumerate(row):
            if not on or (r, c) in skip:
                continue
            x, y = c * b, r * b
            if style == "circle":
                d.ellipse([x, y, x + b - 1, y + b - 1], fill=fg)
            elif style == "rounded":
                d.rounded_rectangle([x, y, x + b - 1, y + b - 1], radius=b * 0.35, fill=fg)
            else:
                d.rectangle([x, y, x + b - 1, y + b - 1], fill=fg)

    return img.resize((size, size), Image.LANCZOS)


def _render_art(matrix, box, border, version, art_path, fg, bg, mark="cross", dot=0.6,
                art_scale=1.0, loose=False, ss=4):
    """Artwork fills the code; modules become small marks drawn over it.

    A scanner samples the middle of each module, so a small mark at each centre
    carries the data while the artwork stays visible in between.
    """
    n = len(matrix)
    size = n * box
    light = (255, 255, 255, 255) if bg[3] == 0 else bg
    base = Image.new("RGBA", (size, size), bg)

    code_px = (n - 2 * border) * box
    art = Image.open(art_path).convert("RGBA")
    art.thumbnail((int(code_px * art_scale),) * 2, Image.LANCZOS)
    art_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    art_layer.alpha_composite(art, (border * box + (code_px - art.size[0]) // 2,
                                    border * box + (code_px - art.size[1]) // 2))
    base.alpha_composite(art_layer)

    # Brightness of the artwork at each module's centre -- a scanner samples the
    # middle of a module, so the centre matters and the whole-module mean does not.
    flat = Image.new("RGB", base.size, light[:3])
    flat.paste(base, (0, 0), base)
    lum = flat.convert("L").resize((n * 3, n * 3), Image.BOX)

    ov = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    # On a transparent background, a light module over the artwork is punched
    # through the artwork instead of painted white, so the surface behind the
    # code shows through and supplies the light value.
    punch = bg[3] == 0
    erase = Image.new("L", (size * ss, size * ss), 0) if punch else None
    ed = ImageDraw.Draw(erase) if punch else None
    b, skip = box * ss, _finder_cells(matrix, border)
    solid = set() if loose else _structural_cells(matrix, border, version) - skip
    r = b * dot / 2

    for row, cells in enumerate(matrix):
        for col, on in enumerate(cells):
            if (row, col) in skip:
                continue
            cx, cy = col * b + b / 2, row * b + b / 2
            cell = [col * b, row * b, (col + 1) * b - 1, (row + 1) * b - 1]
            if (row, col) in solid:
                if on:
                    d.rectangle(cell, fill=fg)
                elif punch:
                    ed.rectangle(cell, fill=255)
                else:
                    d.rectangle(cell, fill=light)
                continue
            L = lum.getpixel((col * 3 + 1, row * 3 + 1))
            if on and L > DARK_OK:
                _mark(d, cx, cy, r, mark, fg)
            elif not on and L < LIGHT_OK:
                _mark(d, cx, cy, r, mark, erase and 255 or light, ed if punch else d)

    base.alpha_composite(ov.resize((size, size), Image.LANCZOS))
    if punch:
        base.paste(Image.new("RGBA", (size, size), (0, 0, 0, 0)), (0, 0),
                   erase.resize((size, size), Image.LANCZOS))

    # Bold circular finder patterns. On a transparent background the middle ring
    # is punched through rather than filled white -- but only where no artwork
    # sits under it, since artwork showing through would read as a dark module.
    fin = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    fmask = Image.new("L", (size * ss, size * ss), 0)
    fd, fm = ImageDraw.Draw(fin), ImageDraw.Draw(fmask)
    for r0, c0 in _finder_boxes(matrix, border):
        cx, cy = (c0 + 3.5) * b, (r0 + 3.5) * b
        under = art_layer.crop((int(c0 * box), int(r0 * box),
                                int((c0 + 7) * box), int((r0 + 7) * box))).getchannel("A")
        disc = Image.new("L", under.size, 0)
        ImageDraw.Draw(disc).ellipse([0, 0, under.size[0] - 1, under.size[1] - 1], fill=255)
        clear = ImageChops.multiply(under, disc).getextrema()[1] <= 16
        mid = (0, 0, 0, 0) if (bg[3] == 0 and clear) else light
        for rad, fill in ((3.5, fg), (2.5, mid), (1.5, fg)):
            fd.ellipse([cx - rad * b, cy - rad * b, cx + rad * b, cy + rad * b], fill=fill)
        fm.ellipse([cx - 3.5 * b, cy - 3.5 * b, cx + 3.5 * b, cy + 3.5 * b], fill=255)

    base.paste(fin.resize((size, size), Image.LANCZOS),
               (0, 0), fmask.resize((size, size), Image.LANCZOS))
    return base


def make_qr(data, logo_path, out_path, scale=0.22, fg="#000000", bg="#ffffff",
            box_size=20, border=4, pad=14, radius=0.18, style="square",
            art=False, mark="cross", dot=0.6, art_scale=1.0, loose=False,
            clear_finders=False):
    fg_c, bg_c = _rgba(fg), _rgba(bg)
    transparent = bg_c[3] == 0

    # High error correction (~30% of the code can be damaged/covered and still scan)
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, box_size=box_size, border=border)
    qr.add_data(data)
    qr.make(fit=True)
    matrix = qr.get_matrix()

    if art:
        if clear_finders:
            art_scale = min(art_scale, _fit_clear_of_finders(logo_path, matrix, box_size, border))
        img = _render_art(matrix, box_size, border, qr.version, logo_path, fg_c, bg_c,
                          mark=mark, dot=dot, art_scale=art_scale, loose=loose)
    else:
        img = _render(matrix, box_size, border, fg_c, bg_c, style)

        W, H = img.size
        logo = Image.open(logo_path).convert("RGBA")

        # Keep the logo <= ~25% of the QR width so it stays scannable
        logo.thumbnail((int(W * scale),) * 2, Image.LANCZOS)
        pw, ph = logo.size[0] + 2 * pad, logo.size[1] + 2 * pad
        box = ((W - pw) // 2, (H - ph) // 2)

        # Rounded plate behind the logo so it never sits on top of live modules.
        # Opaque background -> paint the plate in bg. Transparent -> punch a hole.
        m = Image.new("L", (pw, ph), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, pw - 1, ph - 1],
                                           radius=int(min(pw, ph) * radius), fill=255)
        img.paste(Image.new("RGBA", (pw, ph), bg_c), box, m)
        img.alpha_composite(logo, (box[0] + pad, box[1] + pad))

    if transparent and not out_path.lower().endswith(".png"):
        raise SystemExit("transparent output needs a .png file (jpg has no alpha channel)")
    img.save(out_path) if transparent else img.convert("RGB").save(out_path, quality=95)
    return out_path, img.size


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("data")
    p.add_argument("logo")
    p.add_argument("out")
    p.add_argument("--scale", type=float, default=0.22, help="centre logo size, fraction of width")
    p.add_argument("--fg", default="#000000")
    p.add_argument("--bg", default="#ffffff", help='background color, or "none" for transparent')
    p.add_argument("--style", default="square", choices=STYLES, help="module shape")
    p.add_argument("--box-size", type=int, default=20)
    p.add_argument("--art", action="store_true", help="full-bleed artwork behind the modules")
    p.add_argument("--mark", default="cross", choices=MARKS, help="module mark in --art mode")
    p.add_argument("--dot", type=float, default=0.6, help="mark size, fraction of a module")
    p.add_argument("--art-scale", type=float, default=1.0, help="artwork size within the code")
    p.add_argument("--clear-finders", action="store_true",
                   help="shrink the artwork so it never touches the three corner circles")
    p.add_argument("--loose", action="store_true",
                   help="leave timing/alignment patterns as marks too (prettier, less robust)")
    a = p.parse_args()
    path, size = make_qr(a.data, a.logo, a.out, scale=a.scale, fg=a.fg, bg=a.bg,
                         box_size=a.box_size, style=a.style, art=a.art, mark=a.mark,
                         dot=a.dot, art_scale=a.art_scale, loose=a.loose,
                         clear_finders=a.clear_finders)
    print(f"wrote {path} ({size[0]}x{size[1]})")
