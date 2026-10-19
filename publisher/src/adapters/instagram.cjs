const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

async function dismissPopups(page) {
  try {
    const popups = [
      page.getByRole('button', { name: 'Agora não' }),
      page.locator('button:has-text("Agora não")'),
      page.locator('button:has-text("Not now")'),
      page.locator('button:has-text("Cancelar")'),
      page.locator('button:has-text("Entendi")'),
      page.locator('button:has-text("OK")')
    ];
    for (const btn of popups) {
      if (await btn.first().isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  } catch (_) {}
}

async function publishInstagramReels({ videoPath, caption, thumbnailPath = null, attempt }) {
  attempt?.stage('Abrindo Instagram');
  const startTime = Date.now();
  const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
  const profileDir = path.join(dataDir, 'profiles', 'instagram');
  const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

  console.log('[Instagram] Iniciando publicação de Reel...');
  console.log('[Instagram] Vídeo:', videoPath);
  if (thumbnailPath) console.log('[Instagram] Miniatura/Capa:', thumbnailPath);

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
    console.log('[Instagram 1/6] Carregando Instagram...');
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissPopups(page);
    await page.keyboard.press('Escape').catch(() => {});

    console.log('[Instagram 2/6] Abrindo modal Criar (+) ➔ Postar...');
    const plusIcon = page.locator('svg[aria-label="Novo post"], svg[aria-label="Nova publicação"], svg[aria-label="New post"], a:has(svg[aria-label="Novo post"]), a:has(svg[aria-label="Nova publicação"]), [aria-label="Novo post"], [aria-label="Nova publicação"], a:has-text("Criar")').first();
    await plusIcon.waitFor({ state: 'visible', timeout: 15000 });
    await plusIcon.click({ force: true });
    await page.waitForTimeout(600);

    const postarLink = page.getByRole('link', { name: /Postar/i }).first();
    if (await postarLink.count() > 0 && await postarLink.isVisible().catch(() => false)) {
      await postarLink.click({ force: true });
      await page.waitForTimeout(600);
    }

    console.log('[Instagram 3/6] Anexando arquivo de vídeo...');
    attempt?.stage('Enviando vídeo');
    const tUpload = Date.now();

    // Tenta anexar pelo botão "Selecionar do computador" via evento filechooser nativo
    let attached = false;
    const selectBtn = page.locator('[role="dialog"] button:has-text("Selecionar"), button:has-text("Selecionar do computador")').first();
    if (await selectBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 6000 }),
          selectBtn.click({ force: true })
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(videoPath);
          attached = true;
          console.log('[Instagram] Vídeo anexado via seletor nativo de arquivos!');
        }
      } catch (errChooser) {
        console.log(`[Instagram] Filechooser direto falhou: ${errChooser.message}, tentando input direto...`);
      }
    }

    if (!attached) {
      const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').last();
      await fileInput.waitFor({ state: 'attached', timeout: 15000 });
      await fileInput.setInputFiles(videoPath);
      console.log('[Instagram] Vídeo anexado via input file direto.');
    }

    // Aguarda o modal carregar o vídeo (o botão "Selecionar do computador" deve sumir ao carregar o player)
    for (let w = 0; w < 12; w++) {
      await page.waitForTimeout(1000);
      const stillInitial = await selectBtn.isVisible().catch(() => false);
      if (!stillInitial) {
        console.log('[Instagram] Vídeo processado pelo modal com sucesso!');
        break;
      }
      if (w === 4 || w === 8) {
        console.log('[Instagram] Reforçando anexo do arquivo de vídeo...');
        const fileInput = page.locator('[role="dialog"] input[type="file"], input[type="file"]').last();
        await fileInput.setInputFiles(videoPath).catch(() => {});
      }
    }

    // Fecha aviso de formato Reels se aparecer
    const reelNotice = page.locator('button:has-text("OK"), button:has-text("Entendi")').first();
    if (await reelNotice.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reelNotice.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }

    console.log('[Instagram 4/6] Verificando proporção...');
    // Nossos cortes já são renderizados em 9:16 vertical (1080x1920).
    // Só tenta abrir o menu de corte se o botão estiver visível imediatamente (sem esperar 12 segundos).
    try {
      const cropBtn = page.locator('[role="dialog"] button:has(svg[aria-label*="corte" i]), [role="dialog"] button:has(svg[aria-label*="crop" i]), [role="dialog"] [aria-label*="Selecionar corte" i]').first();
      if (await cropBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await cropBtn.click();
        await page.waitForTimeout(400);
        const opt916 = page.locator('span:text-is("9:16"), div:text-is("9:16")').last();
        if (await opt916.isVisible({ timeout: 2000 }).catch(() => false)) {
          await opt916.click({ force: true });
          console.log('[Instagram] ✅ Proporção 9:16 vertical confirmada!');
          await page.waitForTimeout(400);
        }
      }
    } catch (_) {}

    console.log('[Instagram 5/6] Configurando capa e avançando telas...');
    // Etapa 1: Avança da tela de corte para a tela de edição/capa
    const nextBtn = page.locator('[role="dialog"] div[role="button"]:has-text("Avançar"), [role="dialog"] button:has-text("Avançar")').first();
    if (await nextBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await nextBtn.click();
      console.log('[Instagram] Avançou para tela de edição de capa.');
      await page.waitForTimeout(1500);
    }

    // Configuração de Capa no Instagram (Upload de arquivo ou seleção de frame)
    try {
      const coverSectionVisible = await page.locator('[role="dialog"] text=/foto da capa/i, [role="dialog"] text=/cover photo/i, [role="dialog"] button:has-text("Selecionar do computador"), [role="dialog"] button:has-text("Adicionar do computador")').first().isVisible({ timeout: 3000 }).catch(() => false);
      if (coverSectionVisible) {
        console.log('[Instagram] Tela "Foto da capa" detectada!');
        attempt?.stage('Configurando capa do Reel');
        let coverDone = false;

        // 1. Tenta upload de arquivo personalizado (capa.jpg)
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          console.log('[Instagram] Tentando upload de capa personalizada:', thumbnailPath);
          try {
            const selectCoverBtn = page.locator('[role="dialog"] button:has-text("Selecionar do computador"), [role="dialog"] button:has-text("Adicionar do computador"), [role="dialog"] div[role="button"]:has-text("Selecionar do computador"), [role="dialog"] div[role="button"]:has-text("Adicionar do computador")').first();
            if (await selectCoverBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
              try {
                const [coverChooser] = await Promise.all([
                  page.waitForEvent('filechooser', { timeout: 4000 }),
                  selectCoverBtn.click({ force: true })
                ]);
                if (coverChooser) {
                  await coverChooser.setFiles(thumbnailPath);
                  coverDone = true;
                  console.log('[Instagram] ✅ Capa anexada via filechooser nativo!');
                  await page.waitForTimeout(1500);
                }
              } catch (eChoose) {
                console.log(`[Instagram] Filechooser da capa: ${eChoose.message}, tentando input direto...`);
              }
            }

            if (!coverDone) {
              const coverInput = page.locator('[role="dialog"] input[type="file"][accept*="image"], [role="dialog"] input[type="file"]').last();
              if (await coverInput.count() > 0) {
                await coverInput.setInputFiles(thumbnailPath);
                coverDone = true;
                console.log('[Instagram] ✅ Capa anexada via input file!');
                await page.waitForTimeout(1500);
              }
            }
          } catch (errImg) {
            console.warn('[Instagram] Falha ao enviar imagem de capa:', errImg.message);
          }
        }

        // 2. Fallback: Selecionar frame do próprio vídeo na linha do tempo (~2 a 3 segundos)
        if (!coverDone) {
          console.log('[Instagram] Selecionando frame com a arte do título a partir do vídeo...');
          try {
            const filmstrip = page.locator('[role="dialog"] [class*="filmstrip"], [role="dialog"] [role="slider"], [role="dialog"] [class*="timeline"], [role="dialog"] [aria-label*="vídeo" i]').first();
            if (await filmstrip.isVisible({ timeout: 2500 }).catch(() => false)) {
              const fBox = await filmstrip.boundingBox();
              if (fBox && fBox.width > 40) {
                const clickX = fBox.x + Math.max(15, Math.min(fBox.width * 0.12, 80));
                const clickY = fBox.y + fBox.height / 2;
                await page.mouse.click(clickX, clickY);
                console.log(`[Instagram] ✅ Frame selecionado no carrossel de vídeo (X=${Math.round(clickX)}).`);
                coverDone = true;
                await page.waitForTimeout(1000);
              }
            }
          } catch (errScrub) {
            console.warn('[Instagram] Aviso ao selecionar frame do vídeo:', errScrub.message);
          }
        }
      }
    } catch (errCover) {
      console.warn('[Instagram] Aviso na verificação de capa (prosseguindo):', errCover.message);
    }

    // Avança inteligentemente até a tela de legenda estar visível
    for (let step = 0; step < 4; step++) {
      const captionVisible = await page.locator('[role="dialog"] div[aria-label*="legenda" i], [role="dialog"] div[aria-label*="caption" i], [role="dialog"] div[role="textbox"]').first().isVisible().catch(() => false);
      if (captionVisible) {
        console.log('[Instagram] Tela de legenda alcançada!');
        break;
      }
      const nextBtnLoop = page.locator('[role="dialog"] div[role="button"]:has-text("Avançar"), [role="dialog"] button:has-text("Avançar")').first();
      if (await nextBtnLoop.isVisible({ timeout: 4000 }).catch(() => false)) {
        await nextBtnLoop.click();
        console.log(`[Instagram] Botão Avançar clicado (etapa ${step + 1}).`);
        await page.waitForTimeout(1000);
      } else {
        await page.waitForTimeout(600);
      }
    }

    console.log('[Instagram] Preenchendo legenda e hashtags...');
    attempt?.stage('Preenchendo legenda');
    const captionEl = page.locator('[role="dialog"] div[aria-label*="legenda" i], [role="dialog"] div[aria-label*="caption" i], [role="dialog"] div[role="textbox"], [role="dialog"] div[contenteditable="true"]').first();
    await captionEl.waitFor({ state: 'visible', timeout: 15000 });
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
    const shareBtn = page.locator('[role="dialog"] button:has-text("Compartilhar"), [role="dialog"] div[role="button"]:has-text("Compartilhar"), [role="dialog"] [aria-label="Compartilhar"]').first();
    await shareBtn.waitFor({ state: 'visible', timeout: 15000 });

    attempt?.stage('Publicando e aguardando confirmação');
    attempt?.beforePublish();
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
    for (let wait = 1; wait <= 90; wait++) {
      await page.waitForTimeout(2000);
      const curText = await page.locator('[role="dialog"]').innerText().catch(() => '');

      if (/(?:reel|v[ií]deo|post) (?:foi )?(?:compartilhado|partilhado)|(?:sua )?publicação (?:foi )?(?:compartilhada|partilhada)|(?:your )?(?:reel|post) (?:has been )?shared/i.test(curText)) {
        confirmed = true;
        attempt?.confirm({ok:true,confirmed:true,network:'instagram',evidence:'Mensagem de publicação compartilhada',at:Date.now()});
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
      ok: confirmed,
      network: 'instagram',
      confirmed,
      totalSeconds,
      uploadSeconds: publishSeconds,
      screenshot: screenshotPath
    };
  } catch (error) {
    const screenshot = path.join(dataDir, `insta-error-${Date.now()}.png`);
    await page.screenshot({path:screenshot,timeout:5000}).catch(() => {});
    console.warn(`[Instagram] Diagnóstico do envio: ${screenshot}`);
    throw error;
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { publishInstagramReels };
