const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');



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

  // Enfileira um corte pronto para as 3 redes
  enqueueCorte({ cutIndex, titulo, videoPath, postPath = null, postText, requestId = 'sessao', folderId = null, driveFileId = null }) {
    console.log(`[Executor] Enfileirando Corte ${cutIndex} para publicação...`);
    const networks = ['youtube', 'tiktok', 'instagram'];
    const jobIds = [];

    for (const net of networks) {
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
        enqueuedAt: Date.now()
      };

      try {
        const added = this.q.add(payload);
        if (added) {
          jobIds.push(jobId);
          console.log(`[Executor] Job ${jobId} adicionado à fila.`);
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

    this.q.status(job.id, 'publishing', `Iniciando envio para ${net}`);
    this.emit('job-started', { job, status: this.getStatus() });

    let result = null;
    let error = null;

    try {
      let effectiveText = p.postText || '';
      let effectiveTitle = p.titulo || '';

      if (p.postPath && fs.existsSync(p.postPath)) {
        try {
          effectiveText = fs.readFileSync(p.postPath, 'utf8').trim();
          const firstLine = effectiveText.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
          if (firstLine && firstLine.length > 3) {
            effectiveTitle = firstLine;
          }
        } catch (_) {}
      }

      if (net === 'youtube') {
        const { publishYouTubeShorts } = require('./adapters/youtube.cjs');
        const ytTitle = (effectiveTitle.toLowerCase().includes('#shorts') ? effectiveTitle : `${effectiveTitle} #shorts`).slice(0, 95);
        result = await publishYouTubeShorts({
          videoPath: p.videoPath,
          title: ytTitle,
          description: effectiveText || effectiveTitle
        });
      } else if (net === 'tiktok') {
        const { publishTikTok } = require('./adapters/tiktok.cjs');
        result = await publishTikTok({
          videoPath: p.videoPath,
          caption: effectiveText || effectiveTitle
        });
      } else if (net === 'instagram') {
        const { publishInstagramReels } = require('./adapters/instagram.cjs');
        result = await publishInstagramReels({
          videoPath: p.videoPath,
          caption: effectiveText || effectiveTitle
        });
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

      // Auto-exclusão segura (Opção 1): após 2 minutos da conclusão nas 3 redes
      try {
        const allJobs = this.q.list();
        const cutJobs = allJobs.filter(j => {
          if (!j.payload) return false;
          const sameFolder = (j.id && p.id && j.id.split('_cut')[0] === p.id.split('_cut')[0]) ||
                             (j.payload.requestId && j.payload.requestId === p.requestId);
          return sameFolder && j.payload.cutIndex === p.cutIndex;
        });
        const allThreeDone = cutJobs.length >= 3 && cutJobs.every(j => j.state === 'completed');

        if (allThreeDone) {
          console.log(`[Auto-Cleanup] 🎯 Corte ${p.cutIndex} concluído com sucesso nas 3 redes!`);
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
