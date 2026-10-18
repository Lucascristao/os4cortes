"""Canonical Gemini Live voice policy and request configuration."""

import hashlib
import json
from pathlib import Path
import re

VOICE_POLICY_PATH = Path(__file__).with_name("voice-policy.json")
VOICE_POLICY = json.loads(VOICE_POLICY_PATH.read_text(encoding="utf-8"))
VOICE_POLICY_VERSION = VOICE_POLICY["version"]
TTS_MODEL_CASCADE = tuple(VOICE_POLICY["model_cascade"])
if TTS_MODEL_CASCADE != ("gemini-3.8-live",):
    raise RuntimeError("Política de voz deve usar somente gemini-3.8-live.")

PRIMARY_TTS_MODEL = TTS_MODEL_CASCADE[0]
SECONDARY_TTS_MODEL = "gemini-3.8-flash-lite-tts"
FALLBACK_TTS_MODEL = "gemini-3.1-flash-tts-preview"
ELIGIBLE_FALLBACK_FAILURES = frozenset()

PRESENTER_VOICES = {
    key: value["voice"] for key, value in VOICE_POLICY["presenters"].items()
}
PRESENTER_NAMES = {
    key: value["name"] for key, value in VOICE_POLICY["presenters"].items()
}
DEFAULT_PRESENTER = VOICE_POLICY["default_presenter"]
DEFAULT_TTS_VOICE = PRESENTER_VOICES[DEFAULT_PRESENTER]
VOICE_LANGUAGE = VOICE_POLICY["language"]
VOICE_DELIVERY_STYLE = VOICE_POLICY["delivery_style"]
NO_VOICE_TREATMENT = VOICE_POLICY["raw_audio_treatment"]
MINIMUM_TRANSCRIPTION_SIMILARITY = float(
    VOICE_POLICY["minimum_transcription_similarity"]
)
LIVE_RUNTIME = VOICE_POLICY["live_runtime"]
GOOGLE_GENAI_REQUIRED_VERSION = str(LIVE_RUNTIME["sdk_version"])
LIVE_MAX_ATTEMPTS = int(LIVE_RUNTIME["max_attempts"])
LIVE_RETRY_BACKOFF_SECONDS = tuple(
    int(value) for value in LIVE_RUNTIME["retry_backoff_seconds"]
)
LIVE_FIRST_AUDIO_TIMEOUT_SECONDS = float(
    LIVE_RUNTIME["first_audio_timeout_seconds"]
)
LIVE_STREAM_IDLE_TIMEOUT_SECONDS = float(
    LIVE_RUNTIME["stream_idle_timeout_seconds"]
)
LIVE_POST_GENERATION_GRACE_SECONDS = float(
    LIVE_RUNTIME["post_generation_grace_seconds"]
)
LIVE_ACCEPT_GENERATION_COMPLETE_WITHOUT_TURN_COMPLETE = bool(
    LIVE_RUNTIME["accept_generation_complete_without_turn_complete"]
)
LIVE_EXPECTED_SPEECH_WPM = float(
    LIVE_RUNTIME["expected_speech_words_per_minute"]
)
LIVE_PATHOLOGICAL_DURATION_MULTIPLIER = float(
    LIVE_RUNTIME["pathological_duration_multiplier"]
)
LIVE_PATHOLOGICAL_DURATION_EXTRA_SECONDS = float(
    LIVE_RUNTIME["pathological_duration_extra_seconds"]
)
LIVE_PATHOLOGICAL_DURATION_FLOOR_SECONDS = float(
    LIVE_RUNTIME["pathological_duration_floor_seconds"]
)
DEFAULT_TTS_RATE = "0%"
DEFAULT_TTS_PITCH = "0%"
GLOBAL_PRONUNCIATIONS = {}

