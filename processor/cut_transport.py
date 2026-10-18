"""Decode the optional gzip transport without unbounded decompression.

Legacy JSON strings pass through unchanged. Only the prefixed transport is
decoded here; JSON parsing and editorial validation remain with the caller.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import io
import zlib


COMPRESSED_PREFIX = "gzip-base64:"
MAXIMUM_TRANSPORT_CHARACTERS = 60_000
MAXIMUM_DECOMPRESSED_BYTES = 512_000


def decode_cuts_json(raw: str) -> str:
    if not isinstance(raw, str):
        raise ValueError("O pacote de cortes precisa ser texto JSON.")
    if not raw.startswith(COMPRESSED_PREFIX):
        return raw
    if len(raw) > MAXIMUM_TRANSPORT_CHARACTERS:
        raise ValueError("O pacote de cortes comprimido excede 60000 caracteres de transporte.")
    try:
        compressed = base64.b64decode(raw[len(COMPRESSED_PREFIX):], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("O pacote de cortes comprimido contém base64 inválido.") from exc
    if not compressed.startswith(b"\x1f\x8b"):
        raise ValueError("O pacote de cortes comprimido contém gzip inválido.")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as reader:
            # A bounded read is essential: gzip.decompress would allocate the
            # whole expanded payload before its length could be checked.
            decoded = reader.read(MAXIMUM_DECOMPRESSED_BYTES + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise ValueError("O pacote de cortes comprimido contém gzip inválido.") from exc
    if len(decoded) > MAXIMUM_DECOMPRESSED_BYTES:
        raise ValueError("O pacote de cortes descompactado excede 512000 bytes. Divida o lote.")
    try:
        return decoded.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("O pacote de cortes descompactado não contém texto UTF-8 válido.") from exc
