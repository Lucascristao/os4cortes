# Falhas e recuperação de cortes

## Diagnóstico de 22/10/2026

A execução `39869870252` registrou repetidamente `Overlay lines overflow the content zone; shorten the scene text.` durante a montagem, depois de gerar e validar as narrações. O corpo do texto tinha posição e tamanho fixos; faltava aproveitar a área livre acima para acomodar as linhas. O título da capa do corte 30 também excedeu as duas linhas previstas pelo preset horizontal. O corte 31 foi confirmado no Drive com vídeo, SRT, texto e capa.

O processador antigo avançava ao próximo corte após cada erro. A porcentagem contabilizava tentativas, enquanto a mensagem de falha era substituída pela próxima etapa. O Publicador instalado conseguia examinar a pasta, mas não havia vídeos finais durante as primeiras verificações.

## Comportamento corrigido

- Textos de cena são medidos com a fonte real e ajustados em posição, tamanho e espaçamento sem truncar seu conteúdo. Todas as cenas do corte passam pela verificação antes da síntese ou codificação.
- Capas tentam o fallback já existente. Um título de duas linhas que ainda não cabe pode usar três linhas se a caixa comportar a mesma fonte mínima. O título original é preservado.
- Falhar somente na capa não descarta vídeo ou voz. Vídeo, SRT e texto são enviados e registrados em `pendingCuts`. A interface identifica a capa pendente; esses pacotes não entram em `ready_cut` nem no feed de publicação.
- Reenviar a mesma montagem com a capa corrigida reaproveita os arquivos pendentes, verificando tamanho e SHA256, e gera somente a capa. Alterações na receita da montagem invalidam essa retomada.
- Cada falha é persistida em `errors`, com corte, título e motivo. Nas duas primeiras falhas consecutivas o processo aguarda uma decisão autenticada de parar ou continuar. Continuar pula o corte que falhou. A terceira falha consecutiva encerra o lote, preservando os resultados.
- Somente um pacote completo salvo no Drive zera a sequência. A porcentagem e os contadores distinguem pacotes completos, vídeos com capa pendente e falhas.
- Parar a geração envia um pedido real ao processador; uma operação de mídia já iniciada pode concluir antes do próximo ponto de parada. A transcrição tem uma ação separada para encerrar somente o acompanhamento.

## Preservação das vozes

Os checkpoints `_os4_vozes_<hash>.zip` ficam na mesma pasta da sessão do Drive. Contêm WAVs PCM16 mono 24 kHz originais, sidecars, manifesto e alinhamento aprovado quando disponível. Não incluem áudio derivado, credenciais ou logs do runner. O armazenamento não recodifica o áudio.

A identidade inclui roteiro literal, IDs das cenas, interpretação, política global, modelo e voz. Alterar somente texto visual ou capa não invalida as vozes. A restauração verifica os hashes, formato PCM, fidelidade do texto e as mesmas políticas de qualidade usadas na síntese; arquivos corrompidos não passam como aprovados. Checkpoints parciais preservam as cenas já aprovadas para gerar somente as ausentes.

O resultado parcial é gravado atomicamente em `output/render-batch-result.json` após cada sucesso ou falha e preservado como artefato diagnóstico do workflow. Relatórios e checkpoints do Drive não são cadastrados como mídia para publicação.

## Limite das execuções anteriores

O workflow anterior não enviava os WAVs ao Drive. O cache de voz do GitHub era desabilitado no repositório público, e a execução investigada não disponibilizava artefatos de áudio. A correção não dá acesso retroativo ao disco temporário de um runner do GitHub. Uma voz só pode ser recuperada se seus bytes originais tiverem sido preservados; não se deve substituir áudio ausente por outro roteiro ou por um arquivo de teste antigo.

## Validação

Os testes cobrem encaixe visual nos dois formatos, título real da capa 30, preservação de vídeo com capa ausente, integridade e retomada das vozes, resultados parciais, pausa e limite de três falhas, decisões antigas, concorrência de parada/continuação, autenticação e publicação somente de pacotes completos. As prévias de tipografia representam a camada de texto da narração; na composição final o vídeo da fonte aparece ao fundo, escurecido e levemente desfocado.
