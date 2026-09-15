# OS4 Publicador — estado de implementação

## Etapa atual: A, configuração local e validação inicial

Não é a implementação final. Publicação, integração com o site, pareamento e acesso ao Drive ainda não estão habilitados. A interface indica explicitamente essa condição.

Autorização de teste recebida: corte 1 com legenda da pasta mais recente do Drive, nas três redes. Ainda é necessário identificar esse arquivo e confirmar as contas por login local.

Instalado em `C:/Users/lucas/Projetos/OS4Publicador/OS4 Publicador.exe`, atalho na área de trabalho, inicialização no login ativada pela primeira abertura do aplicativo. Aplicativo aberto e processo confirmado. Nenhuma conta informada na última verificação; nenhuma publicação realizada.

Teste Electron isolado aprovado: abertura da janela, IPC via preload, escrita/leitura de identificação no SQLite e renderização. Os dados fictícios ficaram em diretório temporário, removido ao terminar. Seis testes de fila passaram, incluindo recuperação após reinício.

O electron-builder falhou duas vezes durante coleta de módulos. `package-portable.ps1` montou o pacote com runtime Electron 44.3.0 extraído e Playwright 1.63.0; Chromium completo 1243 foi incluído. Não usar o diretório incompleto dist/win-unpacked como aplicativo final. Pacote usado: dist/portable-0.1.0.

Correção adicional do download já publicada no OS4: commit f9b17cd, deploy Netlify 6aa94cad2397f33d9d6a8ff6. Usa drive.google.com/uc com authuser=email do OS4 e link alternativo de visualização. Dez testes web passaram. Ainda não validado no Brave real: controle do navegador falhou/foi interrompido pela ferramenta. Não tornou arquivos públicos.

Base: AutoSocial commit `6deb560ee58ea1e6a040e1ee8e6ca269bd1576b5`, https://github.com/Katzca/AutoSocial . Licença MIT preservada em vendor/autosocial. Somente catálogo de rótulos foi incorporado nesta etapa; os publicadores originais não são executados.

## Achados que impedem reutilização direta

- Os três publicadores usam argumentos de ocultação de automação; Instagram também fixa User-Agent antigo. Não transportar esses comportamentos.
- YouTube escolhe automaticamente não infantil e sem restrição etária. Trocar por declarações aprovadas pelo usuário; título e descrição devem ser parâmetros separados, sem truncamento.
- Confirmação YouTube inclui palavra genérica processing; Instagram aceita mudança de URL. Exigir evidência inequívoca de publicação.
- TikTok repete clique em publicar, adiciona som opcional e desabilita verificações. Remover esses caminhos. Persistir intenção antes de um único clique.
- Rótulos do upstream não cobrem português adequadamente; adaptar e verificar nas sessões reais.
- Falha em arquivar localmente após publicação não pode tornar o item reenviável.

## Implementado

- Aplicativo Electron isolado, janela/bandeja, instância única, sessões Playwright em LOCALAPPDATA, navegador próprio sem copiar o Brave.
- Inicialização automática no login quando executado pelo pacote instalado.
- Tela para conectar redes e informar identidades; não confunde informação digitada com identidade validada.
- Núcleo SQLite WAL com transações, deduplicação, limite diário 50 por rede, pausa 300–600s, intenção de publicação persistida, recuperação para verificação após reinício.
- Testes simulados para deduplicação, cancelamento, exclusão global, limite e virada do dia Fortaleza.

## Próximas etapas obrigatórias

1. Instalar/abrir o pacote e conectar contas com participação do usuário.
2. Localizar corte escolhido e validar adaptadores, sem inventar identidade, declarações ou resultados.
3. Implementar backend de pareamento, comandos imutáveis e eventos em Netlify Blobs; fila local única em SQLite.
4. Resolver acesso ao Drive: atualmente refresh token foi fornecido aos Secrets do GitHub na configuração antiga. O código Netlify não o persiste para renovação de acesso. Não tentar ler secrets do GitHub. Precisará OAuth para acesso persistente apropriado no backend ou integração local devidamente autorizada.
5. Aba Postar, controle/revogação do dispositivo, sincronização, cache, limites remotos e recovery conforme plano aprovado.
6. Testes completos, preview sem envio real e rollout com validação em cada rede.

## Comandos de desenvolvimento

`npm ci`, `npm test`, `npm start`. Para empacotar: definir PLAYWRIGHT_BROWSERS_PATH para publisher/browser, executar `npx playwright install chromium`, depois `npm run pack`.
Dados pessoais não pertencem ao repo, ao pacote distribuído ou ao Netlify. Não criar atalho apontando para a árvore de desenvolvimento.
