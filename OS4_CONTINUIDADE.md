# OS4 Cortes — continuidade em 13/09/2026

## Pedido e prioridade
Melhorias devem funcionar em vídeos diversos, sem regras específicas para este exemplo. Usuário pediu parar antes de 5% restante da janela de 5h, documentar pendências e publicar o concluído.

Último esclarecimento: PASSAR PELA MESA NÃO É NECESSARIAMENTE PROBLEMA. O problema principal é a indecisão entre duas pessoas, indo e voltando quando a outra apenas concorda. Deseja também transições menos secas. Não confundir estabilidade do rosto com identificação real de quem fala.

## Concluído
- Commit main `7ffa58f241609827dcac2fa5778aa492f0a5af49` já enviado ao GitHub Lucascristao/os4cortes.
- Legendas: fonte 68→88; até 6 palavras e 34 caracteres por grupo; uma ou duas linhas; limites de pausa/duração; quebras que procuram respeitar frases; destaque amarelo da palavra mantendo o contexto visível; medição real da fonte para evitar ultrapassar a área segura.
- Pillow adicionado aos dois requirements. Compatibilidade de fontes e caminhos FFmpeg no Windows. Correção do arredondamento SRT na virada do minuto.
- 6 testes de legenda e 6 testes Node passaram localmente. CI Linux concluído com sucesso: https://github.com/Lucascristao/os4cortes/actions/runs/34799730768
- Render completo de um corte com legenda foi concluído e uma imagem foi inspecionada visualmente.
- Deploy Netlify iniciado; consultar confirmação ao final deste documento.
- Novos processamentos no GitHub usam main. Cortes antigos precisam ser renderizados novamente para receber as legendas.

## Repositório e arquivos
Raiz desta tarefa: `C:/Users/lucas/Documents/Codex/2026-09-13/https-os4cortes-netlify-app-https-os4cortes`.
Repositório: `work/os4cortes`. Produção: https://os4cortes.netlify.app . Site Netlify: `0723722b-e057-42e3-ad63-6261cb4db4ff`.
Não sobrescrever alterações anteriores do usuário em web/enhancements.js, autenticação e SW. Base anterior era aa260b4.

## Enquadramento — proposta salva, NÃO publicada
Código experimental foi retirado antes do commit:
- `work/video-analysis/framing.py`: política temporal de continuidade de rosto, espera por perda temporária, confirmação antes de trocar, zona morta e movimento independente de FPS.
- `work/video-analysis/tracking-proposta.patch`: integração com tracking.py e detecção de mudança de plano.
- `work/video-analysis/test_video_proposta.py`: 6 testes de framing + 6 de legenda. Os testes sintéticos passaram, mas não equivalem à validação visual em múltiplos vídeos.
- Para retomar, copiar framing.py para processor e aplicar/adaptar o patch. NÃO aplicar cegamente: revisão visual ainda necessária.
- No novo render do corte 1, entre 25–33s há passagem pela mesa e depois estabilização no homem de camisa clara. A política elimina a escolha repetida pelo maior rosto enquanto o alvo atual ainda existe. Porém pode manter um ouvinte se a seleção inicial estiver errada. Não usa áudio nem identificação de falante.
- reset_shot atualmente encaixa o centro imediatamente no novo rosto. Rever isso conforme pedido de transição menos seca, sem criar arrastos longos ou movimentos para a direção errada.
- Não prometer que este algoritmo identifica quem fala. Avaliar associação temporal e evidência de fala/movimento labial ou fallback apropriado quando há dois rostos. Validar em outros vídeos e diferentes FPS.

## Materiais e reprodução
Originais do usuário: `C:/Users/lucas/Pictures/Miguel Andrade/Vd2/`: como pode ser.mp4, corte_01.mp4 até corte_04.mp4.
Documento de contexto: `C:/Users/lucas/Projetos/OS4CORTES/OS4_CORTES_COMPLETO.md`.
Vídeo original exemplo: https://www.youtube.com/watch?v=X3HOegrwb8U . Download 720p já está em `work/video-analysis/original.mp4`.
Transcrição recuperada do artefato do run 34770346824 em `work/video-analysis/transcript/` (buscar transcricao.json recursivamente). NÃO precisa transcrever novamente.
Offsets por correlação de áudio em `work/video-analysis/offsets.json`: corte1 120.89s/46.72s; corte2 201.09s/69.31s; corte3 294.59s/63.10s; corte4 497.69s/53.41s.
Scripts align.py e render.py em video-analysis. render.py atualmente só processa corte1 e, se executado agora, usará tracking original de produção.
Contact sheets em video-analysis: reference.jpg, corte.jpg, movement.jpg, corte2.jpg, corte3.jpg, corte4.jpg, original-movement.jpg, original-detail.jpg, novo-movimento.jpg.
`outputs/cortes-melhorados/corte_01_novo_legenda.mp4` é AMOSTRA EXPERIMENTAL: combina legenda publicada e tracking NÃO publicado. Não apresentar como reprodução exata da produção.
Imagem de legenda: `outputs/cortes-melhorados/legenda-nova.jpg`.

