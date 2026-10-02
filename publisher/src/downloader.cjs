const { chromium, request } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { withGoogleLock } = require('./google-lock.cjs');

const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
const downloadsBaseDir = path.join(dataDir, 'downloads');
const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const googleProfileDir = path.join(dataDir, 'profiles', 'youtube');
const storageStateFile = path.join(dataDir, 'google_auth_state.json');

// Garante que o arquivo de cookies/sessão do Google esteja exportado e atualizado
async function ensureGoogleAuthState() {
  if (fs.existsSync(storageStateFile)) {
    try {
      const stats = fs.statSync(storageStateFile);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 3600);
      if (stats.size > 200 && ageHours < 72) {
        return true;
      }
    } catch (_) {}
  }

  if (!fs.existsSync(googleProfileDir)) {
    return false;
  }

  console.log('[Downloader] Sincronizando sessão do Google para downloads de alta velocidade...');
  try {
    await withGoogleLock(async () => {
      const ctx = await chromium.launchPersistentContext(googleProfileDir, {
        executablePath: chromePath,
        headless: true,
        viewport: { width: 800, height: 600 },
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled']
      });
      try {
        await ctx.storageState({ path: storageStateFile });
        console.log('[Downloader] Sessão do Google exportada com sucesso para downloads desacoplados.');
      } finally {
        await ctx.close().catch(() => {});
      }
    }, 'export_google_storage_state', 90000);
    return fs.existsSync(storageStateFile);
  } catch (err) {
    console.warn(`[Downloader] Não foi possível exportar storageState: ${err.message}`);
    return false;
  }
}

// Download autenticado de alta velocidade via request HTTP do Playwright (SEM abrir navegador e SEM travar YouTube)
async function downloadGoogleDriveFileDirect(fileId, destPath) {
  await ensureGoogleAuthState();
  if (!fs.existsSync(storageStateFile)) {
    throw new Error('Estado de autenticação do Google não disponível no momento.');
  }

  const downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
  console.log(`[Downloader] Acessando link do Drive (modo desacoplado): ${downloadUrl}`);

  const reqCtx = await request.newContext({
    storageState: storageStateFile,
    timeout: 600000 // 10 minutos
  });

  try {
    const res = await reqCtx.get(downloadUrl, { maxRedirects: 10, timeout: 600000 });
    const cType = res.headers()['content-type'] || '';
    if (res.ok() && (cType.includes('video') || cType.includes('octet-stream'))) {
      const buf = await res.body();
      if (buf && buf.length > 500000 && !buf.slice(0, 100).toString().toLowerCase().includes('<html')) {
        fs.writeFileSync(destPath, buf);
        console.log(`[Downloader] Download direto concluído: ${(buf.length / (1024 * 1024)).toFixed(1)} MB.`);
        return true;
      }
    }

    // Se retornou página HTML de confirmação de arquivo grande (>100MB)
    const text = await res.text().catch(() => '');
    let confirmUrl = null;

    const formMatch = text.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
    if (formMatch) {
      const actionUrl = formMatch[1];
      const formContent = formMatch[2];
      const params = new URLSearchParams();
      const inputMatches = [...formContent.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)];
      for (const m of inputMatches) params.set(m[1], m[2]);
      const inputMatchesRev = [...formContent.matchAll(/<input[^>]+value="([^"]*)"[^>]+name="([^"]+)"/gi)];
      for (const m of inputMatchesRev) params.set(m[2], m[1]);
      confirmUrl = `${actionUrl}?${params.toString()}`;
    } else {
      const linkMatch = text.match(/href="([^"]+confirm=[^"]+)"/);
      if (linkMatch) {
        confirmUrl = linkMatch[1].replace(/&amp;/g, '&');
        if (confirmUrl.startsWith('/')) confirmUrl = `https://drive.google.com${confirmUrl}`;
      }
    }

    if (confirmUrl) {
      console.log(`[Downloader] Confirmando download de arquivo grande: ${confirmUrl}`);
      const resConfirm = await reqCtx.get(confirmUrl, { maxRedirects: 10, timeout: 600000 });
      if (resConfirm.ok()) {
        const buf = await resConfirm.body();
        if (buf && buf.length > 500000 && !buf.slice(0, 100).toString().toLowerCase().includes('<html')) {
          fs.writeFileSync(destPath, buf);
          console.log(`[Downloader] Download grande concluído: ${(buf.length / (1024 * 1024)).toFixed(1)} MB.`);
          return true;
        }
      }
    }
    throw new Error('Conteúdo retornado pelo Drive não é um vídeo válido.');
  } finally {
    await reqCtx.dispose().catch(() => {});
  }
}

