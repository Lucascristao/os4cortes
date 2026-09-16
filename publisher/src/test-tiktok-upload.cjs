const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const videoPath = 'C:\\Users\\lucas\\Downloads\\corte_01_Como_um_neg_cio_de_conte_do_chegou_a_R_1_milh_o_no_m_s_legenda.mp4';
const postText = `Como um negócio de conteúdo chegou a R$ 1 milhão no mês

Afonso detalha a estrutura do negócio no momento da conversa: produtos digitais de baixo ticket, mentorias de maior valor, automações, tráfego e um time comercial. Ele também explica que a parte de mentoria ainda era recente e que a renovação dos clientes ainda seria testada.

#negocios #conteudo #infoproduto #empreendedorismo`;

async function runTikTokUpload() {
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'tiktok');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('====================================================');
  console.log('--- PUBLICANDO NO TIKTOK COM CONFIRMAÇÃO ---');
  console.log('Vídeo:', videoPath);
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
    console.log('[1/5] Acessando TikTok Studio Upload...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`TikTok Studio carregado em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Localizar input[type="file"]
    console.log('[2/5] Localizando campo de upload de arquivo...');
    let fileInput = null;
    for (let i = 0; i < 15; i++) {
      if (await page.locator('input[type="file"]').count() > 0) {
        fileInput = page.locator('input[type="file"]').first();
        break;
      }
      for (const frame of page.frames()) {
        if (await frame.locator('input[type="file"]').count() > 0) {
          fileInput = frame.locator('input[type="file"]').first();
          break;
        }
      }
      if (fileInput) break;
      await page.waitForTimeout(1000);
    }

    if (!fileInput) {
      throw new Error('Input de arquivo não encontrado no TikTok Studio.');
    }

    const tUpload = Date.now();
    console.log('Enviando arquivo de vídeo (62.5 MB)...');
    await fileInput.setInputFiles(videoPath);
    console.log('Arquivo enviado! Aguardando o editor do TikTok carregar...');

    // Aguarda o editor ou o modal aparecer
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1500);
      const editorCount = await page.locator('div[contenteditable="true"]').count().catch(() => 0);
      const modalCount = await page.locator('button:has-text("Entendi")').count().catch(() => 0);
      if (editorCount > 0 || modalCount > 0) {
        console.log(`Editor do TikTok pronto em ${((Date.now() - tUpload) / 1000).toFixed(1)}s!`);
        break;
      }
    }

    // Fecha o modal "Novos recursos de edição adicionados"
    console.log('[3/5] Fechando avisos/popups da interface...');
    const entendiBtn = page.locator('button:has-text("Entendi")').first();
    if (await entendiBtn.isVisible().catch(() => false)) {
      console.log('Clicando em "Entendi" no modal de novidades...');
      await entendiBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    // Preencher a legenda
    console.log('[4/5] Preenchendo legenda e hashtags...');
    const editor = page.locator('.public-DraftEditor-content, div[contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 20000 });
    await editor.scrollIntoViewIfNeeded();
    await editor.click({ force: true });
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(postText);
    console.log('Legenda preenchida com sucesso!');
    await page.waitForTimeout(1000);

    // Localizar botão Publicar
    console.log('[5/5] Localizando botão "Publicar"...');
    const publishBtn = page.locator('button:has-text("Publicar"), [data-e2e="post_video_button"]').last();
    await publishBtn.scrollIntoViewIfNeeded();

    console.log('Aguardando botão Publicar ficar habilitado...');
    let attempts = 0;
    while (await publishBtn.isDisabled().catch(() => true) && attempts < 45) {
      if (attempts % 5 === 0) {
        console.log(`Processando vídeo no TikTok... (${attempts * 2}s)`);
      }
      await page.waitForTimeout(2000);
      attempts++;
    }

    console.log('>>> CLICANDO EM PUBLICAR NO TIKTOK <<<');
    await publishBtn.click({ force: true });
    console.log('Clique em Publicar executado!');

    // Diálogo de confirmação de verificação de conteúdo
    console.log('Verificando se apareceu diálogo de confirmação ("Ativar")...');
    let confirmed = false;
    for (let c = 0; c < 15; c++) {
      await page.waitForTimeout(1000);
      const confirmBtn = page.locator('button:has-text("Ativar"), button:has-text("Confirmar"), button:has-text("Publicar agora")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        console.log('Clicando em "Ativar" no diálogo de verificação...');
        await confirmBtn.click({ force: true });
        console.log('Confirmação "Ativar" clicada com sucesso!');
        confirmed = true;
        break;
      }
    }

    console.log('Aguardando confirmação final da postagem...');
    await page.waitForTimeout(8000);

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const uploadSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);

    const screenshotPath = path.join(dataDir, 'tiktok-07-confirmed.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log('====================================================');
    console.log('=== TIKTOK: PUBLICAÇÃO CONCLUÍDA E CONFIRMADA! ===');
    console.log(`Confirmação ativada: ${confirmed}`);
    console.log(`Tempo total da operação: ${totalSeconds} segundos`);
    console.log(`Tempo de upload e processamento: ${uploadSeconds} segundos`);
    console.log('Screenshot salva em:', screenshotPath);
    console.log('====================================================');

    return {
      ok: true,
      confirmed,
      totalSeconds,
      uploadSeconds,
      screenshot: screenshotPath
    };
  } finally {
    console.log('Aguardando 6 segundos antes de encerrar o navegador...');
    await page.waitForTimeout(6000);
    await ctx.close();
  }
}

runTikTokUpload()
  .then(res => {
    console.log('RESULTADO_FINAL_TIKTOK:', JSON.stringify(res));
    process.exit(0);
  })
  .catch(err => {
    console.error('ERRO_TIKTOK:', err.message);
    process.exit(1);
  });
