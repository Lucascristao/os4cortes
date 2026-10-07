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
    timeout: 12000 // 12 segundos: se for arquivo pequeno/médio conclui veloz; se for grande (>50MB) cai rápido para o Chrome
  });

  try {
    const res = await reqCtx.get(downloadUrl, { maxRedirects: 5, timeout: 12000 });
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
      console.log(`[Downloader] Confirmando download de arquivo grande via stream: ${confirmUrl}`);
      try {
        await downloadDirectHttp(confirmUrl, destPath);
        if (isRealMp4File(destPath)) {
          const stats = fs.statSync(destPath);
          console.log(`[Downloader] Download de arquivo grande concluído: ${(stats.size / (1024 * 1024)).toFixed(1)} MB.`);
          return true;
        }
      } catch (errStream) {
        console.warn(`[Downloader] Stream direto falhou: ${errStream.message}, tentando via request buffer...`);
        const resConfirm = await reqCtx.get(confirmUrl, { maxRedirects: 5, timeout: 120000 });
        if (resConfirm.ok()) {
          const buf = await resConfirm.body();
          if (buf && buf.length > 500000 && !buf.slice(0, 100).toString().toLowerCase().includes('<html')) {
            fs.writeFileSync(destPath, buf);
            console.log(`[Downloader] Download grande concluído: ${(buf.length / (1024 * 1024)).toFixed(1)} MB.`);
            return true;
          }
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

// Download direto e resiliente HTTP com suporte nativo a streaming de arquivos grandes (>100MB) do Google Drive
async function downloadHttpStreamWithResume(downloadUrl, destPath) {
  let expectedLength = 0;
  for (let attempt = 1; attempt <= 10; attempt++) {
    let currentSize = 0;
    if (fs.existsSync(destPath)) {
      currentSize = fs.statSync(destPath).size;
    }

    if (expectedLength > 0 && currentSize >= expectedLength) {
      console.log(`[Downloader] Arquivo 100% baixado: ${(currentSize / (1024 * 1024)).toFixed(1)} MB`);
      return true;
    }

    const headers = {};
    if (currentSize > 0) {
      headers['Range'] = `bytes=${currentSize}-`;
      console.log(`[Downloader] Retomando download de ${(currentSize / (1024 * 1024)).toFixed(1)} MB... (tentativa ${attempt})`);
    } else {
      console.log(`[Downloader] Iniciando stream HTTP direto (tentativa ${attempt})...`);
    }

    try {
      await new Promise((resolve, reject) => {
        const proto = downloadUrl.startsWith('https') ? https : http;
        const req = proto.get(downloadUrl, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let redirectUrl = res.headers.location;
            if (redirectUrl.startsWith('/')) {
              const u = new URL(downloadUrl);
              redirectUrl = `${u.origin}${redirectUrl}`;
            }
            return downloadHttpStreamWithResume(redirectUrl, destPath).then(resolve).catch(reject);
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            return reject(new Error(`HTTP Status ${res.statusCode}`));
          }

          const cType = res.headers['content-type'] || '';
          if (cType.includes('text/html')) {
            return reject(new Error('HTML recebido em vez de fluxo de vídeo.'));
          }

          if (res.headers['content-range']) {
            const m = res.headers['content-range'].match(/\/(\d+)/);
            if (m) expectedLength = parseInt(m[1], 10);
          } else if (res.headers['content-length'] && currentSize === 0) {
            expectedLength = parseInt(res.headers['content-length'], 10);
          }

          console.log(`[Downloader] Status ${res.statusCode}, tamanho total esperado: ${expectedLength > 0 ? (expectedLength / (1024 * 1024)).toFixed(1) + ' MB' : 'desconhecido'}`);

          const outStream = fs.createWriteStream(destPath, { flags: currentSize > 0 ? 'a' : 'w' });
          res.pipe(outStream);

          outStream.on('finish', () => {
            outStream.close();
            try {
              const stats = fs.statSync(destPath);
              if (expectedLength > 0 && stats.size < expectedLength) {
                return reject(new Error(`Download truncado: ${stats.size} de ${expectedLength} bytes`));
              }
              resolve(true);
            } catch (e) {
              reject(e);
            }
          });
          outStream.on('error', reject);
        });

        req.on('error', reject);
        req.setTimeout(300000, () => {
          req.destroy();
          reject(new Error('Timeout de socket no stream'));
        });
      });

      return true;
    } catch (err) {
      console.warn(`[Downloader] Tentativa ${attempt} falhou: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  throw new Error(`Falha ao completar download após 10 tentativas.`);
}

async function downloadDirectHttp(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const u = new URL(url);
          redirectUrl = `${u.origin}${redirectUrl}`;
        }
        return downloadDirectHttp(redirectUrl, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }

      const cType = res.headers['content-type'] || '';
      // Se for página HTML de confirmação de arquivo grande (>100MB) do Google Drive
      if (cType.includes('text/html')) {
        let htmlBody = '';
        res.on('data', chunk => { htmlBody += chunk; });
        res.on('end', () => {
          const formMatch = htmlBody.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
          let confirmUrl = null;
          if (formMatch) {
            const actionUrl = formMatch[1];
            const formContent = formMatch[2];
            const params = new URLSearchParams();
            const inputMatches = [...formContent.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)];
            for (const m of inputMatches) params.set(m[1], m[2]);
            confirmUrl = `${actionUrl}?${params.toString()}`;
          } else {
            const linkMatch = htmlBody.match(/href="([^"]+confirm=[^"]+)"/);
            if (linkMatch) {
              confirmUrl = linkMatch[1].replace(/&amp;/g, '&');
              if (confirmUrl.startsWith('/')) confirmUrl = `https://drive.google.com${confirmUrl}`;
            } else {
              const uuidMatch = htmlBody.match(/name="uuid"\s+value="([^"]+)"/) || htmlBody.match(/uuid=([a-f0-9-]+)/);
              const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
              if (idMatch) {
                confirmUrl = `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&confirm=t${uuidMatch ? '&uuid=' + uuidMatch[1] : ''}`;
              }
            }
          }

          if (confirmUrl) {
            console.log(`[Downloader] Seguindo confirmação de arquivo grande com resume: ${confirmUrl}`);
            return downloadHttpStreamWithResume(confirmUrl, destPath).then(resolve).catch(reject);
          }
          return reject(new Error('Download retornou página HTML de login ou erro em vez do arquivo de vídeo.'));
        });
        return;
      }

      // Se já veio o stream direto do arquivo
      downloadHttpStreamWithResume(url, destPath).then(resolve).catch(reject);
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
  console.log(`[Downloader] Baixando arquivo do Drive com Chrome autenticado: ${downloadUrl}`);

  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);

  try {
    let actualDownload = null;
    try {
      const [ download ] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }).catch(() => null),
        page.goto(downloadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => {
          if (err.message.includes('Download is starting') || err.message.includes('ERR_ABORTED')) {
            console.log('[Downloader] Download nativo iniciado na navegação.');
          } else {
            console.warn(`[Downloader] Aviso na navegação: ${err.message}`);
          }
        })
      ]);
      actualDownload = download;
    } catch (_) {}

    if (!actualDownload) {
      console.log('[Downloader] Procurando botão de confirmação de vírus do Google Drive...');
      const downloadBtn = page.locator('#uc-download-link, input[type="submit"], a[href*="confirm="], button:has-text("Fazer o download mesmo assim"), button:has-text("Fazer download mesmo assim"), a:has-text("Fazer download mesmo assim"), :has-text("mesmo assim"), :has-text("Download anyway"), #download-button').first();
      if (await downloadBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
        console.log('[Downloader] Clicando em botão de confirmação com captura nativa do Chrome...');
        const [ bigDownload ] = await Promise.all([
          page.waitForEvent('download', { timeout: 600000 }),
          downloadBtn.click({ force: true })
        ]);
        actualDownload = bigDownload;
      }
    }

    if (actualDownload) {
      console.log(`[Downloader] Gravando download nativo em disco: ${destPath}`);
      let checkTimer = null;
      const savePromise = actualDownload.saveAs(destPath);
      const pollPromise = new Promise((resolve) => {
        checkTimer = setInterval(() => {
          if (isRealMp4FileComplete(destPath)) {
            clearInterval(checkTimer);
            resolve(true);
          }
        }, 2500);
      });
      try {
        await Promise.race([savePromise, pollPromise]);
      } finally {
        if (checkTimer) clearInterval(checkTimer);
      }
      console.log(`[Downloader] Download nativo concluído e salvo em: ${destPath}`);
      return true;
    }

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
      console.log('[Downloader] Baixando via URL de confirmação com suporte a resume...');
      await downloadDirectHttp(formConfirmUrl, destPath);
      return true;
    }

    throw new Error('Nenhum link ou botão de download encontrado na página do Google Drive.');
  } finally {
    await page.close().catch(() => {});
  }
}

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
  s = s.replace(/(?:_|\s|-)*(?:capa|legenda|post|16x9|16_9|16-9)?\.(?:mp4|mov|mkv|txt|srt|json|jpg|jpeg|png).*$/gi, '');
  s = s.replace(/(?:_|\s|-)+(?:16x9|16_9|16-9)$/gi, '');
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
    return tag === 'ftyp' || tag === 'moov' || tag === 'wide' || tag === 'mdat' || tag === 'free';
  } catch (_) {
    return false;
  }
}

