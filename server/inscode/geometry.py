"""Function-pattern geometry, derived from version + size alone.

Mirrors web/src/qr/geometry.ts -- change both together. The TypeScript side has a
test pinning this logic against node-qrcode's own `isReserved()` for versions
1..40, which is what keeps the two renderers agreeing module for module.
"""


def symbol_size(version: int) -> int:
    return version * 4 + 17


def finder_boxes(size: int) -> list[tuple[int, int]]:
    """Top-left corners of the three 7x7 finder patterns. Quiet zone excluded."""
    return [(0, 0), (0, size - 7), (size - 7, 0)]


def finder_centres(size: int) -> list[tuple[float, float]]:
    return [(c + 3.5, r + 3.5) for r, c in finder_boxes(size)]


def finder_cells(size: int) -> set[tuple[int, int]]:
    return {
        (r, c)
        for r0, c0 in finder_boxes(size)
        for r in range(r0, r0 + 7)
        for c in range(c0, c0 + 7)
    }


def alignment_coords(version: int) -> list[int]:
    """Alignment-pattern centres. Version 1 has none; 6 and size-7 always bracket the run."""
    if version <= 1:
        return []
    size = symbol_size(version)
    pos_count = version // 7 + 2
    interval = 26 if size == 145 else -(-(size - 13) // (2 * pos_count - 2)) * 2
    positions = [size - 7]
    for i in range(1, pos_count - 1):
        positions.append(positions[i - 1] - interval)
    positions.append(6)
    return sorted(positions)


def alignment_cells(version: int) -> set[tuple[int, int]]:
    size = symbol_size(version)
    coords = alignment_coords(version)
    cells: set[tuple[int, int]] = set()
    for a in coords:
        for b in coords:
            if (a, b) in {(6, 6), (6, size - 7), (size - 7, 6)}:
                continue
            for r in range(a - 2, a + 3):
                for c in range(b - 2, b + 3):
                    cells.add((r, c))
    return cells


def reserved_cells(version: int) -> set[tuple[int, int]]:
    """Every cell a scanner uses to find and decode the grid before reading data.

    Finders and separators, timing, alignment, format info, the dark module, and
    version info on version 7 and up. Art mode paints these solid -- drawn as loose
    marks over artwork they stop resolving and the code dies.
    """
    size = symbol_size(version)
    cells: set[tuple[int, int]] = set()

    def add(r: int, c: int) -> None:
        if 0 <= r < size and 0 <= c < size:
            cells.add((r, c))

    for row, col in finder_boxes(size):
        r0 = 0 if row == 0 else row - 1
        c0 = 0 if col == 0 else col - 1
        for r in range(r0, r0 + 8):
            for c in range(c0, c0 + 8):
                add(r, c)

    for i in range(size):
        add(6, i)
        add(i, 6)

    cells |= alignment_cells(version)

    for i in range(9):
        add(8, i)
        add(i, 8)
    for i in range(8):
        add(8, size - 1 - i)
        add(size - 1 - i, 8)

    if version >= 7:
        for i in range(6):
            for j in range(3):
                add(i, size - 11 + j)
                add(size - 11 + j, i)

    return cells


def structural_cells(version: int) -> set[tuple[int, int]]:
    """Reserved cells minus the finder discs -- what art mode draws as solid modules."""
    return reserved_cells(version) - finder_cells(symbol_size(version))


#: Format and version information are the only function patterns with error
#: correction of their own: 15 bits under BCH(15,5) and 18 under BCH(18,6), each
#: written twice in different corners. Both codes correct up to three wrong bits, and
#: a decoder reads whichever copy comes back cleaner -- so damage is fatal only when
#: *both* copies are past this.
FUNCTION_BCH_CORRECTS = 3

#: Human names for the kinds of grid cell, for reports that must say which.
GRID_KINDS = ("alignment", "timing", "separator")


def format_info_copies(version: int) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    """The two copies of the 15-bit format information (ISO/IEC 18004 s8.9).

    One wraps the top-left finder; the other is split between the top-right and
    bottom-left. Column 6 and row 6 are skipped -- the timing patterns run through
    there -- and the always-dark module is not part of either copy.
    """
    size = symbol_size(version)
    around_top_left = {(8, c) for c in range(9) if c != 6} | {(r, 8) for r in range(9) if r != 6}
    split = {(8, size - 1 - i) for i in range(8)} | {(size - 1 - i, 8) for i in range(7)}
    return around_top_left, split


def version_info_copies(version: int) -> tuple[set[tuple[int, int]], set[tuple[int, int]]] | None:
    """The two copies of the 18-bit version information, or None below version 7."""
    if version < 7:
        return None
    size = symbol_size(version)
    top_right = {(r, size - 11 + j) for r in range(6) for j in range(3)}
    bottom_left = {(size - 11 + j, c) for c in range(6) for j in range(3)}
    return top_right, bottom_left


def dark_module(version: int) -> tuple[int, int]:
    """The module that is always dark. No decoder reads it, so nothing depends on it."""
    return (symbol_size(version) - 8, 8)


def grid_kinds(version: int) -> dict[tuple[int, int], str]:
    """Cells that help a scanner lock the module grid, and what each one is.

    Everything here carries no error correction of its own -- but "no error
    correction" is not the same as "fatal", and measuring the difference matters. A
    decoder built like zxing (and, from the evidence, the iPhone camera) derives the
    grid from the three finder patterns: their run widths give the module size and
    their spacing gives the dimension. So:

      * Timing and alignment damage is survivable, and by a wide margin. Destroying
        row 6, column 6 and every alignment cell of a version-3 symbol still decodes
        at every size tested, blurred included; so does wiping all 325 alignment cells
        of a version-13 symbol under a 26% perspective tilt.
      * Separator damage is not, because it is really finder damage: a dark module
        against a finder's outer ring merges the runs and the 1:1:3:1:1 ratio scan
        stops matching. That failure is caught where it belongs, by widening
        `audit.finder_profiles` to require the finder to be isolated.

    So this set is reported as a caution rather than a cause of death, named by kind
    because which one it is changes what to do -- the timing patterns are at row and
    column 6, the alignment patterns wherever the version puts them. Alignment is
    classified first: an alignment pattern centred on row 6 genuinely overlaps the
    timing run, and the more specific structure is the more useful name.

    Excluded: the finder discs (found by ratio, not read), the format and version
    information (BCH-protected and duplicated), and the always-dark module.
    """
    protected = {dark_module(version)}
    for copies in (format_info_copies(version), version_info_copies(version)):
        if copies:
            protected |= copies[0] | copies[1]

    alignment = alignment_cells(version)
    out: dict[tuple[int, int], str] = {}
    for r, c in structural_cells(version) - protected:
        if (r, c) in alignment:
            out[(r, c)] = "alignment"
        elif r == 6 or c == 6:
            out[(r, c)] = "timing"
        else:
            out[(r, c)] = "separator"
    return out
