const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const { withGoogleLock } = require('../google-lock.cjs');

// Formata títulos para o YouTube: viral, instigante, sem cortar no meio de palavras e preservando acentos
function formatarTituloViralYoutube(tituloBruto, maxChars = 70) {
  if (!tituloBruto) return 'Corte';
  
  let s = String(tituloBruto).trim();
  // Remove prefixos numéricos ("Corte 01:", "01 - ", etc.)
  s = s.replace(/^(?:corte\s*\d+[\s:_-]*|\d+[\s:._-]*)/i, '').trim();
  // Pega apenas a primeira linha caso venha com quebras
  s = s.split(/\r?\n/)[0].trim();

  // Se tem separador com convidado ou programa (" | " ou " - ")
  if (s.includes(' | ') || s.includes(' - ')) {
    const separador = s.includes(' | ') ? ' | ' : ' - ';
    const partes = s.split(separador).map(p => p.trim()).filter(Boolean);
    const gancho = partes[0];
    const complemento = partes.slice(1).join(separador);

    // Se o gancho principal for forte e explicativo (>= 25 caracteres), usamos o gancho direto para máxima viralidade
    if (gancho.length >= 25 && gancho.length <= maxChars) {
      s = gancho;
    } else if (gancho.length + separador.length + complemento.length <= maxChars) {
      s = `${gancho}${separador}${complemento}`;
    } else {
      s = gancho;
    }
  }

  // Se ainda assim passar de maxChars, trunca elegantemente na última palavra completa
  if (s.length > maxChars) {
    const sub = s.slice(0, maxChars);
    const lastSpace = sub.lastIndexOf(' ');
    if (lastSpace > 25) {
      s = sub.slice(0, lastSpace);
    } else {
      s = sub;
    }
  }

  // Limpa pontuações soltas no final
  s = s.replace(/[\s|_:-]+$/, '').trim();
  return s || 'Corte';
}

