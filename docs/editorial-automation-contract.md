# Automação do minivídeo autoral no OS4

Este documento registra a integração local de minivídeos autorais em 18/10/2026: pacote, transporte, voz, montagem e processamento em lote. O código e os testes locais não confirmam implantação nem uma execução integral de uma sessão real no workflow OS4. A amostra de vídeo também não comprova essas etapas de produção.

## Implementado nesta alteração

- O navegador preserva `editorial` intacto entre importação, cartão de edição e envio do lote. O campo deve ser um objeto JSON quando presente; a verificação básica de modo não reescreve suas cenas.
- O rótulo `Mini vídeo narrado` identifica os cartões com plano editorial. Excluir outro corte e alterar título ou tempos não elimina nem associa o plano a outro cartão.
- `saida_suave` deixa de ser descartado ao ler o editor.
- `normalizar_cortes` valida a propriedade opcional com `normalize_editorial_plan`, incluindo os limites `inicio`/`fim` do corte. Intervalos invalidados por uma edição de tempos falham antes do acesso ao Drive ou do processamento de mídia. Cortes legados não ganham a propriedade `editorial`.
- `render_batch` usa um modo global por lote: `simple` conserva o render legado e `editorial` exige plano autoral em todos os cortes, sintetiza as cenas narradas e monta sua sequência com os trechos originais.
- No modo autoral, uma falha de montagem ou upload é registrada por corte, e os seguintes continuam. O resultado contém somente pacotes completos em `cuts`, além de `errors`, `requestedCount` e `completedCount`.

O prompt da nova interface solicita o pacote com narração quando o formato autoral está selecionado. A API valida a estrutura mínima de todas as cenas e seus intervalos antes de iniciar o runner; as políticas completas de voz, visual e evidência continuam validadas pelo Python. O workflow transporta o modo e referencia a chave Gemini. Essas alterações locais de API e workflow não confirmam implantação ou ativação na aplicação publicada.

## Seleção de modo e compatibilidade

| Pedido à API | Modo enviado ao workflow | Comportamento |
| --- | --- | --- |
| `simpleCuts: false` | `cut_mode: editorial` | Exige plano v1 em todos os cortes e conserva o pacote completo. |
| `simpleCuts: true` | `cut_mode: simple` | Aceita o pacote legado e remove `editorial` antes do despacho, mesmo se o usuário o tiver importado. |
| Campo `simpleCuts` ausente | `cut_mode: simple` | Compatibilidade com clientes antigos; a simples presença de um plano não ativa geração de voz. |

O campo aceita somente booleanos quando fornecido. A interface nova envia `false` para o formato autoral; clientes antigos que omitem o campo mantêm o comportamento anterior. A marcação de tarja é independente: `hasLowerThird` continua definindo somente o tratamento da imagem de origem.

O workflow também usa `simple` quando `cut_mode` é omitido em um disparo manual. Para ativar narração no runner, é necessário configurar **`GEMINI_API_KEY` nos GitHub Actions secrets do repositório OS4** e disponibilizar a versão correspondente do código e das dependências. A chave não precisa passar pelo navegador nem pela API Netlify. Nenhuma configuração de conta, leitura de valor de secret ou implantação foi realizada nesta revisão; referenciar o nome no YAML não comprova que a chave esteja provisionada.

## Fluxo local atual

```text
Vídeo escolhido pelo usuário
  -> transcrição e vídeo-base no Drive
  -> prompt do modo escolhido copiado pelo usuário para uma IA
  -> pacote JSON importado e editado no navegador
  -> workflow-start valida modo, plano e limite do pacote
  -> renderizar.yml / cuts_json JSON ou gzip-base64 / cut_mode
  -> render_batch decodifica e valida o pacote inteiro
  -> simple: tracking + legendas e metadados
  -> editorial: voz + alinhamento + cenas originais e narradas
  -> upload dos pacotes completos ao Drive
  -> ready_cut / feed do Publicador
```

O usuário já mantém controle sobre o vídeo de origem, títulos e intervalos. Gerar automaticamente o roteiro e a montagem de cada corte não exige delegar a escolha desses assuntos a uma plataforma externa.

