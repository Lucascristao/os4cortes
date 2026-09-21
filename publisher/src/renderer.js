const message = document.querySelector('#message');
const logBox = document.querySelector('#log-box');
const queueList = document.querySelector('#queue-list');
const cooldownBanner = document.querySelector('#cooldown-banner');
const cooldownText = document.querySelector('#cooldown-text');
const pauseBanner = document.querySelector('#pause-banner');
const queueCounter = document.querySelector('#queue-counter');
const btnTogglePause = document.querySelector('#btn-toggle-pause');
const btnRetryAll = document.querySelector('#btn-retry-all');
const tabFailedCount = document.querySelector('#tab-failed-count');

// Estatísticas
const statQueued = document.querySelector('#stat-queued');
const statPub = document.querySelector('#stat-pub');
const statDone = document.querySelector('#stat-done');
const statFail = document.querySelector('#stat-fail');

// Modal de Erro
const errorModal = document.querySelector('#error-modal');
const modalClose = document.querySelector('#modal-close');
const modalErrorTitle = document.querySelector('#modal-error-title');
const modalErrorJob = document.querySelector('#modal-error-job');
const modalErrorText = document.querySelector('#modal-error-text');
const modalBtnRetry = document.querySelector('#modal-btn-retry');
const modalBtnDelete = document.querySelector('#modal-btn-delete');

// Chips de Cooldown por Rede
const chipYoutube = document.querySelector('#chip-youtube');
const timerYoutube = document.querySelector('#timer-youtube');
const chipTiktok = document.querySelector('#chip-tiktok');
const timerTiktok = document.querySelector('#timer-tiktok');
const chipInstagram = document.querySelector('#chip-instagram');
const timerInstagram = document.querySelector('#timer-instagram');

let cooldownTimer = null;
let currentNextAvailable = { youtube: 0, tiktok: 0, instagram: 0 };
let currentQueueStatus = null;
let activeFilter = 'all';
let currentModalJobId = null;

