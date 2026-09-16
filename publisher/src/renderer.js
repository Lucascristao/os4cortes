const message = document.querySelector('#message');
const logBox = document.querySelector('#log-box');
const queueList = document.querySelector('#queue-list');
const cooldownBanner = document.querySelector('#cooldown-banner');
const cooldownText = document.querySelector('#cooldown-text');
const queueCounter = document.querySelector('#queue-counter');

// Estatísticas
const statQueued = document.querySelector('#stat-queued');
const statPub = document.querySelector('#stat-pub');
const statDone = document.querySelector('#stat-done');
const statFail = document.querySelector('#stat-fail');

let cooldownTimer = null;
let remainingCooldownSec = 0;

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

// Listener de cooldown
if (window.os4?.onCooldown) {
  window.os4.onCooldown((data) => {
    startCooldownCountdown(data.waitSec);
    if (data.status) renderQueue(data.status);
  });
}

function startCooldownCountdown(seconds) {
  remainingCooldownSec = seconds;
  cooldownBanner.classList.remove('hidden');

  if (cooldownTimer) clearInterval(cooldownTimer);
  updateCooldownDisplay();

  cooldownTimer = setInterval(() => {
    remainingCooldownSec--;
    if (remainingCooldownSec <= 0) {
      clearInterval(cooldownTimer);
      cooldownBanner.classList.add('hidden');
    } else {
      updateCooldownDisplay();
    }
  }, 1000);
}

function updateCooldownDisplay() {
  const min = String(Math.floor(remainingCooldownSec / 60)).padStart(2, '0');
  const sec = String(remainingCooldownSec % 60).padStart(2, '0');
  cooldownText.textContent = `Pausa segura de proteção ativa. Próxima publicação liberada em ${min}:${sec}.`;
}

function renderQueue(status) {
  if (!status) return;

  statQueued.textContent = status.counts?.queued || 0;
  statPub.textContent = status.counts?.publishing || 0;
  statDone.textContent = status.counts?.completed || 0;
  statFail.textContent = status.counts?.failed || 0;

  const total = status.counts?.total || 0;
  queueCounter.textContent = `${total} ${total === 1 ? 'item' : 'itens'} no histórico`;

  if (!status.jobs || status.jobs.length === 0) {
    queueList.innerHTML = '<p class="empty-queue">Aguardando novo lote renderizado ou postagem manual...</p>';
    return;
  }

  queueList.innerHTML = '';
  // Mostra os mais recentes primeiro
  const sorted = [...status.jobs].reverse();

  for (const job of sorted) {
    const item = document.createElement('div');
    item.className = 'queue-item';

    const info = document.createElement('div');
    info.className = 'queue-item-info';
    const strong = document.createElement('strong');
    strong.textContent = `Corte ${job.cutIndex}: ${job.titulo}`;
    const span = document.createElement('span');
    span.textContent = `Rede: ${job.network.toUpperCase()} · ${job.evidence || new Date(job.created).toLocaleTimeString('pt-BR')}`;
    info.append(strong, span);

    const badge = document.createElement('span');
    badge.className = `status-badge status-${job.state}`;
    const labels = {
      queued: 'Na fila',
      publishing: 'Publicando...',
      completed: 'Concluído ✓',
      failed: 'Falhou'
    };
    badge.textContent = labels[job.state] || job.state;

    item.append(info, badge);
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

document.querySelector('#site').onclick = () => window.os4.openSite();

refresh();
setInterval(() => {
  if (!document.hidden) {
    refresh();
  }
}, 4000);