| Passagem | Comportamento implementado localmente |
| --- | --- |
| Prompt | Solicita o pacote correspondente ao modo escolhido. A geração do roteiro continua no fluxo de IA que o usuário já utiliza. |
| Navegador | Preserva plano e `saida_suave`, identifica cartões narrados e envia o modo explicitamente. |
| `workflow-start.mts` | Valida estrutura mínima e intervalos, conserva planos autorais e os remove no modo simples; comprime lotes autorais grandes. |
| `renderizar.yml` | Repassa `cuts_json` e `cut_mode` pelo ambiente; referencia Gemini no runner e instala as dependências de voz e alinhamento. |
| `normalizar_cortes` | Decodifica o transporte opcional e normaliza cada plano com os limites do corte; conserva o contrato legado. |
| Batch autoral | Pré-valida o pacote, chama o executor de cenas, isola erros de montagem/upload por corte e produz o resumo parcial. |
| `ready_cut` | É emitido depois que o pacote final do corte tem todos os arquivos enviados. Um corte com falha não entra no feed como pronto. |

O limite de 60.000 caracteres continua valendo para o transporte e para pacotes simples. Para pacotes autorais grandes, a compressão descrita abaixo permite enviar dezenas de roteiros sem trocar os parâmetros do workflow. Não colocar o alinhamento de palavras nem os artefatos de execução em `cuts_json`.

## Transporte de lotes autorais grandes

Pacotes autorais têm limite bruto de **512.000 bytes UTF-8**. Se o JSON ultrapassar **60.000 caracteres ou 60.000 bytes UTF-8**, a API aplica gzip e base64, enviando `gzip-base64:<dados>` no mesmo campo `cuts_json`. Verificar os bytes também impede que texto Unicode curto em caracteres ultrapasse o limite de um argumento no runner Linux. O resultado comprimido deve caber em 60.000 caracteres; se qualquer limite for excedido, a API orienta dividir o lote antes de disparar o workflow. Pacotes autorais abaixo dos dois limiares continuam como JSON normal, e pacotes simples conservam integralmente o limite anterior, sem compressão automática.

`processor/cut_transport.py` reconhece o prefixo, valida o base64 e lê no máximo 512.001 bytes do gzip para rejeitar uma expansão acima do limite. A leitura limitada evita descompactar integralmente uma carga excessiva para só depois medir seu tamanho. Texto UTF-8 inválido, gzip truncado, payload de transporte grande demais e membros gzip concatenados que ultrapassem o limite falham antes de acesso ao Drive ou processamento de mídia. JSON legado em array ou no objeto `{"cortes": [...]}` mantém compatibilidade.

O job conta os cortes a partir da lista validada recebida pela API, sem tentar interpretar o campo de transporte comprimido como JSON. O workflow continua repassando a mesma string até o normalizador Python; não há novo upload ou serviço nesse caminho.

## Contrato de plano v1

Manter os campos legados e acrescentar um objeto editorial por corte no modo autoral. O modo simples aceita o pacote sem esse objeto; o modo autoral o exige. Não inferir o modo narrado de duração, assunto, destino ou presença de tarja.

O campo editorial carrega a intenção revisável: versão de formato, IDs de cenas, tom de narração, falas, intervalos de áudio original, textos visuais e referências na transcrição. O contrato inicial em `processor/editorial_plan.py` usa `editorial.version: 1` e os tipos `kind: narration` e `kind: clip`:

`inicio` e `fim` delimitam o envelope da fonte: o menor início e o maior fim entre clipes, fundos e evidências usados naquele corte. Eles não são a duração final do minivídeo. A duração final resulta dos trechos escolhidos e dos áudios realmente gerados. O pacote especifica `formato` e `destino` de cada corte; a extensão desse envelope não decide o formato autoral por conta própria.

```json
{
  "titulo": "O que essa resposta esclarece?",
  "inicio": "00:10",
  "fim": "00:20",
  "formato": "9:16",
  "editorial": {
    "version": 1,
    "source": {"label": "Entrevista original", "date": "2026-10-18"},
    "scenes": [
      {
        "id": "opening",
        "kind": "narration",
        "text": "O que essa resposta esclarece?",
        "background": {"start": 10, "end": 12},
        "visual": {"title": "O que foi dito?", "kicker": "Uma pergunta", "lines": ["Veja a resposta"]},
        "tts": {"delivery": "question", "cues": []},
        "evidence": [{"start": 12, "end": 18}]
      },
      {"id": "answer", "kind": "clip", "start": 12, "end": 18}
    ]
  }
}
```

Este exemplo mostra o transporte, não um roteiro com três atos pronto para publicação. Os tempos são segundos absolutos na origem. O validador exige de duas a doze cenas, pelo menos uma cena de cada tipo, IDs de cena únicos e evidências numéricas para a narração. Ele verifica a estrutura e os intervalos; não comprova a verdade das afirmações nem a adequação editorial das perguntas. Um ID estável de corte e a persistência durável de artefatos permanecem necessários para a retomada descrita abaixo.