// Download de texto (.txt de post) via request desacoplado (sem abrir navegador)
async function downloadTextFileDirect(fileId) {
  if (!fileId) return '';
  await ensureGoogleAuthState();
  if (!fs.existsSync(storageStateFile)) return '';

  const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
  const reqCtx = await request.newContext({
    storageState: storageStateFile,
    timeout: 30000
  });

  try {
    const res = await reqCtx.get(directUrl, { maxRedirects: 10, timeout: 30000 });
    if (res.ok()) {
      const text = await res.text();
      if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<!doctype html>') && !text.includes('accounts.google.com')) {
        return text.trim();
      }
      const confirmMatch = text.match(/href="(\/uc\?export=download[^"]+confirm=[^"]+)"/) ||
                           text.match(/href="([^"]+confirm=[^"&]+[^"]*)"/);
      if (confirmMatch) {
        const confirmUrl = confirmMatch[1].startsWith('http') ? confirmMatch[1] : `https://drive.google.com${confirmMatch[1]}`;
        const resConfirm = await reqCtx.get(confirmUrl, { timeout: 30000 });
        if (resConfirm.ok()) {
          const confText = await resConfirm.text();
          if (confText && !confText.includes('<!DOCTYPE html>') && !confText.includes('<!doctype html>')) {
            return confText.trim();
          }
        }
      }
    }
    return '';
  } catch (err) {
    console.warn(`[Downloader] Falha ao obter texto desacoplado: ${err.message}`);
    return '';
  } finally {
    await reqCtx.dispose().catch(() => {});
  }
}

// Fallback: Função auxiliar para download direto HTTP se o arquivo for público
async function downloadDirectHttp(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadDirectHttp(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      const cType = res.headers['content-type'] || '';
      if (cType.includes('text/html')) {
        return reject(new Error('Download retornou página HTML em vez de arquivo de vídeo.'));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        try {
          const stats = fs.statSync(destPath);
          const head = fs.readFileSync(destPath).slice(0, 300).toString('utf8').toLowerCase();
          if (head.includes('<html') || head.includes('<!doc') || head.includes('accounts.google.com')) {
            try { fs.unlinkSync(destPath); } catch (_) {}
            return reject(new Error('Download retornou página HTML em vez do arquivo de vídeo.'));
          }
          if (stats.size < 1000000) {
            try { fs.unlinkSync(destPath); } catch (_) {}
            return reject(new Error(`Download incompleto (${stats.size} bytes).`));
          }
        } catch (e) {
          return reject(e);
        }
        resolve(true);
      });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(600000, () => {
      req.destroy();
      reject(new Error('Timeout no download direto'));
    });
  });
}

