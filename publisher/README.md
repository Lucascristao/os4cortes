# OS4 Publicador 0.2.0

Cole a pasta do vídeo novo em **Acompanhar & Iniciar Fila**, mesmo enquanto os cortes ainda são gerados. O acompanhamento consulta a API do OS4 a cada dois minutos, recebe os pacotes completos e retoma automaticamente após reiniciar. A geração escreve `_os4_publicador.json` na pasta para conectar o aplicativo à API; pastas de renderizações antigas podem não conter esse arquivo.

Vídeos verticais seguem para TikTok e Instagram. Vídeos 16:9 seguem para YouTube. São permitidos dois envios simultâneos em redes diferentes, com um envio por rede. O intervalo de três a cinco minutos conta desde o início da tentativa e mantém uma pausa mínima de trinta segundos após o encerramento. O limite diário existente é de cinquenta tentativas por rede, contado pelo horário de Fortaleza; o painel informa quando esse limite é atingido.

O aplicativo grava a intenção antes do clique final e a confirmação da rede antes de fechar o navegador. Envios inconclusivos ficam em **Conferência pendente**: confira a rede e escolha **Já publicado** ou **Não publicado: reenviar**. A publicação continua usando os perfis locais do Chrome; a nova API acompanha a geração dos cortes e não substitui as APIs oficiais das redes sociais.

Falhas anteriores ao clique final recebem até três tentativas automáticas. Falhas de download são repetidas com espera crescente, enquanto outros cortes continuam. Arquivos locais são excluídos dois minutos após todas as publicações que os utilizam estarem confirmadas. Os originais permanecem no Drive.

Fila, acompanhamento, perfis e logs ficam em `%LOCALAPPDATA%\OS4Publicador`. O log contínuo é `activity.ndjson`; o histórico de etapas e confirmações fica em `queue.sqlite`. A autorização para acompanhar a pasta é criptografada pelo Windows e não é enviada à interface.

Validação: `npm --prefix publisher test`. O teste de interface `node publisher/tests/smoke.cjs` usa dados isolados e desativa envios; `OS4_TEST_EXE` permite selecionar o executável instalado. Para gerar um pacote portátil, execute `publisher/package-portable.ps1` com o runtime e o Playwright instalados.
