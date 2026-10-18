"""Literal Gemini Live output checks with safe spoken-number equivalence."""

from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
import re
import unicodedata

def tokens(text, aliases=None):
    for original, replacement in (aliases or {}).items():
        text = re.sub(r"\b" + re.escape(original) + r"\b", replacement, text, flags=re.I)
    text = unicodedata.normalize("NFKD", text.casefold())
    text = "".join(c for c in text if not unicodedata.combining(c))
    result = []
    for token in re.findall(r"\d+(?:[.,]\d+)*|[^\W\d_]+", text):
        if token[0].isdigit():
            try:
                from num2words import num2words
                # Brazilian notation: a dot groups thousands when followed by
                # three digits; a comma separates the fractional portion.
                numeric = token.replace(".", "") if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?", token) else token
                token = num2words(Decimal(numeric.replace(",", ".")), lang="pt_BR")
                token = "".join(c for c in unicodedata.normalize("NFKD", token) if not unicodedata.combining(c))
            except (ImportError, ValueError, OverflowError, InvalidOperation):
                pass
        result.extend(re.findall(r"[^\W_]+", token))
    return result

VERSION = "live-literal-token-fidelity-v2"
MONTHS = (
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
)
NUMBER_WORDS = {
    "zero", "um", "uma", "dois", "duas", "tres", "quatro", "cinco",
    "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze",
    "catorze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito",
    "dezenove", "vinte", "trinta", "quarenta", "cinquenta", "sessenta",
    "setenta", "oitenta", "noventa", "cem", "cento", "duzentos",
    "duzentas", "trezentos", "trezentas", "quatrocentos", "quatrocentas",
    "quinhentos", "quinhentas", "seiscentos", "seiscentas", "setecentos",
    "setecentas", "oitocentos", "oitocentas", "novecentos", "novecentas",
    "mil", "milhao", "milhoes", "bilhao", "bilhoes", "trilhao", "trilhoes",
    "e", "menos", "por", "cento", "real", "reais", "centavo", "centavos",
}


