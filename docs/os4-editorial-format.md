# Formato editorial do OS4 Cortes

O usuário escolhe o vídeo e recebe o prompt para enviar à IA que já utiliza. A IA seleciona os cortes, escolhe pauta, ângulo e contribuição, organiza evidências e devolve o JSON pronto para importar e gerar. Editar ou excluir cortes é opcional; não há briefing nem aprovação humana obrigatória por vídeo. A automação produz a voz e monta os arquivos. O OS4 tem uma linha editorial de direita e um comentarista de bem com a vida, próximo e incisivo. Cada proposta acrescenta uma leitura própria sustentada pela fonte e adapta sua linguagem ao assunto.

## Uma ideia completa por vídeo

Antes de escrever a locução, a própria IA define o ângulo do comentário, a descoberta ou reação que o público receberá e os trechos que a sustentam. O começo dá motivo para continuar; o desenvolvimento preserva a fala relevante e acrescenta uma leitura; o fim entrega a descoberta, opinião ou graça prometida. Essa estrutura não exige três blocos de narração nem uma pergunta em todos os vídeos. O mínimo é de conteúdo: contexto, desenvolvimento e desfecho. Uma frase solta, um bordão ou uma reação isolada não bastam, mesmo com narração acrescentada em volta.

Uma ideia completa também precisa de apelo viral ou curioso sustentado pela fonte: surpresa, contraste, humor, fala marcante, tensão com desfecho ou aprendizado interessante. Uma história banal deve ser descartada mesmo se estiver completa. A IA não inventa conflito ou indignação nem força uma quantidade mínima de cortes para preencher o lote.

Não há duração mínima numérica, duração-alvo ou faixas de curtos, médios e longos. Verticais podem passar de dois minutos e usam até 180 segundos de conteúdo original. No autoral, a conta é a soma de `end - start` de cada cena `kind: clip`, incluindo repetições reproduzidas. Narração, fundos, evidências e envelope da fonte não entram nesse limite; o vertical pronto pode ultrapassar três minutos. No simples, a duração do trecho original é `fim - inicio`. Exatamente 180 segundos ainda cabe no vertical; acima disso, o corte é encaminhado como horizontal/YouTube antes da montagem. Uma escolha explícita de horizontal permanece horizontal.

A montagem final usa a duração real dos WAVs, sem usá-la para reclassificar o destino. Não repetir uma explicação, prolongar silêncio, desacelerar a voz ou alongar uma cartela para atingir um minuto. Uma fala precisa continuar até completar a ideia, inclusive condições, negativas e ressalvas que mudem o sentido.

## Comentarista de direita com interpretação contextual

Escrever como quem conversa com uma pessoa, com frases curtas, opinião e ritmo. Em política, assumir a perspectiva de direita e desenvolver a cobrança ou o contraste que a fonte permite: coerência, responsabilidade no uso do dinheiro público, liberdade e limites do poder quando pertinentes. Firmeza pode vir com leveza; não exige raiva, grito ou sermão. Em economia, aproximar a consequência da vida do público; em empreendedorismo, destacar a decisão e o resultado concreto.

No prompt autoral, a prioridade de escrita vem antes do planejamento e do schema. Pares fictícios de registro formal e falado demonstram a voz em qualquer tema, conservando o sentido. A IA confere cada `text` quanto a oralidade, emoção adequada e função própria antes de revisar o contrato, na mesma resposta. Duas narrações com a mesma ideia devem ser unidas, substituídas ou reduzidas; pontes curtas podem apenas orientar a atenção. A lista de construções formais orienta a redação e não cria bloqueio por palavras no motor. Veja a [direção de escrita e os exemplos](os4-commentator-profile.md).

Humor pode começar diretamente na fala original. Preservar preparação, surpresa e desfecho; o comentário entra no momento em que acrescenta uma reação, sem antecipar nem explicar a piada. Não impor política a uma história sem assunto político, nem piada a sofrimento. Assuntos sensíveis pedem sobriedade. O número e o tamanho das intervenções seguem o contexto, sem alongar a voz para simular autoria.

Provocação e ironia devem nascer das palavras, situações e contrastes mostrados. Uma pergunta também transmite pressupostos: “Quem se beneficiou do esquema?” pressupõe um esquema e não serve quando isso não foi estabelecido. Uma ressalva cabe quando corrige um salto concreto na conclusão. A atribuição curta, como “ela afirma”, costuma bastar para apresentar um depoimento; não inserir automaticamente defesas jurídicas ou repetir que uma declaração não prova crime.

O fechamento entrega a observação, opinião ou desfecho prometido. Quando houver uma pergunta ao público, ela deve ser específica, natural e ligada ao ponto mostrado. Pode ficar ausente quando estraga o tempo da piada ou enfraquece o fim. Evitar “o que você acha?” sem assunto e sequências de pedidos de comentário, curtida e compartilhamento.

