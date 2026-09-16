const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const videoPath = 'C:\\Users\\lucas\\Downloads\\corte_01_Como_um_neg_cio_de_conte_do_chegou_a_R_1_milh_o_no_m_s_legenda.mp4';
const postText = `Como um negócio de conteúdo chegou a R$ 1 milhão no mês

Afonso detalha a estrutura do negócio no momento da conversa: produtos digitais de baixo ticket, mentorias de maior valor, automações, tráfego e um time comercial. Ele também explica que a parte de mentoria ainda era recente e que a renovação dos clientes ainda seria testada.

#negocios #conteudo #infoproduto #empreendedorismo`;

async function runInstagramUpload(video = videoPath, text = postText) {
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'instagram');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('====================================================');
  console.log('--- PUBLICANDO NO INSTAGRAM (REELS) ---');
  console.log('Vídeo:', video);
  console.log('Hora de início:', new Date().toLocaleTimeString('pt-BR'));
  console.log('====================================================');

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
    const t0 = Date.now();
    console.log('[1/6] Carregando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    console.log(`Instagram carregado em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Fecha popup "Ativar notificações" ou "Salvar login"
    const agora = page.getByRole('button', { name: 'Agora não' });
    if (await agora.count() > 0 && await agora.isVisible().catch(() => false)) {
      await agora.click().catch(() => {});
      console.log('Popup "Agora não" fechado com sucesso!');
      await page.waitForTimeout(500);
    }
    await page.keyboard.press('Escape').catch(() => {});

    // Localiza e clica no botão Criar (+) na barra lateral
    console.log('[2/6] Localizando botão "Criar" (+)...');
    const plusIcon = page.locator('svg[aria-label="Novo post"], svg[aria-label="Nova publicação"], svg[aria-label="New post"]').first();
    await plusIcon.waitFor({ state: 'visible', timeout: 15000 });
    await plusIcon.click({ force: true });
    console.log('Clicou no botão Criar (+)!');
    await page.waitForTimeout(1000);

    // Se abrir submenu, clica em "Postar"
    const postarLink = page.getByRole('link', { name: /Postar/i }).first();
    if (await postarLink.count() > 0 && await postarLink.isVisible().catch(() => false)) {
      console.log('Clicando na opção "Postar" no submenu...');
      await postarLink.click({ force: true });
      await page.waitForTimeout(1000);
    }

    // Localizar input[type="file"] do modal de upload
    console.log('[3/6] Enviando arquivo de vídeo...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 30000 });

    const tUpload = Date.now();
    await fileInput.setInputFiles(video);
    console.log('Arquivo enviado! Aguardando o modal processar o vídeo...');
    await page.waitForTimeout(5000);

    // Fecha aviso "Os vídeos agora são compartilhados como Reels" se aparecer
    const reelNotice = page.locator('button:has-text("OK"), button:has-text("Entendi")').first();
    if (await reelNotice.count() > 0 && await reelNotice.isVisible().catch(() => false)) {
      console.log('Fechando aviso de formato Reels...');
      await reelNotice.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Ajustar proporção para Original (9:16 vertical)
    console.log('[4/6] Definindo proporção Original (9:16)...');
    const cropBtn = page.locator('button[aria-label*="corte" i], button[aria-label*="crop" i], svg[aria-label*="corte" i], svg[aria-label*="crop" i]').first();
    if (await cropBtn.count() > 0 && await cropBtn.isVisible().catch(() => false)) {
      await cropBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      const originalOption = page.locator('button:has-text("Original"), span:has-text("Original"), div[role="button"]:has-text("Original"), button:has-text("9:16"), span:has-text("9:16")').first();
      if (await originalOption.count() > 0 && await originalOption.isVisible().catch(() => false)) {
        await originalOption.click({ force: true }).catch(() => {});
        console.log('Proporção definida como Original!');
        await page.waitForTimeout(500);
      }
    }

    // Avançar (passo 1 -> filtros/edição)
    console.log('[5/6] Avançando telas...');
    const nextBtn1 = page.locator('div[role="button"]:has-text("Avançar"), button:has-text("Avançar")').first();
    await nextBtn1.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn1.click();
    console.log('Avançou tela 1 (edição/capa).');
    await page.waitForTimeout(2500);

    // Avançar (passo 2 -> legenda)
    const nextBtn2 = page.locator('div[role="button"]:has-text("Avançar"), button:has-text("Avançar")').first();
    await nextBtn2.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn2.click();
    console.log('Avançou tela 2 (legenda e configurações).');
    await page.waitForTimeout(2500);

    // Preencher a legenda
    console.log('Preenchendo legenda e hashtags...');
    const captionEl = page.locator('div[aria-label*="legenda" i], div[aria-label*="caption" i], div[role="textbox"], div[contenteditable="true"]').first();
    await captionEl.waitFor({ state: 'visible', timeout: 20000 });
    await captionEl.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(text);
    console.log('Legenda preenchida com sucesso!');
    await page.waitForTimeout(1000);

    // Fecha o dropdown de hashtags da legenda clicando no modal header
    await page.locator('[role="dialog"] header').click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);

    // Clicar em Compartilhar via mouse coordinates no cabeçalho
    console.log('[6/6] >>> CLICANDO EM COMPARTILHAR NO INSTAGRAM <<<');
    const shareBtn = page.locator('[role="dialog"]').getByRole('button', { name: 'Compartilhar', exact: true });
    await shareBtn.waitFor({ state: 'visible', timeout: 20000 });

    const box = await shareBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(200);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
    } else {
      await shareBtn.click({ force: true });
    }
    console.log('Botão Compartilhar clicado com sucesso!');

    // Aguardar confirmação de publicação
    console.log('Aguardando envio e confirmação do Instagram...');
    let confirmed = false;
    let publishSeconds = 0;
    for (let wait = 1; wait <= 60; wait++) {
      await page.waitForTimeout(2000);
      const curText = await page.locator('[role="dialog"]').innerText().catch(() => '');

      if (curText.includes('compartilhad') || curText.includes('shared')) {
        confirmed = true;
        publishSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);
        console.log(`>>> CONFIRMADO: REEL COMPARTILHADO NO INSTAGRAM em ${publishSeconds}s! <<<`);
        break;
      }

      if (wait % 5 === 0) {
        console.log(`Upload no Instagram em andamento... (${wait * 2}s)`);
      }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalScreenshot = path.join(dataDir, 'insta-success.png');
    await page.screenshot({ path: finalScreenshot, fullPage: true }).catch(() => {});

    console.log('====================================================');
    console.log('=== INSTAGRAM: PUBLICAÇÃO CONCLUÍDA! ===');
    console.log(`Status de confirmação: ${confirmed}`);
    console.log(`Tempo total da operação: ${totalSeconds} segundos`);
    console.log(`Tempo de upload e processamento: ${publishSeconds} segundos`);
    console.log('Screenshot salva em:', finalScreenshot);
    console.log('====================================================');

    return {
      ok: true,
      confirmed,
      totalSeconds,
      publishSeconds,
      screenshot: finalScreenshot
    };
  } finally {
    await page.waitForTimeout(3000);
    await ctx.close();
  }
}

if (require.main === module) {
  runInstagramUpload()
    .then(res => {
      console.log('RESULTADO_FINAL_INSTAGRAM:', JSON.stringify(res));
      process.exit(0);
    })
    .catch(err => {
      console.error('ERRO_INSTAGRAM:', err.message);
      process.exit(1);
    });
}

module.exports = { runInstagramUpload };
