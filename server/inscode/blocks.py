"""Which codeword does each module carry, and how much damage can each block take?

This is the exact half of the scannability question. A QR code is not protected as
one lump: the payload is split into Reed-Solomon blocks, each with its own error
budget, and the codewords are interleaved across the symbol so that a scratch in one
place is spread over every block. So "the logo covers 31%, level H recovers 30%" is
not a calculation -- it is an average compared against an area. The real constraint
is the *worst* block, and answering that needs the module -> codeword map.

Everything here is integer arithmetic over (version, EC level). No rendering, no
decoding, no images: two designs with the same version and EC level have the same
map, and it is the same map in every implementation of ISO/IEC 18004.

Mirrors web/src/qr/blocks.ts -- change both together.
"""
from dataclasses import dataclass

from .geometry import reserved_cells, symbol_size

EC_LEVELS = ("L", "M", "Q", "H")

# ISO/IEC 18004 Table 9, indexed [(version - 1) * 4 + level]. The same layout both
# python-qrcode and node-qrcode use internally, which is what test_audit.py and
# audit.test.ts check this against -- neither library exposes it as public API, so
# the table lives here and each side is pinned to its own library's copy.
#: Reed-Solomon blocks the payload is split into.
EC_BLOCKS = (
      1,   1,   1,   1,   1,   1,   1,   1,
      1,   1,   2,   2,   1,   2,   2,   4,
      1,   2,   4,   4,   2,   4,   4,   4,
      2,   4,   6,   5,   2,   4,   6,   6,
      2,   5,   8,   8,   4,   5,   8,   8,
      4,   5,   8,  11,   4,   8,  10,  11,
      4,   9,  12,  16,   4,   9,  16,  16,
      6,  10,  12,  18,   6,  10,  17,  16,
      6,  11,  16,  19,   6,  13,  18,  21,
      7,  14,  21,  25,   8,  16,  20,  25,
      8,  17,  23,  25,   9,  17,  23,  34,
      9,  18,  25,  30,  10,  20,  27,  32,
     12,  21,  29,  35,  12,  23,  34,  37,
     12,  25,  34,  40,  13,  26,  35,  42,
     14,  28,  38,  45,  15,  29,  40,  48,
     16,  31,  43,  51,  17,  33,  45,  54,
     18,  35,  48,  57,  19,  37,  51,  60,
     19,  38,  53,  63,  20,  40,  56,  66,
     21,  43,  59,  70,  22,  45,  62,  74,
     24,  47,  65,  77,  25,  49,  68,  81,
)
#: Error-correction codewords in each of those blocks. Uniform within a version/level.
EC_PER_BLOCK = (
      7,  10,  13,  17,  10,  16,  22,  28,
     15,  26,  18,  22,  20,  18,  26,  16,
     26,  24,  18,  22,  18,  16,  24,  28,
     20,  18,  18,  26,  24,  22,  22,  26,
     30,  22,  20,  24,  18,  26,  24,  28,
     20,  30,  28,  24,  24,  22,  26,  28,
     26,  22,  24,  22,  30,  24,  20,  24,
     22,  24,  30,  24,  24,  28,  24,  30,
     28,  28,  28,  28,  30,  26,  28,  28,
     28,  26,  26,  26,  28,  26,  30,  28,
     28,  26,  28,  30,  28,  28,  30,  24,
     30,  28,  30,  30,  30,  28,  30,  30,
     26,  28,  30,  30,  28,  28,  28,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
     30,  28,  30,  30,  30,  28,  30,  30,
)

# Misdecode protection: ISO/IEC 18004 spends a few of the smallest symbols' error
# correction codewords on detecting a wrong decode rather than repairing one, so
# those blocks correct fewer errors than ec/2. Zero from version 4 up, which is
# every code this tool realistically produces -- but the small ones should not
# quietly overstate their budget.
_PROTECTION = {(1, "L"): 3, (1, "M"): 2, (1, "Q"): 1, (1, "H"): 1, (2, "L"): 2, (3, "L"): 1}