O pacote registra `editorial.profile`: perspectiva `right`, tema, tom, intensidade, ângulo e pergunta opcional em string vazia. Cada cena pode sobrescrever `tts.tone` e `tts.intensity`; os demais parâmetros herdam o perfil do corte. A intenção da cena (`hook`, `explain`, `contrast`, `question`, `closing`) continua separada do tom. Perfil e direções são metadados; somente `text` vira fala. Consulte o [contrato de automação](editorial-automation-contract.md).

O novo pacote também declara `editorial.intent`: papel em relação à fonte, ponto da análise original, alvo da cobrança e contribuição do OS4. Quando a fonte traz uma análise alinhada, o narrador desenvolve o argumento como cocomentarista; não desloca automaticamente a pauta para moderar o comentarista da fonte. Entrevistas diretas, humor e argumentos de outra posição recebem a relação adequada ao conteúdo. O [perfil detalhado](os4-commentator-profile.md) reúne as regras e os exemplos calibrados uma vez; não há aprovação recorrente de vídeos.

## Atribuição e evidência

Para cada afirmação, registrar se é fala atribuída, fato verificado em outra fonte, inferência editorial ou pergunta. Associar falas a palavras e timestamps da transcrição e manter a URL/origem. A legenda automática ajuda a localizar; a revisão do áudio confirma nomes, negativas e limites de corte. Timestamps derivados de legendas não devem ser apresentados como alinhamento acústico confirmado.

“Ela diz que apresentou” registra um depoimento. Não prova, por si, os fatos posteriores nem a inexistência deles. Uma interpretação precisa explicar o raciocínio e conservar seu alcance: “neste trecho” quando a conclusão se refere somente ao recorte. Não usar uma resposta sobre intenção como prova do resultado, nem desconhecimento declarado como prova de inexistência.

O vídeo original permanece audível sozinho nos excertos. Durante o comentário, silenciar a fala de fundo e identificar a fonte. O visual deve acompanhar a ideia explicada, sem inventar documentos, ligações comerciais ou relações entre pessoas. Efeitos decorativos não substituem o comentário nem constituem evidência de elegibilidade para monetização.

## Contrato para automação em lote

O pacote produzido pela IA deve trazer, antes da geração, sem exigir preenchimento manual:

1. Fonte escolhida pelo usuário, pergunta central, título proporcional ao conteúdo e conclusão que será entregue.
2. Trechos com início/fim, ideia completa e evidências associadas, com os limites resolvidos pela IA antes de devolver o pacote.
3. Roteiro autoral por cena e frases com alegações atribuídas. As instruções de voz ficam fora do texto falado.
4. Um desfecho que entregue a proposta e, quando couber, uma pergunta específica sem pressuposto factual inventado.
5. Formato e destino coerentes com o tempo de conteúdo original, separado da narração e do envelope da fonte.
6. Perfil e intenção coerentes entre fala, título, textos de tela e legenda do post. A conferência interna ocorre na própria geração, sem uma etapa adicional de aprovação por vídeo.

A seleção em lote não deve devolver várias versões do mesmo argumento com títulos diferentes. Comparar a pergunta, a descoberta e os intervalos de fonte entre candidatos. Não impor uma quantidade de cortes que force trechos incompletos ou repetitivos. O usuário conserva a escolha do conteúdo e o controle das propostas antes de gerar.

A síntese reutiliza Gemini Live/Charon conforme a integração aprovada, com leitura literal e identidade vocal estável. Tema, tom e intensidade dirigem a interpretação: ritmo, ênfase, leveza e ironia podem variar com o contexto, conservando timbre, registro confortável, presença e volume. A intensidade é direção expressiva, não ganho, pitch ou efeito aleatório. A transcrição do provedor verifica fidelidade do texto; a revisão do áudio verifica dicção e naturalidade. O alinhamento local fornece tempos e deve distinguir palavras medidas de fronteiras estimadas.

Uma correção explícita de alinhamento pode resolver um caso conhecido, documentando palavra, limites, motivo e origem da estimativa. Não transformar esse caso em aprovação geral de grupos ausentes nem alterar o áudio para esconder a falha. Mudança no roteiro exige narração compatível com o texto novo; alteração somente visual preserva cache de voz válido.

## Hipótese de apelo e resultado medido

“Essa pergunta pode provocar comparação entre as falas” é hipótese editorial. Registrar por que parece plausível e qual comportamento se pretende observar. Não chamá-la de gancho vencedor, formato viral ou mecanismo de monetização antes de observar resultados.

Quando houver publicação real, registrar plataforma, ID/URL, data, versão do roteiro, duração e momento da leitura dos dados. Usar apenas métricas de fato disponíveis: retenção nos segundos iniciais, tempo médio assistido, conclusão, compartilhamentos por visualização e conteúdo dos comentários. Ausência de acesso é dado indisponível, nunca zero.

Comparar vídeos com duração, assunto, origem do público, idade e janela de medição semelhantes. Um exemplo de leitura é contar quantos comentários respondem à pergunta específica, distinguindo-os de respostas genéricas e spam. Uma melhora isolada não demonstra que a voz, a pergunta ou o efeito causou o resultado. Identificar variáveis alteradas e conservar exemplos que contrariem a hipótese.

