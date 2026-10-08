const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const { waitForUploadReady } = require('../upload-ready.cjs');

async function publishTikTok({ videoPath, caption, attempt }) {
  attempt?.stage('Abrindo TikTok');
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'tiktok');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('[TikTok] Iniciando publicação no TikTok Studio...');
  console.log('[TikTok] Vídeo:', videoPath);

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
    console.log('[TikTok 1/4] Carregando TikTok Studio...');
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

    console.log('[TikTok 2/4] Enviando arquivo de vídeo...');
    attempt?.stage('Enviando vídeo');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[TikTok] Vídeo anexado! Aguardando o editor carregar...');

    // Aguarda o botão Publicar estar visível na página de detalhes
    const publishBtn = page.locator('button:has-text("Publicar"), div[role="button"]:has-text("Publicar")').first();
    await publishBtn.waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForTimeout(4000);

    // Fecha popup "Entendi" se reaparecer
    const entendi2 = page.locator('button:has-text("Entendi"), div[role="button"]:has-text("Entendi")').first();
    if (await entendi2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await entendi2.click({ force: true }).catch(() => {});
    }

    console.log('[TikTok 3/4] Preenchendo legenda e hashtags...');
    attempt?.stage('Preenchendo legenda');
    const captionEditor = page.locator('div[contenteditable="true"], div.notranslate[contenteditable="true"]').first();
    await captionEditor.waitFor({state:'visible',timeout:30000});
    if (await captionEditor.isVisible().catch(() => false)) {
      await captionEditor.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);
      await page.keyboard.insertText(caption);
      console.log('[TikTok] Legenda preenchida com sucesso!');
      await page.waitForTimeout(1000);
    }

    console.log('[TikTok 4/4] >>> LOCALIZANDO BOTÃO PUBLICAR NO TIKTOK <<<');
    // Rola até o rodapé para garantir que os botões inferiores estejam na tela
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    const postBtn = page.locator('button:has-text("Publicar")').last();
    await postBtn.waitFor({ state: 'visible', timeout: 30000 });
    await postBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    console.log('[TikTok] Clicando no botão vermelho Publicar...');
    await postBtn.waitFor({state:'visible'});
    await waitForUploadReady(postBtn, page, attempt);
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