DELIVERY_INSTRUCTIONS = {
    "hook": "Abra com presença e curiosidade real, como quem convida alguém a entender uma descoberta. Mantenha estabilidade vocal constante de afinação (pitch), mesmo volume e cadência conversada.",
    "explain": "Conduza a explicação como uma conversa: conecte as ideias com fluidez, clareza e ritmo natural. Mantenha estabilidade vocal constante de afinação (pitch), mesmo volume e cadência conversada.",
    "contrast": "Faça ouvir a diferença entre as duas ideias com naturalidade e clareza. Mantenha estabilidade vocal constante de afinação (pitch), mesmo volume e cadência conversada.",
    "question": "Dirija a pergunta ao ouvinte com curiosidade natural e tom próximo. Mantenha estabilidade vocal constante de afinação (pitch), mesmo volume e cadência conversada.",
    "closing": "Retome a ideia central com calor e convicção, mantendo proximidade e estabilidade vocal constante de afinação (pitch), mesmo volume e cadência conversada.",
}
CUE_KIND_INSTRUCTIONS = {
    "emphasis": "Dê relevo à ideia principal deste trecho e retome a conversa com fluidez.",
    "number": "Articule o número com clareza, ligando-o ao significado da frase; mantenha a leitura fluida, sem cadência de lista.",
    "contrast": "Faça ouvir a oposição entre as ideias, apoiando os termos que mudam o sentido.",
}
CUE_INTENT_INSTRUCTIONS = {
    "curiosity": "Intenção: curiosidade dirigida ao ouvinte, com interesse na resposta.",
    "discovery": "Intenção: descoberta; faça a nova informação ganhar presença na conversa.",
    "reassurance": "Intenção: acolhimento e segurança, ajudando o ouvinte a acompanhar a ideia.",
    "caution": "Intenção: atenção a uma condição ou limite, com firmeza proporcional ao conteúdo.",
    "conviction": "Intenção: convicção clara na afirmação, sem transformar uma hipótese em certeza.",
}
CUE_ARC_INSTRUCTIONS = {
    "question": "Arco: abra a pergunta com curiosidade e deixe sua resposta em suspenso, respeitando a pontuação.",
    "build": "Arco: conduza o raciocínio até a informação principal, dando a ela maior presença.",
    "resolve": "Arco: entregue a resposta e conclua o pensamento com uma resolução natural.",
    "contrast": "Arco: apresente a primeira ideia, marque a virada e dê relevo ao que muda na segunda.",
}


def project_pronunciations(project: dict | None) -> dict[str, str]:
    speech = (project or {}).get("speech") or {}
    raw = speech.get("pronunciations") or {}
    return {
        str(key).strip(): str(value).strip()
        for key, value in raw.items()
        if str(key).strip() and str(value).strip()
    }