function cleanAnsi(str) {
  return (str || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function appendLog(text) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${new Date().toLocaleTimeString('pt-BR')}] ${text}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

document.querySelector('#clear-logs')?.addEventListener('click', () => {
  logBox.innerHTML = '';
});

// Listener de logs da ponte
if (window.os4?.onLog) {
  window.os4.onLog((data) => {
    appendLog(typeof data === 'string' ? data : data.msg);
    updateQueueUi();
  });
}

// Listener de status da fila
if (window.os4?.onQueueStatus) {
  window.os4.onQueueStatus((status) => {
    renderQueue(status);
  });
}

function formatCooldown(sec) {
  const min = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${min}:${s}`;
}

function updateNetworkChip(chipEl, timerEl, remainingSec) {
  if (!chipEl || !timerEl) return;
  if (remainingSec > 0) {
    chipEl.className = 'net-chip is-cooling';
    timerEl.textContent = formatCooldown(remainingSec);
  } else {
    chipEl.className = 'net-chip is-ready';
    timerEl.textContent = 'Pronto ✓';
  }
}

function updateCooldownDisplay() {
  const now = Date.now();
  const ytSec = Math.max(0, Math.ceil(((currentNextAvailable.youtube || 0) - now) / 1000));
  const ttSec = Math.max(0, Math.ceil(((currentNextAvailable.tiktok || 0) - now) / 1000));
  const igSec = Math.max(0, Math.ceil(((currentNextAvailable.instagram || 0) - now) / 1000));

  updateNetworkChip(chipYoutube, timerYoutube, ytSec);
  updateNetworkChip(chipTiktok, timerTiktok, ttSec);
  updateNetworkChip(chipInstagram, timerInstagram, igSec);

  const anyCooling = ytSec > 0 || ttSec > 0 || igSec > 0;
  if (anyCooling) {
    cooldownBanner.classList.remove('hidden');
    cooldownText.textContent = 'Intervalo inteligente ativo (3 a 5 min entre cortes do mesmo canal).';
  } else {
    cooldownBanner.classList.add('hidden');
  }
}

function syncCooldowns(nextAvailable) {
  if (!nextAvailable) return;
  currentNextAvailable = { ...nextAvailable };
  if (!cooldownTimer) {
    cooldownTimer = setInterval(updateCooldownDisplay, 1000);
  }
  updateCooldownDisplay();
}

// Listener de cooldown
if (window.os4?.onCooldown) {
  window.os4.onCooldown((data) => {
    if (data.status?.nextAvailable) {
      syncCooldowns(data.status.nextAvailable);
    } else if (data.nextAvailable) {
      syncCooldowns(data.nextAvailable);
    }
    if (data.status) renderQueue(data.status);
  });
}

// Controle de Pausa da Fila
if (btnTogglePause) {
  btnTogglePause.addEventListener('click', async () => {
    if (!currentQueueStatus) return;
    const isPaused = Boolean(currentQueueStatus.isPaused);
    btnTogglePause.disabled = true;
    try {
      if (isPaused) {
        await window.os4.resumeQueue();
        appendLog('[Fila] Processamento retomado pelo usuário.');
      } else {
        await window.os4.pauseQueue();
        appendLog('[Fila] Processamento pausado pelo usuário.');
      }
      await updateQueueUi();
    } catch (err) {
      appendLog(`[Fila Erro] Falha ao alternar pausa: ${err.message}`);
    } finally {
      btnTogglePause.disabled = false;
    }
  });
}

// Reprocessar Todas as Falhas
if (btnRetryAll) {
  btnRetryAll.addEventListener('click', async () => {
    btnRetryAll.disabled = true;
    try {
      const count = await window.os4.retryAllFailed();
      appendLog(`[Fila] ${count} publicações com falha reenfileiradas.`);
      await updateQueueUi();
    } catch (err) {
      appendLog(`[Fila Erro] Falha ao reprocessar falhas: ${err.message}`);
    } finally {
      btnRetryAll.disabled = false;
    }
  });
}

// Modal de Erro
function openErrorModal(job) {
  currentModalJobId = job.id;
  modalErrorTitle.textContent = `Motivo da Falha · Corte ${job.cutIndex}`;
  modalErrorJob.textContent = `Rede: ${job.network.toUpperCase()} · Título: ${job.titulo}`;
  modalErrorText.textContent = cleanAnsi(job.evidence) || 'Nenhum detalhe técnico registrado para esta falha.';
  errorModal.classList.remove('hidden');
}

function closeErrorModal() {
  currentModalJobId = null;
  errorModal.classList.add('hidden');
}

if (modalClose) modalClose.addEventListener('click', closeErrorModal);
if (errorModal) {
  errorModal.addEventListener('click', (e) => {
    if (e.target === errorModal) closeErrorModal();
  });
}

if (modalBtnRetry) {
  modalBtnRetry.addEventListener('click', async () => {
    if (!currentModalJobId) return;
    modalBtnRetry.disabled = true;
    try {
      await window.os4.retryJob(currentModalJobId);
      appendLog(`[Fila] Corte reenfileirado manualmente.`);
      closeErrorModal();
      await updateQueueUi();
    } catch (err) {
      alert(`Erro ao reenfileirar: ${err.message}`);
    } finally {
      modalBtnRetry.disabled = false;
    }
  });
}

if (modalBtnDelete) {
  modalBtnDelete.addEventListener('click', async () => {
    if (!currentModalJobId) return;
    if (!confirm('Deseja realmente descartar este corte da fila de publicação?')) return;
    modalBtnDelete.disabled = true;
    try {
      await window.os4.deleteJob(currentModalJobId);
      appendLog(`[Fila] Corte descartado da fila.`);
      closeErrorModal();
      await updateQueueUi();
    } catch (err) {
      alert(`Erro ao descartar: ${err.message}`);
    } finally {
      modalBtnDelete.disabled = false;
    }
  });
}

// Filtros da Fila
document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeFilter = tab.getAttribute('data-filter') || 'all';
    syncStatCardsActive(activeFilter);
    if (currentQueueStatus) renderJobsList(currentQueueStatus.jobs || []);
  });
});

document.querySelectorAll('.stat-card').forEach((card) => {
  card.addEventListener('click', () => {
    const filter = card.getAttribute('data-filter');
    if (!filter) return;
    activeFilter = filter;
    document.querySelectorAll('.filter-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-filter') === filter);
    });
    syncStatCardsActive(filter);
    if (currentQueueStatus) renderJobsList(currentQueueStatus.jobs || []);
  });
});

function syncStatCardsActive(filter) {
  document.querySelectorAll('.stat-card').forEach((card) => {
    card.classList.toggle('active', card.getAttribute('data-filter') === filter);
  });
}

function renderQueue(status) {
  if (!status) return;
  currentQueueStatus = status;

  // Sincroniza cooldowns individuais por rede
  if (status.nextAvailable) {
    syncCooldowns(status.nextAvailable);
  }

  // Atualiza Pausa
  if (btnTogglePause) {
    if (status.isPaused) {
      btnTogglePause.textContent = '▶️ Retomar Fila';
      btnTogglePause.className = 'btn-resume btn-sm';
      pauseBanner.classList.remove('hidden');
    } else {
      btnTogglePause.textContent = '⏸️ Pausar Fila';
      btnTogglePause.className = 'btn-pause btn-sm';
      pauseBanner.classList.add('hidden');
    }
  }

  // Contadores
  const failedCount = status.counts?.failed || 0;
  statQueued.textContent = status.counts?.queued || 0;
  statPub.textContent = status.counts?.publishing || 0;
  const completedToday = status.counts?.completedToday !== undefined ? status.counts.completedToday : 0;
  const completedTotal = status.counts?.completed || 0;
  statDone.textContent = completedToday;
  const doneLabel = document.getElementById('stat-done-label');
  if (doneLabel) {
    doneLabel.textContent = completedTotal > completedToday
      ? `Concluídos Hoje (${completedTotal} no total)`
      : 'Concluídos Hoje';
  }
  statFail.textContent = failedCount;
  if (tabFailedCount) tabFailedCount.textContent = failedCount;

  if (btnRetryAll) {
    btnRetryAll.classList.toggle('hidden', failedCount === 0);
  }

  const total = status.counts?.total || 0;
  queueCounter.textContent = `${total} ${total === 1 ? 'item' : 'itens'} no histórico`;

  renderJobsList(status.jobs || []);
}

function renderJobsList(jobs) {
  if (!jobs || jobs.length === 0) {
    queueList.innerHTML = '<p class="empty-queue">Aguardando novo lote renderizado ou postagem manual...</p>';
    return;
  }

  // Filtragem
  let filtered = [...jobs].reverse();
  if (activeFilter === 'queued') {
    filtered = filtered.filter(j => j.state === 'queued');
  } else if (activeFilter === 'publishing') {
    filtered = filtered.filter(j => j.state === 'publishing');
  } else if (activeFilter === 'today') {
    filtered = filtered.filter(j => j.state === 'completed' && j.completedToday);
  } else if (activeFilter === 'failed') {
    filtered = filtered.filter(j => j.state === 'failed');
  }

  if (filtered.length === 0) {
    const emptyMessages = {
      queued: 'Nenhum corte aguardando na fila no momento.',
      publishing: 'Nenhuma publicação ativa agora.',
      today: 'Nenhum corte concluído hoje ainda.',
      failed: 'Nenhuma falha registrada! Tudo em ordem.'
    };
    queueList.innerHTML = `<p class="empty-queue">${emptyMessages[activeFilter] || 'Nenhum item encontrado para este filtro.'}</p>`;
    return;
  }

  queueList.innerHTML = '';

  for (const job of filtered) {
    const item = document.createElement('div');
    item.className = `queue-item ${job.state === 'failed' ? 'is-failed' : ''}`;

    const info = document.createElement('div');
    info.className = 'queue-item-info';
    const strong = document.createElement('strong');
    strong.textContent = `Corte ${job.cutIndex}: ${job.titulo}`;
    const span = document.createElement('span');
    
    let timeOrDetail = '';
    if (job.state === 'failed') {
      const cleanErr = cleanAnsi(job.evidence);
      timeOrDetail = cleanErr ? `Erro: ${cleanErr.split('\n')[0].slice(0, 85)}...` : 'Falha no envio';
    } else {
      timeOrDetail = job.evidence || new Date(job.created).toLocaleTimeString('pt-BR');
    }
    span.textContent = `Rede: ${job.network.toUpperCase()} · ${timeOrDetail}`;
    info.append(strong, span);

    const right = document.createElement('div');
    right.className = 'queue-item-right';

    if (job.state === 'failed') {
      const btnErr = document.createElement('button');
      btnErr.className = 'btn-item-action btn-item-error';
      btnErr.textContent = '⚠️ Ver Erro';
      btnErr.title = 'Ver mensagem completa do erro';
      btnErr.onclick = () => openErrorModal(job);

      const btnRetry = document.createElement('button');
      btnRetry.className = 'btn-item-action btn-item-retry';
      btnRetry.textContent = '🔄 Tentar';
      btnRetry.title = 'Tentar publicar este corte novamente';
      btnRetry.onclick = async () => {
        btnRetry.disabled = true;
        try {
          await window.os4.retryJob(job.id);
          appendLog(`[Fila] Corte ${job.cutIndex} (${job.network}) reenfileirado.`);
          await updateQueueUi();
        } catch (e) {
          alert(e.message);
          btnRetry.disabled = false;
        }
      };

      const btnDel = document.createElement('button');
      btnDel.className = 'btn-item-action btn-item-delete';
      btnDel.textContent = '🗑️';
      btnDel.title = 'Descartar da fila';
      btnDel.onclick = async () => {
        if (!confirm(`Descartar Corte ${job.cutIndex} (${job.network}) da fila?`)) return;
        btnDel.disabled = true;
        try {
          await window.os4.deleteJob(job.id);
          appendLog(`[Fila] Corte ${job.cutIndex} descartado.`);
          await updateQueueUi();
        } catch (e) {
          alert(e.message);
          btnDel.disabled = false;
        }
      };

      right.append(btnErr, btnRetry, btnDel);
    } else {
      const badge = document.createElement('span');
      badge.className = `status-badge status-${job.state}`;
      const labels = {
        queued: 'Na fila',
        publishing: 'Publicando...',
        completed: 'Concluído ✓'
      };
      badge.textContent = labels[job.state] || job.state;
      right.appendChild(badge);
    }

    item.append(info, right);
    queueList.appendChild(item);
  }
}

async function updateQueueUi() {
  try {
    if (window.os4?.getQueue) {
      const q = await window.os4.getQueue();
      renderQueue(q);
    }
  } catch (_) {}
}

async function action(button, fn) {
  button.disabled = true;
  message.textContent = 'Aguarde…';
  try {
    await fn();
    message.textContent = 'Concluído.';
  } catch (e) {
    message.textContent = e.message;
  } finally {
    button.disabled = false;
    await refresh();
  }
}

// Renderização das contas
const accountsEl = document.querySelector('#accounts');
for (const [network, label] of Object.entries({ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' })) {
  const row = document.createElement('div');
  row.className = 'account';
  const name = document.createElement('strong');
  name.textContent = label;
  const input = document.createElement('input');
  input.id = network;
  input.placeholder = '@usuário ou nome do canal';
  input.setAttribute('aria-label', `Conta ${label}`);
  const login = document.createElement('button');
  login.textContent = 'Conectar';
  login.onclick = () => action(login, () => window.os4.login(network));
  const save = document.createElement('button');
  save.textContent = 'Salvar identificação';
  save.className = 'secondary';
  save.onclick = () => action(save, () => window.os4.saveAccount(network, input.value));
  const close = document.createElement('button');
  close.textContent = 'Fechar navegador';
  close.className = 'secondary';
  close.onclick = () => action(close, () => window.os4.closeLogin(network));
  const status = document.createElement('div');
  status.className = 'status';
  status.id = `status-${network}`;
  row.append(name, input, login, save, close, status);
  accountsEl.append(row);
}

async function refresh() {
  try {
    const s = await window.os4.state();
    document.querySelector('#version').textContent = `Versão ${s.version} · ${s.dataDir}`;
    document.querySelector('#startup').textContent = s.autoStart
      ? 'Inicialização automática ativada no login do Windows. Fechar a janela mantém o aplicativo na bandeja.'
      : 'Inicialização automática será ativada após a instalação.';

    for (const n of ['tiktok', 'instagram', 'youtube']) {
      const input = document.getElementById(n);
      if (document.activeElement !== input) input.value = s.accounts[n]?.account || '';
      document.getElementById(`status-${n}`).textContent = `${s.accounts[n]?.status || 'Conta conectada'} ${s.open.includes(n) ? ' · navegador aberto' : ''}`;
    }

    await updateQueueUi();
  } catch (e) {
    message.textContent = e.message;
  }
}

// Importação de Pasta do Google Drive (Opção B)
const driveFolderInput = document.querySelector('#drive-folder-input');
const btnImportDrive = document.querySelector('#btn-import-drive');
const driveFeedback = document.querySelector('#drive-import-feedback');

if (btnImportDrive) {
  btnImportDrive.addEventListener('click', async () => {
    const url = driveFolderInput.value.trim();
    if (!url) {
      driveFeedback.textContent = 'Por favor, insira o link ou ID da pasta do Google Drive.';
      driveFeedback.classList.remove('hidden');
      return;
    }

    btnImportDrive.disabled = true;
    driveFeedback.classList.remove('hidden');
    driveFeedback.textContent = '🔍 Conectando e escaneando a pasta do Google Drive em segundo plano...';

    try {
      await window.os4.importDriveFolder(url);
      driveFeedback.textContent = '🚀 Varredura iniciada! Acompanhe o progresso nos logs de atividade e na fila.';
      appendLog('[Drive UI] Pedido de importação da pasta enviado.');
    } catch (err) {
      btnImportDrive.disabled = false;
      driveFeedback.textContent = `Erro ao iniciar importação: ${err.message}`;
    }
  });
}

if (window.os4?.onDriveImportFinished) {
  window.os4.onDriveImportFinished((res) => {
    if (btnImportDrive) btnImportDrive.disabled = false;
    if (driveFeedback) {
      if (res.ok) {
        driveFeedback.textContent = `✅ Importação concluída! ${res.enqueuedCount} novos cortes adicionados à fila (${res.skippedCount} já constavam como publicados).`;
      } else {
        driveFeedback.textContent = `❌ ${res.error || res.message || 'Falha na importação.'}`;
      }
    }
    updateQueueUi();
  });
}

document.querySelector('#site').onclick = () => window.os4.openSite();

refresh();
setInterval(() => {
  if (!document.hidden) {
    refresh();
  }
}, 4000);

