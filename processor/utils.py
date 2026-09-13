from __future__ import annotations

import re
from pathlib import Path


def nome_seguro(texto: str, limite: int = 60) -> str:
    texto = re.sub(r"[^A-Za-z0-9_-]+", "_", str(texto)).strip("_")
    return (texto[:limite] or "corte")


def tempo_para_segundos(valor) -> float:
    if isinstance(valor, (int, float)):
        return float(valor)

    partes = str(valor).strip().split(":")
    if len(partes) == 1:
        return float(partes[0])
    if len(partes) == 2:
        return float(partes[0]) * 60 + float(partes[1])
    if len(partes) == 3:
        return float(partes[0]) * 3600 + float(partes[1]) * 60 + float(partes[2])

    raise ValueError(f"Tempo inválido: {valor}")


def garantir_pasta(path: str | Path) -> Path:
    pasta = Path(path)
    pasta.mkdir(parents=True, exist_ok=True)
    return pasta