A elegibilidade, eventual aprovação e receita de monetização são resultados separados. Somente confirmação real da plataforma e dados do canal permitem registrá-los como ocorridos. Não inferir aprovação pela presença de narração, partículas, legendas ou pela aparência de um canal concorrente.

## Arquivos do piloto

O exemplo reutilizável está em `work/monetization-sketch/v2/roteiro-v2.md`, com contrato em `editorial-plan-v2.json` e palavras de apoio em `evidence-ledger-v2.json`. São documentos editoriais; não ativam seleção automática, nova API ou publicação e não alteram o motor de render.

## Adaptador de voz e dependências

`processor/editorial_voice.py` lê e normaliza o JSON e usa os IDs, textos e direções de todas as cenas de narração. A produção usa `processor/voice_runtime/`, port mínimo da implementação Gemini Live do O Dinheiro Explica. A origem, commit e hashes estão em `voice_runtime/ORIGIN.json`; o loop Live, fidelidade, retries, cache e política foram preservados. O checkout ODE não é necessário na produção OS4. `--ode-root` continua opcional para compatibilidade e comparação com o worker original.

Exemplo de entrada: `python -m processor.editorial_voice --plan CAMINHO_PLANO --output-dir CAMINHO_AUDIO`. Exige `google-genai==2.26.0`, `num2words`, `ffprobe` e `GEMINI_API_KEY` no ambiente do runner. A chave precisa ser cadastrada no repositório OS4 para ativação; ter o código não comprova essa configuração. O código não lê arquivos de credenciais nem extrai o segredo do GitHub. `--preflight-only` apenas prepara e verifica requisitos locais, sem chamada remota. O wrapper `work/monetization-sketch/v2/tts-os4-plan.py` aplica hook/explain/question a abertura/comentario/fechamento em memória para o piloto, sem reescrever o plano. Na nuvem, ele pode ser copiado como `tts-os4-live.py` junto de `editorial_voice.py`, `editorial_plan.py` e `voice_runtime/`, ou usar `--ode-root` no job de prova.

O adaptador acrescenta direção global de conversa próxima e questionadora, preservando leitura literal e identidade Charon. A instrução global participa dos fingerprints de política e perfil de fala. Mudar essa direção invalida cache incompatível. Não há troca automática de modelo/voz nem fallback; áudio rejeitado continua rejeitado conforme a política preservada.

O perfil atual acrescenta ressonância suave de peito e registro confortável mais grave, tomando somente o tom do Plotquake como referência. O master aplica −1 semitom comum a todas as narrações, com compensação de duração, sem modificar os WAVs brutos ou as vozes da fonte. A configuração não alterna entre cenas. Veja [a direção vocal e sua proveniência](../processor/voice_runtime/DIRECTION.md).

A prova real do OS4 em 18/10/2026 gerou as três falas, refez automaticamente uma fala rejeitada pela conferência ASR e preservou os áudios já aprovados. Os dois formatos finais do piloto têm 67,6 segundos. Falhas de alinhamento têm uma única recuperação por execução, limitada às cenas rejeitadas e com hashes atuais; o motor não reduz o rigor da conferência para aceitar o áudio.

## Identidade de criador para diferentes assuntos

O formato atende economia, empreendedorismo, política e outros temas com a mesma identidade OS4. A conversa, a pergunta e o raciocínio determinam a montagem; não há linguagem de telejornal, ticker, selo de transmissão ou tarja de manchete. Os créditos permanecem discretos, e o tratamento de tarja na fonte continua independente do formato.

Na revisão visual de 18/10/2026, o fundo de narração passou a ter saturação zero e camada preta de 68%, conservando o vídeo real desfocado em movimento. Isso elimina o tom esverdeado da versão anterior. Títulos maiores em branco usam uma ênfase em âmbar; os apoios se substituem, um por vez. As entradas têm aceleração suave, deslocando somente a área de texto alterada e mantendo marca e elementos persistentes estáveis.

A pesquisa de 2026 tomou como referência o [BFI London Film Festival, da Pentagram](https://www.pentagram.com/work/bfi-london-film-festival), apresentado em 15/10/2026: letras reveladas gradualmente por luz e movimento em superfície escura. A [atualização de motion typography da Adobe, de 20/01/2026](https://blog.adobe.com/en/publish/2026/01/20/new-ai-powered-video-editing-tools-premiere-major-motion-design-upgrades-after-effects), também informa o uso do movimento na tipografia. A aplicação OS4 usa composição, cores e fonte próprias, adaptadas à leitura em celular e ao quadro horizontal.

`VISUAL_STYLE_VERSION` invalida fundos e composições narradas de versões antigas, sem refazer a voz aprovada. A animação usa uma sequência finita de PNGs, com um único input no compositor, para limitar uso de memória em lotes.
