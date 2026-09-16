const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const { publishYouTubeShorts } = require('./adapters/youtube.cjs');
const { publishTikTok } = require('./adapters/tiktok.cjs');
const { publishInstagramReels } = require('./adapters/instagram.cjs');

class QueueExecutor extends EventEmitter {
  constructor(queueInstance) {
    super();
    this.q = queueInstance;
    this.isRunning = false;
    this.activeJob = null;
    this.timer = null;
    this.nextAvailable = {
      youtube: 0,
      tiktok: 0,
      instagram: 0
    };
  }

  // Enfileira um corte pronto para as 3 redes
  enqueueCorte({ cutIndex, titulo, videoPath, postText, requestId = 'sessao' }) {
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
        videoFileId: path.basename(videoPath),
        videoPath,
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
        // Todos os jobs pendentes estão em intervalo seguro (5-10 min)
        const earliestTime = Math.min(...pendingJobs.map(j => this.nextAvailable[j.payload.network] || now));
        const waitSec = Math.max(1, Math.ceil((earliestTime - now) / 1000));
        this.emit('cooldown', { waitSec, nextAvailable: earliestTime, status: this.getStatus() });
        console.log(`[Executor] Intervalo de segurança ativo. Próxima postagem liberada em ${waitSec}s...`);
        await new Promise(res => setTimeout(res, 5000));
        continue;
      }

      // Executa o job selecionado
      await this.processJob(selectedJob);
    }
  }

  async processJob(job) {
    const p = job.payload;
    const net = p.network;
    this.activeJob = job;
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
        const ytTitle = (effectiveTitle.toLowerCase().includes('#shorts') ? effectiveTitle : `${effectiveTitle} #shorts`).slice(0, 95);
        result = await publishYouTubeShorts({
          videoPath: p.videoPath,
          title: ytTitle,
          description: effectiveText || effectiveTitle
        });
      } else if (net === 'tiktok') {
        result = await publishTikTok({
          videoPath: p.videoPath,
          caption: effectiveText || effectiveTitle
        });
      } else if (net === 'instagram') {
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

    const now = Date.now();
    // Aplica o intervalo de segurança aleatório de 5 a 10 minutos (300 a 600 segundos)
    const delaySec = crypto.randomInt(300, 601);
    this.nextAvailable[net] = now + (delaySec * 1000);

    if (result && result.ok) {
      const detail = `Publicado com sucesso em ${result.uploadSeconds || result.totalSeconds}s. Próximo permitido após ${delaySec}s`;
      this.q.status(job.id, 'completed', detail);
      this.emit('job-completed', { job, result, nextInSeconds: delaySec, status: this.getStatus() });
      console.log(`[Executor] ✅ Job ${job.id} CONCLUÍDO! Pausa de ${delaySec}s aplicada na rede ${net}.`);

      // Auto-exclusão segura (Opção 1): após 2 minutos da conclusão nas 3 redes
      try {
        const allJobs = this.q.list();
        const cutJobs = allJobs.filter(j => j.payload && j.payload.cutIndex === p.cutIndex);
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
      const detail = `Falha: ${error || 'Erro desconhecido'}. Tentativa reagendada para ${delaySec}s`;
      this.q.status(job.id, 'failed', detail);
      this.emit('job-failed', { job, error, nextInSeconds: delaySec, status: this.getStatus() });
      console.log(`[Executor] ❌ Job ${job.id} FALHOU. Pausa de ${delaySec}s aplicada.`);
    }

    this.activeJob = null;
  }

  getStatus() {
    const list = this.q.list();
    return {
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
        failed: list.filter(j => j.state === 'failed').length
      },
      nextAvailable: this.nextAvailable,
      jobs: list.map(j => ({
        id: j.id,
        state: j.state,
        network: j.payload.network,
        cutIndex: j.payload.cutIndex,
        titulo: j.payload.titulo,
        evidence: j.evidence,
        created: j.created
      }))
    };
  }

  stop() {
    this.isRunning = false;
  }
}

module.exports = { QueueExecutor };
