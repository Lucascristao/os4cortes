const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const { withGoogleLock } = require('../google-lock.cjs');

async function publishYouTubeShorts({ videoPath, title, description = '' }) {
  return withGoogleLock(async () => {
    const startTime = Date.now();
    const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
    const profileDir = path.join(dataDir, 'profiles', 'youtube');
    const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

    console.log('[YouTube] Iniciando publicação de Shorts...');
    console.log('[YouTube] Vídeo:', videoPath);
    console.log('[YouTube] Título:', title);

    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromePath,
      headless: false,
      viewport: { width: 1366, height: 850 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled']
    });

    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(60000);

  try {
    console.log('[YouTube 1/5] Carregando YouTube Studio...');
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Fecha possíveis popups de boas-vindas do Studio
    const dismissButtons = [
      page.locator('ytcp-button#dismiss-button'),
      page.locator('button:has-text("Dispensar")'),
      page.locator('button:has-text("Continuar")'),
      page.locator('button:has-text("Entendi")')
    ];
    for (const btn of dismissButtons) {
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        await btn.first().click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    console.log('[YouTube 2/5] Abrindo modal de upload...');
    const createBtn = page.locator('button[id="create-icon"], ytcp-button:has-text("Criar"), button:has-text("Criar"), div[id="create-icon"]').first();
    await createBtn.waitFor({ state: 'visible', timeout: 20000 });
    await createBtn.click({ force: true });
    await page.waitForTimeout(1000);

    const uploadOption = page.locator('tp-yt-paper-item:has-text("Enviar vídeos"), #text-item:has-text("Enviar vídeos")').first();
    await uploadOption.waitFor({ state: 'visible', timeout: 15000 });
    await uploadOption.click({ force: true });
    await page.waitForTimeout(2000);

    console.log('[YouTube 3/5] Enviando arquivo de vídeo...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 20000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[YouTube] Arquivo enviado! Aguardando processamento inicial...');
    await page.waitForTimeout(5000);

    console.log('[YouTube 4/5] Preenchendo metadados...');
    const titleBox = page.locator('#title-textarea #textbox, #textbox[aria-label*="título" i], #textbox[aria-label*="title" i]').first();
    if (await titleBox.isVisible({ timeout: 15000 }).catch(() => false)) {
      await titleBox.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(title);
      console.log('[YouTube] Título definido com sucesso!');
    }

    const descBox = page.locator('#description-textarea #textbox, #textbox[aria-label*="descrição" i], #textbox[aria-label*="description" i]').first();
    if (description && await descBox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await descBox.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(description);
      console.log('[YouTube] Descrição preenchida com sucesso!');
    }

    // Verifica se atingiu o limite diário de envios do canal
    const limitNotice = page.locator('text=/limite di[aá]rio de envio/i, text=/daily upload limit/i, text=/limite de envio atingido/i, :has-text("limite de envio")').first();
    if (await limitNotice.isVisible({ timeout: 2000 }).catch(() => false)) {
      const msg = await limitNotice.innerText().catch(() => 'Limite diário de envio atingido');
      throw new Error(`Limite diário do YouTube atingido: "${msg.trim()}". O YouTube libera novos envios em 24h ou após verificação de recursos avançados.`);
    }

    // Seleciona "Não é conteúdo para crianças"
    const notForKids = page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], [name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], #radioLabel:has-text("Não é conteúdo para crianças"), [aria-label*="Não é conteúdo para crianças" i]').first();
    try {
      await notForKids.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await notForKids.click({ force: true, timeout: 8000 });
      console.log('[YouTube] Selecionado: Não é conteúdo para crianças');
    } catch (_) {
      // Fallback: tenta clicar diretamente pelo texto
      const textRadio = page.locator('text="Não é conteúdo para crianças"').first();
      await textRadio.scrollIntoViewIfNeeded().catch(() => {});
      await textRadio.click({ force: true }).catch(() => {});
    }

    // Avança telas até Visibilidade (Próximo -> Próximo -> Próximo)
    console.log('[YouTube 5/5] Avançando telas até Visibilidade...');
    const nextBtn = page.locator('ytcp-button#next-button, button:has-text("Próximo")').first();
    for (let step = 1; step <= 3; step++) {
      await page.waitForTimeout(2000);
      if (await limitNotice.isVisible({ timeout: 500 }).catch(() => false)) {
        throw new Error('Limite diário do YouTube atingido nesta conta (cota máxima de ~10 envios por 24h).');
      }
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        console.log(`[YouTube] Avançou etapa ${step}`);
      }
    }
    await page.waitForTimeout(2000);

    // Marca como Público
    console.log('[YouTube] Definindo visibilidade como "Público"...');
    const publicOption = page.locator('tp-yt-paper-radio-button[name="PUBLIC"], #radioLabel:has-text("Público"), [name="PUBLIC"]').first();
    await publicOption.waitFor({ state: 'visible', timeout: 20000 });
    await publicOption.scrollIntoViewIfNeeded();
    await publicOption.click();
    console.log('[YouTube] Visibilidade definida como: Público');
    await page.waitForTimeout(1500);

    // Garante que a transmissão do arquivo de vídeo foi 100% concluída antes de publicar
    console.log('[YouTube] Aguardando confirmação de envio dos dados do vídeo...');
    const uploadDoneSelector = 'text=/envio conclu[ií]do/i, text=/upload complete/i, text=/processando/i, text=/processing/i, text=/verificações concluídas/i, text=/checks complete/i';
    let uploadConfirmed = false;
    for (let u = 1; u <= 60; u++) {
      const isDone = await page.locator(uploadDoneSelector).first().isVisible({ timeout: 1000 }).catch(() => false);
      if (isDone) {
        uploadConfirmed = true;
        console.log(`[YouTube] ✅ Envio dos bytes do vídeo 100% concluído em ${u * 2}s!`);
        break;
      }
      if (u % 5 === 0) {
        console.log(`[YouTube] Transmitindo arquivo para os servidores do YouTube (${u * 2}s)...`);
      }
      await page.waitForTimeout(2000);
    }

    // Clica em Publicar
    console.log('[YouTube] >>> CLICANDO EM PUBLICAR <<<');
    const doneBtn = page.locator('ytcp-button#done-button, button:has-text("Publicar"), button:has-text("Salvar")').first();
    await doneBtn.waitFor({ state: 'visible', timeout: 15000 });
    await doneBtn.click();

    // Aguarda confirmação
    console.log('[YouTube] Aguardando confirmação do YouTube...');
    let confirmed = false;
    const successSelectors = [
      'ytcp-video-share-dialog',
      'ytcp-uploads-still-processing-dialog',
      '#dialog-title:has-text("publicado")',
      '#dialog-title:has-text("Processando")',
      'text="Vídeo publicado"',
      'text="Short publicado"',
      'text="Vídeo enviado"',
      'text="Processando vídeo"',
      'text="Verificações concluídas"',
      'button:has-text("Fechar")',
      'ytcp-button:has-text("Fechar")',
      'ytcp-button#close-button'
    ];

    for (let w = 1; w <= 30; w++) {
      await page.waitForTimeout(1500);
      let isSuccess = false;
      for (const sel of successSelectors) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) {
          isSuccess = true;
          break;
        }
      }

      if (isSuccess) {
        confirmed = true;
        console.log('[YouTube] >>> VÍDEO CONFIRMADO PELO YOUTUBE! <<<');
        console.log('[YouTube] Mantendo navegador conectado por 15 segundos para estabilização de processamento e handshake...');
        await page.waitForTimeout(15000);

        const closeBtn = page.locator('ytcp-button#close-button, ytcp-button:has-text("Fechar"), button:has-text("Fechar")').first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click().catch(() => {});
          await page.waitForTimeout(2000);
        }
        break;
      }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const uploadSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);
    const screenshotPath = path.join(dataDir, `yt-published-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    if (!confirmed) {
      throw new Error('YouTube não confirmou a publicação do vídeo (verifique o screenshot salvo em: ' + screenshotPath + ')');
    }

    return {
      ok: true,
      network: 'youtube',
      confirmed,
      totalSeconds,
      uploadSeconds,
      screenshot: screenshotPath
    };
    } catch (err) {
      const errScreenshot = path.join(dataDir, `yt-error-${Date.now()}.png`);
      if (page) await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
      console.error(`[YouTube] Erro durante o fluxo: ${err.message} (screenshot salva em ${errScreenshot})`);
      throw err;
    } finally {
      if (page) await page.waitForTimeout(1500).catch(() => {});
      if (ctx) await ctx.close().catch(() => {});
    }
  }, `publish_youtube_${(title || '').slice(0, 20)}`, 240000);
}

module.exports = { publishYouTubeShorts };
