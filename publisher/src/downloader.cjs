const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

const dataDir = path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
const downloadsBaseDir = path.join(dataDir, 'downloads');
const chromePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const googleProfileDir = path.join(dataDir, 'profiles', 'youtube');

// Função auxiliar para download direto HTTP se o arquivo for público
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
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(true);
      });
      fileStream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timeout no download direto'));
    });
  });
}

// Download autenticado pelo Google Drive usando a sessão Google já conectada
async function downloadGoogleDriveFileWithContext(ctx, fileId, destPath) {
  const downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
  console.log(`[Downloader] Acessando link do Drive: ${downloadUrl}`);

  // Método 1: Download direto via request autenticado (super rápido e silencioso)
  try {
    const res = await ctx.request.get(downloadUrl, { maxRedirects: 10, timeout: 300000 });
    const cType = res.headers()['content-type'] || '';
    if (res.ok() && (cType.includes('video') || cType.includes('octet-stream'))) {
      const buffer = await res.body();
      if (buffer && buffer.length > 500000) { // Maior que 500KB (garante que não é página de erro)
        fs.writeFileSync(destPath, buffer);
        console.log(`[Downloader] Download direto concluído: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB.`);
        return true;
      }
    }
    
    // Se recebeu HTML, pode ser a página de aviso de vírus para arquivos muito grandes
    const bodyText = await res.text().catch(() => '');
    const confirmMatch = bodyText.match(/href="([^"]+confirm=[^"]+)"/) || bodyText.match(/action="([^"]+)"/);
    if (confirmMatch && confirmMatch[1]) {
      let confirmUrl = confirmMatch[1].replace(/&amp;/g, '&');
      if (confirmUrl.startsWith('/')) confirmUrl = `https://drive.google.com${confirmUrl}`;
      console.log(`[Downloader] Confirmando download de arquivo grande: ${confirmUrl}`);
      const resConfirm = await ctx.request.get(confirmUrl, { maxRedirects: 10, timeout: 300000 });
      if (resConfirm.ok()) {
        const buf = await resConfirm.body();
        fs.writeFileSync(destPath, buf);
        return true;
      }
    }
  } catch (errReq) {
    console.warn(`[Downloader] Tentativa de streaming direto gerou aviso: ${errReq.message}. Tentando via browser...`);
  }

  // Método 2: Fallback via navegação no navegador se necessário
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  try {
    await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    const confirmBtn = page.locator('#uc-download-link, a:has-text("Fazer download mesmo assim"), button:has-text("Fazer download mesmo assim"), a[href*="confirm="]').first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('[Downloader] Clicando em "Fazer download mesmo assim"...');
      const dlPromise = page.waitForEvent('download', { timeout: 120000 });
      await confirmBtn.click();
      const dl = await dlPromise;
      await dl.saveAs(destPath);
      return true;
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// Baixa um arquivo de texto (.txt de post) de forma autenticada via Playwright request
async function downloadTextFileWithContext(ctx, fileId) {
  if (!fileId) return '';
  try {
    const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
    const res = await ctx.request.get(directUrl);
    if (res.ok()) {
      const text = await res.text();
      if (text && !text.includes('<!DOCTYPE html>') && !text.includes('<!doctype html>') && !text.includes('accounts.google.com')) {
        return text.trim();
      }
    }
  } catch (err) {
    console.warn(`[Downloader] Falha ao obter texto autenticado do post: ${err.message}`);
  }
  return '';
}

// Função principal: baixa um corte completo (.mp4 + .txt) e mede tempo e velocidade
async function downloadCorte({ cutIndex, titulo, videoFileId, postFileId, requestId = 'default', onProgress = () => {} }) {
  const destDir = path.join(downloadsBaseDir, requestId);
  fs.mkdirSync(destDir, { recursive: true });

  const safeTitle = (titulo || `corte_${cutIndex}`).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
  const videoFileName = `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_legenda.mp4`;
  const postFileName = `corte_${String(cutIndex).padStart(2, '0')}_${safeTitle}_post.txt`;
  const videoDestPath = path.join(destDir, videoFileName);
  const postDestPath = path.join(destDir, postFileName);

  onProgress({ status: 'starting', cutIndex, titulo });

  let postText = '';
  if (fs.existsSync(postDestPath)) {
    try {
      postText = fs.readFileSync(postDestPath, 'utf8');
    } catch (_) {}
  }

  // Se o vídeo e o texto já existem no disco, não gasta banda nem tempo
  if (fs.existsSync(videoDestPath) && fs.statSync(videoDestPath).size > 500000 && postText) {
    const stats = fs.statSync(videoDestPath);
    const sizeMb = Number((stats.size / (1024 * 1024)).toFixed(1));
    console.log(`[Downloader] Corte ${cutIndex} já existe localmente em ${videoDestPath} (${sizeMb} MB). Reutilizando.`);
    let cleanTitle = titulo;
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) cleanTitle = firstLine;

    const result = {
      cutIndex,
      titulo: cleanTitle,
      videoPath: videoDestPath,
      postPath: postDestPath,
      postText,
      sizeMb,
      durationSec: 0,
      speedMbPerSec: 0
    };
    onProgress({ status: 'completed', ...result });
    return result;
  }

  console.log(`[Downloader] Iniciando sessão para o Corte ${cutIndex}...`);
  const ctx = await chromium.launchPersistentContext(googleProfileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled']
  });

  const t0 = Date.now();
  try {
    // 1. Download do Texto de Post
    if (postFileId) {
      console.log(`[Downloader] Baixando texto do post para o Corte ${cutIndex}...`);
      postText = await downloadTextFileWithContext(ctx, postFileId);
      if (postText) {
        fs.writeFileSync(postDestPath, postText, 'utf8');
        console.log(`[Downloader] Texto do post salvo (${postText.length} caracteres).`);
      }
    }

    // 2. Download do Vídeo com cronometragem
    console.log(`[Downloader] Iniciando download do vídeo do Corte ${cutIndex} (ID: ${videoFileId})...`);
    await downloadGoogleDriveFileWithContext(ctx, videoFileId, videoDestPath);
  } catch (errAuth) {
    console.warn(`[Downloader] Tentativa autenticada falhou (${errAuth.message}), tentando download direto...`);
    const directUrl = `https://drive.google.com/uc?id=${videoFileId}&export=download`;
    await downloadDirectHttp(directUrl, videoDestPath);
  } finally {
    await ctx.close().catch(() => {});
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

  let cleanTitle = titulo;
  if (postText) {
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) {
      cleanTitle = firstLine;
    }
  }

  const result = {
    cutIndex,
    titulo: cleanTitle,
    videoPath: videoDestPath,
    postPath: postDestPath,
    postText,
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

  const ctx = await chromium.launchPersistentContext(googleProfileDir, {
    executablePath: chromePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await ctx.newPage();
  const allFound = new Map();

  try {
    await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    for (let scrollStep = 0; scrollStep < 15; scrollStep++) {
      const items = await page.evaluate(() => {
        const allWithId = Array.from(document.querySelectorAll('[data-id]'));
        const list = [];
        for (const el of allWithId) {
          const id = el.getAttribute('data-id');
          const text = (el.innerText || el.textContent || '').trim();
          const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
          if (id && lines.length > 0) {
            const fileNameCandidate = lines.find(l => l.includes('corte_') || l.includes('.') || l.endsWith('.mp4') || l.endsWith('.txt') || l.endsWith('.srt') || l.endsWith('.json')) || lines[0];
            list.push({ id, name: fileNameCandidate });
          }
        }
        return list;
      });

      for (const item of items) {
        if (!allFound.has(item.id)) {
          allFound.set(item.id, item.name);
        }
      }

      await page.keyboard.press('PageDown');
      await page.waitForTimeout(600);
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const files = Array.from(allFound.entries()).map(([id, name]) => ({ id, name }));
  const cutsMap = new Map();

  for (const f of files) {
    const match = f.name.match(/corte_(\d+)/i);
    if (!match) continue;

    const cutNum = parseInt(match[1], 10);
    if (!cutsMap.has(cutNum)) {
      cutsMap.set(cutNum, { cutIndex: cutNum, rawName: f.name });
    }
    const cut = cutsMap.get(cutNum);

    if (f.name.endsWith('_legenda.mp4')) {
      cut.videoLegenda = { id: f.id, name: f.name };
    } else if (f.name.endsWith('_post.txt')) {
      cut.post = { id: f.id, name: f.name };
    } else if (f.name.endsWith('.srt')) {
      cut.srt = { id: f.id, name: f.name };
    } else if (f.name.endsWith('.mp4') && !f.name.endsWith('_legenda.mp4')) {
      cut.rawVideo = { id: f.id, name: f.name };
    }

    if (!cut.titulo) {
      const clean = f.name
        .replace(/^corte_\d+_/i, '')
        .replace(/(_legenda\.mp4|_post\.txt|\.mp4|\.srt)$/i, '')
        .replace(/_/g, ' ')
        .trim();
      if (clean) cut.titulo = clean;
    }
  }

  const validCuts = Array.from(cutsMap.values())
    .filter(c => c.videoLegenda && c.videoLegenda.id)
    .sort((a, b) => a.cutIndex - b.cutIndex);

  onLog(`[Drive Scan] ${validCuts.length} cortes com vídeo legendado identificados na pasta.`);
  return { folderId, cuts: validCuts };
}

async function importAndEnqueueDriveFolder({ folderUrlOrId, executor, onLog = console.log, onProgress = () => {} }) {
  onLog(`[Drive Import] Iniciando escaneamento da pasta do Google Drive...`);
  const { folderId, cuts } = await scanDriveFolder(folderUrlOrId, onLog);

  if (cuts.length === 0) {
    onLog(`[Drive Import] Nenhum corte com arquivo *_legenda.mp4 encontrado nesta pasta.`);
    return { ok: false, message: 'Nenhum corte com legenda encontrado na pasta.' };
  }

  onLog(`[Drive Import] ${cuts.length} cortes identificados na pasta. Verificando histórico...`);
  
  const existingJobs = executor.q.list();
  const requestId = `drive_${folderId.slice(0, 12)}`;
  let enqueuedCount = 0;
  let skippedCount = 0;

  for (const cut of cuts) {
    const cutJobs = existingJobs.filter(j => j.payload && j.payload.cutIndex === cut.cutIndex);
    const completedJobs = cutJobs.filter(j => j.state === 'completed');
    
    if (completedJobs.length >= 3) {
      onLog(`[Drive Import] ⏭️ Corte ${cut.cutIndex} já foi publicado nas 3 redes. Pulando.`);
      skippedCount++;
      continue;
    }

    onLog(`[Drive Import] ⬇️ Preparando Corte ${cut.cutIndex}: "${cut.titulo}" (apenas _legenda.mp4 e _post.txt)...`);
    
    try {
      const downloaded = await downloadCorte({
        cutIndex: cut.cutIndex,
        titulo: cut.titulo,
        videoFileId: cut.videoLegenda.id,
        postFileId: cut.post?.id,
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
        requestId
      });

      enqueuedCount++;
      onLog(`[Drive Import] ✅ Corte ${cut.cutIndex} adicionado à fila de postagens (${jobIds.length} tarefas criadas).`);
    } catch (err) {
      onLog(`[Drive Import] ❌ Erro ao baixar Corte ${cut.cutIndex}: ${err.message}`);
    }
  }

  onLog(`[Drive Import] Fila atualizada: ${enqueuedCount} cortes adicionados (${skippedCount} já publicados anteriormente).`);
  return { ok: true, enqueuedCount, skippedCount, totalCuts: cuts.length };
}

module.exports = {
  downloadCorte,
  downloadBatch,
  downloadGoogleDriveFileWithContext,
  extractDriveFolderId,
  scanDriveFolder,
  importAndEnqueueDriveFolder
};

