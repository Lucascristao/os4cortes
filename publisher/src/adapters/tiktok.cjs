const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

async function publishTikTok({ videoPath, caption }) {
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
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[TikTok] Vídeo anexado! Aguardando o editor carregar...');

    // Aguarda o botão Publicar estar visível na página de detalhes
    const publishBtn = page.locator('button:has-text("Publicar"), div[role="button"]:has-text("Publicar")').first();
    await publishBtn.waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(4000);

    // Fecha popup "Entendi" se reaparecer
    const entendi2 = page.locator('button:has-text("Entendi"), div[role="button"]:has-text("Entendi")').first();
    if (await entendi2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await entendi2.click({ force: true }).catch(() => {});
    }

    console.log('[TikTok 3/4] Preenchendo legenda e hashtags...');
    const captionEditor = page.locator('div[contenteditable="true"], div.notranslate[contenteditable="true"]').first();
    if (await captionEditor.isVisible().catch(() => false)) {
      await captionEditor.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);
      await page.keyboard.insertText(caption);
      console.log('[TikTok] Legenda preenchida com sucesso!');
      await page.waitForTimeout(1000);
    }

    // Desativa a "Verificação de conteúdo simples" se estiver ativada
    const checkToggle = page.locator('input[type="checkbox"][aria-checked="true"], [role="switch"][aria-checked="true"]').first();
    if (await checkToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('[TikTok] Desativando verificação de 10 minutos...');
      await checkToggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }

    console.log('[TikTok 4/4] >>> CLICANDO EM PUBLICAR NO TIKTOK <<<');
    await publishBtn.click({ force: true });
    await page.waitForTimeout(3000);

    // Se abrir modal de confirmação "Deseja publicar agora?"
    const modalPubBtn = page.locator('div[role="dialog"] button:has-text("Publicar"), div[role="dialog"] div[role="button"]:has-text("Publicar")').first();
    if (await modalPubBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('[TikTok] Confirmando modal de publicação...');
      await modalPubBtn.click({ force: true });
    }

    // Aguarda confirmação
    console.log('[TikTok] Aguardando confirmação do TikTok...');
    let confirmed = false;
    for (let w = 1; w <= 30; w++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      if (url.includes('/tiktokstudio/content') || await page.locator('text="Seu vídeo foi publicado", text="Publicado com sucesso"').first().isVisible().catch(() => false)) {
        confirmed = true;
        console.log('[TikTok] >>> CONFIRMADO: VÍDEO PUBLICADO NO TIKTOK! <<<');
        break;
      }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const uploadSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);
    const screenshotPath = path.join(dataDir, `tiktok-published-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    return {
      ok: true,
      network: 'tiktok',
      confirmed,
      totalSeconds,
      uploadSeconds,
      screenshot: screenshotPath
    };
  } finally {
    await page.waitForTimeout(3000);
    await ctx.close();
  }
}

module.exports = { publishTikTok };