async function publishYouTubeVideo({ videoPath, title, description = '', thumbnailPath = null }) {
  return withGoogleLock(async () => {
    const startTime = Date.now();
    const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
    const profileDir = path.join(dataDir, 'profiles', 'youtube');
    const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

    console.log('[YouTube] Iniciando publicação de vídeo...');
    console.log('[YouTube] Vídeo:', videoPath);
    console.log('[YouTube] Título:', title);
    if (thumbnailPath) console.log('[YouTube] Miniatura/Capa 16:9:', thumbnailPath);

    if (!fs.existsSync(videoPath)) {
      throw new Error(`Arquivo de vídeo não encontrado em: ${videoPath}`);
    }
    const videoStat = fs.statSync(videoPath);
    if (videoStat.size < 1000000) {
      throw new Error(`Arquivo de vídeo corrompido ou incompleto (${videoStat.size} bytes): ${videoPath}`);
    }
    const fd = fs.openSync(videoPath, 'r');
    const headBuf = Buffer.alloc(200);
    fs.readSync(fd, headBuf, 0, 200, 0);
    fs.closeSync(fd);
    const headStr = headBuf.toString('utf8');
    if (headStr.includes('<html') || headStr.includes('<!DOCTYPE') || headStr.includes('accounts.google.com')) {
      throw new Error(`Arquivo de vídeo corrompido (contém página HTML do Google em vez de vídeo): ${videoPath}`);
    }

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
    await page.goto('https://studio.youtube.com/?approve_browser_access=true', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Fecha possíveis popups de boas-vindas do Studio
    const dismissButtons = [
      page.locator('a[href*="approve_browser_access"]'),
      page.locator('text=/pular para o youtube studio/i'),
      page.locator(':has-text("PULAR PARA O YOUTUBE STUDIO")'),
      page.locator('ytcp-button#dismiss-button'),
      page.locator('button:has-text("Dispensar")'),
      page.locator('button:has-text("Continuar")'),
      page.locator('button:has-text("Entendi")')
    ];
    for (const btn of dismissButtons) {
      if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
        console.log('[YouTube] Clicando em botão de dispensar/pular aviso inicial...');
        await btn.first().click().catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    console.log('[YouTube 2/5] Abrindo modal de upload...');
    const createBtn = page.locator('button[id="create-icon"], ytcp-button#create-icon, ytcp-button:has-text("Criar"), ytcp-button:has-text("Create"), button:has-text("Criar"), button:has-text("Create"), div[id="create-icon"], [aria-label*="Criar"], [aria-label*="Create"], ytcp-button-shape#create-icon').first();
    await createBtn.waitFor({ state: 'visible', timeout: 45000 });
    await createBtn.click({ force: true });
    await page.waitForTimeout(1000);

    const uploadOption = page.locator('tp-yt-paper-item:has-text("Enviar vídeos"), tp-yt-paper-item:has-text("Upload videos"), tp-yt-paper-item:has-text("Enviar"), #text-item:has-text("Enviar vídeos"), #text-item:has-text("Upload videos"), ytcp-text-menu #text-item').first();
    await uploadOption.waitFor({ state: 'visible', timeout: 20000 });
    await uploadOption.click({ force: true });
    await page.waitForTimeout(2000);

    console.log('[YouTube 3/5] Enviando arquivo de vídeo...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 20000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[YouTube] Arquivo enviado! Aguardando processamento inicial...');
    await page.waitForTimeout(3000);

    const unreadableError = page.locator('text=/arquivo ileg[ií]vel/i, text=/n[aã]o foi poss[ií]vel encontrar ou ler o arquivo/i, text=/could not find or read/i').first();
    if (await unreadableError.isVisible({ timeout: 2500 }).catch(() => false)) {
      throw new Error('O arquivo de vídeo foi considerado ilegível pelo YouTube Studio (download truncado ou incompleto).');
    }

    console.log('[YouTube 4/5] Preenchendo metadados...');
    const safeTitle = formatarTituloViralYoutube(title, 70);
    console.log(`[YouTube] Título viral formatado (${safeTitle.length} chars): "${safeTitle}"`);

    // Seletores abrangentes para o campo de Título no YouTube Studio (Upload Dialog e Metadata Editor)
    const titleSelectors = [
      '#title-textarea #textbox',
      'ytcp-video-title #textbox',
      'ytcp-social-suggestions-textbox[label*="título" i] #textbox',
      'ytcp-social-suggestions-textbox[label*="title" i] #textbox',
      'ytcp-social-suggestions-textbox #textbox',
      '#textbox[aria-label*="título" i]',
      '#textbox[aria-label*="title" i]',
      'div[aria-label*="título" i][contenteditable="true"]',
      'div[aria-label*="title" i][contenteditable="true"]',
      'ytcp-video-metadata-editor #title-textarea #textbox'
    ];
    const titleBox = page.locator(titleSelectors.join(', ')).first();

    // Aguarda até 45s o campo de título estar visível (essencial para vídeos 16:9 maiores onde o diálogo leva alguns segundos para renderizar)
    try {
      await titleBox.waitFor({ state: 'visible', timeout: 45000 });
      await titleBox.scrollIntoViewIfNeeded().catch(() => {});
      await titleBox.click();
      await titleBox.focus().catch(() => {});
      await page.waitForTimeout(200);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(150);
      await page.keyboard.insertText(safeTitle);
      console.log('[YouTube] Título inserido com sucesso:', safeTitle);
      await page.waitForTimeout(400);
    } catch (errTitleWait) {
      console.error('[YouTube] ❌ Falha ao localizar/preencher campo de título:', errTitleWait.message);
      throw new Error(`Não foi possível carregar o formulário de metadados do YouTube Studio a tempo: ${errTitleWait.message}`);
    }

    // Preenche descrição com seletores abrangentes e garantia estrita de foco
    const descSelectors = [
      '#description-textarea #textbox',
      'ytcp-video-description #textbox',
      'ytcp-social-suggestions-textbox[label*="descri" i] #textbox',
      'ytcp-social-suggestions-textbox[label*="description" i] #textbox',
      'div[aria-label*="descri" i][contenteditable="true"]',
      'div[aria-label*="description" i][contenteditable="true"]',
      '#description-container #textbox',
      '#textbox[aria-label*="descri" i]',
      '#textbox[aria-label*="description" i]',
      'ytcp-video-metadata-editor #description-textarea #textbox'
    ];
    const descBox = page.locator(descSelectors.join(', ')).first();

    if (description) {
      try {
        if (await descBox.isVisible({ timeout: 15000 }).catch(() => false)) {
          await descBox.scrollIntoViewIfNeeded().catch(() => {});
          await descBox.click();
          await descBox.focus().catch(() => {});
          await page.waitForTimeout(300);

          // Verifica se o foco ativo realmente migrou para a descrição antes de enviar teclas
          const isDescFocused = await descBox.evaluate((el) => {
            const active = document.activeElement;
            return active === el || el.contains(active);
          }).catch(() => false);

          if (!isDescFocused) {
            console.warn('[YouTube] Foco ainda não estava no elemento de descrição após clique. Reforçando foco...');
            await descBox.click({ force: true }).catch(() => {});
            await descBox.focus().catch(() => {});
            await page.waitForTimeout(200);
          }

          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(200);
          await page.keyboard.insertText(description);
          console.log('[YouTube] Descrição preenchida com sucesso!');
          await page.waitForTimeout(500);
        } else {
          console.warn('[YouTube] Caixa de descrição não ficou visível a tempo.');
        }
      } catch (errDesc) {
        console.warn('[YouTube] Aviso ao preencher descrição:', errDesc.message);
      }
    }

    // Pós-verificação estrita de integridade do Título:
    // Garante que o título não foi corrompido pela descrição, não divergiu e não permaneceu o nome do arquivo MP4
    try {
      const currentTitle = ((await titleBox.innerText().catch(() => '')) || '').trim();
      if (currentTitle !== safeTitle) {
        console.warn(`[YouTube] Título divergente detectado (atual: "${currentTitle}", esperado: "${safeTitle}"). Restaurando título oficial...`);
        await titleBox.scrollIntoViewIfNeeded().catch(() => {});
        await titleBox.click();
        await titleBox.focus().catch(() => {});
        await page.waitForTimeout(200);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);
        await page.keyboard.insertText(safeTitle);
        await page.waitForTimeout(400);
        const verifiedTitle = ((await titleBox.innerText().catch(() => '')) || '').trim();
        console.log('[YouTube] Título oficial restaurado e confirmado:', verifiedTitle);
      } else {
        console.log('[YouTube] Título verificado e confirmado:', currentTitle);
      }
    } catch (errVerify) {
      console.warn('[YouTube] Aviso na verificação de integridade do título:', errVerify.message);
    }

    // Upload opcional de miniatura personalizada (Thumbnail / Capa 16:9)
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        console.log('[YouTube] Tentando upload de miniatura personalizada (thumbnail/capa 16:9)...');
        const thumbInput = page.locator('input#file-loader, ytcp-thumbnails-compact input[type="file"], input[type="file"][accept*="image"]').first();
        if (await thumbInput.count() > 0) {
          await thumbInput.setInputFiles(thumbnailPath);
          console.log('[YouTube] Miniatura 16:9 enviada com sucesso:', thumbnailPath);
          await page.waitForTimeout(2000);
        }
      } catch (errThumb) {
        console.warn('[YouTube] Aviso ao enviar miniatura (recurso opcional ou requer canal verificado):', errThumb.message);
      }
    }

    // Verifica se atingiu o limite diário de envios do canal
    const limitNotice = page.locator('text=/limite di[aá]rio de envio/i, text=/daily upload limit/i, text=/limite de envio atingido/i, :has-text("limite de envio")').first();
    if (await limitNotice.isVisible({ timeout: 2000 }).catch(() => false)) {
      const msg = await limitNotice.innerText().catch(() => 'Limite diário de envio atingido');
      throw new Error(`Limite diário do YouTube atingido: "${msg.trim()}". O YouTube libera novos envios em 24h ou após verificação de recursos avançados.`);
    }

    // Seleciona "Não é conteúdo para crianças"
    console.log('[YouTube] Selecionando audiência ("Não é conteúdo para crianças")...');
    const notForKidsSelectors = [
      'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
      '#radioLabel:has-text("Não é conteúdo para crianças")',
      '[aria-label*="Não é conteúdo para crianças" i]',
      'text="Não é conteúdo para crianças"'
    ];

    let selectedKids = false;
    for (const sel of notForKidsSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
          await loc.click({ force: true, timeout: 6000 });
          selectedKids = true;
          console.log(`[YouTube] Selecionado audiência via seletor: ${sel}`);
          break;
        } catch (_) {}
      }
    }
    if (!selectedKids) {
      console.warn('[YouTube] Atenção: Tentando clique forçado no texto de audiência...');
      await page.locator('text=/Não.*conteúdo.*crianças/i').first().click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(1500);

    // Avança telas até Visibilidade (Próximo -> Próximo -> Próximo)
    console.log('[YouTube 5/5] Avançando telas até Visibilidade...');
    for (let step = 1; step <= 4; step++) {
      if (await limitNotice.isVisible({ timeout: 500 }).catch(() => false)) {
        throw new Error('Limite diário do YouTube atingido nesta conta (cota máxima de envios por 24h).');
      }

      // Se já alcançou a tela de visibilidade, para o avanço
      const isVisibilityVisible = await page.locator('tp-yt-paper-radio-button[name="PUBLIC"], #radioLabel:has-text("Público")').first().isVisible({ timeout: 500 }).catch(() => false);
      if (isVisibilityVisible) {
        break;
      }

      // Se ainda estiver bloqueado com erro de audiência, tenta clicar novamente
      const errorMsg = page.locator('text="Você precisa responder a esta pergunta"').first();
      if (await errorMsg.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[YouTube] Erro de audiência detectado. Clicando novamente no botão Não é conteúdo para crianças...');
        await page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], text="Não é conteúdo para crianças"').first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(1000);
      }

      const nextBtn = page.locator('ytcp-button#next-button, button:has-text("Avançar"), button:has-text("Próximo"), #next-button').first();
      if (await nextBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.click({ force: true });
        console.log(`[YouTube] Clicou no botão Avançar (etapa ${step})`);
        await page.waitForTimeout(2000);
      }
    }

    // Se ainda não estiver na tela de Visibilidade, clica diretamente na aba de Visibilidade
    const visibilityTab = page.locator('ytcp-stepper-step:has-text("Visibilidade"), [test-id="VISIBILITY_STEP"], #step-title-3, ytcp-badge:has-text("Visibilidade")').first();
    if (await visibilityTab.isVisible({ timeout: 1000 }).catch(() => false)) {
      await visibilityTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);

    // Marca como Público
    console.log('[YouTube] Definindo visibilidade como "Público"...');
    const publicOption = page.locator('tp-yt-paper-radio-button[name="PUBLIC"], #radioLabel:has-text("Público"), [name="PUBLIC"]').first();
    await publicOption.waitFor({ state: 'visible', timeout: 20000 });
    await publicOption.scrollIntoViewIfNeeded().catch(() => {});
    await publicOption.click({ force: true });
    console.log('[YouTube] Visibilidade definida como: Público');
    await page.waitForTimeout(1500);

    // Verifica se houve falha ou erro de processamento do YouTube
    const processingErrorSelector = 'text=/processamento interrompido/i, text=/não foi possível processar o vídeo/i, text=/processing abandoned/i, text=/could not process video/i';
    if (await page.locator(processingErrorSelector).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      const errTxt = await page.locator(processingErrorSelector).first().innerText().catch(() => 'Processamento interrompido');
      throw new Error(`Processamento interrompido pelo YouTube: ${errTxt.trim()}`);
    }

    // Garante que o botão de Publicar está ativo e clica assim que habilitado ou verificações concluídas
    console.log('[YouTube] Aguardando confirmação e liberação do botão Publicar...');
    const doneBtn = page.locator('ytcp-button#done-button, button:has-text("Publicar"), button:has-text("Salvar"), #done-button').first();

    for (let u = 1; u <= 60; u++) {
      if (await page.locator(processingErrorSelector).first().isVisible({ timeout: 500 }).catch(() => false)) {
        const errTxt = await page.locator(processingErrorSelector).first().innerText().catch(() => 'Processamento interrompido');
        throw new Error(`Processamento interrompido pelo YouTube: ${errTxt.trim()}`);
      }

      // Se o botão Publicar já está visível e habilitado (sem aria-disabled="true" ou disabled)
      const isDoneBtnVisible = await doneBtn.isVisible().catch(() => false);
      const isDoneBtnDisabled = await doneBtn.getAttribute('aria-disabled').catch(() => null) === 'true' ||
                                await doneBtn.getAttribute('disabled').catch(() => null) !== null;

      if (isDoneBtnVisible && !isDoneBtnDisabled) {
        console.log(`[YouTube] ✅ Botão Publicar já habilitado e pronto em ${Math.round(u * 1.5)}s! Clicando diretamente...`);
        break;
      }

      // Verificação rápida no texto da página para evitar esperar desnecessariamente
      const hasChecksDone = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return /verificações concluídas/i.test(text) ||
               /checks complete/i.test(text) ||
               /envio concluído/i.test(text) ||
               /upload complete/i.test(text);
      }).catch(() => false);

      if (hasChecksDone && isDoneBtnVisible) {
        console.log(`[YouTube] ✅ Verificações concluídas detectadas no YouTube em ${Math.round(u * 1.5)}s!`);
        break;
      }

      if (u % 5 === 0) {
        console.log(`[YouTube] Processando envio no YouTube (${Math.round(u * 1.5)}s)...`);
      }
      await page.waitForTimeout(1500);
    }

    // Clica em Publicar
    console.log('[YouTube] >>> CLICANDO EM PUBLICAR <<<');
    await doneBtn.waitFor({ state: 'visible', timeout: 15000 });
    await doneBtn.scrollIntoViewIfNeeded().catch(() => {});
    await doneBtn.click({ force: true });

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

    for (let w = 1; w <= 45; w++) {
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
  }, `publish_youtube_${(title || '').slice(0, 20)}`, 600000);
}

module.exports = {
  publishYouTubeVideo,
  publishYouTubeShorts: publishYouTubeVideo
};