## Ambiente
Python funcional: `C:/Users/lucas/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.
Pacotes adicionais instalados em `work/video-analysis/packages`: opencv-python-headless 5.0.0.93, numpy 2.5.3, yt-dlp. Inserir esse diretório em sys.path. Sandbox pode não ler cv2 instalado pelo usuário escalado; render funcionou com exec escalado. FFmpeg disponível. Não reinstalar sem necessidade.
Render completo levou alguns minutos; logs de tracking são silenciosos, legendas exibem progresso FFmpeg.
gh autenticado funciona via exec escalado; não precisa reutilizar tokens do histórico. Git escalado requer safe.directory explícito e helper gh auth git-credential. Nunca imprimir credenciais.
Supabase não participa destas mudanças. Se surgir tarefa Supabase, seguir AGENTS do usuário (MCP pessoal obrigatório).

- Enquadramento estabilizado (`processor/framing.py` e `processor/tracking.py`) com detecção de fala por movimento labial (`speaking_score`).
- Eliminação do flicker/ping-pong e priorização automática do falante ativo quando há dois participantes em cena.
- Transição cinematográfica suave através da mesa sem saltos secos desnecessários.
- Micro-animação "Pop" (zoom sutil \fscx/\fscy) na palavra falada ativa nas legendas (`processor/captions.py`).
- Botão "Copiar Prompt para IA" na interface com formatação pronta para ChatGPT/Claude (`web/index.html` e `web/app.js`).
- Higienizador automático de JSON (`higienizarJsonPacote`) que remove crases markdown, vírgulas órfãs e textos conversacionais ao importar cortes.
- 14 testes unitários em Python e 6 testes Node aprovados localmente com 100% de sucesso.
- Render de teste do corte 01 gerado com sucesso em `outputs_teste/` e validado visualmente.

## Repositório e arquivos
Repositório: `Lucascristao/os4cortes`. Produção: https://os4cortes.netlify.app . Site Netlify: `0723722b-e057-42e3-ad63-6261cb4db4ff`.
Base anterior: `d33ea1b`. Branch do Publicador: `feat/local-publisher`.

## OS4 Publicador — Fluxo Contínuo Concluído e Validado (16/09/2026)
- **Download silencioso do Google Drive (`publisher/src/downloader.cjs`):**
  - Conexão direta via sessão autenticada do Google Chrome (`profiles/youtube`).
  - Filtro estrito: baixa apenas `*_legenda.mp4` e `*_post.txt`. Arquivos crus (`.srt` e `.mp4` sem legenda) são sumariamente ignorados.
  - Medição em tempo real de taxa de download (MB/s) e tempo decorrido.
- **Instagram Reels (`publisher/src/adapters/instagram.cjs`):**
  - Seleção explícita e obrigatória da proporção `9:16` vertical no modal de corte.
  - Inserção integral do texto do post (título, parágrafos explicativos e hashtags).
  - Publicação validada e confirmada pelo usuário na conta real `@os4.cortes`.
- **TikTok Studio (`publisher/src/adapters/tiktok.cjs`):**
  - Rolagem automática até o rodapé e clique nativo por coordenadas no botão vermelho `Publicar`.
  - Validação estrita de confirmação com captura de evidência. Testado e confirmado em 84.5s.
- **YouTube Shorts (`publisher/src/adapters/youtube.cjs`):**
  - Título limpo e formatado extraído da 1ª linha do `_post.txt` com pontuação e acentuação corretas + tag `#shorts`.
  - Preenchimento da descrição completa, seleção de não infantil, avanço até visibilidade Pública e fechamento do modal pós-publicação.
- **Fila Sequencial Segura (`publisher/src/executor.cjs`):**
  - Intervalo de proteção aleatório de 5 a 10 minutos (300–600s) entre postagens na mesma rede.
- **Ponte Local (`publisher/src/bridge.cjs`):**
  - Porta `127.0.0.1:49152` conectada ao término de render da aplicação web.
- **Importação Sob Demanda do Google Drive (Opção B):**
  - Campo na interface do desktop app para colar qualquer link de pasta do Google Drive.
  - Varredura e indexação inteligente com rolagem contínua para carregar todos os cortes.
  - Filtro estrito: baixa e enfileira exclusivamente `*_legenda.mp4` e `*_post.txt`, descartando `.srt` e `.mp4` crus.
- **Correções de Desduplicação e Varredura (Opção B - Atualizado):**
  - O filtro de duplicidades do downloader agora é estritamente isolado pela pasta/sessão (`requestId`/`folderId`), impedindo que cortes de um novo vídeo sejam pulados por terem números iguais a cortes de vídeos anteriores.
  - O `videoFileId` no executor agora incorpora o `requestId`, prevenindo colisões de fingerprint no SQLite.
  - Varredura no Drive reforçada com suporte a regex flexível (`/corte[_\s-]*\d+/i`), leitura de atributos de acessibilidade (`aria-label`, `title`) e rolagem ampla de contêiner.
- **Conexão Web -> Desktop (Opção A - Atualizado):**
  - Desbloqueio da Content Security Policy (CSP) em `netlify.toml` liberando `http://127.0.0.1:49152` na diretiva `connect-src`.
  - Suporte a Private Network Access (PNA) no `bridge.cjs` com o cabeçalho `Access-Control-Allow-Private-Network: true`, permitindo requisições originadas do site público HTTPS (`https://os4cortes.netlify.app`).
  - Banner informativo no site `web/app.js` com status em tempo real e botão de reenvio.
- **Sincronização:**
  - Arquivos sincronizados na pasta do app instalado em `C:\Users\lucas\Projetos\OS4Publicador\resources\app\src\`.


