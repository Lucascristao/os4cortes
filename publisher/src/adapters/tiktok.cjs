const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const { waitForUploadReady } = require('../upload-ready.cjs');

async function publishTikTok({ videoPath, caption, thumbnailPath = null, attempt }) {
  attempt?.stage('Abrindo TikTok');
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'tiktok');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('[TikTok] Iniciando publicação no TikTok Studio...');
  console.log('[TikTok] Vídeo:', videoPath);
  if (thumbnailPath) console.log('[TikTok] Miniatura/Capa:', thumbnailPath);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1366, height: 850 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled']
  });

  await attempt?.attach(ctx);
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(60000);

  try {
    console.log('[TikTok 1/5] Carregando TikTok Studio...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);

    // Fecha popup "Novos recursos de edição adicionados" / "Entendi"
    for (let k = 0; k < 3; k++) {
      const entendi = page.locator('button:has-text("Entendi"), div[role="button"]:has-text("Entendi")').first();
      if (await entendi.isVisible({ timeout: 1500 }).catch(() => false)) {
        await entendi.click({ force: true }).catch(() => {});
        console.log('[TikTok] Fechou popup "Entendi".');
        await page.waitForTimeout(500);
      }
    }

    console.log('[TikTok 2/5] Enviando arquivo de vídeo...');
    attempt?.stage('Enviando vídeo');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[TikTok] Vídeo anexado! Aguardando o editor carregar...');

    // Aguarda o editor ou popup do TikTok carregar
    const captionEditor = page.locator('div[contenteditable="true"], div.notranslate[contenteditable="true"]').first();
    for (let i = 0; i < 30; i++) {
      const entendi = page.locator('button:has-text("Entendi"), div[role="button"]:has-text("Entendi")').first();
      if (await entendi.isVisible({ timeout: 1000 }).catch(() => false)) {
        await entendi.click({ force: true }).catch(() => {});
        console.log('[TikTok] Fechou popup "Entendi".');
      }
      if (await captionEditor.isVisible({ timeout: 1000 }).catch(() => false)) {
        break;
      }
      await page.waitForTimeout(1000);
    }

    console.log('[TikTok 3/5] Preenchendo legenda e hashtags...');
    attempt?.stage('Preenchendo legenda');
    await captionEditor.waitFor({state:'visible',timeout:45000});
    if (await captionEditor.isVisible().catch(() => false)) {
      await captionEditor.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);
      await page.keyboard.insertText(caption);
      console.log('[TikTok] Legenda preenchida com sucesso!');
      await page.waitForTimeout(1000);
    }

    // Aguarda o término do processamento do vídeo no TikTok para liberar a capa e o botão Publicar
    console.log('[TikTok 4/6] Aguardando processamento do vídeo no TikTok...');
    const postBtn = page.locator('button:has-text("Publicar")').last();
    await postBtn.waitFor({ state: 'visible', timeout: 45000 });
    await waitForUploadReady(postBtn, page, attempt);
    await page.waitForTimeout(2000);

    // Configura capa (Upload de imagem personalizada ou seleção de frame com título)
    console.log('[TikTok 5/6] Configurando capa do vídeo...');
    attempt?.stage('Configurando capa do vídeo');
    try {
      const coverLabel = page.getByText(/^Capa$/i).or(page.locator('text="Capa"')).first();
      if (await coverLabel.isVisible({ timeout: 3000 }).catch(() => false)) {
        await coverLabel.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
      }

      let editCoverBtn = null;
      const candidates = [
        page.getByText(/^Editar capa$/i).locator('visible=true').first(),
        page.getByText(/Editar capa/i).locator('visible=true').first(),
        page.locator('button:has-text("Editar capa"), div[role="button"]:has-text("Editar capa")').locator('visible=true').first(),
        page.locator('[class*="cover"] [class*="edit"]').locator('visible=true').first(),
        page.locator('[data-e2e*="edit-cover"]').locator('visible=true').first()
      ];
      for (const cand of candidates) {
        if (await cand.isVisible({ timeout: 1500 }).catch(() => false)) {
          editCoverBtn = cand;
          break;
        }
      }

      if (!editCoverBtn) {
        const anyEdit = page.getByText(/Editar capa/i).first();
        if (await anyEdit.isVisible({ timeout: 2000 }).catch(() => false)) {
          editCoverBtn = anyEdit;
        }
      }

      if (editCoverBtn) {
        console.log('[TikTok] Clicando no botão "Editar capa"...');
        await editCoverBtn.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        await editCoverBtn.click({ force: true });
        console.log('[TikTok] Modal "Editar capa" aberto.');
        await page.waitForTimeout(3000);

        let coverApplied = false;

        // 1. Tenta envio direto do arquivo de imagem (thumbnailPath / capa.jpg)
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          console.log('[TikTok] Tentando upload de arquivo da capa:', thumbnailPath);
          try {
            const uploadTab = page.locator('div[role="tab"]:has-text("Carregar"), div[role="tab"]:has-text("Upload"), button:has-text("Carregar"), button:has-text("Upload"), text="Carregar capa", text="Upload cover"').locator('visible=true').first();
            if (await uploadTab.isVisible({ timeout: 2000 }).catch(() => false)) {
              await uploadTab.click({ force: true });
              await page.waitForTimeout(1000);
            }

            const imgInput = page.locator('div[role="dialog"] input[type="file"], input[type="file"][accept*="image"]').first();
            if (await imgInput.count() > 0) {
              await imgInput.setInputFiles(thumbnailPath);
              console.log('[TikTok] ✅ Arquivo de capa anexado com sucesso!');
              coverApplied = true;
              await page.waitForTimeout(2000);
            }
          } catch (errUpload) {
            console.warn('[TikTok] Não foi possível fazer upload do arquivo de imagem:', errUpload.message);
          }
        }

        // 2. Fallback: Selecionar frame do vídeo com o título (~2 a 3 segundos)
        if (!coverApplied) {
          console.log('[TikTok] Selecionando frame com a arte do título na linha do tempo...');
          try {
            const videoTab = page.locator('div[role="tab"]:has-text("vídeo"), div[role="tab"]:has-text("video"), text="Do vídeo", text="From video"').locator('visible=true').first();
            if (await videoTab.isVisible({ timeout: 1500 }).catch(() => false)) {
              await videoTab.click({ force: true });
              await page.waitForTimeout(1000);
            }

            const timeline = page.locator('[role="dialog"] [class*="timeline"], [role="dialog"] [class*="slider"], [role="dialog"] [class*="progress"], [role="dialog"] [role="slider"], [role="dialog"] [class*="filmstrip"]').locator('visible=true').first();
            if (await timeline.isVisible({ timeout: 3000 }).catch(() => false)) {
              const tBox = await timeline.boundingBox();
              if (tBox && tBox.width > 50) {
                // Clica entre 10% e 15% do comprimento (aproximadamente 2s a 3s do vídeo)
                const clickX = tBox.x + Math.max(20, Math.min(tBox.width * 0.12, 100));
                const clickY = tBox.y + tBox.height / 2;
                await page.mouse.click(clickX, clickY);
                console.log(`[TikTok] ✅ Frame com título selecionado na timeline do vídeo (X=${Math.round(clickX)}).`);
                coverApplied = true;
                await page.waitForTimeout(1500);
              }
            } else {
              const frameThumbs = page.locator('[role="dialog"] [class*="frame"], [role="dialog"] [class*="thumb"]');
              if (await frameThumbs.count() >= 2) {
                await frameThumbs.nth(1).click({ force: true });
                console.log('[TikTok] ✅ Segundo frame da lista selecionado como capa.');
                coverApplied = true;
                await page.waitForTimeout(1000);
              }
            }
          } catch (errFrame) {
            console.warn('[TikTok] Erro ao selecionar frame do vídeo:', errFrame.message);
          }
        }

        // Confirmar modal de capa (Salvar / Concluir / Done / Save)
        const saveCoverBtn = page.locator('[role="dialog"] button:has-text("Concluir"), [role="dialog"] button:has-text("Salvar"), [role="dialog"] button:has-text("Done"), [role="dialog"] button:has-text("Save"), [role="dialog"] div[role="button"]:has-text("Concluir"), [role="dialog"] div[role="button"]:has-text("Salvar")').locator('visible=true').first();
        if (await saveCoverBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
          await saveCoverBtn.click({ force: true });
          console.log('[TikTok] Capa confirmada e modal fechado.');
          await page.waitForTimeout(2000);
        } else {
          const anyModalBtn = page.locator('[role="dialog"] button[class*="primary"]').first();
          if (await anyModalBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await anyModalBtn.click({ force: true });
            console.log('[TikTok] Botão primário do modal clicado.');
            await page.waitForTimeout(2000);
          }
        }
      } else {
        const coverContainer = page.locator('[class*="cover-container"], [class*="cover-preview"], [class*="thumbnail"]').locator('visible=true').first();
        if (await coverContainer.isVisible({ timeout: 1500 }).catch(() => false)) {
          console.log('[TikTok] Clicando no container da miniatura da capa...');
          await coverContainer.scrollIntoViewIfNeeded().catch(() => {});
          await coverContainer.click({ force: true });
          await page.waitForTimeout(2500);
          const saveCoverBtn = page.locator('[role="dialog"] button:has-text("Concluir"), [role="dialog"] button:has-text("Salvar")').locator('visible=true').first();
          if (await saveCoverBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await saveCoverBtn.click({ force: true });
            await page.waitForTimeout(1500);
          }
        } else {
          console.log('[TikTok] Seção "Editar capa" não encontrada ou já definida.');
        }
      }
    } catch (errCover) {
      console.warn('[TikTok] Aviso na configuração de capa (seguindo fluxo de publicação):', errCover.message);
    }

    console.log('[TikTok 6/6] >>> LOCALIZANDO BOTÃO PUBLICAR NO TIKTOK <<<');
    // Rola até o rodapé para garantir que os botões inferiores estejam na tela
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    await postBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    console.log('[TikTok] Clicando no botão vermelho Publicar...');
    attempt?.stage('Publicando e aguardando confirmação');
    attempt?.beforePublish();
    const box = await postBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(200);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
    } else {
      await postBtn.click({ force: true });
    }
    await page.waitForTimeout(3000);

    // Se abrir modal de confirmação "Deseja publicar agora?"
    const modalPubBtn = page.locator('div[role="dialog"] button:has-text("Publicar"), div[role="dialog"] div[role="button"]:has-text("Publicar")').first();
    let modalConfirmed = false;
    if (await modalPubBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('[TikTok] Confirmando modal de publicação...');
      attempt?.check();
      await modalPubBtn.click({ force: true });
      modalConfirmed = true;
    }

    // A confirmação do modal é distinta do botão final e só recebe um clique.
    console.log('[TikTok] Aguardando confirmação do TikTok...');
    let confirmed = false;
    for (let w = 1; w <= 40; w++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      const hasSuccessText = await page.locator('text="Seu vídeo foi publicado", text="Publicado com sucesso", text="Your video has been uploaded", text="Vídeo publicado"').first().isVisible().catch(() => false);
      if (url.includes('/tiktokstudio/content') || hasSuccessText) {
        confirmed = true;
        attempt?.confirm({ok:true,confirmed:true,network:'tiktok',evidence:hasSuccessText?'Mensagem de publicação concluída':'Redirecionamento para lista de publicações',at:Date.now()});
        console.log('[TikTok] >>> CONFIRMADO: VÍDEO PUBLICADO NO TIKTOK! <<<');
        break;
      }

      if (!modalConfirmed && await modalPubBtn.isVisible().catch(() => false)) {
        attempt?.check();
        await modalPubBtn.click();
        modalConfirmed = true;
      }


    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const uploadSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);
    const screenshotPath = path.join(dataDir, `tiktok-published-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    if (!confirmed) {
      throw new Error('TikTok não confirmou a publicação do vídeo (verifique o screenshot salvo em: ' + screenshotPath + ')');
    }

    return {
      ok: true,
      network: 'tiktok',
      confirmed,
      totalSeconds,
      uploadSeconds,
      screenshot: screenshotPath
    };
  } catch (error) {
    const screenshot = path.join(dataDir, `tiktok-error-${Date.now()}.png`);
    await page.screenshot({path:screenshot,timeout:5000}).catch(() => {});
    console.warn(`[TikTok] Diagnóstico do envio: ${screenshot}`);
    throw error;
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { publishTikTok };