@dataclass(frozen=True)
class Block:
    index: int
    data_codewords: int
    ec_codewords: int
    #: Codewords in this block that Reed-Solomon can repair. Any wrong bit in a
    #: codeword spends the whole codeword, however many of its 8 modules are wrong.
    correctable: int


@dataclass(frozen=True)
class BlockPlan:
    version: int
    ec_level: str
    blocks: tuple[Block, ...]
    total_codewords: int
    #: Trailing modules that carry no codeword. Damage here is free.
    remainder_bits: int
    #: Owning block for each codeword, in the interleaved order they are placed.
    owners: tuple[int, ...]


def data_modules(version: int) -> int:
    """Modules available to codewords: everything that is not a function pattern.

    `reserved_cells` already knows precisely which those are, so the codeword count
    and the remainder bits fall out of the geometry rather than a second table.
    """
    size = symbol_size(version)
    return size * size - len(reserved_cells(version))


def block_plan(version: int, ec_level: str) -> BlockPlan:
    i = (version - 1) * 4 + EC_LEVELS.index(ec_level)
    count = EC_BLOCKS[i]
    ec_per_block = EC_PER_BLOCK[i]

    available = data_modules(version)
    total = available // 8
    data_total = total - count * ec_per_block

    # Blocks come in at most two sizes, and the longer ones go last.
    long_blocks = total % count
    short_data = data_total // count
    correctable = (ec_per_block - _PROTECTION.get((version, ec_level), 0)) // 2

    blocks = tuple(
        Block(
            index=b,
            data_codewords=short_data + (1 if b >= count - long_blocks else 0),
            ec_codewords=ec_per_block,
            correctable=correctable,
        )
        for b in range(count)
    )

    # Interleaving, ISO/IEC 18004 s8.6: the nth data codeword of every block in turn,
    # then the nth EC codeword of every block. This is why a logo cannot be "31% of
    # one block" -- a contiguous patch of the symbol lands on all of them at once.
    owners: list[int] = []
    for n in range(max(b.data_codewords for b in blocks)):
        owners.extend(b.index for b in blocks if n < b.data_codewords)
    for _ in range(ec_per_block):
        owners.extend(b.index for b in blocks)

    return BlockPlan(
        version=version,
        ec_level=ec_level,
        blocks=blocks,
        total_codewords=total,
        remainder_bits=available - total * 8,
        owners=tuple(owners),
    )


def placement_order(version: int) -> list[tuple[int, int]]:
    """Every data module, in the order the codeword bits are written into it.

    ISO/IEC 18004 s8.7.3: two-module-wide columns walked right to left, the symbol
    traversed upward then downward in alternation, skipping the vertical timing
    pattern so the pairing stays aligned. Function patterns are stepped over rather
    than counted.
    """
    size = symbol_size(version)
    reserved = reserved_cells(version)
    out: list[tuple[int, int]] = []
    row, col, upward = size - 1, size - 1, True

    while col > 0:
        if col == 6:  # the timing column is never half of a data pair
            col -= 1
        for _ in range(size):
            for c in (col, col - 1):
                if (row, c) not in reserved:
                    out.append((row, c))
            row += -1 if upward else 1
        row += 1 if upward else -1  # back onto the symbol before turning around
        upward = not upward
        col -= 2

    return out


def module_codewords(version: int, ec_level: str) -> dict[tuple[int, int], int]:
    """Module -> the index of the codeword whose bits it carries.

    Remainder modules are absent: they hold padding bits no decoder reads, so
    damaging them costs nothing and they should not be charged to a block.
    """
    plan = block_plan(version, ec_level)
    return {
        cell: i >> 3
        for i, cell in enumerate(placement_order(version))
        if i >> 3 < plan.total_codewords
    }
