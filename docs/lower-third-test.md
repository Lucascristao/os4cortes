# Teste local de tratamento de tarja

Prova do motor de vídeo, com saída vertical 9:16 e saída YouTube 16:9.

## Fonte

- Vídeo fornecido pelo usuário: https://youtu.be/PMGxFRAea_I
- Trecho: 01:00–01:08, oito segundos, 1920 × 1080, 30 fps.
- Altura da região inferior: 30% da origem (324 px). A área útil termina em y=756.
- Artefatos locais: `output/lower-third-test/` (ignorados pelo Git).

## Tratamentos

- `off`: mantém o comportamento existente.
- `cover`: cobre a região inferior na origem antes do tracking e do zoom.
- `crop`: remove a região inferior e calcula um novo recorte com a proporção de saída. O plano aberto preserva o topo da imagem.

Na saída YouTube, recortar 30% da altura exige recalcular também a largura: a janela base é 1344 × 756. A saída continua em 1920 × 1080. Na vertical, a janela base é 425 × 756 e a saída é 1080 × 1920. Há ampliação da área restante.

As legendas e as capas do pipeline recebem o vídeo já tratado. Esta prova chama diretamente os renderizadores e compara o enquadramento sem adicionar legendas.

## Reprodução

Com as dependências de `requirements-render.txt`, NumPy e FFmpeg disponíveis:

```powershell
python tests/render_lower_third_smoke.py `
  --source .render_work/news-test-source.mp4 `
  --duration 8 --height 0.30 `
  --output output/lower-third-test
```

O script gera seis MP4, três comparativos de quadros (0,8 s; 3,5 s; 7,5 s) e `verificacao.json`. Confere decodificação de todos os quadros, resolução, duração e áudio. O áudio completo deve decodificar, ter a duração esperada e conter sinal.

## Resultado verificado em 18/10/2026

- Os seis arquivos foram gerados: 240 quadros, 30 fps, oito segundos cada.
- As três versões verticais têm 1080 × 1920; as três versões YouTube têm 1920 × 1080.
- O áudio completo dos seis arquivos decodificou com a duração esperada e sinal presente.
- A cobertura manteve a região inferior preta nos 240 quadros de cada formato.
- Inspeção visual dos comparativos em 0,8 s, 3,5 s e 7,5 s: a tarja desaparece nos dois tratamentos e nos dois formatos, incluindo a mudança de câmera para os entrevistadores.
- O reenquadramento vertical fica bem próximo do rosto; a cobertura preserva o plano mais aberto. Em 16:9, o reenquadramento também reduz as laterais do plano.
- 31 testes Python selecionados de tratamento, framing, normalização de formatos e integração do publicador passaram. Os 11 testes Node da API também passaram.

Resultados sem legendas, para comparar o tratamento da imagem. Protótipo disponível apenas no código e nos artefatos locais.

O lote aceita a mesma configuração para todos os cortes de uma sessão, inclusive os horizontais:

```text
python -m processor.render_batch [argumentos existentes] --lower-third-mode cover --lower-third-height 0.30
python -m processor.render_batch [argumentos existentes] --lower-third-mode crop --lower-third-height 0.30
```

## Integração com a web no código

Conforme a escolha do usuário, a interface tem somente a marcação **Vídeo com tarja jornalística**, abaixo da URL. Ela aplica reenquadramento a todos os cortes da sessão, tanto 9:16 quanto 16:9. A faixa preta fica disponível apenas no motor para uso futuro. A interface não adiciona prévia, ajuste de altura, seletor de modo ou etapa por corte.

`hasLowerThird` acompanha a transcrição, o polling e a sessão salva no navegador. Pode ser alterado para uma sessão existente sem retranscrever. Links alternativos do mesmo vídeo preservam a escolha; outro vídeo começa desmarcado. A API aceita apenas booleanos e deriva os parâmetros do motor: marcado = `crop/0.30`; desmarcado ou legado = `off/0`.

O workflow `renderizar.yml` passa a configuração uma vez para o lote, usando os mesmos renderizadores e mantendo o original no Drive.

Validação da interface: envio de transcrição, restauração após recarregar, importação e envio de lote misto 9:16 + YouTube em navegador local com API simulada. O teste não inicia processamento remoto nem publicação. Captura em `output/reframing-ready/interface.jpg`. Testes automatizados cobrem persistência, isolamento entre vídeos, booleanos inválidos e transmissão para 40 cortes mistos.

O valor de 30% foi validado no trecho informado. Vídeos com tarjas de outras alturas podem exigir refinamento futuro do motor.

## Pequenos ajustes de continuidade do falante

A revisão mantém o estilo, os zooms e os tempos de espera existentes. As correções se concentram em associar cada boca à referência anterior mais próxima, limpar o histórico após perda da detecção, não contar ausência de rostos como evidência contínua e exigir o mesmo candidato antes de transferir o foco no YouTube.

A seleção continua baseada em evidência visual de movimento labial. As regressões com múltiplos candidatos verificam as falhas de estado; o trecho real tem quase sempre um rosto e valida execução e troca de câmera, sem comprovar identificação de falante em qualquer conversa.

## Validação final da integração

- 43 testes Python selecionados passaram, incluindo as regressões de continuidade do falante, amostragem em baixa taxa de quadros e os testes com OpenCV instalado.
- 22 testes Node passaram; verificação TypeScript e sintaxe da PWA passaram.
- Duas amostras finais em `output/reframing-ready/`: vertical 1080 × 1920 e YouTube 1920 × 1080, ambas com 240 quadros, oito segundos e áudio completo. Os quadros de 0,8 s, 3,5 s e 7,5 s foram inspecionados.
- `comparativo_final.jpg` contém os dois formatos em três momentos; `interface.jpg` registra a marcação única por vídeo.

Publicação pela integração GitHub → Netlify: as alterações seguem juntas na `main`, incluindo o workflow que envia a configuração ao motor. A confirmação do CI e do deploy deve se referir ao mesmo commit. A validação local acima usa dados simulados na web e os dois renders reais; não inicia lote remoto nem publicação de vídeos.
