# Capas, voz e entrada do original

O pacote escolhe modelo e título; o motor seleciona frames reais e monta a capa, no simples e no autoral. Instagram/TikTok usam 9:16; YouTube usa 16:9. O conteúdo original continua sendo a referência do limite editorial de 180 segundos, separado da duração final entregue.

## Contrato por corte

```json
{"cover":{"version":1,"template_id":"03_close","title":"O QUE ELA CONFIRMA?"}}
```

`cover.title` é texto simples, não vazio, com até 60 caracteres. A escrita mira 3–6 palavras e até 32 caracteres; no close, até 24. O editor permite revisar esse texto separadamente do título de publicação. A seleção acompanha o cartão após edição, exclusão, reordenação, armazenamento local, exportação e transporte gzip. Versão, modelo ou título inválido são rejeitados antes do runner.

| Modelo | Composição |
| --- | --- |
| `01_central` | Rosto dominante central e título abaixo. |
| `02_lateral` | Pessoa à esquerda e texto à direita, com preset vertical próprio. |
| `03_close` | Close maior, faixa discreta e título de uma linha. |

Pacotes legados sem `cover` usam central no vertical e lateral no horizontal, com o título existente. O modelo `04_duas_pessoas` foi retirado: pacotes antigos que o contenham são migrados para central no vertical ou lateral no horizontal, preservando o título da capa. O editor e o prompt oferecem somente os três modelos ativos. Títulos legados acima de 60 caracteres são importados sem truncamento no editor; a geração solicita título de capa curto. O executor também valida o contrato.

## Compositor e cache

`processor/covers.py` consome os seis presets de `processor/assets/covers/presets-v1.json`: três composições em cada formato. Fontes Archivo Black e Inter, licenças, hashes e referências v3 reduzidas ficam nessa árvore versionada. A produção não lê as pastas de prévias.

O seletor amostra deterministicamente até 60 frames na união dos intervalos originais, após tratar a tarja. YuNet/OpenCV avalia rosto, tamanho útil, nitidez facial, exposição e enquadramento. O crop mantém proporções e margens de testa/queixo. Detecção fornece geometria, sem inferir nomes ou identidade entre cenas.

Cada composição destaca somente um rosto selecionado. A presença de várias pessoas no frame não habilita montagem de par nem amplia um segundo rosto do fundo. A seleção continua priorizando atividade de fala, detalhe dos olhos e qualidade visual. Editor, API e executor migram pacotes antigos antes da composição; seus relatórios usam o modelo individual normalizado. Chamadas diretas ao compositor com o modelo retirado também o migram e registram `requested_template: 04_duas_pessoas`, o modelo realmente aplicado e `fallback_reason: retired_two_person_template`.

Sem rosto detectado, o fallback preserva a cena inteira dentro do painel de foto, mantendo a proporção e sem inventar um rosto no centro para calcular o recorte. A ausência de rosto, a nitidez baixa ou margens imperfeitas não bloqueiam por si só a capa. Se nenhum dos frames puder ser extraído ou decodificado, somente esse corte falha com motivo claro, antes da síntese de voz; o motor não fabrica um fundo cinza para registrar sucesso.

Título que não caiba no close tenta central/lateral. Demais modelos permitem duas linhas; close permite uma. Mínimos: vertical 50 px, close vertical 48 px, horizontal 70 px. Se o título continuar ilegível, somente esse corte falha antes de sintetizar voz.

O relatório registra modelo pedido/aplicado, substituição, timestamp, qualidade, crop e hash. O cache da capa inclui fonte, intervalos, tarja, preset, fontes e texto. Mudar somente a capa não muda TTS, alinhamento, cenas ou master autorais. No simples vertical, a saída legendada depende também do hash da capa: mantém o flash inclusivo `t <= 0.14`, sem inserir frames ou atrasar áudio.

Nomes `_capa.jpg` e `files.capa` continuam compatíveis com o Publicador. Todo corte novo exige capa gerada e enviada antes de emitir `ready_cut`; itens legados já salvos continuam aceitos pelo feed.

## Narração e abertura

Cada narração possui um derivado PCM em cache com velocidade 1,10× e pitch −1 semitom aplicados uma vez. WAV bruto, alinhamento canônico, voz, direção e política de TTS são preservados. A chave do derivado inclui hash bruto, velocidade, pitch, formato e versão.

O compositor mede a duração efetiva, divide os tempos das palavras por 1,10 e calcula a timeline em frames, arredondando para cima. Volume ativo e picos são medidos nos derivados; mantém ganho comum do narrador e teto atuais. O master recebe áudio já tratado. Falas originais conservam velocidade 1,00× e tom.

O prompt permite começar com fala original compreensível em qualquer tema. Havendo narração antes, mira 8–15 segundos finais, com gancho/contexto enxutos e contribuição própria do OS4. `first_original_clip_seconds` soma todas as cenas anteriores ao primeiro original. Zero e menos de oito são válidos; acima de quinze produz somente aviso editorial. O motor não corta frases, move cenas ou compra nova síntese para cumprir a faixa.

O relatório separa `source_clip_seconds`, `first_original_clip_seconds`, duração da timeline e duração final medida. Esses dados acompanham o resultado para comparar publicações futuras.

## Validação e liberação

CI executa Node/API/editor, Python e Publicador, com provas reais de áudio/flash e FFmpeg obrigatório. A matriz visual confere seis presets, rostos variados, migração do modelo retirado, fallback de cena, acentos, títulos, material menos nítido, horizontal em 320×180 e recorte central quadrado vertical. A prova A/B usa WAVs existentes, sem síntese adicional.

Liberação pela branch `codex/capas-voz-producao`, PR e CI. Merge em `main` disponibiliza o motor e o Netlify publica pela integração Git existente; não há conexão nem deploy manual. A conferência final usa geração controlada até Drive/Publicador, sem postar testes nas redes. Não há Facebook, novo selo público ou alteração de regras de monetização nesta entrega.

Caches de áudio/roteiro entre jobs seguem desativados em repositórios públicos. O cache local reaproveita os artefatos disponíveis; não presume retomada durável entre execuções.
