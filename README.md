# OS4 Cortes

Sistema para transformar vídeos longos em cortes verticais 9:16 com tracking de rosto, legendas automáticas e pacote de publicação.

## Arquitetura inicial

- **PWA / Netlify**: interface web responsiva e instalável no celular.
- **GitHub Actions**: processamento pesado (download, Whisper, FFmpeg, YuNet e renderização).
- **Google Drive**: armazenamento permanente de vídeos, transcrições, cortes e textos de postagem.
- **Sem Supabase nesta primeira versão**.

## Fluxo previsto

1. Informar URL do YouTube ou vídeo.
2. Gerar transcrição com Faster-Whisper.
3. Exportar a transcrição para análise editorial.
4. Importar pacote com título, início, fim, legenda da postagem e hashtags.
5. Para cada corte:
   - tracking 9:16;
   - MP4 sem legenda;
   - legenda Clean com Archivo Black;
   - MP4 legendado;
   - SRT;
   - TXT/JSON com texto de postagem.
6. Salvar cada corte no Google Drive antes de iniciar o próximo.

## Direção da interface

A interface será uma **PWA mobile-first**, podendo ser instalada no Android/iPhone como atalho/app web. O desktop continuará funcionando normalmente.

## Próxima prova técnica

Executar um único corte no GitHub Actions e comparar o resultado com o motor validado no Google Colab.
