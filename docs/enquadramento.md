# Continuidade e recuperação de enquadramento

O workflow `renderizar.yml` executa `python -m processor.render_batch` no GitHub
Actions. A política de enquadramento faz parte desse processador; não exige que
o usuário processe vídeos localmente.

## Perda de alvo

O rastreador conserva a composição durante uma perda muito breve de detecção.
Passados 300 ms sem o alvo, o vertical mostra a fonte inteira sobre um fundo
suavizado. Numa nova cena ainda sem rosto detectado, essa visão geral entra
imediatamente. O tratamento de tarja já foi aplicado à fonte antes de compor
essa imagem; a visão geral não recupera áreas removidas por `lower_third.crop`.

O intervalo de confirmação de outro candidato corre durante a espera pela
recuperação, em vez de começar depois dela. Quando a recuperação é confirmada,
o enquadramento vai diretamente ao rosto, sem atravessar o espaço entre pessoas.
O acompanhamento normal e a confirmação de fala sustentada permanecem ativos.

## Movimento e atividade da boca

A estimativa de atividade da boca desconta a variação de uma região de referência
do rosto. Movimento comum à face ou iluminação não deve ser contado automaticamente
como articulação local da boca. Isso continua sendo uma heurística visual: não
foi acrescentada diarização de áudio ou identificação audiovisual de quem fala.
Reações, oclusões, rostos pequenos e planos em movimento podem exigir a visão
geral temporária.

## Cache e integração

`FRAMING_POLICY_VERSION` participa dos caches de vídeo simples, cenas originais
e mídia rastreada nos estilos autorais. A mudança dessa versão visual não altera
os fingerprints de roteiro, voz bruta, interpretação ou alinhamento. Um pacote
existente pode reaproveitar a narração e refazer o vídeo com o novo enquadramento.

O prompt, os identificadores de layouts/ícones, a montagem das cenas narradas e
as configurações de voz não são alterados por esta correção.

## Verificação

Os testes cobrem perda breve e prolongada de alvo, recuperação sem pan pelo vazio,
troca sustentada entre três participantes, movimento global da face, articulação
local e separação entre cache visual e cache de voz.

Foi renderizada uma comparação de 14 segundos de uma fonte horizontal real com
três participantes e câmera em movimento, usando YuNet e o mesmo áudio. Durante
a situação incerta, a política nova conserva os participantes na imagem geral.
Essa prova verifica o caminho do render e não garante a escolha correta de quem
fala em qualquer episódio. Os testes locais foram executados no Windows/Python
3.15; o CI valida Linux/Python 3.12 com FFmpeg e ffprobe.