// Fallback: Download autenticado pelo Google Drive usando contexto persistente do navegador
async function downloadGoogleDriveFileWithContext(ctx, fileId, destPath) {
  const downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
  console.log(`[Downloader] Acessando link do Drive via navegador autenticado: ${downloadUrl}`);

  try {
    const res = await ctx.request.get(downloadUrl, { maxRedirects: 10, timeout: 600000 });
    const cType = res.headers()['content-type'] || '';
    if (res.ok() && (cType.includes('video') || cType.includes('octet-stream'))) {
      const buffer = await res.body();
      if (buffer && buffer.length > 1000000 && !buffer.slice(0, 200).toString().toLowerCase().includes('<html')) {
        fs.writeFileSync(destPath, buffer);
        console.log(`[Downloader] Download direto via browser concluído: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB.`);
        return true;
      }
    }
  } catch (errReq) {
    console.warn(`[Downloader] Request via browser gerou aviso: ${errReq.message}. Tentando página com form de confirmação...`);
  }

  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  try {
    await page.goto(downloadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(2000);

    // Extrai a URL completa do formulário de confirmação (#download-form) com todos os parâmetros (id, export, authuser, confirm, uuid, at)
    const formConfirmUrl = await page.evaluate(() => {
      const f = document.querySelector('form#download-form') || document.querySelector('form[action*="download"]');
      if (f) {
        const params = new URLSearchParams();
        for (const inp of f.querySelectorAll('input[name]')) {
          if (inp.name) params.set(inp.name, inp.value);
        }
        return `${f.action}?${params.toString()}`;
      }
      const link = document.querySelector('#uc-download-link, a[href*="confirm="]');
      if (link && link.href) return link.href;
      return null;
    });

    if (formConfirmUrl) {
      console.log(`[Downloader] URL de confirmação obtida com sucesso. Baixando stream...`);
      const resConfirm = await ctx.request.get(formConfirmUrl, { maxRedirects: 10, timeout: 600000 });
      if (resConfirm.ok()) {
        const buf = await resConfirm.body();
        if (buf && buf.length > 1000000 && !buf.slice(0, 200).toString().toLowerCase().includes('<html')) {
          fs.writeFileSync(destPath, buf);
          console.log(`[Downloader] Download de arquivo grande concluído: ${(buf.length / (1024 * 1024)).toFixed(1)} MB.`);
          return true;
        }
      }
    }

    const confirmBtn = page.locator('#uc-download-link, a:has-text("Fazer download mesmo assim"), button:has-text("Fazer download mesmo assim"), a[href*="confirm="]').first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('[Downloader] Clicando em "Fazer download mesmo assim"...');
      const [ dl ] = await Promise.all([
        page.waitForEvent('download', { timeout: 300000 }),
        confirmBtn.click()
      ]);
      await dl.saveAs(destPath);
      const st = fs.statSync(destPath);
      if (st.size > 1000000) {
        console.log(`[Downloader] Download via evento concluído: ${(st.size / (1024 * 1024)).toFixed(1)} MB.`);
        return true;
      }
    }

    throw new Error('Não foi possível obter o link de download direto do Google Drive.');
  } finally {
    await page.close().catch(() => {});
  }
}

