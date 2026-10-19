"""Channel identity for new publication metadata; source speech stays literal."""
from __future__ import annotations

import re


CHANNEL_NAME = "OS4 de Direita"
CHANNEL_HANDLE = "@os4dedireita"
CHANNEL_BADGE = "OS4 DE DIREITA"
CHANNEL_SIGNATURE = f"Siga {CHANNEL_HANDLE} para mais análises e comentários de direita."

_URL = re.compile(r"(https?://[^\s<>]+)", re.IGNORECASE)
_LEGACY_HANDLE = re.compile(r"(?<![\w@])@os4[._]?cortes(?!\w|\.\w)", re.IGNORECASE)
_LEGACY_HASHTAG = re.compile(r"(?<![\w#])#os4[._]?cortes(?!\w|\.\w)", re.IGNORECASE)
_LEGACY_NAME = re.compile(r"(?<![\w/@#\\])os4\s+cortes\b", re.IGNORECASE)
_LEGACY_SLUG = re.compile(r"(?<![\w/@#\\])os4[._]?cortes(?!\w|\.\w)", re.IGNORECASE)
_LEGACY_SIGNATURE = re.compile(
    r"Siga\s+@os4(?:[._]?cortes|dedireita)\s+para mais insights diários sobre negócios e liderança\.?",
    re.IGNORECASE,
)


def normalize_branding(value: str) -> str:
    """Update channel references in owned text, preserving URLs and other names.

    Apply only to titles/descriptions/tags owned by the channel. Transcripts,
    source credits and literal editorial narration are never rewritten here.
    """
    parts = _URL.split(value)
    for index in range(0, len(parts), 2):
        text = _LEGACY_SIGNATURE.sub(CHANNEL_SIGNATURE, parts[index])
        text = _LEGACY_HANDLE.sub(CHANNEL_HANDLE, text)
        text = _LEGACY_HASHTAG.sub("#os4dedireita", text)
        text = _LEGACY_NAME.sub(CHANNEL_NAME, text)
        parts[index] = _LEGACY_SLUG.sub("os4dedireita", text)
    return "".join(parts)


def ensure_channel_signature(value: str) -> str:
    """Use the current identity and append its CTA only when absent."""
    text = normalize_branding(value).strip()
    # Reused packages may already contain the same generated signature twice.
    seen = False

    def signature_once(match):
        nonlocal seen
        if seen:
            return ""
        seen = True
        return CHANNEL_SIGNATURE

    text = re.sub(re.escape(CHANNEL_SIGNATURE), signature_once, text, flags=re.IGNORECASE)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text).strip()
    if not re.search(r"(?<![\w@])@os4dedireita(?!\w|\.\w)", text, re.IGNORECASE):
        text = f"{text}\n\n{CHANNEL_SIGNATURE}" if text else CHANNEL_SIGNATURE
    return text
