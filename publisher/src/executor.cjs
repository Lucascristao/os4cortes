const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');



function buildYouTubeTitle(rawTitle, postText, maxChars = 70) {
  let text = '';
  // Prioriza o título real com acentos da primeira linha do postText se disponível
  if (postText) {
    const firstLine = postText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (firstLine && firstLine.length > 3) {
      text = firstLine;
    }
  }
  if (!text) {
    text = (rawTitle || 'Corte').trim();
  }

  // Remove prefixos numéricos redundantes ("Corte 01:", "01 - ", etc.)
  let s = text.replace(/^(?:corte\s*\d+[\s:_-]*|\d+[\s:._-]*)/i, '').replace(/#shorts/gi, '').replace(/\s+/g, ' ').trim();

  // Se tem separador com convidado ou programa (" | " ou " - ")
  if (s.includes(' | ') || s.includes(' - ')) {
    const separador = s.includes(' | ') ? ' | ' : ' - ';
    const partes = s.split(separador).map(p => p.trim()).filter(Boolean);
    const gancho = partes[0];
    const complemento = partes.slice(1).join(separador);

    // Se o gancho principal já for forte e explicativo (>= 25 caracteres), usamos o gancho direto para máxima viralidade
    if (gancho.length >= 25 && gancho.length <= maxChars) {
      s = gancho;
    } else if (gancho.length + separador.length + complemento.length <= maxChars) {
      s = `${gancho}${separador}${complemento}`;
    } else {
      s = gancho;
    }
  }

  // Se ainda assim passar de maxChars, trunca elegantemente na última palavra completa (nunca corta uma palavra no meio)
  if (s.length > maxChars) {
    const sub = s.slice(0, maxChars);
    const lastSpace = sub.lastIndexOf(' ');
    if (lastSpace > 25) {
      s = sub.slice(0, lastSpace);
    } else {
      s = sub;
    }
  }

  // Limpa pontuações soltas no final
  s = s.replace(/[\s|_:-]+$/, '').trim();
  return s || 'Corte';
}

class QueueExecutor extends EventEmitter {
  constructor(queueInstance) {
    super();
    this.q = queueInstance;
    this.isRunning = false;
    this.isPaused = Boolean(this.q.get('queue_paused', false));
    this.activeJob = null;
    this.timer = null;
    this.nextAvailable = {
      youtube: 0,
      tiktok: 0,
      instagram: 0
    };
  }

  // Enfileira um corte pronto para as redes pendentes
  enqueueCorte({ cutIndex, titulo, videoPath, postPath = null, postText, requestId = 'sessao', folderId = null, driveFileId = null, capaPath = null, formato = null }) {
    console.log(`[Executor] Enfileirando Corte ${cutIndex} para publicação...`);
    const is16x9 = (formato === '16:9') || (videoPath && /_16x9/i.test(videoPath));
    const networks = is16x9 ? ['youtube'] : ['tiktok', 'instagram'];
    const jobIds = [];

    // Proteção contra duplicação: não enfileira redes que já foram concluídas com sucesso para este corte nesta pasta
    const allJobs = this.q.list();
    const alreadyCompletedNets = allJobs.filter(j => {
      if (j.state !== 'completed' || !j.payload) return false;
      const sameCut = j.payload.cutIndex === cutIndex;
      const sameFolder = (folderId && j.payload.folderId === folderId) ||
                         (requestId && j.payload.requestId === requestId) ||
                         (driveFileId && j.payload.driveFileId === driveFileId);
      return sameCut && sameFolder;
    }).map(j => j.payload.network);

    for (const net of networks) {
      if (alreadyCompletedNets.includes(net)) {
        console.log(`[Executor] Corte ${cutIndex} já foi concluído anteriormente no ${net}. Pulando rede.`);
        continue;
      }

      const jobId = `${requestId}_cut${cutIndex}_${net}`;
      const payload = {
        id: jobId,
        network: net,
        account: `@os4.cortes`,
        cutIndex,
        titulo: titulo || `Corte ${cutIndex}`,
        requestId,
        folderId,
        driveFileId,
        videoFileId: `${requestId}_${path.basename(videoPath)}`,
        videoPath,
        postPath: postPath || null,
        postText: postText || titulo || '',
        capaPath: capaPath || null,
        formato: is16x9 ? '16:9' : '9:16',
        enqueuedAt: Date.now()
      };

      try {
        const added = this.q.add(payload);
        if (added) {
          jobIds.push(jobId);
          console.log(`[Executor] Job ${jobId} adicionado à fila (${is16x9 ? 'YouTube 16:9' : 'Vertical 9:16'}).`);
        }
      } catch (err) {
        console.warn(`[Executor] Não foi possível adicionar job ${jobId}: ${err.message}`);
      }
    }

    this.emit('queue-updated', this.getStatus());
    this.ensureWorkerRunning();
    return jobIds;
  }

  ensureWorkerRunning() {
    if (!this.isRunning) {
      this.isRunning = true;
      this.workerLoop().catch(err => {
        console.error('[Executor] Erro fatal no worker:', err);
        this.isRunning = false;
      });
    }
  }

  async workerLoop() {
    console.log('[Executor] Loop do processador de fila iniciado.');

    while (this.isRunning) {
      if (this.isPaused) {
        this.emit('paused', this.getStatus());
        await new Promise(res => setTimeout(res, 2000));
        continue;
      }

      const allJobs = this.q.list();
      const pendingJobs = allJobs.filter(j => j.state === 'queued');

      if (pendingJobs.length === 0) {
        // Nada na fila no momento
        this.emit('idle', this.getStatus());
        await new Promise(res => setTimeout(res, 4000));
        continue;
      }

      // Procura o primeiro job elegível para envio
      const now = Date.now();
      let selectedJob = null;

      for (const job of pendingJobs) {
        const net = job.payload.network;
        const cooldownEnd = this.nextAvailable[net] || 0;
        if (now >= cooldownEnd) {
          selectedJob = job;
          break;
        }
      }

      if (!selectedJob) {
        // Todos os jobs pendentes estão em intervalo seguro
        const earliestTime = Math.min(...pendingJobs.map(j => this.nextAvailable[j.payload.network] || now));
        const waitSec = Math.max(1, Math.ceil((earliestTime - now) / 1000));
        const cooldowns = {
          youtube: Math.max(0, Math.ceil(((this.nextAvailable.youtube || 0) - now) / 1000)),
          tiktok: Math.max(0, Math.ceil(((this.nextAvailable.tiktok || 0) - now) / 1000)),
          instagram: Math.max(0, Math.ceil(((this.nextAvailable.instagram || 0) - now) / 1000))
        };
        this.emit('cooldown', { waitSec, nextAvailable: earliestTime, cooldowns, status: this.getStatus() });
        console.log(`[Executor] Intervalo de segurança ativo. Próxima postagem liberada em ${waitSec}s (YT: ${cooldowns.youtube}s, TT: ${cooldowns.tiktok}s, IG: ${cooldowns.instagram}s)...`);
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }

      // Executa o job selecionado
      await this.processJob(selectedJob);
      // Pequeno respiro técnico (2s) para fechamento de processos do navegador
      await new Promise(res => setTimeout(res, 2000));
    }
  }

  async processJob(job) {
    const p = job.payload;
    const net = p.network;
    this.activeJob = job;
    const jobStartTime = Date.now();
    console.log('====================================================');
    console.log(`[Executor] PROCESSANDO POSTAGEM: Corte ${p.cutIndex} no ${net.toUpperCase()}`);
    console.log('====================================================');

    // Validacao estrita de integridade do video antes de abrir navegador
    let isFileReady = false;
    if (p.videoPath && fs.existsSync(p.videoPath)) {
      try {
        const { execSync } = require('child_process');
        const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p.videoPath}"`, { timeout: 10000 }).toString().trim();
        const dur = parseFloat(out);
        if (!isNaN(dur) && dur > 5) {
          isFileReady = true;
        }
      } catch (_) {}
    }

    if (!isFileReady) {
      const currentSizeMb = (p.videoPath && fs.existsSync(p.videoPath)) ? (fs.statSync(p.videoPath).size / 1024 / 1024).toFixed(1) : '0';
      console.warn(`[Executor] ⏳ Video do Corte ${p.cutIndex} (${net}) ainda nao esta completo no disco (${currentSizeMb} MB). Aguardando conclusao do download...`);
      this.nextAvailable[net] = Date.now() + 30000;
      this.q.status(job.id, 'queued', `Aguardando download completo (${currentSizeMb} MB no disco)...`);
      this.emit('job-updated', { job, status: this.getStatus() });
      this.activeJob = null;
      return;
    }

    this.q.status(job.id, 'publishing', `Iniciando envio para ${net}`);
    this.emit('job-started', { job, status: this.getStatus() });

    let result = null;
    let error = null;

    try {
      let effectiveText = p.postText || '';
      let effectiveTitle = p.titulo || '';

      if (p.postPath && fs.existsSync(p.postPath)) {
        try {
          const fileContent = fs.readFileSync(p.postPath, 'utf8').trim();
          if (fileContent.length > effectiveText.length) {
            effectiveText = fileContent;
          }
          const firstLine = fileContent.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
          // A primeira linha do post.txt é a autoridade máxima do título (tem todos os acentos e redação correta)
          if (firstLine && firstLine.length > 3) {
            effectiveTitle = firstLine;
          }
        } catch (_) {}
      } else if (effectiveText) {
        const firstLine = effectiveText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
        if (firstLine && firstLine.length > 3) {
          effectiveTitle = firstLine;
        }
      }

      if (net === 'youtube') {
        effectiveTitle = buildYouTubeTitle(effectiveTitle, effectiveText, 70);
      }

      const runWithTimeout = (promise, ms, desc) => {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Timeout de segurança (${Math.round(ms / 1000)}s) excedido na postagem (${desc})`));
          }, ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
      };

      if (net === 'youtube') {
        const { publishYouTubeVideo } = require('./adapters/youtube.cjs');
        const ytTitle = buildYouTubeTitle(effectiveTitle, effectiveText);
        // Tenta resolver capaPath caso não tenha vindo explicitamente mas exista arquivo _capa.jpg
        let ytThumbnail = p.capaPath || null;
        if (!ytThumbnail && p.videoPath) {
          const possibleThumb = p.videoPath.replace(/(\.mp4|_16x9\.mp4|_legenda\.mp4)$/i, '_capa.jpg');
          if (fs.existsSync(possibleThumb)) {
            ytThumbnail = possibleThumb;
          }
        }

        result = await runWithTimeout(
          publishYouTubeVideo({
            videoPath: p.videoPath,
            title: ytTitle,
            description: effectiveText || effectiveTitle,
            thumbnailPath: ytThumbnail
          }),
          600000,
          `YouTube Corte ${p.cutIndex}`
        );
      } else if (net === 'tiktok') {
        const { publishTikTok } = require('./adapters/tiktok.cjs');
        result = await runWithTimeout(
          publishTikTok({
            videoPath: p.videoPath,
            caption: effectiveText || effectiveTitle
          }),
          300000,
          `TikTok Corte ${p.cutIndex}`
        );
      } else if (net === 'instagram') {
        const { publishInstagramReels } = require('./adapters/instagram.cjs');
        result = await runWithTimeout(
          publishInstagramReels({
            videoPath: p.videoPath,
            caption: effectiveText || effectiveTitle
          }),
          300000,
          `Instagram Corte ${p.cutIndex}`
        );
      } else {
        throw new Error(`Rede desconhecida: ${net}`);
      }
    } catch (err) {
      error = err.message;
      console.error(`[Executor] Falha na postagem do Corte ${p.cutIndex} no ${net}:`, err);
    }

    const finishTime = Date.now();
    const elapsedSec = (finishTime - jobStartTime) / 1000;

    if (result && result.ok) {
      // Intervalo seguro calibrado de 3 a 5 minutos (180 a 300 segundos) para a MESMA rede
      // Desconta o tempo já gasto no upload/processamento, garantindo pausa mínima de 30s pós-upload
      const targetIntervalSec = crypto.randomInt(180, 301);
      const delaySec = Math.max(30, Math.round(targetIntervalSec - elapsedSec));
      this.nextAvailable[net] = finishTime + (delaySec * 1000);

      const detail = `Publicado com sucesso em ${result.uploadSeconds || result.totalSeconds || Math.round(elapsedSec)}s. Próximo corte no ${net} em ${delaySec}s`;
      this.q.status(job.id, 'completed', detail);
      this.emit('job-completed', { job, result, nextInSeconds: delaySec, status: this.getStatus() });
      console.log(`[Executor] ✅ Job ${job.id} CONCLUÍDO! Pausa de ${delaySec}s aplicada na rede ${net} (ciclo total: ${Math.round(elapsedSec + delaySec)}s).`);

      // Auto-exclusão segura (Opção 1): após 2 minutos da conclusão de todas as tarefas deste corte
      try {
        const allJobs = this.q.list();
        const cutJobs = allJobs.filter(j => {
          if (!j.payload) return false;
          const sameFolder = (j.id && p.id && j.id.split('_cut')[0] === p.id.split('_cut')[0]) ||
                             (j.payload.requestId && j.payload.requestId === p.requestId);
          return sameFolder && j.payload.cutIndex === p.cutIndex;
        });
        const allCutDone = cutJobs.length > 0 && cutJobs.every(j => j.state === 'completed');

        if (allCutDone) {
          console.log(`[Auto-Cleanup] 🎯 Corte ${p.cutIndex} concluído com sucesso em todas as suas redes (${cutJobs.length} rede(s))!`);
          console.log(`[Auto-Cleanup] Agendando exclusão segura dos arquivos do PC em 2 minutos (120s)...`);

          setTimeout(() => {
            try {
              if (p.videoPath && fs.existsSync(p.videoPath)) {
                fs.unlinkSync(p.videoPath);
                console.log(`[Auto-Cleanup] Vídeo do Corte ${p.cutIndex} excluído do PC: ${p.videoPath}`);
              }
              if (p.postPath && fs.existsSync(p.postPath)) {
                fs.unlinkSync(p.postPath);
                console.log(`[Auto-Cleanup] Post do Corte ${p.cutIndex} excluído do PC: ${p.postPath}`);
              }
              if (p.capaPath && fs.existsSync(p.capaPath)) {
                fs.unlinkSync(p.capaPath);
                console.log(`[Auto-Cleanup] Capa do Corte ${p.cutIndex} excluída do PC: ${p.capaPath}`);
              }
              console.log(`[Auto-Cleanup] ✅ Corte ${p.cutIndex}: espaço em disco liberado! (Originais mantidos no Drive)`);
            } catch (errDel) {
              console.warn(`[Auto-Cleanup] Aviso ao excluir arquivos do corte ${p.cutIndex}: ${errDel.message}`);
            }
          }, 120000);
        }
      } catch (errCheck) {
        console.warn(`[Auto-Cleanup] Erro na verificação: ${errCheck.message}`);
      }
    } else {
      // Em caso de falha: recuperação rápida de 30 a 60s em vez de travar por 10 minutos
      const failDelaySec = crypto.randomInt(30, 61);
      this.nextAvailable[net] = finishTime + (failDelaySec * 1000);

      const detail = `Falha: ${error || 'Erro desconhecido'}. Tentativa reagendada para ${failDelaySec}s`;
      this.q.status(job.id, 'failed', detail);
      this.emit('job-failed', { job, error, nextInSeconds: failDelaySec, status: this.getStatus() });
      console.log(`[Executor] ❌ Job ${job.id} FALHOU. Pausa de recuperação rápida de ${failDelaySec}s aplicada na rede ${net}.`);
    }

    this.activeJob = null;
  }

  pause() {
    this.isPaused = true;
    this.q.set('queue_paused', true);
    console.log('[Executor] ⏸️ Fila de publicações PAUSADA pelo usuário.');
    this.emit('queue-paused', this.getStatus());
    this.emit('queue-updated', this.getStatus());
    return true;
  }

  resume() {
    this.isPaused = false;
    this.q.set('queue_paused', false);
    console.log('[Executor] ▶️ Fila de publicações RETOMADA pelo usuário.');
    this.ensureWorkerRunning();
    this.emit('queue-resumed', this.getStatus());
    this.emit('queue-updated', this.getStatus());
    return true;
  }

  retryJob(id) {
    console.log(`[Executor] 🔄 Reenfileirando job ${id}...`);
    const job = this.q.list().find(j => j.id === id);
    if (job && job.payload && job.payload.network) {
      this.nextAvailable[job.payload.network] = 0; // Libera a rede imediatamente para nova tentativa
    }
    this.q.retry(id);
    this.emit('queue-updated', this.getStatus());
    this.ensureWorkerRunning();
    return true;
  }

  retryAllFailed() {
    console.log('[Executor] 🔄 Reenfileirando todos os jobs com falha...');
    this.nextAvailable = { youtube: 0, tiktok: 0, instagram: 0 }; // Libera todas as redes para reprocessamento
    const count = this.q.retryAllFailed();
    this.emit('queue-updated', this.getStatus());
    this.ensureWorkerRunning();
    return count;
  }

  deleteJob(id) {
    console.log(`[Executor] 🗑️ Excluindo job ${id}...`);
    this.q.delete(id);
    this.emit('queue-updated', this.getStatus());
    return true;
  }

  getStatus() {
    const list = this.q.list();
    const completedToday = this.q.completedTodayCount ? this.q.completedTodayCount() : 0;
    const todayIds = this.q.completedTodayJobIds ? this.q.completedTodayJobIds() : new Set();
    const now = Date.now();
    return {
      isPaused: this.isPaused,
      activeJob: this.activeJob ? {
        id: this.activeJob.id,
        network: this.activeJob.payload.network,
        cutIndex: this.activeJob.payload.cutIndex,
        titulo: this.activeJob.payload.titulo
      } : null,
      counts: {
        total: list.length,
        queued: list.filter(j => j.state === 'queued').length,
        publishing: list.filter(j => j.state === 'publishing').length,
        completed: list.filter(j => j.state === 'completed').length,
        completedToday,
        failed: list.filter(j => j.state === 'failed').length
      },
      nextAvailable: this.nextAvailable,
      cooldowns: {
        youtube: Math.max(0, Math.ceil(((this.nextAvailable.youtube || 0) - now) / 1000)),
        tiktok: Math.max(0, Math.ceil(((this.nextAvailable.tiktok || 0) - now) / 1000)),
        instagram: Math.max(0, Math.ceil(((this.nextAvailable.instagram || 0) - now) / 1000))
      },
      jobs: list.map(j => ({
        id: j.id,
        state: j.state,
        network: j.payload.network,
        cutIndex: j.payload.cutIndex,
        titulo: j.payload.titulo,
        evidence: j.evidence,
        created: j.created,
        completedToday: todayIds.has(j.id)
      }))
    };
  }

  stop() {
    this.isRunning = false;
  }
}

module.exports = { QueueExecutor };