def project_speech_fingerprint(project: dict | None) -> str:
    pronunciations = project_pronunciations(project)
    canonical = json.dumps(
        pronunciations,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def automatic_year_pronunciations(narration: str) -> dict[str, str]:
    """Keep numeric years in the script while directing pt-BR pronunciation."""
    years = sorted(
        set(re.findall(r"(?<!\d)(?:19|20)\d{2}(?!\d)", str(narration)))
    )
    if not years:
        return {}
    try:
        from num2words import num2words
    except ImportError as exc:
        raise ValueError(
            "num2words indisponível; não orientar anos sem normalizador."
        ) from exc
    return {
        year: str(num2words(int(year), lang="pt_BR")).strip()
        for year in years
    }


def scene_voice_direction(scene: dict) -> dict:
    """Validated acting instructions; never turn old rate/pitch into processing."""
    raw = scene.get("tts") or {}
    if not isinstance(raw, dict):
        raise ValueError("tts da cena deve ser um objeto.")
    for field in ("rate", "pitch"):
        if str(raw.get(field, "0%")) not in ("0%", "+0%", "-0%"):
            raise ValueError(f"Gemini Live raw não aplica {field}; use direção de interpretação.")
    result = {}
    delivery = raw.get("delivery")
    if delivery:
        if not isinstance(delivery, str) or delivery not in DELIVERY_INSTRUCTIONS:
            raise ValueError("Direção de interpretação desconhecida.")
        result["delivery"] = delivery
    if raw.get("pause_ms") is not None:
        pause = int(raw["pause_ms"])
        if not 90 <= pause <= 300:
            raise ValueError("Pausa de direção fora do intervalo editorial.")
        result["pause_ms"] = pause
    narration = str(scene.get("narration") or "")
    pronunciations = automatic_year_pronunciations(narration)
    pronunciations.update(
        project_pronunciations({
            "speech": {"pronunciations": raw.get("pronunciations") or {}}
        })
    )
    if pronunciations:
        result["pronunciations"] = pronunciations
    raw_cues = raw.get("cues") or []
    if not isinstance(raw_cues, list) or any(not isinstance(cue, dict) for cue in raw_cues):
        raise ValueError("Cues vocais devem ser uma lista de objetos.")
    if len(raw_cues) > 6:
        raise ValueError("Mais de seis cues vocais na cena.")
    cues = []
    previous_end = -1
    for cue in sorted(raw_cues, key=lambda c: narration.find(str(c.get("text") or ""))):
        phrase = str(cue.get("text") or "").strip()
        start = narration.find(phrase)
        kind = cue.get("kind")
        pause = int(cue.get("pause_before_ms", 0))
        if not phrase or len(phrase) > 160 or narration.count(phrase) != 1 or start < previous_end or not isinstance(kind, str) or kind not in CUE_KIND_INSTRUCTIONS or not 0 <= pause <= 300:
            raise ValueError("Cue vocal exige trecho literal único, válido e sem sobreposição.")
        if (start > 0 and narration[start-1].isalnum() and phrase[0].isalnum()) or (start+len(phrase) < len(narration) and narration[start+len(phrase)].isalnum() and phrase[-1].isalnum()):
            raise ValueError("Cue vocal corta uma palavra.")
        if re.search(r"[.!?]\s+", phrase):
            raise ValueError("Cue vocal não pode atravessar frases.")
        validated = {"text": phrase, "kind": kind, "pause_before_ms": pause}
        for field, choices in (("intent", CUE_INTENT_INSTRUCTIONS), ("arc", CUE_ARC_INSTRUCTIONS)):
            if field in cue:
                if not isinstance(cue[field], str) or cue[field] not in choices:
                    raise ValueError(f"Cue vocal tem {field} desconhecido.")
                validated[field] = cue[field]
        if "emphasis_word" in cue:
            word = cue["emphasis_word"]
            if not isinstance(word, str) or not word or len(word) > 80 or not word.isalnum():
                raise ValueError("Palavra-chave vocal deve ser uma única palavra literal.")
            if re.findall(r"[^\W_]+", phrase).count(word) != 1:
                raise ValueError("Palavra-chave vocal deve aparecer uma vez como palavra inteira no cue.")
            validated["emphasis_word"] = word
        cues.append(validated)
        previous_end = start + len(phrase)
    if cues:
        result["cues"] = cues
    return result


def scene_direction_fingerprint(scene: dict) -> str | None:
    direction = scene_voice_direction(scene)
    if not direction:
        return None
    return hashlib.sha256(json.dumps({"version": "live-scene-direction-v3", "direction": direction, "instruction": live_turn_text("", direction)}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def live_turn_text(
    narration: str,
    direction: dict,
    previous_context: str | None = None,
) -> str:
    if not direction and not previous_context:
        return "ROTEIRO:\n" + narration
    instructions = [
        "INSTRUÇÕES DE INTERPRETAÇÃO; NÃO LEIA ESTE BLOCO. Aplique esta direção somente ao roteiro abaixo. Preserve a identidade e a estabilidade de afinação e volume da voz definida na configuração da sessão. Leia somente o ROTEIRO e encerre depois da última palavra, sem comentário ou despedida extra."
    ]
    if previous_context:
        instructions.append(
            f"CONTINUIDADE VOCAL: Esta cena dá sequência à frase anterior: {json.dumps(previous_context[-120:], ensure_ascii=False)}. Mantenha rigorosamente a mesma afinação (pitch), mesmo volume de locução e mesma cadência ao iniciar o ROTEIRO."
        )
    if direction.get("delivery"):
        instructions.append(DELIVERY_INSTRUCTIONS[direction["delivery"]])
    if direction.get("pause_ms"):
        instructions.append(
            f"Pequenas pausas naturais entre ideias, aproximadamente {direction['pause_ms']} ms; isso é direção de fala, não um controle exato."
        )
    for term, spoken in sorted(direction.get("pronunciations", {}).items()):
        instructions.append(
            f"Pronúncia: {json.dumps(term, ensure_ascii=False)} como {json.dumps(spoken, ensure_ascii=False)}."
        )
    for cue in direction.get("cues", []):
        cue_instructions = [CUE_KIND_INSTRUCTIONS[cue["kind"]]]
        if cue.get("intent"):
            cue_instructions.append(CUE_INTENT_INSTRUCTIONS[cue["intent"]])
        if cue.get("arc"):
            cue_instructions.append(CUE_ARC_INSTRUCTIONS[cue["arc"]])
        if cue.get("emphasis_word"):
            cue_instructions.append(
                f"Apoie a palavra {json.dumps(cue['emphasis_word'], ensure_ascii=False)}, preservando a fluidez do trecho."
            )
        if cue.get("pause_before_ms", 0) > 0:
            cue_instructions.append(
                f"Faça uma pausa natural breve antes, aproximadamente {cue['pause_before_ms']} ms; é intenção, não tempo exato."
            )
        cue_instructions.append("Preserve cada palavra.")
        instructions.append(
            f"Trecho {json.dumps(cue['text'], ensure_ascii=False)}: "
            + " ".join(cue_instructions)
        )
    return "\n".join(instructions) + "\n\nROTEIRO:\n" + narration


def live_system_instruction(pronunciations: dict[str, str] | None = None) -> str:
    lines = [
        "Você é o narrador do canal O Dinheiro Explica.",
        "Sua única tarefa nesta sessão é ler em voz alta, literalmente, o texto "
        "fornecido pelo usuário depois de ROTEIRO.",
        "Não acrescente saudações, explicações próprias, resumos, reformulações, "
        "antecipações ou qualquer palavra além do roteiro.",
        f"Idioma: português brasileiro ({VOICE_LANGUAGE}).",
        f"Direção de voz: {VOICE_DELIVERY_STYLE}",
        "Mantenha rigorosa estabilidade vocal: mesma afinação base (pitch), mesmo volume de locução e mesmo timbre conversado natural em todas as falas.",
        "Use a pontuação do roteiro para criar pausas naturais. Preserve números, "
        "nomes e sentido. Não leia instruções, rótulos ou delimitadores.",
    ]
    items = pronunciations or {}
    if items:
        pairs = "; ".join(
            f"{term} = {spoken}" for term, spoken in sorted(items.items())
        )
        lines.append(
            "Pronúncias obrigatórias, usadas somente para a fala e nunca como "
            f"conteúdo extra: {pairs}."
        )
    return " ".join(lines)


def live_session_config(
    voice: str,
    pronunciations: dict[str, str] | None = None,
) -> dict:
    if voice not in PRESENTER_VOICES.values():
        raise ValueError("Voz não prevista na política do canal.")
    return {
        "response_modalities": ["AUDIO"],
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {"voice_name": voice}
            }
        },
        "output_audio_transcription": {},
        "system_instruction": live_system_instruction(pronunciations),
    }


def gemini_speech_request(
    narration: str,
    voice: str,
    model: str,
) -> tuple[str, dict]:
    if model != PRIMARY_TTS_MODEL:
        raise ValueError("Somente gemini-3.8-live está autorizado.")
    return "live-websocket", {
        "model": model,
        "config": live_session_config(voice),
        "client_content": {
            "turns": {
                "role": "user",
                "parts": [{"text": "ROTEIRO:\n" + narration}],
            },
            "turn_complete": True,
        },
    }


def voice_policy_fingerprint(model: str, voice: str) -> str:
    if model != PRIMARY_TTS_MODEL or voice not in PRESENTER_VOICES.values():
        raise ValueError("Modelo ou voz fora da política atual.")
    canonical = json.dumps(
        {
            "version": VOICE_POLICY_VERSION,
            "model": model,
            "voice": voice,
            "config": live_session_config(voice),
            "raw_audio_treatment": NO_VOICE_TREATMENT,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


VOICE_POLICY_CACHE_KEY = hashlib.sha256(
    json.dumps(
        VOICE_POLICY,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
).hexdigest()[:16]