// Fallback: Baixa texto via navegador autenticado
async function downloadTextFileWithContext(ctx, fileId) {
  if (!fileId) return '';
  const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await ctx.request.get(directUrl, { timeout: 20000 });
      if (res.ok()) {
        const text = await res.text();
        if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<!doctype html>') && !text.includes('accounts.google.com')) {
          return text.trim();
        }

        const confirmMatch = text.match(/href="(\/uc\?export=download[^"]+confirm=[^"]+)"/) ||
                             text.match(/href="([^"]+confirm=[^"&]+[^"]*)"/);
        if (confirmMatch) {
          const confirmUrl = confirmMatch[1].startsWith('http') ? confirmMatch[1] : `https://drive.google.com${confirmMatch[1]}`;
          const resConfirm = await ctx.request.get(confirmUrl, { timeout: 20000 });
          if (resConfirm.ok()) {
            const confText = await resConfirm.text();
            if (confText && !confText.includes('<!DOCTYPE html>') && !confText.includes('<!doctype html>')) {
              return confText.trim();
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Downloader] Tentativa ${attempt} de obter texto do post falhou: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    const page = await ctx.newPage();
    try {
      await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      const preEl = page.locator('pre').first();
      if (await preEl.isVisible({ timeout: 4000 }).catch(() => false)) {
        const preText = await preEl.innerText();
        if (preText && preText.trim()) return preText.trim();
      }
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (bodyText && !bodyText.includes('Google Drive') && !bodyText.includes('fazer download')) {
        return bodyText.trim();
      }
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.warn(`[Downloader] Fallback via página falhou para texto: ${err.message}`);
  }

  return '';
}

// Sanitiza o título do corte extraído da interface ou nomes de arquivos
function sanitizeCutTitle(rawTitle) {
  if (!rawTitle) return '';
  let s = String(rawTitle);
  // Remove prefixos como "Imagem", "Text", "corte_03", etc.
  s = s.replace(/^(?:Imagem|Text)?\s*corte[_\s-]*\d+[_\s-]*/i, '');
  // Remove artefatos e botões da interface do Google Drive
  s = s.replace(/(?:Compartilhar|Mais ações|Renomear|Adicionar|Com estrela|Ctrl\+Alt\+[A-Z]).*$/gi, '');
  s = s.replace(/\s+eu\s*\d+:\d+.*$/gi, '');
  s = s.replace(/\s+\d+(?:,\d+)?\s*(?:KB|MB|GB|bytes).*$/gi, '');
  // Remove extensões e sufixos de arquivo
  s = s.replace(/(?:_|\s|-)*(?:capa|legenda|post)?\.(?:mp4|mov|mkv|txt|srt|json|jpg|jpeg|png).*$/gi, '');
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function isRealMp4File(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1000000) return false;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(200);
    fs.readSync(fd, buf, 0, 200, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8');
    if (head.includes('<html') || head.includes('<!doc') || head.includes('accounts.google.com')) {
      return false;
    }
    const tag = buf.slice(4, 8).toString('ascii');
    return tag === 'ftyp' || tag === 'moov' || tag === 'wide';
  } catch (_) {
    return false;
  }
}

// Função principal: baixa um corte completo (.mp4 + .txt) e mede tempo e velocidade
async function downloadCorte({ cutIndex, titulo, videoFileId, postFileId, capaFileId = null, formato = null, requestId = 'default', onProgress = () => {} }) {
  const destDir = path.join(downloadsBaseDir, requestId);
  fs.mkdirSync(destDir, { recursive: true });

  const cleanInitialTitle = sanitizeCutTitle(titulo) || `Corte ${cutIndex}`;
  const safeTitle = cleanInitialTitle.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
  const is16x9 = (formato === '16:9') || /_16x9/i.test(titulo) || (typeof videoFileId === 'string' && /_16x9/i.test(videoFileId));
  const videoFileName = is16x9
    ? `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_16x9.mp4`
    : `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_legenda.mp4`;
  const postFileName = `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_post.txt`;
  const capaFileName = `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_capa.jpg`;
  const videoDestPath = path.join(destDir, videoFileName);
  const postDestPath = path.join(destDir, postFileName);
  const capaDestPath = path.join(destDir, capaFileName);

  onProgress({ status: 'starting', cutIndex, titulo: cleanInitialTitle });

  let postText = '';
  if (fs.existsSync(postDestPath)) {
    try {
      postText = fs.readFileSync(postDestPath, 'utf8');
    } catch (_) {}
  }

  // Se o vídeo e o texto já existem no disco, não gasta banda nem tempo
  if (isRealMp4File(videoDestPath) && postText) {
    const stats = fs.statSync(videoDestPath);
    const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(1));
    console.log(`[Downloader] Corte ${cutIndex} já existe localmente em ${videoDestPath} (${sizeMb} MB). Reutilizando.`);
    let cleanTitle = cleanInitialTitle;
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) cleanTitle = firstLine;

    const result = {
      cutIndex,
      titulo: cleanTitle,
      videoPath: videoDestPath,
      postPath: postDestPath,
      capaPath: fs.existsSync(capaDestPath) ? capaDestPath : null,
      postText,
      formato: is16x9 ? '16:9' : '9:16',
      sizeMb,
      durationSec: 0,
      speedMbPerSec: 0
    };
    onProgress({ status: 'completed', ...result });
    return result;
  } else if (fs.existsSync(videoDestPath) && !isRealMp4File(videoDestPath)) {
    console.warn(`[Downloader] Arquivo existente em ${videoDestPath} não é um vídeo MP4 válido (${fs.statSync(videoDestPath).size} bytes). Removendo para download limpo...`);
    try { fs.unlinkSync(videoDestPath); } catch (_) {}
  }

  console.log(`[Downloader] Iniciando sessão para o Corte ${cutIndex}...`);
  const t0 = Date.now();
  let downloadSuccess = false;

  // TENTATIVA 1: Modo direto desacoplado (Rápido, sem abrir navegador, sem travar YouTube)
  try {
    if (postFileId && !postText) {
      console.log(`[Downloader] Baixando texto do post para o Corte ${cutIndex} (modo desacoplado)...`);
      postText = await downloadTextFileDirect(postFileId);
      if (postText) {
        fs.writeFileSync(postDestPath, postText, 'utf8');
        console.log(`[Downloader] Texto do post salvo (${postText.length} caracteres).`);
      }
    }

    console.log(`[Downloader] Baixando vídeo do Corte ${cutIndex} (modo desacoplado, ID: ${videoFileId})...`);
    await downloadGoogleDriveFileDirect(videoFileId, videoDestPath);
    downloadSuccess = isRealMp4File(videoDestPath);
  } catch (errDirect) {
    console.warn(`[Downloader] Modo desacoplado falhou (${errDirect.message}). Tentando fallback com navegador...`);
  }

  // TENTATIVA 2: Fallback com navegador e trava do Google (timeout de 10 min)
  if (!downloadSuccess) {
    await withGoogleLock(async () => {
      const ctx = await chromium.launchPersistentContext(googleProfileDir, {
        executablePath: chromePath,
        headless: true,
        viewport: { width: 1280, height: 800 },
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
        acceptDownloads: true
      });

      try {
        if (postFileId && !postText) {
          postText = await downloadTextFileWithContext(ctx, postFileId);
          if (postText) {
            fs.writeFileSync(postDestPath, postText, 'utf8');
            console.log(`[Downloader] Texto do post salvo (${postText.length} caracteres).`);
          }
        }

        console.log(`[Downloader] Iniciando download do vídeo do Corte ${cutIndex} via browser (ID: ${videoFileId})...`);
        await downloadGoogleDriveFileWithContext(ctx, videoFileId, videoDestPath);
        downloadSuccess = isRealMp4File(videoDestPath);
      } catch (errAuth) {
        console.warn(`[Downloader] Tentativa via browser falhou (${errAuth.message}), tentando download direto...`);
        try {
          const directUrl = `https://drive.google.com/uc?id=${videoFileId}&export=download`;
          await downloadDirectHttp(directUrl, videoDestPath);
          downloadSuccess = isRealMp4File(videoDestPath);
        } catch (e) {
          console.warn(`[Downloader] Fallback HTTP direto falhou: ${e.message}`);
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    }, `download_corte_${cutIndex}`, 600000);
  }

  if (!isRealMp4File(videoDestPath)) {
    try { if (fs.existsSync(videoDestPath)) fs.unlinkSync(videoDestPath); } catch (_) {}
    throw new Error(`Arquivo de vídeo do Corte ${cutIndex} não foi baixado corretamente (não é um MP4 válido).`);
  }

  const durationSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const stats = fs.statSync(videoDestPath);
  const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(1));
  const speedMbPerSec = durationSec > 0 ? Number((sizeMb / durationSec).toFixed(2)) : sizeMb;

  console.log('====================================================');
  console.log(`[Downloader] CORTE ${cutIndex} BAIXADO COM SUCESSO!`);
  console.log(`Tamanho do arquivo: ${sizeMb} MB`);
  console.log(`Tempo de download: ${durationSec} segundos`);
  console.log(`Velocidade média: ${speedMbPerSec} MB/s`);
  console.log(`Salvo em: ${videoDestPath}`);
  console.log('====================================================');

  let cleanTitle = cleanInitialTitle;
  if (postText) {
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) {
      cleanTitle = firstLine;
    }
  }

  if (capaFileId && !fs.existsSync(capaDestPath)) {
    try {
      console.log(`[Downloader] Baixando miniatura da capa para Corte ${cutIndex}...`);
      await downloadGoogleDriveFileDirect(capaFileId, capaDestPath);
    } catch (_) {}
  }

  const result = {
    cutIndex,
    titulo: cleanTitle,
    videoPath: videoDestPath,
    postPath: postDestPath,
    capaPath: fs.existsSync(capaDestPath) ? capaDestPath : null,
    postText,
    formato: is16x9 ? '16:9' : '9:16',
    sizeMb,
    durationSec,
    speedMbPerSec
  };

  onProgress({ status: 'completed', ...result });
  return result;
}

