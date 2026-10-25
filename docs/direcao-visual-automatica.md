# Direção visual automática para o OS4

**Estado:** proposta de evolução do motor Python + FFmpeg. O contrato abaixo
ainda não foi integrado ao processamento de produção. A prova visual local
serve para avaliar a linguagem; não comprova o funcionamento de um lote inteiro.

## Objetivo

Aproximar os cortes da referência com movimento, variedade de composição e
elementos que entram junto da fala. A edição continua automática: a IA entrega
dados no pacote editorial e o motor aplica um repertório de layouts e animações.
Não haverá um agente assistindo e corrigindo cada corte durante o render.

O principal ganho está na relação entre fala e imagem: uma informação por vez,
mudança de composição quando a ideia muda e destaque no instante em que ela é dita.
Adicionar movimento contínuo a todos os elementos não substitui essa relação.

## Linguagem visual

- **OS4 preto e âmbar:** fundo escuro, texto claro, destaques e sublinhados âmbar.
- **Papel OS4:** fundo off-white com textura discreta, texto preto e acentos âmbar.
  Preserva a identificação do canal e aproxima a composição da referência.
- Tipografia grande, hierarquia clara e palavras decorativas translúcidas no fundo.
- Vídeo em cartão com cantos arredondados, sombra e inclinação discreta opcional.
- Cartões de citação, comparação e lista com revelação progressiva.
- Fotografias fornecidas podem usar moldura de papel; a origem deve permanecer clara.
- Calendário, contador e ícones só aparecem quando há conteúdo adequado no pacote.

O tema controla cores, fontes, raios, sombras e movimentos. O layout controla
a organização dos elementos. Cada corte pode variar de layout sem variar de marca.

## Repertório inicial

| Layout | Entrada necessária | Comportamento |
| --- | --- | --- |
| `source_card` | Trecho da fonte | Vídeo em cartão e legenda na área segura. |
| `statement` | Frase curta | Entrada por blocos e ênfase em palavras ancoradas. |
| `quote` | Citação literal e origem | Cartão com sublinhado sincronizado. |
| `comparison` | Dois textos sustentados pela fonte | Revela um lado e depois o outro. |
| `list` | Dois ou três itens curtos | Introduz um cartão por evento. |
| `number` | Valor explícito e unidade | Número destacado; contagem apenas se pertinente. |

Calendário, fotografias e ilustrações entram em uma fase posterior. Não são
obrigatórios por corte. Um ícone decorativo não deve sugerir um acontecimento real.

## Contrato declarativo proposto

O exemplo é ilustrativo. Os novos campos exigem validação e transporte próprios;
o normalizador atual não os executa. Nenhum campo aceita código ou filtro FFmpeg.

```json
{
  "visualPlan": {
    "version": 1,
    "theme": "os4-paper-amber",
    "scenes": [{
      "sceneId": "analysis_01",
      "layout": "statement",
      "title": "O custo aumentou",
      "events": [{
        "type": "underline",
        "target": "title",
        "anchor": {
          "sceneId": "analysis_01",
          "text": "o custo aumentou",
          "occurrence": 1
        },
        "durationMs": 650
      }]
    }]
  }
}
```

`sceneId` referencia uma cena existente; `occurrence` começa em 1 e identifica
a ocorrência da frase dentro dela. A âncora deve citar palavras realmente faladas.
A correspondência pode ignorar caixa e pontuação, preservando palavras e números.
Não se usa similaridade semântica para encaixar uma frase que não está no áudio.

O motor resolve as âncoras nos timestamps das palavras já alinhadas. Na fonte,
converte tempos absolutos para o trecho; na narração, utiliza o alinhamento após
o ajuste de velocidade. Só depois converte os eventos para frames da timeline.
Áudio existente e alinhamento permanecem os mesmos insumos; mudar o tema não
deve exigir uma nova síntese de voz.

## Execução e fallback

Um compilador visual transforma o contrato em eventos resolvidos, com posição,
início, fim e curva de animação escolhidos por regras do motor. Python gera as
camadas e FFmpeg compõe os frames. Reaproveitam-se tracking, legendas, montagem,
cache e entrega existentes. Versão do tema e eventos resolvidos entram no cache.

Campo inválido ou referência inexistente recebe diagnóstico no preflight.
Âncora sem correspondência confiável remove o efeito opcional e conserva o texto
legível no layout simples, registrando o motivo. Ausência de mídia fornecida
leva ao cartão de texto ou ao vídeo original, sem buscar ou inventar substitutos.

Uma citação precisa ser literal e atribuída. Números e datas devem vir do pacote
e ter apoio na fonte. Não criar prints com aparência de notícia, documento ou
publicação real. Um gráfico ilustrativo precisa se apresentar como ilustração;
não pode transformar uma opinião em dado medido.

## Ritmo e legibilidade

- Priorizar uma informação visual principal por momento e até três itens por lista.
- Reservar áreas próprias para vídeo, texto, legendas e crédito nos dois formatos.
- Usar entradas curtas e tempo de leitura proporcional ao texto, sem cortes cegos.
- Limitar a densidade de eventos; falas rápidas não exigem um efeito por palavra.
- Manter títulos legíveis, contraste suficiente e movimento decorativo discreto.
- Preservar a fala original e evitar efeitos sobre rostos ou detalhes relevantes.

## Fases e validação

1. **Prova local:** comparar preto/âmbar e papel/âmbar com o mesmo áudio existente;
   verificar cartão de vídeo, frase, citação e mudanças na fala antes da integração.
2. **Base no motor:** adicionar compilador visual, temas, âncoras e fallback;
   integrar `source_card`, `statement` e `quote`, preservando pacotes antigos.
3. **Variedade controlada:** comparação, lista e número com dados explícitos;
   incluir calendário e mídias fornecidas somente após validar a base.
4. **Lote piloto:** medir duração, custo e consistência em cortes curtos/longos,
   verticais/horizontais, com falas rápidas, frases repetidas e textos extensos.

A validação cobre resolução de âncoras, duração real, limites de texto, colisões,
áreas seguras, sincronia audiovisual e fallback. Inspecionar frames de entrada,
meio e saída e assistir aos exemplos renderizados, inclusive com áudio.
Qualidade visual aprovada em um exemplo não garante relevância em todos os temas:
sem agente por corte, a qualidade depende de um contrato restrito, bons templates
e comportamento previsível quando faltam dados.