Separar dois artefatos:

1. **Pacote editorial:** entrada revisável, independente de caminhos da máquina e de durações estimadas pela IA.
2. **Plano de execução:** saída resolvida do processador contendo caminhos internos, hash dos insumos, duração medida do áudio, timestamps finais e resultados de QA. Não aceitar caminhos locais ou URLs arbitrárias fornecidos como cenas no pacote do navegador.

Para cada cena, os tipos mínimos são:

- **Original:** intervalo absoluto no vídeo-base; conserva a fala e o contexto. A transcrição continua referenciada nos tempos da origem.
- **Narração:** texto literal, direção de voz e intervalo da origem usado apenas como fundo desfocado e escurecido. As legendas desta cena são alinhadas ao áudio sintetizado, não aos tempos da entrevista.

Textos visuais devem ser dados, renderizados pelo componente de edição. A IA não deve fornecer filtros FFmpeg, comandos, nomes de fontes no sistema, HTML ou código executável.

### Validação antes de síntese

- Versão suportada e limites de quantidade/tamanho de cenas e falas.
- Todos os intervalos estão dentro do vídeo-base e do escopo de conteúdo selecionado para o corte; exceções precisam ser explícitas no pacote, não inventadas pelo modelo.
- Toda afirmação factual tem referência à transcrição. A verificação de referência é mecânica; a referência não transforma uma afirmação em verdadeira nem elimina a necessidade de avaliar sua redação.
- Cenas originais não são remontadas de modo a atribuir uma resposta a outra pergunta ou eliminar uma ressalva essencial.
- O roteiro tem uma promessa compreensível no começo, desenvolvimento com evidência e um fechamento que entrega a promessa. A pergunta ao público é específica ao que foi mostrado.
- A pergunta final não introduz uma acusação, fato novo ou falsa alternativa.
- Para cenas narradas, há texto literal não vazio e um fundo de origem resolvível; para cenas originais, há início e fim válidos.

Falhar a validação editorial não deve converter silenciosamente o corte em uma versão publicada sem a contribuição autoral prevista.

## Automação implementada e ampliação futura

### 1. Pacote narrado determinístico, sem novo planejador na produção

O prompt do modo autoral solicita as cenas do minivídeo. O usuário importa o pacote completo, escolhe o vídeo e pode excluir ou alterar cortes antes de acionar o lote. O navegador e o Python preservam e validam o contrato.

Depois desse acionamento, o caminho autoral implementado sintetiza a voz, alinha as legendas e monta os cortes sem edição manual de cada arquivo. Ele automatiza a produção em massa **a partir do pacote**, mas o roteiro ainda é gerado fora do motor. Credenciais e integração com os serviços de produção continuam requisitos para executar esse caminho no workflow implantado.

### 2. Planejamento de roteiro dentro do motor — futuro

Receber como entrada o vídeo escolhido, a seleção de conteúdo e o perfil editorial. Um planejador cria o mesmo contrato usado pela etapa 1 e passa pelo mesmo validador; não cria um caminho paralelo de renderização.

Salvar versão e hash de cada roteiro antes da síntese. Uma retomada não deve pedir ao modelo para reescrever um roteiro que já teve sua voz gerada. O planejamento precisa de um adaptador próprio: o sintetizador Gemini Live do piloto não deve escolher os fatos nem improvisar a locução.

Definir explicitamente a fronteira da escolha humana:

- **Vídeo e cortes escolhidos:** o planejador só monta os intervalos autorizados e gera as ligações narradas.
- **Vídeo escolhido e cortes sugeridos:** o planejador pode propor cortes dentro desse vídeo; nenhum vídeo de outra fonte entra sozinho.

São dois modos de seleção distintos. O segundo não deve substituir o primeiro por comportamento implícito.

### 3. Execução automática por corte

```text
normalizar e validar pacote
  -> resolver referências e fundos
  -> sintetizar apenas falas ausentes no cache
  -> conferir fidelidade da fala e alinhar palavras
  -> renderizar cenas de narração / cenas originais
  -> concatenar e normalizar áudio
  -> verificar duração, áudio, legendas e quadros
  -> subir pacote completo para o Drive
  -> registrar IDs de arquivos e ready_cut
```