// Valida rigorosamente a integridade do video MP4 usando ffprobe (garante que nao foi cortado/truncado)
function isRealMp4FileComplete(filePath) {
  if (!isRealMp4File(filePath)) return false;
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString().trim();
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const dur = parseFloat(lines[0]);
    if (isNaN(dur) || dur < 3) {
      console.warn(`[Downloader] Video ${filePath} tem duracao invalida via ffprobe (${dur}s)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Downloader] Video MP4 incompleto ou corrompido em ${filePath}: ${err.message}`);
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
  if (isRealMp4FileComplete(videoDestPath) && postText) {
    const stats = fs.statSync(videoDestPath);
    const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(1));
    console.log(`[Downloader] Corte ${cutIndex} já existe localmente em ${videoDestPath} (${sizeMb} MB). Reutilizando.`);
    let cleanTitle = cleanInitialTitle;
    if (!cleanTitle || /^corte\s*\d+$/i.test(cleanTitle)) {
      const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
      if (firstLine && firstLine.length > 3) cleanTitle = firstLine;
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
      durationSec: 0,
      speedMbPerSec: 0
    };
    onProgress({ status: 'completed', ...result });
    return result;
  } else if (fs.existsSync(videoDestPath) && !isRealMp4FileComplete(videoDestPath)) {
    console.warn(`[Downloader] Arquivo existente em ${videoDestPath} está incompleto ou inválido (${fs.statSync(videoDestPath).size} bytes). Removendo para download limpo...`);
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
    downloadSuccess = isRealMp4FileComplete(videoDestPath);
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
        try {
          await downloadGoogleDriveFileWithContext(ctx, videoFileId, videoDestPath);
        } catch (errCtx) {
          if (isRealMp4FileComplete(videoDestPath)) {
            console.log(`[Downloader] Vídeo do Corte ${cutIndex} já está íntegro no disco (${errCtx.message}). Prosseguindo.`);
          } else {
            throw errCtx;
          }
        }
        downloadSuccess = isRealMp4FileComplete(videoDestPath);
      } catch (errAuth) {
        console.warn(`[Downloader] Tentativa via browser falhou (${errAuth.message}), tentando download direto...`);
        try {
          const directUrl = `https://drive.google.com/uc?id=${videoFileId}&export=download`;
          await downloadDirectHttp(directUrl, videoDestPath);
          downloadSuccess = isRealMp4FileComplete(videoDestPath);
        } catch (e) {
          console.warn(`[Downloader] Fallback HTTP direto falhou: ${e.message}`);
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    }, `download_corte_${cutIndex}`, 900000);
  }

  if (!isRealMp4FileComplete(videoDestPath)) {
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
  if (!cleanTitle || /^corte\s*\d+$/i.test(cleanTitle)) {
    if (postText) {
      const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
      if (firstLine && firstLine.length > 3) {
        cleanTitle = firstLine;
      }
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

// Processa o download em lote de todos os cortes de uma sessão (com retry automático)
async function downloadBatch(batch, onCutDownloaded = () => {}) {
  const { requestId, cuts = [] } = batch;
  console.log(`[Downloader] Iniciando download em lote para a sessão ${requestId}: ${cuts.length} cortes.`);
  const downloadedCuts = [];
  const failedCuts = [];

  for (const c of cuts) {
    const videoFileId = c.files?.videoLegenda?.id || c.files?.video?.id;
    const postFileId = c.files?.post?.id;
    const capaFileId = c.files?.capa?.id;
    const formato = c.formato || (c.destino === 'youtube' ? '16:9' : '9:16');

    if (!videoFileId) {
      console.warn(`[Downloader] Corte ${c.index || c.numero} sem ID de arquivo de vídeo, pulando...`);
      continue;
    }

    let downloaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
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
        downloaded = true;
        break;
      } catch (err) {
        console.warn(`[Downloader] Tentativa ${attempt}/3 falhou para Corte ${c.index || c.numero}: ${err.message}`);
        if (attempt < 3) {
          const backoffMs = 10000 * attempt;
          console.log(`[Downloader] Aguardando ${backoffMs / 1000}s antes de retentar Corte ${c.index || c.numero}...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }

    if (!downloaded) {
      console.error(`[Downloader] Corte ${c.index || c.numero} falhou em 3 tentativas. Será retentado na rodada final.`);
      failedCuts.push(c);
    }
  }

  // Rodada final de retry para cortes que falharam em todas as tentativas
  if (failedCuts.length > 0) {
    console.log(`[Downloader] ========================================`);
    console.log(`[Downloader] 🔄 Rodada final de retry: ${failedCuts.length} corte(s) pendente(s)...`);
    console.log(`[Downloader] Aguardando 30s para estabilização da conexão/sessão do Drive...`);
    console.log(`[Downloader] ========================================`);
    await new Promise(r => setTimeout(r, 30000));

    for (const c of failedCuts) {
      const videoFileId = c.files?.videoLegenda?.id || c.files?.video?.id;
      const postFileId = c.files?.post?.id;
      const capaFileId = c.files?.capa?.id;
      const formato = c.formato || (c.destino === 'youtube' ? '16:9' : '9:16');

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
            console.log(`[Downloader Progress] Corte ${c.index}: ${p.status} (retry final)`);
          }
        });
        downloadedCuts.push(info);
        onCutDownloaded(info);
        console.log(`[Downloader] ✅ Corte ${c.index || c.numero} recuperado com sucesso no retry final!`);
      } catch (err) {
        console.error(`[Downloader] ❌ Corte ${c.index || c.numero} falhou DEFINITIVAMENTE após todas as tentativas: ${err.message}`);
      }
    }
  }

  const totalFailed = cuts.length - downloadedCuts.length;
  if (totalFailed > 0) {
    console.warn(`[Downloader] ⚠️ ${totalFailed} de ${cuts.length} cortes não puderam ser baixados nesta sessão.`);
  } else {
    console.log(`[Downloader] ✅ Todos os ${cuts.length} cortes baixados com sucesso!`);
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
    const match = f.name.match(/corte[\s-_]*(\d+)/i);
    if (!match) continue;

    const cutNum = parseInt(match[1], 10);
    const is16x9Format = /16x9|16_9|16-9/i.test(f.name);
    const cutKey = is16x9Format ? `${cutNum}_16x9` : `${cutNum}_9x16`;
    if (!cutsMap.has(cutKey)) {
      cutsMap.set(cutKey, { cutIndex: cutNum, rawName: f.name, formato: is16x9Format ? '16:9' : '9:16' });
    }
    const cut = cutsMap.get(cutKey);

    const isVideoExt = /\.(mp4|mov|mkv|webm)$/i.test(f.name);
    const isSrt = /\.srt$/i.test(f.name);
    const isPost = /\.(txt|json)$/i.test(f.name) && (/post/i.test(f.name) || /descricao/i.test(f.name));
    const isCapa = /\.(jpg|jpeg|png|webp)$/i.test(f.name) && (/capa/i.test(f.name) || /thumb/i.test(f.name));

    if (isVideoExt) {
      if (is16x9Format) {
        cut.video16x9 = { id: f.id, name: f.name };
        cut.videoLegenda = { id: f.id, name: f.name };
        cut.formato = '16:9';
      } else if (/legenda/i.test(f.name)) {
        cut.videoLegenda = { id: f.id, name: f.name };
        cut.formato = '9:16';
      } else {
        cut.rawVideo = { id: f.id, name: f.name };
      }
    } else if (isPost) {
      if (/post_youtube/i.test(f.name) || !cut.post) {
        cut.post = { id: f.id, name: f.name };
      }
    } else if (isCapa) {
      cut.capa = { id: f.id, name: f.name };
    } else if (isSrt) {
      cut.srt = { id: f.id, name: f.name };
    }

    if (!isCapa && !isSrt) {
      if (!cut.titulo || cut.titulo.includes('capa') || cut.titulo.length > 60) {
        const clean = sanitizeCutTitle(f.name);
        if (clean && (!cut.titulo || !cut.titulo.includes('capa') || clean.length < cut.titulo.length)) {
          cut.titulo = clean;
        }
      }
    }
  }

  const validCuts = Array.from(cutsMap.values())
    .map(c => {
      if (!c.videoLegenda && c.video16x9) {
        c.videoLegenda = c.video16x9;
      } else if (!c.videoLegenda && c.rawVideo) {
        c.videoLegenda = c.rawVideo;
      }
      if (!c.titulo || c.titulo.includes('capa')) {
        c.titulo = sanitizeCutTitle(c.rawName) || `Corte ${c.cutIndex}`;
      }
      return c;
    })
    .filter(c => c.videoLegenda && c.videoLegenda.id && /\.(mp4|mov|mkv|webm)$/i.test(c.videoLegenda.name))
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
