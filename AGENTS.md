# Agentes do projeto OS4 Cortes

Ao desenvolver o modo optativo **Motion Dark** (temas editoriais, composição, legendas, Line MD, planejamento de cenas), leia a skill local `.agents/skills/os4-motion/SKILL.md` antes de alterar o código. O motor usa exclusivamente Python, Pillow, SVG e FFmpeg; não adicionar Remotion.

Preserve o modelo simples e os estilos autorais `classic` e `paper` sem alterações no resultado. Todas as modificações de motion design devem ser opt-in, testadas e revisadas por PR. A skill orienta o agente de desenvolvimento, não é uma dependência do render de vídeos.

O prompt da IA, o validador Netlify, `processor/editorial_plan.py`, a renderização e a UI devem aceitar **os mesmos identificadores** de layouts e ícones; a biblioteca de SVG deve ser local e conter suas licenças. Alterações só visuais não devem invalidar o cache de voz aprovado.
