const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

async function publishInstagramReels({ videoPath, caption }) {
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'instagram');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('[Instagram] Iniciando publicação de Reel...');
  console.log('[Instagram] Vídeo:', videoPath);

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
    console.log('[Instagram 1/6] Carregando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Fecha popup "Ativar notificações" se aparecer
    const agora = page.getByRole('button', { name: 'Agora não' });
    if (await agora.count() > 0 && await agora.isVisible().catch(() => false)) {
      await agora.click().catch(() => {});
      console.log('[Instagram] Popup "Agora não" fechado.');
      await page.waitForTimeout(400);
    }
    await page.keyboard.press('Escape').catch(() => {});

    console.log('[Instagram 2/6] Abrindo modal Criar (+) ➔ Postar...');
    const plusIcon = page.locator('svg[aria-label="Novo post"], svg[aria-label="Nova publicação"], svg[aria-label="New post"]').first();
    await plusIcon.waitFor({ state: 'visible', timeout: 15000 });
    await plusIcon.click({ force: true });
    await page.waitForTimeout(600);

    const postarLink = page.getByRole('link', { name: /Postar/i }).first();
    if (await postarLink.count() > 0 && await postarLink.isVisible().catch(() => false)) {
      await postarLink.click({ force: true });
      await page.waitForTimeout(600);
    }

    console.log('[Instagram 3/6] Anexando arquivo de vídeo...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });
    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('[Instagram] Vídeo anexado! Aguardando o modal processar...');
    await page.waitForTimeout(2500);

    // Fecha aviso de formato Reels se aparecer
    const reelNotice = page.locator('button:has-text("OK"), button:has-text("Entendi")').first();
    if (await reelNotice.count() > 0 && await reelNotice.isVisible().catch(() => false)) {
      await reelNotice.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }

    console.log('[Instagram 4/6] Definindo proporção 9:16 vertical...');
    try {
      const cropBtn = page.locator('button:has(svg[aria-label*="corte" i]), button:has(svg[aria-label*="crop" i]), [aria-label*="Selecionar corte" i]').first();
      await cropBtn.waitFor({ state: 'visible', timeout: 12000 });
      await cropBtn.click();
      await page.waitForTimeout(600);

      const opt916 = page.locator('span:text-is("9:16"), div:text-is("9:16")').last();
      await opt916.waitFor({ state: 'visible', timeout: 8000 });
      await opt916.click({ force: true });
      console.log('[Instagram] ✅ Proporção 9:16 vertical confirmada!');
      await page.waitForTimeout(800);
    } catch (errCrop) {
      console.warn(`[Instagram] Aviso na seleção de proporção: ${errCrop.message}`);
    }

    console.log('[Instagram 5/6] Avançando telas...');
    const nextBtn1 = page.locator('div[role="button"]:has-text("Avançar"), button:has-text("Avançar")').first();
    await nextBtn1.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn1.click();
    await page.waitForTimeout(1200);

    const nextBtn2 = page.locator('div[role="button"]:has-text("Avançar"), button:has-text("Avançar")').first();
    await nextBtn2.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn2.click();
    await page.waitForTimeout(1200);

    console.log('[Instagram] Preenchendo legenda e hashtags...');
    const captionEl = page.locator('div[aria-label*="legenda" i], div[aria-label*="caption" i], div[role="textbox"], div[contenteditable="true"]').first();
    await captionEl.waitFor({ state: 'visible', timeout: 20000 });
    await captionEl.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
    await page.keyboard.insertText(caption);
    await page.waitForTimeout(600);

    // Fecha dropdown de hashtags clicando no cabeçalho do modal
    await page.locator('[role="dialog"] header').click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);

    // Verifica se há toggle de 'Compartilhar no Facebook' visível na tela de postagem
    try {
      const fbSwitch = page.locator('[role="switch"][aria-label*="Facebook" i], input[type="checkbox"][aria-label*="Facebook" i], div:has-text("Compartilhar no Facebook") [role="switch"]').first();
      if (await fbSwitch.isVisible({ timeout: 1200 }).catch(() => false)) {
        const isChecked = await fbSwitch.getAttribute('aria-checked') === 'true' || await fbSwitch.isChecked().catch(() => false);
        if (!isChecked) {
          await fbSwitch.click();
          console.log('[Instagram] ✅ Toggle "Compartilhar no Facebook" ativado na tela de postagem!');
          await page.waitForTimeout(400);
        }
      } else {
        const advBtn = page.locator('div[role="button"]:has-text("Configurações avançadas"), span:has-text("Configurações avançadas")').first();
        if (await advBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await advBtn.click();
          await page.waitForTimeout(400);
          const advFb = page.locator('[role="switch"][aria-label*="Facebook" i], input[type="checkbox"][aria-label*="Facebook" i], div:has-text("Facebook") [role="switch"]').first();
          if (await advFb.isVisible({ timeout: 1000 }).catch(() => false)) {
            const isCheckedAdv = await advFb.getAttribute('aria-checked') === 'true' || await advFb.isChecked().catch(() => false);
            if (!isCheckedAdv) {
              await advFb.click();
              console.log('[Instagram] ✅ Toggle "Compartilhar no Facebook" ativado em Configurações Avançadas!');
            }
          }
        }
      }
    } catch (errFb) {
      console.log(`[Instagram] Verificação de Facebook na tela de post: ${errFb.message}`);
    }

    console.log('[Instagram 6/6] >>> CLICANDO EM COMPARTILHAR NO INSTAGRAM <<<');
    const shareBtn = page.locator('[role="dialog"]').getByRole('button', { name: 'Compartilhar', exact: true });
    await shareBtn.waitFor({ state: 'visible', timeout: 20000 });

    const box = await shareBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.up();
    } else {
      await shareBtn.click({ force: true });
    }
    console.log('[Instagram] Botão Compartilhar clicado com sucesso!');

    // Aguarda confirmação
    console.log('[Instagram] Aguardando envio e confirmação do Instagram...');
    let confirmed = false;
    let publishSeconds = 0;
    for (let wait = 1; wait <= 60; wait++) {
      await page.waitForTimeout(2000);
      const curText = await page.locator('[role="dialog"]').innerText().catch(() => '');

      if (curText.includes('compartilhad') || curText.includes('shared')) {
        confirmed = true;
        publishSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);
        console.log(`[Instagram] >>> CONFIRMADO: REEL COMPARTILHADO EM ${publishSeconds}s! <<<`);
        break;
      }
      if (wait % 5 === 0) {
        console.log(`[Instagram] Processando envio... (${wait * 2}s)`);
      }
    }

    // Fecha o modal de confirmação clicando em Concluir ou X se estiver presente
    try {
      const fecharBtn = page.locator('button:has-text("Concluir"), div[role="button"]:has-text("Concluir"), svg[aria-label="Fechar"]').first();
      if (await fecharBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await fecharBtn.click({ timeout: 2000, force: true }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch (_) {}

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const screenshotPath = path.join(dataDir, `insta-published-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    return {
      ok: true,
      network: 'instagram',
      confirmed,
      totalSeconds,
      uploadSeconds: publishSeconds,
      screenshot: screenshotPath
    };
  } finally {
    await page.waitForTimeout(2000);
    await ctx.close();
  }
}

module.exports = { publishInstagramReels };
