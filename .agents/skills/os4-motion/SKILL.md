---
name: os4-motion
description: Design, implement and audit cinematic motion graphics for OS4 Cortes, exclusively in Python, Pillow, SVG and FFmpeg. Apply when changing editorial visual planning, scene layouts, word-highlight captions, line-md animated assets, dark lighting, or automatic rendering.
---

# OS4 Motion — agent development skill

## Role
Act as a motion-graphics technical director **for development and quality assurance**, not as a paid per-video edit agent. Do not bring in Remotion or any web image-generation dependency. Python/FFmpeg render each video deterministically from approved JSON.

## Source of truth
Read `docs/direcao-visual-automatica.md`, `processor/editorial_plan.py`, `processor/editorial_motion_dark.py`, `processor/editorial_renderer.py`, and the current `web/app.js` editorial prompt before any changes. Keep `simple`, `classic`, `paper` behavior and approved TTS/WAV cache intact.

## Art direction
- Every narrative moment has ONE dominant purpose: source clip, fact/statement, literal quote, comparison, or verified number.
- Prefer typography with *timed* emphasis over generic cards; the spoken expression anchors timing whenever literally available.
- Dark editorial identity: directional amber light, cool secondary bounce, restrained film texture/vignette, projected layered shadows. Avoid flat dark blocks, giant opaque subtitle boxes, endless static cards, visually inert hold times, or busy decoration.
- Captions: real word-aligned timing, high-contrast white, gold highlight for active words, readable stroke and no opaque rectangle. Never truncate spoken words.
- Keep visual/credit/caption safe zones independent; preserve real speaker faces and attributed statements.
- 9:16 and 16:9 must both work. Validate frame 0, each transition midpoint, each speech highlight and exit.

## Executable catalogue (current MVP)
`visual.motion.layout`: `source_card`, `statement`, `comparison`, `quote`, `number`.
`visual.motion.icon`: `line-md:chat`, `line-md:alert-circle`, `line-md:confirm-circle`, `line-md:clipboard-check`.
`visual.motion.emphasis`: exact, literal substring of `visual.title`, max 50 chars.
Icons are vendored original animated SVG files from cyberalien/line-md (MIT); sample their keyframes at render time, then cache. No internet fetch during production. Don't hallucinate icons.
Reject invalid IDs, mismatched emphasis, misleading `number`/quotes and unsupported special effects in preflight, or degrade optional effects safely with diagnostics.
Do not interpret opinions as measured statistics or invented evidence.

## Editing contract
The AI's **single** cut JSON is the upstream direction. It supplies `visual.motion` ONLY for narration when optional `motion_dark` is selected in the site UI. The UI chooses style across a batch and the transport overrides only the rendering copy. No live AI agent is needed in FFmpeg. Voice and aligned words remain literal and reusable between styles.

## Build/check protocol
1. Write one narrowly scoped implementation with tests.
2. Confirm `python -m compileall processor`, `python -m unittest discover -s tests`, `npm test`.
3. Render a real transcript/audio fixture. Inspect first/transition/last frames; verify word highlighting actually changes with audio. Do not call a screenshot a video.
4. Check CPU/memory/cache and that style switches never resynthesize accepted TTS.
5. Publish as PR first. Do not silently deploy or merge over the current OS4 pipeline.

## Quality failure
Stop if it still looks like title+generic card for most of the cut, captions obscure the source, the scene is misattributed, timing is guessed as exact, icons are missing from exports, or any mode regression occurs. Document the limitation instead of claiming production-quality equivalence to the provided reference.