// Processa o download em lote de todos os cortes de uma sessão
async function downloadBatch(batch, onCutDownloaded = () => {}) {
  const { requestId, cuts = [] } = batch;
  console.log(`[Downloader] Iniciando download em lote para a sessão ${requestId}: ${cuts.length} cortes.`);
  const downloadedCuts = [];

  for (const c of cuts) {
    const videoFileId = c.files?.videoLegenda?.id || c.files?.video?.id;
    const postFileId = c.files?.post?.id;
    const capaFileId = c.files?.capa?.id;
    const formato = c.formato || (c.destino === 'youtube' ? '16:9' : '9:16');

    if (!videoFileId) {
      console.warn(`[Downloader] Corte ${c.index || c.numero} sem ID de arquivo de vídeo, pulando...`);
      continue;
    }

    try {
      const info = await downloadCorte({
        cutIndex: c.index || c.numero || (downloadedCuts.length + 1),
        titulo: c.titulo,
        videoFileId,
        postFileId,
        capaFileId,
        formato,
        requestId: requestId || 'sessao_recente',
        onProgress: (p) => {
          console.log(`[Downloader Progress] Corte ${c.index}: ${p.status}`);
        }
      });
      downloadedCuts.push(info);
      onCutDownloaded(info);
    } catch (err) {
      console.error(`[Downloader] Falha ao baixar Corte ${c.index}: ${err.message}`);
    }
  }

  return downloadedCuts;
}

