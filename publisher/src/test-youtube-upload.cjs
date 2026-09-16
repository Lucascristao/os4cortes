const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const videoPath = 'C:\\Users\\lucas\\Downloads\\corte_01_Como_um_neg_cio_de_conte_do_chegou_a_R_1_milh_o_no_m_s_legenda.mp4';
const videoTitle = 'Como um negócio de conteúdo chegou a R$ 1 milhão no mês';

async function runYouTubeUpload() {
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'youtube');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('====================================================');
  console.log('--- INICIANDO TESTE DE UPLOAD NO YOUTUBE (SHORTS) ---');
  console.log('Vídeo:', videoPath);
  console.log('Título:', videoTitle);
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
    console.log('[1/6] Acessando YouTube Studio...');
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.log(`YouTube Studio carregado em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Fecha possíveis popups de novidades/boas-vindas do Studio
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

    // Clicar no botão CRIAR (topo direito)
    console.log('[2/6] Localizando botão "CRIAR"...');
    const createBtn = page.locator('#create-icon, button[aria-label*="Criar" i], ytcp-button#create-icon').first();
    await createBtn.waitFor({ state: 'visible', timeout: 20000 });
    await createBtn.click();
    await page.waitForTimeout(1000);

    // Clicar em "Enviar vídeos"
    console.log('Clicando em "Enviar vídeos"...');
    const uploadItem = page.locator('tp-yt-paper-item:has-text("Enviar vídeos"), #text-item:has-text("Enviar vídeos")').first();
    await uploadItem.waitFor({ state: 'visible', timeout: 15000 });
    await uploadItem.click();
    await page.waitForTimeout(2000);

    // Enviar o arquivo de vídeo no input file
    console.log('[3/6] Selecionando arquivo de vídeo (62.5 MB)...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 20000 });

    const tUpload = Date.now();
    await fileInput.setInputFiles(videoPath);
    console.log('Arquivo enviado! Aguardando o diálogo de detalhes do YouTube abrir...');
    await page.waitForTimeout(5000);

    // Preencher Título
    console.log('[4/6] Preenchendo título do vídeo...');
    const titleBox = page.locator('#title-textarea #textbox, ytcp-social-suggestions-textbox #textbox, div[aria-label*="título" i][contenteditable="true"]').first();
    await titleBox.waitFor({ state: 'visible', timeout: 30000 });
    await titleBox.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(videoTitle);
    console.log('Título preenchido com sucesso!');
    await page.waitForTimeout(1000);

    // Selecionar Público: "Não é conteúdo para crianças"
    console.log('Selecionando público ("Não é conteúdo para crianças")...');
    const notForKidsRadio = page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button:has-text("Não é conteúdo para crianças"), #radioLabel:has-text("Não é conteúdo para crianças")').first();
    await notForKidsRadio.scrollIntoViewIfNeeded();
    await notForKidsRadio.click();
    console.log('Público definido!');
    await page.waitForTimeout(1000);

    // Avançar pelas etapas: Próximo -> Próximo -> Próximo
    console.log('[5/6] Avançando nas etapas de configuração do YouTube...');
    const nextBtn = page.locator('ytcp-button#next-button, button:has-text("Próximo")').first();

    // Etapa 1 -> 2 (Elementos do vídeo)
    await nextBtn.click();
    console.log('Avançou para: Elementos do vídeo');
    await page.waitForTimeout(1500);

    // Etapa 2 -> 3 (Verificações)
    await nextBtn.click();
    console.log('Avançou para: Verificações');
    await page.waitForTimeout(1500);

    // Etapa 3 -> 4 (Visibilidade)
    await nextBtn.click();
    console.log('Avançou para: Visibilidade');
    await page.waitForTimeout(2000);

    // Selecionar "Público"
    console.log('Definindo visibilidade como "Público"...');
    const publicRadio = page.locator('tp-yt-paper-radio-button[name="PUBLIC"], #radioLabel:has-text("Público")').first();
    await publicRadio.scrollIntoViewIfNeeded();
    await publicRadio.click();
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(dataDir, 'yt-01-ready.png') });

    // Clicar em Salvar / Publicar
    console.log('[6/6] >>> CLICANDO EM PUBLICAR NO YOUTUBE <<<');
    const doneBtn = page.locator('ytcp-button#done-button, button:has-text("Publicar")').first();
    await doneBtn.waitFor({ state: 'visible', timeout: 15000 });
    await doneBtn.click();
    console.log('Clique em Publicar disparado com sucesso!');

    // Aguardar confirmação de publicação
    console.log('Aguardando tela de confirmação de publicação do YouTube...');
    let published = false;
    let videoUrl = null;

    for (let wait = 1; wait <= 40; wait++) {
      await page.waitForTimeout(2000);

      // Procura caixa de diálogo de vídeo publicado
      const successModal = page.locator('ytcp-video-share-dialog, #dialog-title:has-text("Vídeo publicado"), text="Vídeo publicado", text="Video published"');
      if (await successModal.count() > 0 && await successModal.first().isVisible().catch(() => false)) {
        published = true;
        const linkEl = page.locator('a.ytcp-video-info, a[href*="youtu.be"]').first();
        if (await linkEl.count() > 0) {
          videoUrl = await linkEl.getAttribute('href').catch(() => null);
        }
        break;
      }
      console.log(`Aguardando confirmação do YouTube... (${wait * 2}s)`);
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const uploadSeconds = ((Date.now() - tUpload) / 1000).toFixed(1);

    const screenshotPath = path.join(dataDir, 'yt-02-published.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log('====================================================');
    console.log('=== YOUTUBE: PUBLICAÇÃO CONCLUÍDA! ===');
    console.log(`Status confirmado: ${published}`);
    if (videoUrl) console.log(`Link do vídeo: ${videoUrl}`);
    console.log(`Tempo total da operação: ${totalSeconds} segundos`);
    console.log(`Tempo de upload e processamento: ${uploadSeconds} segundos`);
    console.log('Screenshot salva em:', screenshotPath);
    console.log('====================================================');

    return {
      ok: true,
      published,
      videoUrl,
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

runYouTubeUpload()
  .then(res => {
    console.log('RESULTADO_FINAL_YOUTUBE:', JSON.stringify(res));
    process.exit(0);
  })
  .catch(err => {
    console.error('ERRO_YOUTUBE:', err.message);
    process.exit(1);
  });
