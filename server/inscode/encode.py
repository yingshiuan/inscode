"""Text -> QR matrix, and the bit-packing used to ship a matrix inside a QRSpec."""
import base64

import qrcode
from qrcode.constants import ERROR_CORRECT_H, ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q

from .spec import Encoded, QRSpec

_EC = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}


class Matrix:
    """A decoded matrix. Reserved cells come from geometry.py, not from here, so
    that both renderers derive them from the same rules."""

    __slots__ = ("size", "version", "mask_pattern", "_bits")

    def __init__(self, size: int, version: int, mask_pattern: int, bits: bytes):
        self.size = size
        self.version = version
        self.mask_pattern = mask_pattern
        self._bits = bits

    def get(self, row: int, col: int) -> bool:
        if not (0 <= row < self.size and 0 <= col < self.size):
            return False
        i = row * self.size + col
        return bool(self._bits[i >> 3] & (0x80 >> (i & 7)))


def _pack(size: int, rows) -> bytes:
    out = bytearray((size * size + 7) // 8)
    for r in range(size):
        for c in range(size):
            if rows[r][c]:
                i = r * size + c
                out[i >> 3] |= 0x80 >> (i & 7)
    return bytes(out)


def encode(text: str, ec_level: str = "H", mask_pattern: int | None = None) -> Encoded:
    """Encode text. Pass `mask_pattern` to reproduce an earlier encode exactly."""
    qr = qrcode.QRCode(
        error_correction=_EC[ec_level],
        border=0,  # the quiet zone is added at render time, as in the TS side
        mask_pattern=mask_pattern,
    )
    qr.add_data(text or " ")
    qr.make(fit=True)
    if mask_pattern is None:
        # python-qrcode picks a mask but never records which. best_mask_pattern()
        # recomputes it -- and leaves the last *test* mask in qr.modules as a side
        # effect, so the chosen one has to be re-applied before reading the matrix.
        mask_pattern = qr.best_mask_pattern()
        qr.makeImpl(False, mask_pattern)
    rows = qr.get_matrix()
    size = len(rows)
    chosen = mask_pattern
    return Encoded(
        version=qr.version,
        maskPattern=int(chosen),
        size=size,
        bits=base64.b64encode(_pack(size, rows)).decode("ascii"),
    )


def matrix_from_encoded(enc: Encoded) -> Matrix:
    bits = base64.b64decode(enc.bits)
    need = (enc.size * enc.size + 7) // 8
    if len(bits) < need:
        raise ValueError(f"encoded.bits too short: {len(bits)} < {need}")
    return Matrix(enc.size, enc.version, enc.mask_pattern, bits)


def matrix_for(spec: QRSpec) -> Matrix:
    """The matrix for a spec. `spec.encoded` wins when present."""
    enc = spec.encoded or encode(spec.content.text, spec.content.ec_level)
    return matrix_from_encoded(enc)
