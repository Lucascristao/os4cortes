# Formato editorial do OS4 Cortes

O usuário escolhe o vídeo e pode selecionar, editar ou excluir qualquer corte. A automação prepara propostas, organiza evidências, produz a voz aprovada e monta os arquivos. Cada proposta precisa acrescentar uma leitura própria que possa ser conferida nos trechos originais.

## Uma ideia completa por vídeo

Antes de escrever a locução, definir uma pergunta central, a descoberta que o público receberá e os trechos que permitem demonstrá-la. O começo identifica pessoas, situação e motivo para continuar. O desenvolvimento apresenta a fala relevante e explica uma distinção, consequência ou contexto verificável. O fim entrega a descoberta prometida e reconhece o limite do que foi mostrado.

O alvo de duração é uma decisão editorial. Para o piloto v2, a faixa é 65–85 segundos, com estimativa de voz a 155 palavras por minuto. A montagem final usa a duração dos WAVs. Não repetir uma explicação, prolongar silêncio, desacelerar a voz ou alongar uma cartela para atingir um minuto. Uma fala precisa continuar até completar a ideia, inclusive condições, negativas e ressalvas que mudem o sentido.

## Narrador conversado e questionador

Escrever como quem explica algo concreto a uma pessoa. Usar frases curtas, verbos claros e conexões naturais. A curiosidade deve nascer de uma diferença real entre afirmações, do funcionamento de algo ou de uma consequência demonstrável. O gancho faz uma promessa pequena que o próprio vídeo consegue cumprir.

Uma pergunta também transmite pressupostos. “Quem se beneficiou do esquema?” afirma implicitamente que houve um esquema; não serve quando isso não foi estabelecido. “O que essa resposta esclarece?” permite comparar as próprias falas. Não usar tom irônico, música ou edição para insinuar a conclusão que o roteiro não consegue sustentar.

No fechamento, primeiro entregar a conclusão. Depois fazer **uma** pergunta ligada à informação apresentada, com um objeto claro: qual ponto da resposta merece uma pergunta seguinte, que condição muda a explicação ou que detalhe falta para entender a sequência. Evitar “o que você acha?” sem assunto e evitar pedir ao público um veredito sobre culpa ou honestidade. A pergunta final já é um convite à conversa; não encadear novos pedidos de comentário, curtida e compartilhamento.

## Atribuição e evidência

Para cada afirmação, registrar se é fala atribuída, fato verificado em outra fonte, inferência editorial ou pergunta. Associar falas a palavras e timestamps da transcrição e manter a URL/origem. A legenda automática ajuda a localizar; a revisão do áudio confirma nomes, negativas e limites de corte. Timestamps derivados de legendas não devem ser apresentados como alinhamento acústico confirmado.

“Ela diz que apresentou” registra um depoimento. Não prova, por si, os fatos posteriores nem a inexistência deles. Uma interpretação precisa explicar o raciocínio e conservar seu alcance: “neste trecho” quando a conclusão se refere somente ao recorte. Não usar uma resposta sobre intenção como prova do resultado, nem desconhecimento declarado como prova de inexistência.

O vídeo original permanece audível sozinho nos excertos. Durante o comentário, silenciar a fala de fundo e identificar a fonte. O visual deve acompanhar a ideia explicada, sem inventar documentos, ligações comerciais ou relações entre pessoas. Efeitos decorativos não substituem o comentário nem constituem evidência de elegibilidade para monetização.

## Contrato para automação em lote

Cada corte deve trazer, antes da geração:

1. Fonte escolhida pelo usuário, pergunta central, título proporcional ao conteúdo e conclusão que será entregue.
2. Trechos com início/fim, palavras de entrada/saída, ideia completa e evidências associadas. Marcar limites novos ou duvidosos para revisão.
3. Roteiro autoral por cena e frases com alegações atribuídas. As instruções de voz ficam fora do texto falado.
4. Uma pergunta final específica e uma verificação de que ela não depende de pressuposto sem evidência.
5. Estimativa de duração com palavras/minuto declaradas e separação entre tempo de narrador e tempo de fonte.
6. Status editorial e pendências reais. Proposta pronta não equivale a áudio gerado, vídeo revisado ou publicação feita.

A seleção em lote não deve devolver várias versões do mesmo argumento com títulos diferentes. Comparar a pergunta, a descoberta e os intervalos de fonte entre candidatos. Não impor uma quantidade de cortes que force trechos incompletos ou repetitivos. O usuário conserva a escolha do conteúdo e o controle das propostas antes de gerar.

A síntese reutiliza Gemini Live/Charon conforme a integração aprovada, com leitura literal, identidade vocal estável e direção por sentido. Perguntas podem receber intenção de curiosidade; contrastes podem apoiar as palavras que mudam o significado. Não alternar voz, pitch ou intensidade para simular espontaneidade. A transcrição do provedor verifica fidelidade do texto; a revisão do áudio verifica dicção e naturalidade. O alinhamento local fornece tempos e deve distinguir palavras medidas de fronteiras estimadas.

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
