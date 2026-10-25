# OS4 Motion Dark — fluxo opcional de direção visual

**Implementação opcional.** Não é ativada para os vídeos simples nem substitui o Visual Atual; não equivale a um agente de edição humana por vídeo.

## UI e passagem da direção
1. Desmarque "Usar corte simples (formato antigo)" e selecione "Motion Dark (Black Cinematográfico)".
2. "Copiar Prompt para IA" adiciona direção de arte ao mesmo prompt editorial. A IA devolve o mesmo pacote de cortes com \`visual.motion\` nas cenas \`narration\`, sem chamada adicional por vídeo.
3. O usuário importa JSON normalmente e processa. \`workflow-start\` escolhe \`editorial.visual_style = "motion_dark"\` **na cópia do pacote**. A escolha não altera a narração, o tempo dos \`clips\`, os IDs, o destino nem o estilo persistido em outros projetos.
4. \`normalize_editorial_plan\` valida a whitelist. \`editorial_renderer\` usa \`editorial_motion_dark\`. O código resolve cenas usando os tempos das palavras alinhadas, com fallback temporal controlado para apoios sem correspondência textual exata.
5. O FFmpeg monta o vídeo real, as camadas PNG RGBA, a narração original e as legendas. Sem API ou agente em tempo de render.

## Contrato de \`visual.motion\`

Campo opcional em cada \`scene.kind = "narration"\`:

\`\`\`json
{
  "visual": {
    "title": "O que ela confirma?",
    "kicker": "POLÍTICA",
    "lines": ["Ela confirma o encontro", "Mas diz não saber dos negócios"],
    "motion": {
      "layout": "comparison",
      "icon": "line-md:confirm-circle",
      "emphasis": "confirma"
    }
  }
}
\`\`\`

\`layout\`: \`source_card\`, \`statement\`, \`comparison\`, \`quote\`, \`number\`. Somente escolher \`number\` com número explícito; não inventar medidas.

\`icon\`: \`line-md:chat\`, \`line-md:alert-circle\`, \`line-md:confirm-circle\`, \`line-md:clipboard-check\`. Todos estão incluídos em \`processor/assets/line_md/\`. SVGs são originais da coleção Line MD, com licença MIT salva no mesmo diretório. O renderizador extrai quadros da animação de traço da própria SVG usando CairoSVG. Não há busca na internet no render.

\`emphasis\`: até 50 caracteres, trecho literal do \`visual.title\` (case-insensitive), ou vazio. Colore o título com âmbar. As legendas continuam destacando a palavra falada por alinhamento acústico, independentemente desta ênfase de título.

Não existe parser de texto livre para executar FFmpeg. Layout, ícone e palavra recebem validação explícita. Não buscar documentos ou fotos que a fonte não enviou; ícones ilustram o significado, não confirmam alegações.

## Estilos visíveis na interface
- **Corte simples:** mantém a edição antiga e sem narração adicional.
- **Visual atual (Classic):** mantém o estilo autoral existente.
- **Motion Dark:** evolução do protótipo Papel Dinâmico. Usa preto absoluto (#000000), superfícies quase pretas (#090909–#161616), luz âmbar localizada nos elementos, sombras, profundidade, ícones animados e legendas com ênfase. Não aplica banho azul nem clareia todo o quadro.

**Papel Dinâmico foi somente a primeira etapa do Motion Dark.** Não é uma terceira escolha. O código `paper` permanece apenas como suporte a pacotes históricos, enquanto a interface converte sessões antigas `paper` para `motion_dark`.

## Desenvolvimento e quality gate
A skill local \`.agents/skills/os4-motion/SKILL.md\` orienta Codex/agente a melhorar o motor. A skill não é executada no GitHub Actions em cada corte.

Rodar:
\`\`\`bash
npm test
python -m compileall processor
python -m unittest discover -s tests -p 'test_*.py' -v
\`\`\`

**Antes de produção:** renderizar lote piloto com áudio real nos dois formatos, inspecionar entradas e saídas, recortes de rostos, destaques palavra a palavra, créditos, legibilidade, transparência, memória e taxas de falhas. A biblioteca inicial contém quatro SVGs e cinco layouts; **não reproduz ainda toda a variedade cinematográfica da referência**. A qualidade do conjunto depende também do JSON escolhido pela IA.