O áudio sintetizado resolve a duração das cenas narradas. A duração estimada do roteiro não é usada para esticar a fala. A heurística antiga de remover silêncio inicial continua no caminho simples; o caminho autoral preserva os intervalos explícitos do plano.

O mesmo tratamento de tarja selecionado para o vídeo deve chegar a todas as cenas originais e aos fundos. O vídeo final narrado continua ocupando `files.videoLegenda`, acompanhado de `post` e `srt`; assim o Publicador recebe um pacote com os mesmos campos que já utiliza.

## Falha por corte e retomada

No modo autoral, falhas de síntese, alinhamento, montagem ou upload são isoladas por corte. O lote registra `{index, titulo, error}` e continua com o seguinte. Validação inválida do pacote, ausência da chave e falha de obtenção do vídeo-base ou transcrição são falhas globais, anteriores à montagem dos cortes. O modo simples conserva o comportamento de interromper a execução em caso de erro.

O resultado autoral contém `requestedCount`, `completedCount` e `errors`, além de `cuts` com os pacotes completos. Ele também é salvo em `output/render-batch-result.json`. Se ao menos um corte fica pronto, o callback terminal é `completed`, mesmo quando há erros nos demais. Se nenhum fica pronto, o callback é `error`, conservando o resultado e seus erros, e o processo retorna código 1. Não foi introduzido um novo estado terminal `partial`.

A interface usa os contadores reais para mostrar `prontos/solicitados` e a quantidade de falhas. Cada erro ganha cartão com índice, título e mensagem; um lote parcial não exibe todos os cortes como concluídos nem 100% de entrega. Só os cortes presentes em `cuts` são enviados ao Publicador. Quando todos falham, o polling apresenta os erros e não inicia publicação.

Os endpoints de progresso e status preservam o objeto `result` inteiro, incluindo erros e contadores; um callback atrasado não substitui o resultado terminal. Cada `ready_cut` também é salvo separadamente, permitindo ao feed do Publicador recuperar pacotes prontos durante ou depois do lote. Isso conserva entregas válidas, mas não é um mecanismo de retomada do renderer nem de deduplicação de novos uploads.

O bloco `finally` continua removendo `.work`. O cache de voz fica fora desse diretório, por padrão em `.editorial-cache`, e valida texto, voz/modelo, direção e política antes do reuso. Cache local sobrevivente pode evitar nova síntese em outra execução na mesma máquina. O YAML restaura e salva esse cache somente no modo autoral e em repositório privado; o salvamento usa `always()` quando existem arquivos, inclusive após falha. Essa configuração ainda precisa ser verificada em uma execução real do workflow e não equivale a um checkpoint durável dos arquivos enviados ao Drive. Não há retomada automática entre jobs públicos nem ledger persistente de IDs de upload.

Uma retomada completa entre runners permanece trabalho futuro e exige:

- ID estável por corte e hash de conteúdo separado do índice visual. Excluir o corte 2 no editor não deve transformar o antigo corte 3 em outro artefato.
- Fingerprint com vídeo/transcrição de origem, roteiro, versão editorial, política de voz, voz/modelo, dimensões e tratamento de tarja.
- Estado durável por corte e por etapa: planejado, áudio validado, cenas renderizadas, pacote verificado, arquivos enviados e pronto.
- Artefatos intermediários úteis persistidos fora da pasta temporária do runner. Cache local sozinho não permite retomar em um runner novo.
- Reuso de áudio apenas se texto, direção e política de voz forem os mesmos. Mudança de tom precisa invalidar o áudio, mesmo com o texto idêntico.
- Registro dos IDs de upload antes de emitir disponibilidade. Repetir callback não pode gerar nova publicação.
- Retomada que executa só etapas ausentes ou inválidas. Corte pronto com o mesmo fingerprint não deve ser sintetizado nem enviado outra vez.

Os modos são globais por lote. O endpoint autoral não aceita um pacote que misture cortes sem plano com cortes narrados. Escolher o modo simples remove todos os planos do transporte e executa o formato antigo. Um lote pode misturar proporções 9:16 e 16:9 sem misturar esses modos de produção.

## Credenciais e dependências identificadas no código

Não foram lidos valores de credenciais nem consultada sua existência nos serviços. Os nomes abaixo são referências no código; não confirmam que os secrets estejam provisionados.