function extractDriveFolderId(urlOrId) {
  if (!urlOrId) return null;
  const str = String(urlOrId).trim();
  const match = str.match(/folders\/([a-zA-Z0-9_-]+)/i);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(str)) return str;
  return null;
}

async function scanDriveFolder(folderUrlOrId, onLog = console.log) {
  const folderId = extractDriveFolderId(folderUrlOrId);
  if (!folderId) {
    throw new Error('Link ou ID da pasta do Google Drive inválido.');
  }

  const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
  onLog(`[Drive Scan] Acessando pasta: ${folderUrl}`);

  const allFound = new Map();

  await withGoogleLock(async () => {
    const ctx = await chromium.launchPersistentContext(googleProfileDir, {
      executablePath: chromePath,
      headless: true,
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled']
    });

    const page = await ctx.newPage();

    try {
      // Atualiza o storageState durante o scan para mantê-lo fresco
      await ctx.storageState({ path: storageStateFile }).catch(() => {});

      await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      // Foca na área de arquivos
      await page.click('[role="main"], [data-id], .a-u-j').catch(() => {});

      for (let scrollStep = 0; scrollStep < 25; scrollStep++) {
        const items = await page.evaluate(() => {
          const allWithId = Array.from(document.querySelectorAll('[data-id]'));
          const list = [];
          for (const el of allWithId) {
            const id = el.getAttribute('data-id');
            if (!id) continue;

            const sources = [
              el.getAttribute('title'),
              el.querySelector('[title]')?.getAttribute('title'),
              el.getAttribute('aria-label'),
              el.querySelector('[aria-label]')?.getAttribute('aria-label'),
              el.innerText,
              el.textContent
            ].filter(Boolean);

            let matchedName = null;
            for (const src of sources) {
              // 1. Procura nome de corte com extensão de mídia/texto
              const m1 = src.match(/(corte[_\s-]*\d+[^"\n\r\t*?<>]+?\.(?:mp4|txt|srt|json|jpg|jpeg|png))/i);
              if (m1) {
                matchedName = m1[1].trim();
                break;
              }
              // 2. Procura identificador de corte em elementos associados a mídia
              const m2 = src.match(/(corte[_\s-]*\d+[^"\n\r\t*?<>]+)/i);
              if (m2 && (src.includes('.mp4') || src.includes('.txt') || src.includes('.srt') || src.includes('legenda'))) {
                matchedName = m2[1].trim();
                break;
              }
            }

            if (!matchedName) {
              const text = (el.innerText || el.textContent || '').trim();
              const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
              matchedName = lines.find(l => /corte[_\s-]*\d+/i.test(l) || /\.(mp4|txt|srt|json)$/i.test(l)) || lines[0];
            }

            if (matchedName) {
              list.push({ id, name: matchedName });
            }
          }
          return list;
        });

        for (const item of items) {
          if (!allFound.has(item.id)) {
            allFound.set(item.id, item.name);
          }
        }

        // Rola o container interno do Drive
        await page.evaluate(() => {
          const scrollable = document.querySelector('[role="main"]') ||
                             document.querySelector('[aria-label="Arquivos"]') ||
                             document.querySelector('.a-u-j') ||
                             document.scrollingElement ||
                             document.body;
          if (scrollable) {
            scrollable.scrollTop += 600;
          }
          window.scrollBy(0, 600);
        });

        await page.keyboard.press('PageDown');
        await page.waitForTimeout(800);
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  }, 'scan_drive_folder', 600000);

  const files = Array.from(allFound.entries()).map(([id, name]) => ({ id, name }));
  const cutsMap = new Map();

  for (const f of files) {
    const match = f.name.match(/corte[_\s-]*(\d+)/i);
    if (!match) continue;

    const cutNum = parseInt(match[1], 10);
    if (!cutsMap.has(cutNum)) {
      cutsMap.set(cutNum, { cutIndex: cutNum, rawName: f.name });
    }
    const cut = cutsMap.get(cutNum);

    const is16x9 = /_16x9\.(?:mp4|mov|mkv)$/i.test(f.name) || f.name.toLowerCase().includes('_16x9');
    const isLegenda = /(?:_|\s|-)?legenda\.(?:mp4|mov|mkv)$/i.test(f.name) ||
                      (f.name.toLowerCase().includes('legenda') && f.name.toLowerCase().endsWith('.mp4'));
    const isPost = /(?:_|\s|-)?post\.txt$/i.test(f.name) ||
                   (f.name.toLowerCase().includes('post') && f.name.toLowerCase().endsWith('.txt'));
    const isSrt = /\.srt$/i.test(f.name);
    const isCapa = /(?:_|\s|-)?capa\.(?:jpg|jpeg|png)$/i.test(f.name) ||
                   (f.name.toLowerCase().includes('capa') && f.name.toLowerCase().endsWith('.jpg'));
    const isRawVideo = /\.mp4$/i.test(f.name) && !isLegenda && !is16x9;

    if (is16x9) {
      cut.video16x9 = { id: f.id, name: f.name };
      cut.videoLegenda = { id: f.id, name: f.name };
      cut.formato = '16:9';
    } else if (isLegenda) {
      cut.videoLegenda = { id: f.id, name: f.name };
      cut.formato = '9:16';
    } else if (isPost) {
      cut.post = { id: f.id, name: f.name };
    } else if (isSrt) {
      cut.srt = { id: f.id, name: f.name };
    } else if (isCapa) {
      cut.capa = { id: f.id, name: f.name };
    } else if (isRawVideo) {
      cut.rawVideo = { id: f.id, name: f.name };
    }

    // Limpa o título do corte ignorando arquivos de capa ou textos de botões
    if (!cut.titulo || cut.titulo.includes('capa') || cut.titulo.length > 60) {
      const clean = sanitizeCutTitle(f.name);
      if (clean && (!cut.titulo || !cut.titulo.includes('capa') || clean.length < cut.titulo.length)) {
        cut.titulo = clean;
      }
    }
  }

  const validCuts = Array.from(cutsMap.values())
    .map(c => {
      // Se tiver vídeo com legenda, usa ele. Se não tiver mas tiver vídeo cru, usa como fallback
      if (!c.videoLegenda && c.rawVideo) {
        c.videoLegenda = c.rawVideo;
      }
      if (!c.titulo || c.titulo.includes('capa')) {
        c.titulo = sanitizeCutTitle(c.rawName) || `Corte ${c.cutIndex}`;
      }
      return c;
    })
    .filter(c => c.videoLegenda && c.videoLegenda.id)
    .sort((a, b) => a.cutIndex - b.cutIndex);

  onLog(`[Drive Scan] ${validCuts.length} cortes com vídeo identificados na pasta.`);
  return { folderId, cuts: validCuts };
}

async function importAndEnqueueDriveFolder({ folderUrlOrId, executor, onLog = console.log, onProgress = () => {} }) {
  onLog(`[Drive Import] Iniciando escaneamento da pasta do Google Drive...`);
  const { folderId, cuts } = await scanDriveFolder(folderUrlOrId, onLog);

  if (cuts.length === 0) {
    onLog(`[Drive Import] Nenhum corte com arquivo de vídeo encontrado nesta pasta.`);
    return { ok: false, message: 'Nenhum corte com vídeo encontrado na pasta.' };
  }

  const requestId = `drive_${folderId.slice(0, 12)}`;
  onLog(`[Drive Import] ${cuts.length} cortes identificados na pasta. Verificando histórico para a pasta ${folderId.slice(0, 8)}...`);
  
  const existingJobs = executor.q.list();
  let enqueuedCount = 0;
  let skippedCount = 0;

  for (const cut of cuts) {
    // Verifica se este corte DESTA PASTA já foi publicado ou está na fila
    const cutJobs = existingJobs.filter(j => {
      if (!j.payload) return false;
      const sameFolder = (j.id && j.id.startsWith(requestId)) || 
                         j.payload.requestId === requestId || 
                         j.payload.folderId === folderId;
      const sameFile = cut.videoLegenda?.id && (j.payload.driveFileId === cut.videoLegenda.id);
      return (sameFolder && j.payload.cutIndex === cut.cutIndex) || sameFile;
    });

    const completedJobs = cutJobs.filter(j => j.state === 'completed');
    const completedNetworks = new Set(completedJobs.map(j => j.payload?.network).filter(Boolean));
    const is16x9Cut = cut.formato === '16:9' || (cut.videoLegenda?.name && /_16x9/i.test(cut.videoLegenda.name));
    const targetNetworks = is16x9Cut ? ['youtube'] : ['tiktok', 'instagram'];
    const isFullyCompleted = targetNetworks.every(n => completedNetworks.has(n));

    if (isFullyCompleted) {
      onLog(`[Drive Import] ⏭️ Corte ${cut.cutIndex} ("${cut.titulo || 'Corte ' + cut.cutIndex}") já foi publicado em suas redes-alvo (${targetNetworks.join(', ')}). Pulando.`);
      skippedCount++;
      continue;
    }

    const pendingJobs = cutJobs.filter(j => j.state === 'queued' || j.state === 'publishing');
    if (pendingJobs.length > 0) {
      onLog(`[Drive Import] ⏳ Corte ${cut.cutIndex} ("${cut.titulo || 'Corte ' + cut.cutIndex}") já está na fila de postagens. Pulando.`);
      skippedCount++;
      continue;
    }

    onLog(`[Drive Import] ⬇️ Preparando Corte ${cut.cutIndex}: "${cut.titulo}" (${is16x9Cut ? 'YouTube 16:9' : 'Vertical 9:16'})...`);
    
    try {
      const downloaded = await downloadCorte({
        cutIndex: cut.cutIndex,
        titulo: cut.titulo,
        videoFileId: cut.videoLegenda.id,
        postFileId: cut.post?.id,
        capaFileId: cut.capa?.id,
        formato: is16x9Cut ? '16:9' : '9:16',
        requestId,
        onProgress: (p) => {
          onProgress({ cutIndex: cut.cutIndex, status: p.status });
        }
      });

      const jobIds = executor.enqueueCorte({
        cutIndex: cut.cutIndex,
        titulo: downloaded.titulo,
        videoPath: downloaded.videoPath,
        postPath: downloaded.postPath,
        postText: downloaded.postText,
        capaPath: downloaded.capaPath,
        formato: downloaded.formato || (is16x9Cut ? '16:9' : '9:16'),
        requestId,
        folderId,
        driveFileId: cut.videoLegenda.id
      });

      enqueuedCount++;
      onLog(`[Drive Import] ✅ Corte ${cut.cutIndex} adicionado à fila (${jobIds.length} tarefas criadas: ${targetNetworks.join(', ')}).`);
    } catch (err) {
      onLog(`[Drive Import] ❌ Erro ao baixar Corte ${cut.cutIndex}: ${err.message}`);
    }
  }

  onLog(`[Drive Import] Fila atualizada: ${enqueuedCount} cortes adicionados (${skippedCount} já publicados/enfileirados anteriormente).`);
  return { ok: true, enqueuedCount, skippedCount, totalCuts: cuts.length };
}

module.exports = {
  downloadCorte,
  downloadBatch,
  downloadGoogleDriveFileWithContext,
  downloadGoogleDriveFileDirect,
  extractDriveFolderId,
  scanDriveFolder,
  importAndEnqueueDriveFolder,
  ensureGoogleAuthState
};