def _expand_numeric_dates(text: str) -> str:
    def date(match):
        day, month, year = map(int, match.groups())
        if 1 <= day <= 31 and 1 <= month <= 12:
            return f"{day} de {MONTHS[month-1]} de {year}"
        return match.group()
    return re.sub(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", date, str(text))


def _num2words(value, *, to=None):
    try:
        from num2words import num2words
        if not callable(num2words):
            raise ImportError("missing numeric normalizer")
    except ImportError as exc:
        raise ValueError(
            "num2words indisponível; não validar nem gerar fala numérica sem o normalizador."
        ) from exc
    kwargs = {"lang": "pt_BR"}
    if to:
        kwargs["to"] = to
    return str(num2words(value, **kwargs))


def _year_aliases(year: int) -> list[str]:
    aliases = [str(year), _num2words(year)]
    if 2000 <= year <= 2099:
        tail = year % 100
        if tail:
            aliases.append(f"{_num2words(year // 100)} {_num2words(tail)}")
            aliases.append(
                re.sub(r"\bmil\s+e\s+", "mil ", _num2words(year), count=1)
            )
    return sorted({item.strip() for item in aliases if item.strip()}, key=len, reverse=True)


def _replace_phrase(text: str, phrase: str, marker: str) -> str:
    pattern = r"(?<!\w)" + re.escape(phrase) + r"(?!\w)"
    return re.sub(pattern, marker, text, flags=re.I)


def normalize_reference_year_equivalents(reference: str, transcript: str):
    reference_out = str(reference)
    transcript_out = str(transcript)
    equivalences = []
    years = sorted({
        int(match.group())
        for match in re.finditer(r"(?<!\d)(?:19|20)\d{2}(?!\d)", reference_out)
    })
    for year in years:
        standard = _num2words(year)
        marker = "anoequiv" + re.sub(r"[^a-z]", "", standard.casefold())
        aliases = _year_aliases(year)
        before_reference = reference_out
        before_transcript = transcript_out
        for alias in aliases:
            reference_out = _replace_phrase(reference_out, alias, marker)
            transcript_out = _replace_phrase(transcript_out, alias, marker)
        if reference_out != before_reference or transcript_out != before_transcript:
            equivalences.append({
                "year": year,
                "marker": marker,
                "accepted_aliases": aliases,
            })
    return reference_out, transcript_out, equivalences


def canonical_tokens(text, pronunciations=None):
    """Keep lexical tokens; normalize punctuation and numeric spelling only."""
    text = str(text)
    if re.search(r"\d", text):
        _num2words(0)

    text = _expand_numeric_dates(text)

    def currency(match):
        number = match.group(1)
        if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?", number):
            number = number.replace(".", "")
        return _num2words(Decimal(number.replace(",", ".")), to="currency")

    text = re.sub(r"R\$\s*(\d+(?:[.,]\d+)*)", currency, text, flags=re.I)
    text = re.sub(r"\b(\d+(?:[.,]\d+)*)\s+reais\b", currency, text, flags=re.I)

    def ordinal(match):
        spoken = _num2words(int(match.group(1)), to="ordinal")
        if match.group(2) == "ª":
            return " ".join(
                word[:-1] + "a" if word.endswith("o") else word
                for word in spoken.split()
            )
        return spoken

    text = re.sub(r"\b(\d+)([ºª])", ordinal, text)
    text = re.sub(r"(\d+(?:[.,]\d+)*)\s*%", r"\1 por cento", text)
    text = re.sub(r"(?<![\w])[-−](?=\d)", "menos ", text)
    return tokens(text, pronunciations)


def _numeric_difference_token(token: str) -> bool:
    normalized = tokens(str(token))
    if not normalized:
        return True
    for item in normalized:
        if item.startswith("anoequiv"):
            continue
        if item not in NUMBER_WORDS:
            return False
    return True


def _numeric_only_mismatch(differences: list[dict]) -> bool:
    if not differences:
        return False
    saw_numeric = False
    for difference in differences:
        changed = (
            list(difference.get("reference_tokens") or [])
            + list(difference.get("output_tokens") or [])
        )
        if not changed:
            continue
        if not all(_numeric_difference_token(token) for token in changed):
            return False
        saw_numeric = True
    return saw_numeric


def evaluate_transcription(reference, transcript, pronunciations=None, minimum=.985):
    reference_text, transcript_text, equivalences = normalize_reference_year_equivalents(
        _expand_numeric_dates(reference),
        _expand_numeric_dates(transcript),
    )
    expected = canonical_tokens(reference_text, pronunciations)
    actual = canonical_tokens(transcript_text, pronunciations)
    similarity = (
        round(
            SequenceMatcher(
                None, " ".join(expected), " ".join(actual), autojunk=False
            ).ratio(),
            6,
        )
        if expected and actual
        else 0.0
    )
    differences = []
    for tag, a, b, c, d in SequenceMatcher(
        None, expected, actual, autojunk=False
    ).get_opcodes():
        if tag != "equal":
            differences.append({
                "operation": tag,
                "reference_tokens": expected[a:b],
                "output_tokens": actual[c:d],
                "reference_start_token": a,
                "output_start_token": c,
            })
    exact = bool(expected) and expected == actual
    return {
        "version": VERSION,
        "passed": exact and similarity >= minimum,
        "similarity": similarity,
        "canonical_token_match": exact,
        "reference_token_count": len(expected),
        "output_token_count": len(actual),
        "differences": differences,
        "numeric_only_mismatch": _numeric_only_mismatch(differences),
        "numeric_equivalences": equivalences,
        "rule": (
            "all lexical tokens required; explicit pronunciations, numeric spelling, "
            "accents, punctuation and reference-bound equivalent year renderings are normalized"
        ),
    }