| Local | Referências atuais |
| --- | --- |
| Workflow OS4 de renderização | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`, `GEMINI_API_KEY` |
| Netlify / despacho e callbacks | `OS4_SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`; token GitHub guardado cifrado na configuração do usuário |
| Piloto de locução | `GEMINI_API_KEY` |

O workflow OS4 de renderização agora referencia `GEMINI_API_KEY`, e `requirements-render.txt` inclui `google-genai==2.26.0`, `num2words` e `faster-whisper`. O script original do piloto dependia de outro checkout via `--ode-root` e de três locuções fixas em Markdown; os adaptadores genéricos `processor/editorial_voice.py` e `processor/editorial_alignment.py` passam a receber cenas variáveis por plano e manifesto. Referências e dependências locais não substituem uma execução integral do workflow implantado.

Reutilizar a política e o adaptador de voz aprovados, com versão fixada e proveniência documentada. A configuração do canal pode alterar a direção de locução sem quebrar o cache de outro canal. Não colocar chave Gemini no navegador, no pacote editorial, no repositório ou no resultado publicado.

## Alinhamento portátil das legendas narradas

`processor/editorial_alignment.py` extrai o alinhamento do piloto para cenas arbitrárias do `narration-manifest.json`. O módulo pode ser importado por `align_audio_directory(audio_dir, model="base")` ou executado como arquivo isolado no bundle cloud:

```text
python -m processor.editorial_alignment --audio-dir audio --model base
python editorial_alignment.py --audio-dir audio --model base
```

O manifesto precisa estar em `status: success`, com hashes do WAV e roteiro e `output_fidelity.passed: true` em cada cena. Essa fidelidade de conteúdo pertence à etapa TTS. O alinhador não a substitui por uma pontuação ASR nem aprova conteúdo pela existência de uma legenda.

O ASR é `faster-whisper`, em CPU/int8, português e timestamps por palavra. O prompt é uma lista curta de vocabulário do próprio manifesto: pode usar `asr_vocabulary` com termos curtos ou nomes capitalizados das falas. O limite é de doze termos e 180 caracteres; o roteiro inteiro não é enviado como prompt inicial.

O texto da legenda permanece canônico. A cobertura ASR direta precisa ser pelo menos 85%, e grupos canônicos divergentes têm no máximo duas palavras. Substituições usam o intervalo medido do ASR; palavras internas podem usar um intervalo positivo entre duas âncoras, respeitando o limite de duração já usado no piloto. Prefixos ausentes, grupos grandes e lacunas grandes são reprovados.

Há uma única resolução adicional por cena: se faltar exatamente um token de `a/o/e/de/do/da/em/no/na/ao/que/se` entre âncoras contíguas, o alinhador pode doar até 60 ms da cauda da âncora anterior, preservando nela pelo menos 80 ms. A palavra recebe `timing_source: estimated-joined-function-word-boundary` e `estimated: true`. O diagnóstico registra o doador antes e depois, o tempo doado e `exact_asr_match: false`. O áudio e a cobertura ASR direta não são alterados. Um substantivo ausente sem intervalo não recebe essa resolução.

O `VERSION` novo invalida os caches antigos. O cache também confere hashes, texto canônico, cobertura e limites de tempo. A aprovação dessa lógica com testes sintéticos não substitui executar ASR e conferir o resultado com o áudio real da produção.

## Verificações necessárias para liberar o lote narrado

1. Pacote legado chega ao renderer e produz os mesmos campos de saída.
2. Importar, editar, excluir outro corte, salvar e restaurar preserva o contrato editorial, IDs e `saida_suave`.
3. Contrato inválido é rejeitado antes de despacho ou síntese.
4. Modo autoral exige plano em todos os cortes; modo simples remove todos os planos; proporções 9:16 e 16:9 permanecem escolhas por corte.
5. Com provedores falsos locais, falha no áudio de um corte não impede o seguinte; nenhum pacote incompleto recebe `ready_cut`.
6. Reutilizar cache local válido evita nova síntese; mudar direção de voz invalida o áudio. Uma nova execução não pressupõe reuso dos IDs de upload.
7. Tempos finais de legenda acompanham as durações reais e a soma das cenas; a transcrição da origem não ocupa por engano a cena de narração.
8. O lote parcial apresenta quantos cortes ficaram prontos e quais precisam de nova tentativa.
9. O Publicador recebe somente pacotes finais completos com postagem correspondente; callback repetido não cria outro registro de disponibilidade para o mesmo corte no mesmo job. Isso não é deduplicação de uploads entre novos jobs.

Esses testes de contrato podem rodar sem rede, sem secrets reais e sem custo de geração. Uma execução integral com a voz e o workflow de produção continua necessária antes de afirmar que a automação foi liberada.
