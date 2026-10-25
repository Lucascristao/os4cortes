const $ = (selector) => document.querySelector(selector);

const loginView = $("#loginView");
const appView = $("#appView");
const btnTranscrever = $("#btnTranscrever");
const btnCancelarJob = $("#btnCancelarJob");
const btnImportar = $("#btnImportar");
const btnGerarCortes = $("#btnGerarCortes");
const btnMostrarDriveSetup = $("#btnMostrarDriveSetup");
const btnSalvarGithub = $("#btnSalvarGithub");
const driveSetupCard = $("#driveSetupCard");
const driveSetupData = $("#driveSetupData");
const githubSetupCard = $("#githubSetupCard");
const githubToken = $("#githubToken");
const githubSetupMsg = $("#githubSetupMsg");
const videoUrl = $("#videoUrl");
const hasLowerThirdInput = $("#hasLowerThird");
const simpleCutsInput = $("#simpleCuts");
const burnCaptionsInput = $("#burnCaptions");
const editorialStyleInput = $("#editorialStyle");
const pacote = $("#pacote");
const cutsEditor = $("#cutsEditor");
const transcriptSection = $("#transcriptSection");
const transcriptText = $("#transcriptText");
const packageSection = $("#packageSection");
const resultsSection = $("#resultsSection");
const resultsList = $("#resultsList");
const driveFolderLink = $("#driveFolderLink");
const resultsDriveLink = $("#resultsDriveLink");
const progressBar = $("#progressBar");
const progressPercent = $("#progressPercent");
const progressTitle = $("#progressTitle");
const progressDetail = $("#progressDetail");
const progressTime = $("#progressTime");
const progressTrack = $(".progress-track");

let githubConnected = false;
let sessaoTranscricao = null;
let pollTimer = null;
let cortesImportados = [];
let lowerThirdVideoKey = "";
let ultimoJob = null;
let enviandoControle = false;

const STORAGE_SESSION = "os4_transcription_session";
const STORAGE_JOB = "os4_current_job";
const STORAGE_RESULTS = "os4_last_results_view";
const STORAGE_PACKAGE = "os4_editor_package";

function chaveVideo(url) {
  const valor = String(url || "").trim();
  try {
    const parsed = new URL(valor);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const partes = parsed.pathname.split("/").filter(Boolean);
    let id = "";
    if (host === "youtu.be") id = partes[0] || "";
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      id = parsed.searchParams.get("v") || (["shorts", "embed", "live"].includes(partes[0]) ? partes[1] : "") || "";
    }
    if (id) return `youtube:${id}`;
  } catch {}
  return valor;
}

function salvarSessaoTranscricao() {
  try { localStorage.setItem(STORAGE_SESSION, JSON.stringify(sessaoTranscricao)); } catch {}
}

function estiloEditorial(value) {
  return value === "paper" || value === "motion_dark" ? value : "classic";
}

function atualizarOpcaoVisual() {
  if (editorialStyleInput) editorialStyleInput.disabled = simpleCutsInput?.checked === true;
  const hint = $("#editorialStyleHint");
  if (hint) hint.textContent = simpleCutsInput?.checked === true
    ? "O corte simples mantém seu visual atual. Desmarque corte simples para escolher o visual dos vídeos autorais."
    : "Visual atual preserva o modelo clássico. Papel dinâmico usa fundo claro. Motion Dark usa fundo grafite com iluminação e legendas destacadas. A escolha vale para todo o lote autoral.";
}

function atualizarTarjaVideo() {
  const key = chaveVideo(videoUrl?.value);
  if (key === lowerThirdVideoKey) return;
  lowerThirdVideoKey = key;
  if (hasLowerThirdInput) {
    hasLowerThirdInput.checked = Boolean(sessaoTranscricao && key === chaveVideo(sessaoTranscricao.videoUrl) && sessaoTranscricao.hasLowerThird === true);
  }
  if (simpleCutsInput) {
    simpleCutsInput.checked = Boolean(sessaoTranscricao && key === chaveVideo(sessaoTranscricao.videoUrl) && sessaoTranscricao.simpleCuts === true);
  }
  if (burnCaptionsInput) {
    burnCaptionsInput.checked = sessaoTranscricao && key === chaveVideo(sessaoTranscricao.videoUrl) && typeof sessaoTranscricao.burnCaptions === "boolean"
      ? sessaoTranscricao.burnCaptions
      : true;
  }
  if (editorialStyleInput) editorialStyleInput.value = estiloEditorial(
    sessaoTranscricao && key === chaveVideo(sessaoTranscricao.videoUrl) ? sessaoTranscricao.editorialStyle : undefined);
  atualizarOpcaoVisual();
}

hasLowerThirdInput?.addEventListener("change", () => {
  // A URL pode ser um rascunho de outro vídeo; só altera a sessão correspondente.
  if (sessaoTranscricao && chaveVideo(videoUrl?.value) === chaveVideo(sessaoTranscricao.videoUrl)) {
    sessaoTranscricao.hasLowerThird = hasLowerThirdInput.checked;
    salvarSessaoTranscricao();
  }
});

simpleCutsInput?.addEventListener("change", () => {
  atualizarOpcaoVisual();
  if (sessaoTranscricao && chaveVideo(videoUrl?.value) === chaveVideo(sessaoTranscricao.videoUrl)) {
    sessaoTranscricao.simpleCuts = simpleCutsInput.checked;
    salvarSessaoTranscricao();
  }
});

editorialStyleInput?.addEventListener("change", () => {
  if (sessaoTranscricao && chaveVideo(videoUrl?.value) === chaveVideo(sessaoTranscricao.videoUrl)) {
    sessaoTranscricao.editorialStyle = estiloEditorial(editorialStyleInput.value);
    salvarSessaoTranscricao();
  }
});

burnCaptionsInput?.addEventListener("change", () => {
  if (sessaoTranscricao && chaveVideo(videoUrl?.value) === chaveVideo(sessaoTranscricao.videoUrl)) {
    sessaoTranscricao.burnCaptions = burnCaptionsInput.checked;
    salvarSessaoTranscricao();
  }
});

function atualizarProgresso({ percent = 0, title = "Aguardando processamento", detail = "", time = "" } = {}) {
  const valor = Math.max(0, Math.min(100, Number(percent) || 0));
  const inteiro = Math.round(valor);

  if (progressBar) progressBar.style.width = `${valor}%`;
  if (progressPercent) progressPercent.textContent = `${inteiro}%`;
  if (progressTitle) progressTitle.textContent = title;
  if (progressDetail) progressDetail.textContent = detail;
  if (progressTime) progressTime.textContent = time;
  if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(inteiro));

  const cutsBar = document.getElementById("cutsLiveBar");
  const cutsStage = document.getElementById("cutsLiveStage");
  const cutsCount = document.getElementById("cutsLiveCount");
  const cutsDetail = document.getElementById("cutsLiveDetail");
  if (cutsBar) cutsBar.style.width = `${valor}%`;
  if (cutsStage) cutsStage.textContent = title;
  if (cutsCount) cutsCount.textContent = time ? `${time} • ${inteiro}%` : `${inteiro}%`;
  if (cutsDetail) cutsDetail.textContent = detail;
}

window.OS4Progress = { atualizar: atualizarProgresso };

function tempo(segundos) {
  const total = Math.max(0, Math.round(Number(segundos) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function tituloEtapa(stage, kind) {
  const mapa = {
    fila: "Na fila do GitHub Actions",
    preparando: "Preparando processamento",
    download: "Baixando vídeo",
    audio: "Preparando áudio",
    carregando_whisper: "Carregando transcrição",
    transcricao: "Transcrevendo vídeo",
    drive: "Salvando no Google Drive",
    preparando_cortes: "Preparando cortes",
    baixando_base: "Carregando sessão do Drive",
    tracking: "Ajustando enquadramento do vídeo",
    legendas: "Aplicando legendas",
    cortes: "Finalizando cortes",
    concluido: kind === "render" ? "Cortes concluídos" : "Transcrição concluída",
    erro: "O processamento encontrou um erro",
    aguardando_decisao: "Corte com falha — aguardando sua decisão",
    retomando: "Retomando o processamento",
    interrompendo: "Encerrando o processamento",
    cancelado: "Processamento interrompido",
  };
  return mapa[stage] || (kind === "render" ? "Gerando cortes" : "Processando vídeo");
}

function setStatus(tipo, texto, estado = "idle") {
  const ids = {
    video: ["#videoStatus", "#videoDot"],
    transcricao: ["#transcricaoStatus", "#transcricaoDot"],
    cortes: ["#cortesStatus", "#cortesDot"],
  };
  const [textoId, dotId] = ids[tipo];
  const el = $(textoId);
  const dot = $(dotId);
  if (el) el.textContent = texto;
  if (dot) dot.className = `status-dot ${estado}`;
}

async function api(url, options = {}) {
  const resposta = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const erro = new Error(dados?.error || `Erro ${resposta.status}`);
    erro.detail = dados?.detail || "";
    erro.status = resposta.status;
    throw erro;
  }
  return dados;
}

async function verificarSetupDrive() {
  if (!driveSetupCard) return;
  driveSetupCard.classList.add("hidden");

  try {
    const dados = await api("/.netlify/functions/drive-setup?check=1");
    if (dados.available && !dados.completed) {
      driveSetupCard.classList.remove("hidden");
      return;
    }
    if (!dados.completed) {
      await api("/.netlify/functions/drive-setup?complete=1");
    }
  } catch {
    // A configuração antiga do Drive não bloqueia o uso normal.
  }
}

async function verificarGithubSetup() {
  githubSetupCard?.classList.add("hidden");
  try {
    const dados = await api("/.netlify/functions/github-setup");
    githubConnected = Boolean(dados.connected);
    if (!githubConnected) githubSetupCard?.classList.remove("hidden");
  } catch (erro) {
    githubConnected = false;
    githubSetupCard?.classList.remove("hidden");
    if (githubSetupMsg) githubSetupMsg.textContent = `Não foi possível verificar o GitHub: ${erro.message}`;
  }
}

$("#btnEditarGithub")?.addEventListener("click", () => {
  githubSetupCard.classList.remove("hidden");
  githubSetupMsg.textContent = "Cole o novo token com acesso ao repositório os4cortes e Actions: Read and write.";
  githubSetupCard.scrollIntoView({ behavior: "smooth", block: "center" });
  githubToken.focus();
});

function restaurarSessao() {
  try {
    const raw = localStorage.getItem(STORAGE_SESSION);
    if (raw) {
      const sessao = JSON.parse(raw);
      if (sessao?.folderId && sessao?.videoFileId && sessao?.transcriptJsonFileId) {
        mostrarTranscricao(sessao);
      }
    }
    const savedPackage = localStorage.getItem(STORAGE_PACKAGE);
    if (savedPackage && pacote && !pacote.value) {
      pacote.value = savedPackage;
      try {
        const parsed = JSON.parse(savedPackage);
        const migrated = atualizarIdentidadePacote(parsed);
        if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
          pacote.value = JSON.stringify(migrated, null, 2);
          localStorage.setItem(STORAGE_PACKAGE, pacote.value);
        }
      } catch {}
    }
    const rawResults = localStorage.getItem(STORAGE_RESULTS);
    if (rawResults && !localStorage.getItem(STORAGE_JOB)) {
      const result = JSON.parse(rawResults);
      if (result?.cuts && (result.cuts.length || result.errors?.length)) {
        mostrarResultados(result, false);
      }
    }
  } catch {
    localStorage.removeItem(STORAGE_SESSION);
  }
}

$("#btnConcluirDriveSetup")?.addEventListener("click", async () => {
  try {
    await api("/.netlify/functions/drive-setup?complete=1");
    driveSetupCard.classList.add("hidden");
  } catch (erro) {
    alert(erro.message);
  }
});

function logout() {
  localStorage.removeItem(STORAGE_SESSION);
  localStorage.removeItem(STORAGE_JOB);
  localStorage.removeItem(STORAGE_RESULTS);
  localStorage.removeItem(STORAGE_PACKAGE);
  location.href = "/.netlify/functions/auth-logout";
}

$(".logout-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  logout();
});

async function api(path, options = {}) {
  const resposta = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.detail || dados.error || `Erro HTTP ${resposta.status}`);
    erro.status = resposta.status;
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

async function carregarSessao() {
  try {
    const dados = await api("/.netlify/functions/auth-session");
    if (!dados?.authenticated || !dados?.user) throw new Error("Sem usuário");

    loginView.classList.add("hidden");
    appView.classList.remove("hidden");

    $("#userName").textContent = dados.user.name || "Conta Google";
    $("#userEmail").textContent = dados.user.email || "";

    if (dados.user.picture) {
      const foto = $("#userPicture");
      if (foto) {
        foto.src = dados.user.picture;
        foto.classList.remove("hidden");
      }
    }

    await verificarSetupDrive();
    await verificarGithubSetup();
    restaurarSessao();
    retomarJob();

    if (new URLSearchParams(location.search).get("login") === "ok") {
      history.replaceState({}, "", location.pathname);
    }
  } catch {
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }
}

btnMostrarDriveSetup?.addEventListener("click", async () => {
  btnMostrarDriveSetup.disabled = true;
  btnMostrarDriveSetup.textContent = "Carregando...";

  try {
    const dados = await api("/.netlify/functions/drive-setup");
    if (!dados.available) throw new Error("Os dados temporários não estão mais disponíveis.");

    driveSetupData.innerHTML = `
      <label>GOOGLE_REFRESH_TOKEN</label>
      <textarea id="setupRefresh" rows="5" readonly></textarea>
      <button type="button" class="secondary" data-copy="setupRefresh">Copiar refresh token</button>
      <label>GOOGLE_DRIVE_FOLDER_ID</label>
      <input id="setupFolder" readonly>
      <button type="button" class="secondary" data-copy="setupFolder">Copiar folder ID</button>
      <p class="hint">Esses valores já são usados pelo processador do GitHub Actions.</p>
    `;
    $("#setupRefresh").value = dados.refreshToken;
    $("#setupFolder").value = dados.folderId;
    driveSetupData.classList.remove("hidden");
    btnMostrarDriveSetup.classList.add("hidden");

    driveSetupData.querySelectorAll("[data-copy]").forEach((botao) => {
      botao.addEventListener("click", async () => {
        const campo = document.getElementById(botao.dataset.copy);
        await navigator.clipboard.writeText(campo.value);
        const original = botao.textContent;
        botao.textContent = "Copiado ✓";
        setTimeout(() => (botao.textContent = original), 1300);
      });
    });
  } catch (erro) {
    alert(erro.message);
    btnMostrarDriveSetup.disabled = false;
    btnMostrarDriveSetup.textContent = "Ver dados de configuração";
  }
});

btnSalvarGithub?.addEventListener("click", async () => {
  const token = githubToken.value.trim();
  if (!token) {
    githubSetupMsg.textContent = "Cole o token Fine-grained do GitHub.";
    return;
  }

  btnSalvarGithub.disabled = true;
  githubSetupMsg.textContent = "Validando acesso ao GitHub...";

  try {
    await api("/.netlify/functions/github-setup", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    githubConnected = true;
    githubToken.value = "";
    githubSetupMsg.textContent = "GitHub Actions conectado ✓";
    setTimeout(() => githubSetupCard.classList.add("hidden"), 700);
  } catch (erro) {
    githubSetupMsg.textContent = erro.message;
  } finally {
    btnSalvarGithub.disabled = false;
  }
});

function limparFluxo() {
  ultimoJob = null;
  sessaoTranscricao = null;
  cortesImportados = [];
  localStorage.removeItem(STORAGE_SESSION);
  localStorage.removeItem(STORAGE_RESULTS);
  localStorage.removeItem(STORAGE_PACKAGE);
  transcriptSection?.classList.add("hidden");
  packageSection?.classList.add("hidden");
  resultsSection?.classList.add("hidden");
  cutsEditor.innerHTML = "";
  cutsEditor.classList.add("hidden");
  btnGerarCortes.classList.add("hidden");
  document.getElementById("cutsLiveProgress")?.classList.add("hidden");
  pacote.value = "";
  setStatus("video", "Preparando", "active");
  setStatus("transcricao", "Aguardando", "idle");
  setStatus("cortes", "Aguardando", "idle");
}

async function obterMetadadosYoutube(url) {
  if (!url) return null;
  try {
    const resp = await fetch(`/.netlify/functions/youtube-meta?url=${encodeURIComponent(url)}`);
    if (resp.ok) {
      const d = await resp.json();
      if (d.ok && d.title) {
        return {
          title: String(d.title || "").trim(),
          author: String(d.author || "").trim(),
        };
      }
    }
  } catch (e) {
    console.warn("Não foi possível obter metadados via backend:", e);
  }
  return null;
}

let debounceMetaTimer = null;
const atualizarMetadadosUrl = () => {
  atualizarTarjaVideo();
  clearTimeout(debounceMetaTimer);
  debounceMetaTimer = setTimeout(async () => {
    const url = videoUrl?.value?.trim();
    if (url && (url.includes("youtube.com") || url.includes("youtu.be"))) {
      const meta = await obterMetadadosYoutube(url);
      if (meta?.title) {
        try { localStorage.setItem("os4_current_video_meta", JSON.stringify(meta)); } catch {}
      }
    }
  }, 350);
};

videoUrl?.addEventListener("input", atualizarMetadadosUrl);
videoUrl?.addEventListener("change", atualizarMetadadosUrl);

btnTranscrever?.addEventListener("click", async () => {
  const url = videoUrl.value.trim();
  const hasLowerThird = hasLowerThirdInput?.checked === true;
  const simpleCuts = simpleCutsInput?.checked === true;
  const editorialStyle = estiloEditorial(editorialStyleInput?.value);
  if (!url) {
    alert("Cole a URL do vídeo primeiro.");
    return;
  }
  if (!githubConnected) {
    githubSetupCard?.classList.remove("hidden");
    githubSetupCard?.scrollIntoView({ behavior: "smooth", block: "center" });
    alert("Faça a configuração inicial do GitHub Actions primeiro.");
    return;
  }

  limparFluxo();
  const metaYt = await obterMetadadosYoutube(url);
  if (metaYt) {
    try { localStorage.setItem("os4_current_video_meta", JSON.stringify(metaYt)); } catch {}
  }

  btnTranscrever.disabled = true;
  btnTranscrever.textContent = "Iniciando...";
  atualizarProgresso({ percent: 1, title: "Enviando para o GitHub Actions", detail: "Preparando a transcrição..." });

  try {
    const dados = await api("/.netlify/functions/workflow-start", {
      method: "POST",
      body: JSON.stringify({ kind: "transcribe", videoUrl: url, hasLowerThird, simpleCuts, editorialStyle }),
    });
    localStorage.setItem(STORAGE_JOB, JSON.stringify({ id: dados.requestId, kind: "transcribe", videoUrl: url, hasLowerThird, simpleCuts, editorialStyle, timestamp: Date.now() }));
    alternarBotaoCancelar(true);
    acompanharJob(dados.requestId, "transcribe");
  } catch (erro) {
    btnTranscrever.disabled = false;
    btnTranscrever.textContent = "Transcrever";
    setStatus("video", "Erro", "error");
    atualizarProgresso({ percent: 0, title: "Não foi possível iniciar", detail: erro.message });
  }
});

function alternarBotaoCancelar(visivel) {
  if (!btnCancelarJob) return;
  if (visivel) {
    btnCancelarJob.classList.remove("hidden");
  } else {
    btnCancelarJob.classList.add("hidden");
  }
}

async function cancelarJobAtual() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(STORAGE_JOB) || "null"); } catch {}
  if (local?.kind === "render") return controlarCortes("stop");
  // Transcription does not implement cooperative stop. State this explicitly.
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  localStorage.removeItem(STORAGE_JOB);
  alternarBotaoCancelar(false);
  btnTranscrever.disabled = false;
  btnTranscrever.textContent = "Transcrever";
  btnGerarCortes.disabled = false;
  btnGerarCortes.textContent = "Gerar todos os cortes";
  setStatus("video", "Aguardando", "idle");
  setStatus("transcricao", "Aguardando", "idle");
  setStatus("cortes", "Aguardando", "idle");
  atualizarProgresso({
    percent: 0,
    title: "Aguardando processamento",
    detail: "Acompanhamento encerrado neste navegador. A transcrição já iniciada continua no GitHub Actions.",
    time: "",
  });
}

btnCancelarJob?.addEventListener("click", cancelarJobAtual);

async function controlarCortes(action) {
  if (enviandoControle) return;
  let local = null;
  try { local = JSON.parse(localStorage.getItem(STORAGE_JOB) || "null"); } catch {}
  if (!local?.id || local.kind !== "render") return;
  const message = document.getElementById("cutsControlMessage");
  enviandoControle = true;
  for (const id of ["btnContinuarCortes", "btnPararCortes"]) { const button = document.getElementById(id); if (button) button.disabled = true; }
  if (btnCancelarJob) btnCancelarJob.disabled = true;
  if (message) message.textContent = action === "stop" ? "Enviando pedido de parada…" : "Confirmando continuação…";
  try {
    await api("/.netlify/functions/workflow-control", { method: "POST", body: JSON.stringify({
      requestId: local.id, action, decisionId: ultimoJob?.pendingDecision?.id || null,
    }) });
    if (message) message.textContent = action === "stop"
      ? "Parada solicitada. Aguarde a confirmação do processador; os cortes já salvos serão preservados."
      : "Continuação confirmada. O corte com falha será pulado; as falhas consecutivas só zeram quando outro corte for salvo.";
    const data = await api(`/.netlify/functions/workflow-status?id=${encodeURIComponent(local.id)}`);
    atualizarTelaJob(data.job, "render");
  } catch (error) {
    if (message) message.textContent = `Não foi possível confirmar a ação: ${error.message}. O acompanhamento continua ativo.`;
  } finally {
    enviandoControle = false;
    for (const id of ["btnContinuarCortes", "btnPararCortes"]) { const button = document.getElementById(id); if (button) button.disabled = false; }
    if (btnCancelarJob) btnCancelarJob.disabled = false;
  }
}

document.getElementById("btnContinuarCortes")?.addEventListener("click", () => controlarCortes("continue"));
document.getElementById("btnPararCortes")?.addEventListener("click", () => controlarCortes("stop"));

function atualizarFalhasCortes(job) {
  document.getElementById("cutsLiveProgress")?.classList.remove("hidden");
  const errors = Array.isArray(job.failureHistory) ? job.failureHistory : job.result?.errors || [];
  const completed = job.completedCount ?? job.result?.completedCount ?? job.result?.cuts?.length ?? 0;
  const failed = job.failedCount ?? errors.length;
  const streak = job.consecutiveFailures ?? job.result?.consecutiveFailures ?? 0;
  const pending = job.pendingCount ?? job.result?.pendingCuts?.length ?? 0;
  const summary = document.getElementById("cutsLiveSummary");
  if (summary) summary.textContent = `${completed}/${job.totalCuts || job.result?.requestedCount || "?"} salvos no Google Drive${pending ? ` • ${pending} vídeo(s) salvo(s); capa pendente` : ""} • ${failed} com falha • ${streak} falha(s) seguida(s)`;
  const panel = document.getElementById("cutsFailurePanel");
  if (errors.length) panel?.classList.remove("hidden"); else panel?.classList.add("hidden");
  const title = document.getElementById("cutsFailureTitle");
  if (title) title.textContent = job.status === "paused" ? "O lote está pausado após uma falha"
    : streak >= 3 ? "Lote interrompido após 3 falhas consecutivas" : "Histórico de falhas do lote";
  const notice = document.getElementById("cutsFailureNotice");
  if (notice) notice.textContent = job.status === "paused"
    ? "Escolha parar ou pular o corte com falha e continuar. Após 3 falhas seguidas, o lote para automaticamente."
    : ["error", "cancelled"].includes(job.status) ? job.result?.stoppedReason || job.error || job.detail || "Processamento interrompido; os cortes já salvos foram preservados."
    : job.stopRequested ? "Parada solicitada. Aguardando o encerramento do processador."
      : "Os erros permanecem neste histórico. Continuar pula o corte com falha; somente um corte salvo zera as falhas consecutivas.";
  const list = document.getElementById("cutsFailureHistory");
  if (list) {
    list.innerHTML = "";
    for (const error of errors) {
      const item = document.createElement("li");
      item.textContent = `Corte ${error.index} — ${error.titulo || "Sem título"}: ${error.error || "Falha no processamento."}`;
      list.appendChild(item);
    }
  }
  const actions = document.getElementById("cutsFailureActions");
  if (job.status === "paused" && job.pendingDecision?.id && !job.stopRequested) actions?.classList.remove("hidden");
  else actions?.classList.add("hidden");
}

function atualizarTelaJob(job, kind) {
  ultimoJob = job;
  if (btnCancelarJob) btnCancelarJob.textContent = kind === "render" ? "Parar processamento" : "Encerrar acompanhamento (transcrição continua)";
  if (kind === "render") {
    btnGerarCortes.textContent = job.status === "paused" ? "Aguardando sua decisão" : job.status === "stopping" ? "Encerrando…" : "Gerando cortes…";
    atualizarFalhasCortes(job);
    if (job.result?.cuts && (job.result.cuts.length || job.result.errors?.length || job.result.pendingCuts?.length)) mostrarResultados(job.result, false, { live: true });
  } else btnTranscrever.textContent = "Processando…";
  const timeText = job.current != null && job.total
    ? `${tempo(job.current)} / ${tempo(job.total)}`
    : job.cut && job.totalCuts
      ? `Corte ${job.cut} de ${job.totalCuts}`
      : "";

  atualizarProgresso({
    percent: job.percent,
    title: tituloEtapa(job.stage, kind),
    detail: job.detail || "Processando...",
    time: timeText,
  });

  if (kind === "transcribe") {
    if (["download", "audio", "carregando_whisper", "transcricao", "drive", "concluido"].includes(job.stage)) {
      setStatus("video", job.stage === "concluido" ? "Pronto" : "Processando", job.stage === "concluido" ? "ok" : "active");
    }
    if (["carregando_whisper", "transcricao"].includes(job.stage)) setStatus("transcricao", "Transcrevendo", "active");
    if (["drive", "concluido"].includes(job.stage)) setStatus("transcricao", job.stage === "concluido" ? "Pronta" : "Salvando", job.stage === "concluido" ? "ok" : "active");
  } else {
    setStatus("video", "Pronto", "ok");
    setStatus("transcricao", "Pronta", "ok");
    const failed = job.failedCount || job.result?.errors?.length || 0;
    setStatus("cortes", job.status === "paused" ? "Aguardando decisão" : job.stage === "concluido" ? (failed ? "Concluído com falhas" : "Concluídos") : (job.detail || "Processando"), failed ? "error" : job.stage === "concluido" ? "ok" : "active");
  }
}

function acompanharJob(id, kind) {
  if (pollTimer) clearInterval(pollTimer);
  let consulting = false;
  btnTranscrever.disabled = true;
  btnGerarCortes.disabled = true;
  if (kind === "render") btnGerarCortes.textContent = "Gerando cortes…";
  alternarBotaoCancelar(true);

  const consultar = async () => {
    if (consulting) return;
    consulting = true;
    try {
      const dados = await api(`/.netlify/functions/workflow-status?id=${encodeURIComponent(id)}`);
      const job = dados.job;
      atualizarTelaJob(job, kind);

      if (job.status === "completed") {
        let jobLocal = null;
        try {
          const salvo = JSON.parse(localStorage.getItem(STORAGE_JOB) || "null");
          if (salvo?.id === id) jobLocal = salvo;
        } catch {}
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.removeItem(STORAGE_JOB);
        alternarBotaoCancelar(false);
        btnTranscrever.disabled = false;
        btnGerarCortes.disabled = false;

        if (kind === "transcribe") {
          mostrarTranscricao({
            ...job.result,
            videoUrl: jobLocal?.videoUrl || job.result?.videoUrl || "",
            hasLowerThird: job.hasLowerThird === true,
            simpleCuts: typeof job.simpleCuts === "boolean" ? job.simpleCuts : jobLocal?.simpleCuts === true,
            editorialStyle: job.editorialStyle ?? jobLocal?.editorialStyle,
          });
          btnTranscrever.disabled = false;
          btnTranscrever.textContent = "Transcrever outro";
        } else {
          mostrarResultados(job.result);
          btnGerarCortes.disabled = false;
          btnGerarCortes.textContent = "Gerar todos os cortes";
        }
      } else if (job.status === "error" || job.status === "cancelled") {
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.removeItem(STORAGE_JOB);
        alternarBotaoCancelar(false);
        setStatus(kind === "render" ? "cortes" : "video", "Erro", "error");
        atualizarProgresso({ percent: job.percent ?? 0, title: "Processamento interrompido", detail: job.error || job.detail || "Falha no processamento." });
        if (job.result?.cuts) mostrarResultados(job.result, false, { interrupted: true });
        btnTranscrever.disabled = false;
        btnTranscrever.textContent = "Transcrever";
        btnGerarCortes.disabled = false;
        btnGerarCortes.textContent = "Gerar todos os cortes";
      } else if (job.stale) {
        progressDetail.textContent = 'Sem atualização recente do GitHub Actions. O acompanhamento continua automaticamente.';
      }
    } catch (erro) {
      console.warn("Falha ao consultar andamento:", erro);
      progressDetail.textContent = [401, 403].includes(erro.status)
        ? "Sua sessão expirou. Entre novamente para acompanhar o processamento."
        : `Não foi possível atualizar o andamento: ${erro.message}. Tentando novamente…`;
      const liveDetail = document.getElementById("cutsLiveDetail");
      if (kind === "render" && liveDetail) liveDetail.textContent = progressDetail.textContent;
      if ([401, 403, 404].includes(erro.status)) {
        clearInterval(pollTimer);
        pollTimer = null;
        alternarBotaoCancelar(false);
        btnTranscrever.disabled = false;
        btnGerarCortes.disabled = false;
        btnTranscrever.textContent = "Transcrever";
        if (erro.status === 404) localStorage.removeItem(STORAGE_JOB);
      }
    } finally {
      consulting = false;
    }
  };

  consultar();
  pollTimer = setInterval(consultar, 3000);
}

function retomarJob() {
  try {
    const raw = localStorage.getItem(STORAGE_JOB);
    if (!raw) return;
    const job = JSON.parse(raw);
    if (!job?.id || !job?.kind) {
      localStorage.removeItem(STORAGE_JOB);
      return;
    }
    // Long batches and paused decisions remain resumable after a page reload.
    if (job.kind === "transcribe") {
      if (videoUrl) videoUrl.value = job.videoUrl || "";
      lowerThirdVideoKey = chaveVideo(job.videoUrl);
      if (hasLowerThirdInput) hasLowerThirdInput.checked = job.hasLowerThird === true;
      if (simpleCutsInput) simpleCutsInput.checked = job.simpleCuts === true;
      if (editorialStyleInput) editorialStyleInput.value = estiloEditorial(job.editorialStyle);
      atualizarOpcaoVisual();
      btnTranscrever.disabled = true;
      btnTranscrever.textContent = "Processando...";
    } else {
      btnGerarCortes.disabled = true;
    }
    alternarBotaoCancelar(true);
    acompanharJob(job.id, job.kind);
  } catch {
    localStorage.removeItem(STORAGE_JOB);
  }
}

function mostrarTranscricao(result) {
  if (!result) return;
  sessaoTranscricao = {
    ...result,
    videoUrl: result.videoUrl || "",
    hasLowerThird: result.hasLowerThird === true,
    simpleCuts: result.simpleCuts === true,
    burnCaptions: typeof result.burnCaptions === "boolean" ? result.burnCaptions : true,
    editorialStyle: estiloEditorial(result.editorialStyle),
  };
  salvarSessaoTranscricao();
  if (videoUrl) videoUrl.value = sessaoTranscricao.videoUrl;
  lowerThirdVideoKey = chaveVideo(sessaoTranscricao.videoUrl);
  if (hasLowerThirdInput) hasLowerThirdInput.checked = sessaoTranscricao.hasLowerThird;
  if (simpleCutsInput) simpleCutsInput.checked = sessaoTranscricao.simpleCuts;
  if (burnCaptionsInput) burnCaptionsInput.checked = sessaoTranscricao.burnCaptions;
  if (editorialStyleInput) editorialStyleInput.value = sessaoTranscricao.editorialStyle;
  atualizarOpcaoVisual();

  transcriptText.value = result.transcript || "";
  driveFolderLink.href = result.driveFolderUrl || `https://drive.google.com/drive/folders/${result.folderId}`;
  transcriptSection.classList.remove("hidden");
  packageSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  setStatus("video", "Pronto", "ok");
  setStatus("transcricao", "Pronta", "ok");
  setStatus("cortes", "Aguardando pacote", "idle");
}

$("#btnCopiarTranscricao")?.addEventListener("click", async (event) => {
  const botao = event?.currentTarget || $("#btnCopiarTranscricao");
  const original = botao?.textContent || "Copiar transcrição";
  await navigator.clipboard.writeText(transcriptText.value);
  if (botao) {
    botao.textContent = "Copiada ✓";
    setTimeout(() => (botao.textContent = original), 1300);
  }
});

const DIRETRIZ_IDENTIDADE_CANAL = `IDENTIDADE DO CANAL
Nome oficial: OS4 de Direita. O identificador é @os4dedireita em todas as redes: Instagram, TikTok e YouTube. Preserve a identidade visual e o logo OS4; use o nome atual e o identificador atual nas referências ao nosso canal.
Nas legendas de postagem e nas descrições do YouTube, inclua uma única assinatura: "Siga @os4dedireita para mais insights com análises e comentários." Use hashtags temáticas, sem hashtags de marca. O nome do canal e o @ são a nossa identificação; não substituem os créditos do vídeo original. Preserve títulos, nomes e falas da fonte. Não acrescente anúncio de mudança de nome, bordão ou chamada para seguir nas narrações só para cumprir a identificação.`;

const DIRETRIZ_FONTE_EXCLUSIVA = `FONTE EXCLUSIVA DESTE TRABALHO
Use somente a transcrição e os metadados fornecidos neste prompt. Não navegue, não pesquise sites, notícias ou artigos de apoio e não abra a URL para buscar contexto adicional. A URL identifica o vídeo apenas como referência interna; não é um pedido de pesquisa. Não inclua a URL na legenda_post ou na descricao. Não acrescente fatos específicos usando memória, notícias ou informações de fora do material, nem atualize o contexto do vídeo com acontecimentos posteriores.
Faça a seleção e, no formato autoral, o comentário a partir do que a fonte efetivamente diz, incluindo suas hipóteses, ironias e opiniões atribuídas. Você pode desenvolver uma observação própria e relacionar os pontos sustentados pelos trechos, conservando seu alcance. Se faltar um dado, omita a afirmação que depende dele ou escolha outro ponto; não pesquise para preencher a lacuna nem peça um briefing por corte. Datas desconhecidas ficam vazias nos campos que aceitam string vazia. Preserve o momento e a leitura do vídeo sem substituir a análise da fonte por uma análise do noticiário.`;

const DIRETRIZ_CREDITOS_PUBLICACAO = `CRÉDITOS DE PUBLICAÇÃO
Em cada legenda_post dos verticais e descricao dos horizontais, inclua um bloco com o título oficial do vídeo original e os nomes dos participantes confirmados na transcrição ou nos metadados. Preserve o título oficial literalmente; não o substitua pelo link, pelo nome do canal ou por um título criado para o corte. Não inclua links ou URLs nesses textos de publicação.
Use este formato nos verticais:
🎬 Episódio completo: "[Título oficial do vídeo original]"
🎙️ Com: [Nomes dos participantes confirmados na transcrição ou nos metadados]
Nos horizontais, use a mesma linha de episódio, acrescente 🎙️ Canal / Host: "[Canal informado nos metadados]" quando disponível e identifique os nomes com 👥 Participantes: [Nomes dos participantes confirmados na transcrição ou nos metadados].
Identifique somente quem participa do vídeo; alguém apenas citado no assunto não é participante, e o nome do canal não confirma quem está falando. Se o título, o canal ou algum participante não estiver confirmado no material, omita a linha ou o nome correspondente. Não invente esses dados, não use a URL como substituto e não publique placeholders como "Título oficial do vídeo", "Canal Oficial" ou "Participante A".`;

const DIRETRIZ_CAPAS = `CAPAS PARA INSTAGRAM, TIKTOK E YOUTUBE
Inclua cover na raiz de CADA corte, simples ou autoral, tanto em 9:16 quanto em 16:9: {"version":1,"template_id":"03_close","title":"O QUE ELA CONFIRMA?"}.
Escolha aleatoriamente um dos três modelos permitidos por corte, variando o lote: 01_central (pessoa central), 02_lateral (pessoa ao lado) ou 03_close (rosto maior e faixa de uma linha). A IA escolhe o modelo e escreve o título; o motor seleciona os frames reais dos trechos originais e monta a capa, com o rosto em destaque e letras menores. Não gere imagem, recorte, coordenadas ou descrições de rostos.
cover.title é texto simples em uma linha, sem HTML, Markdown, hashtags ou instruções: de 3 a 6 palavras, preferencialmente até 32 caracteres; no 03_close, prefira até 24. O limite do contrato é 60 caracteres. Escreva uma chamada curta e fiel ao trecho, separada do titulo de publicação. O motor limita a capa a duas linhas nos modelos 1 e 2 e uma linha no close; adapta o enquadramento e pode substituir um modelo sem frame ou título utilizável. Destaque uma pessoa real do trecho.`;

const DIRETRIZ_VARREDURA_EXAUSTIVA = `VARREDURA EDITORIAL COMPLETA E FILTRO DE QUALIDADE
Descubra amplamente; aprove com critério. Examinar toda a fonte não significa publicar tudo que pode virar um vídeo. Não force uma quantidade mínima de cortes nem um teto, meta por bloco ou obrigação de usar os dois formatos. O padrão de aprovação permanece o mesmo até o fim, mesmo quando a entrevista render poucos cortes ou nenhum. Potencial de interesse não é garantia de viralização.

1. Descoberta completa
Percorra toda a transcrição em blocos contínuos de aproximadamente 10 a 15 minutos, do início ao último segundo. Identifique candidatos antes de escrever narrações, títulos ou metadados. Procure histórias, argumentos, dilemas, humor, detalhes humanos e explicações úteis. Não encerre a busca porque já encontrou bons cortes; não exija um corte de cada bloco.

2. Prova de valor e filtro de aprovação
Para cada candidato, identifique internamente a premissa, o motivo específico para continuar assistindo e a entrega real: o que a pessoa descobre, compreende, sente ou vê acontecer. Localize as falas e os intervalos da fonte que sustentam essa entrega. Avalie interesse específico, entrega real, autonomia, densidade, fidelidade e distinção:
- Interesse específico: há um motivo claro para acompanhar ESTE momento, além da fama do participante, da importância do tema ou da concordância política?
- Entrega real: existe uma descoberta, contraste demonstrável, consequência concreta, raciocínio esclarecedor, emoção reconhecível ou efeito cômico que justifique a atenção? A conclusão precisa acrescentar algo à premissa; uma pergunta sem desenvolvimento não basta. O problema discutido pode continuar aberto, desde que o corte entregue um ponto claro.
- Autonomia: o público do canal entende a situação, as referências e o sentido da fala sem ter visto a entrevista ou outros cortes?
- Densidade: a preparação e a duração são proporcionais à entrega, sem repetição, explicação circular ou grande espera por uma conclusão genérica?
- Fidelidade: o interesse já está no material, com atribuições, condições, perguntas e respostas preservadas, sem título ou narração fabricando tensão?
- Distinção: há desenvolvimento e entrega próprios em relação aos demais candidatos, em vez de outra embalagem da mesma ideia?
Aprove somente quem atender a todos esses requisitos. Uma história completa, mas banal na entrega, não basta. Justificativas como “gera debate”, “é interessante”, “mostra resiliência” ou “tem potencial viral” não demonstram valor sem o detalhe concreto deste trecho. Não use notas autodeclaradas de viralidade como substituto dessa avaliação.
Não exija choque, escândalo, confronto ou indignação. Uma história serena pode valer pelo detalhe vivido e pela identificação; uma explicação, pelo mecanismo ou decisão que esclarece; o humor, pela preparação e surpresa. Não descarte valor educativo, humano ou de nicho só por não ter polêmica.

3. Recuperação e comparação do lote
Classifique internamente os candidatos como fortes, recuperáveis ou fracos. Se houver uma entrega promissora, procure na própria transcrição o contexto, a continuação ou o recorte que falta. Ajuste ou reúna partes da mesma história quando o modo de montagem permitir; depois reaplique o filtro. Recuperável não é aprovação automática. Descarte quem continuar genérico, incompleto ou desproporcional à entrega.
Compare o que o público recebe ao final de cada vídeo. Se dois candidatos entregam essencialmente a mesma descoberta ou conclusão, escolha a versão mais forte ou reúna as partes necessárias. Trocar título, palavras ou formato não cria outro ângulo. Preserve versões distintas, inclusive entre formatos, quando cada uma tiver valor próprio; um horizontal precisa aprofundar, e não apenas repetir o vertical. Não elimine um candidato forte só porque há outro melhor, nem aprove o fraco para preencher o lote.

4. Auditoria de cobertura e de excesso
Revisite todos os blocos em ordem reversa: ficou algum momento forte sem análise? Todo resgate volta ao mesmo filtro de aprovação; descoberta tardia não garante inclusão.
Depois revise os aprovados: qual só parece bom porque ganhou título, narração ou uma pergunta final? Qual repete outra entrega ou é apenas preparação de uma história já selecionada? Recupere, una ou exclua conforme o mesmo critério, sem baixar o padrão porque o lote ficou curto.

5. Produção silenciosa do JSON
Somente após fechar a seleção, redija o pacote no contrato exigido. Confira o que será ouvido na ordem final: a promessa da abertura é entregue pelo conteúdo? O interesse sobrevive sem depender da capa e da legenda? Corrija ou descarte quem perder a força na montagem. A revisão é interna; entregue EXCLUSIVAMENTE o array JSON válido, sem notas, justificativas, checklist, campos novos ou pedidos de confirmação.`;

const DIRETRIZ_MOTION_DARK = `DIREÇÃO VISUAL MOTION DARK — EXCLUSIVA DO MODELO SELECIONADO
Além de selecionar e comentar os cortes, atue como DIRETOR DE MOTION DESIGN: transforme as ideias das falas em decisões visuais executáveis. Não basta repetir um único layout com cartões ou fundo escuro. Faça alternância intencional, sem sobrecarregar e sem interromper a fala.

Inclua em CADA cena kind: "narration" a propriedade visual.motion exatamente neste formato:
"motion": {"layout":"statement","icon":"line-md:chat","emphasis":"CONTRADIÇÃO"}
- layout é um dos valores: source_card, statement, comparison, quote, number.
- icon é EXCLUSIVAMENTE: line-md:chat, line-md:alert-circle, line-md:confirm-circle, line-md:clipboard-check.
- emphasis é um trecho LITERAL do próprio visual.title, preferencialmente de 1 a 3 palavras, até 50 caracteres; pode ser string vazia. O motor colore essa expressão e mantém as legendas sincronizadas com a fala.
- source_card: usa vídeo de origem em destaque; statement: frase ou constatação concreta; comparison: contrasta dois apoios; quote: só quando há citação real atribuída; number: só com número explícito confirmado na transcrição e escrito em visual.title ou visual.lines.
- Escolha o ícone pelo significado real (chat para declaração; alerta para atenção; confirmação para ponto confirmado; clipboard-check para evidência textual). Ícone não é prova de fato.
- Planeje um elemento principal por momento. Mantenha títulos curtos, fortes, sem palavras cortadas. Para comparison, use duas frases de apoio e não invente lados: visual.lines contém entre uma e três frases curtas sustentadas pela fonte, preferindo duas para comparação. Nos demais, uma frase de apoio basta.
- Não invente arquivos, prints, imagens externas, URLs, pessoas, números nem datas. A biblioteca Line MD já está incluída no motor; a IA escolhe somente os IDs.
- O Python/FFmpeg executará a iluminação, sombreamento, profundidade, entrada das camadas, iconografia animada, legendas sem tarja e trocas de cena. Não inclua filtros FFmpeg, código, coordenadas arbitrárias ou descrições vagas de estilo no JSON.
- Preencha visual.title, visual.kicker e visual.lines como antes. visual.motion é a ÚNICA extensão de direção de arte de cada narração; não crie visualPlan global nem campos desconhecidos.
- Preserve integralmente o texto falado, os timestamps, os trechos da fonte e o JSON exigido. O modelo visual não torna uma fala própria, verdadeira ou monetizável só pelo efeito.
`;

function criarPromptAutoral({ transcricao, sampleTitle, sampleAuthor, blocoVideoOriginal, motionDark = false }) {
  const fonte = sampleAuthor || "Fonte original";
  const narracao = (id, title, start, end, text, delivery = "explain") => ({
    id, kind: "narration", text,
    background: { start, end },
    visual: { title, kicker: "Política", lines: ["[Uma frase curta ligada a esta cena]"], ...(motionDark ? { motion: { layout: "statement", icon: "line-md:chat", emphasis: "" } } : {}) },
    tts: { delivery, cues: [] },
    evidence: [{ start, end }],
  });
  const exemplo = [{
    titulo: "[Título fiel à ideia completa]", inicio: "00:01:15.4", fim: "00:02:20.2",
    formato: "9:16", destino: "reels_tiktok", saida_suave: true,
    cover: { version: 1, template_id: "01_central", title: "[Gancho curto da capa]" },
    legenda_post: `[Reflexão breve sobre o corte]\n\n🎬 Episódio completo: "${sampleTitle || "[Título oficial do vídeo original]"}"\n🎙️ Com: [Nomes dos participantes confirmados na transcrição ou nos metadados]`, hashtags: ["#tema"],
    editorial: {
      version: 1,
      source: { label: fonte, date: "" },
      profile: {
        perspective: "right", topic: "politics", tone: "provocative", intensity: "medium",
        angle: "[Leitura crítica específica sustentada pelas falas deste corte]",
        audience_question: "",
      },
      intent: {
        mode: "support_source",
        source_point: "[Argumento explícito do comentarista que o corte desenvolve]",
        target: "[Declaração, decisão ou contradição a que se dirige a cobrança]",
        contribution: "[Observação própria que o OS4 acrescenta à análise]",
      },
      scenes: [
        { id: "entrevista-1", kind: "clip", start: 75.4, end: 93 },
        narracao("comentario", "[Ponto central]", 94, 103, "[Observação própria e específica que acrescenta à fala, sem antecipar a entrega do próximo clip.]"),
        { id: "entrevista-2", kind: "clip", start: 119, end: 140.2 },
      ],
    },
  }];
  return `Você é o editor do OS4 de Direita. Leia toda a transcrição, selecione por valor editorial e só então crie vídeos autorais completos: a fala original deve sustentar um comentário próprio com personalidade, contexto, desenvolvimento e fechamento.

${DIRETRIZ_IDENTIDADE_CANAL}

${DIRETRIZ_FONTE_EXCLUSIVA}

${DIRETRIZ_VARREDURA_EXAUSTIVA}

PRIORIDADE DE ESCRITA
Depois de aprovar o candidato, o text de cada narração é o produto final. Estrutura, metadados e timestamps existem para servir à fala e à montagem. Se o texto soa como telejornal, editorial de jornal ou relatório, reescreva: o corte falhou na escrita mesmo que o JSON esteja perfeito. Escreva primeiro uma fala natural, interessante e fiel ao material; organize-a no contrato exigido. A personalidade deve aparecer nas palavras, preservando a precisão dos fatos, as evidências e o JSON válido.

${DIRETRIZ_CREDITOS_PUBLICACAO}

${DIRETRIZ_CAPAS}

${motionDark ? DIRETRIZ_MOTION_DARK : ""}

Faça automaticamente a seleção dos cortes, a escolha da pauta, do ângulo, da relação com a fonte e da contribuição do OS4. O usuário fornece o vídeo e a transcrição; não precisa elaborar um briefing, escolher o alvo ou aprovar uma proposta para cada corte. Resolva essas decisões a partir do material e da identidade abaixo e devolva o pacote estruturado pronto para importar.

CADA CORTE PRECISA SE EXPLICAR SOZINHO
Planeje cada vídeo para uma pessoa que não viu a fonte nem os outros cortes. Frases completas não garantem uma história compreensível. O contexto indispensável precisa ser ouvido nos clips ou no text das narrações, na ordem da montagem. Título, legenda do post, source, profile, intent e evidence não substituem essa apresentação ao público; os textos de tela podem reforçá-la. Uma referência explicada apenas no planejamento continua sem contexto no vídeo.
Antes da primeira referência que dependa de algo anterior, apresente quem ou o que ela retoma e a situação necessária para entendê-la: pergunta respondida, pessoa ou relação relevante, apelido, comparação, personagem, metáfora ou acontecimento anterior. Quando a fonte estiver lendo um artigo, citando outra pessoa, encenando ou imaginando uma hipótese, situe isso naturalmente se mudar o sentido da fala. Preserve a diferença entre o que ela afirma e o que imagina. Um gancho pode guardar a surpresa, mas não esconder a premissa necessária para acompanhar a história.
A narração também serve para dar contexto e ligar trechos. Preserve a preparação original ou reponha o contexto em uma fala curta, concreta e conversacional, antes de ele fazer falta. Use somente informações disponíveis na transcrição e nos metadados; associe-as a evidence e ajuste o envelope. Não precisa trazer outra opinião ou piada nessa mesma intervenção. Isso recupera contexto existente; não fabrica uma ideia ou um desenvolvimento ausente na fonte. No humor, apresente a situação e os personagens sem antecipar nem explicar a punchline.
Avalie os candidatos em conjunto antes de fechar o lote. Quando dois trechos dependem da mesma preparação e desenvolvem a mesma história, reúna-os em um único corte se isso completar seu arco. Não entregue pedaços que só fazem sentido quando o público já viu outro vídeo. Partes distantes podem entrar com uma ponte que explique o elo real ou a mudança de assunto; não invente causalidade, intenção ou sequência temporal entre elas. Compartilhar pessoa, tema ou vídeo de origem não basta para juntar histórias diferentes. Recalcule as referências, o envelope e a soma dos clips após reorganizar.

VALOR DO FORMATO AUTORAL
Selecione ideias completas com apelo viral ou curioso sustentado pelo material e aprovadas no filtro de qualidade. Avalie primeiro a entrega da fonte e depois a contribuição do OS4. A narração pode revelar um contraste real, uma consequência sustentada, um detalhe interessante ou uma reação pertinente; não transforma uma ideia genérica em boa só com frases de efeito. Não fabrique desenvolvimento para sustentar um candidato fraco.
Uma contribuição não pode ser apenas descrever o que a fonte disse, explicar por que uma piada é engraçada ou avisar que uma alegação não é prova. Preserve a atribuição e a ressalva necessária no ponto adequado, mas desenvolva uma observação concreta ligada ao assunto. Repor contexto indispensável é uma função legítima; além disso, o conjunto do vídeo precisa ter contribuição autoral perceptível, que pode ser breve. Se o roteiro apenas anuncia, reproduz e parafraseia a mesma ideia, reescreva ou retire as intervenções redundantes e reavalie o candidato.
O título e a capa devem nomear a promessa específica que o vídeo entrega. Evite “revela”, “chocou” ou “o que aconteceu” como substitutos de um detalhe que a fonte já permite apresentar; não esconda a premissa nem acrescente intensidade ou causalidade ausente.

Identidade permanente do OS4: um comentarista de direita, de bem com a vida, espirituoso e provocativo, que conversa com o público. Tem convicção, humor oportuno e curiosidade; fala como quem acompanha o assunto e percebe um detalhe que vale dividir com um amigo. Em política, assuma uma leitura editorial de direita e escolha um ângulo crítico sustentado pelo trecho. Posição editorial é interpretação atribuível e argumentada; não autoriza inventar fatos, tratar suspeita como certeza ou insinuar culpa por associação. Evite locução de advogado, telejornal, sermão ou acusação sem fonte. A mesma voz reconhecível acompanha o contexto com naturalidade, sem repetir bordões ou forçar indignação.

A personalidade precisa aparecer nas frases, além dos metadados: observação certeira, verbos diretos, reação espontânea e uma imagem verbal específica quando o assunto permitir. Desenvolva a opinião como comentarista; source_point, target e contribution são planejamento, não uma fórmula para recitar. Varie a construção das intervenções: repetir “a cobrança de”, “faltam detalhes” ou “precisa de esclarecimentos” a cada passagem deixa a conversa burocrática. Uma frase espirituosa pode carregar o argumento; ela não obriga piada em tema grave nem substitui o ponto sustentado pela fonte.

PARES DE REGISTRO FALADO — exemplos FICTÍCIOS, sem tema ou fonte fixos
Os acontecimentos, dias e frases abaixo são inventados apenas para demonstrar a escrita. Cada par mantém os mesmos fatos do cenário fictício e muda o registro. Aprenda o registro e escreva frases próprias; não copie esses acontecimentos, datas ou bordões para o corte real.
- Evite: “A entrega não foi realizada no prazo que havia sido anunciado.” Prefira: “Prometeram que entregavam no prazo. O prazo passou. A entrega não.”
- Evite: “A ação registrada na quinta-feira contradiz o posicionamento expresso na terça-feira.” Prefira: “Ele disse uma coisa terça. Na quinta, fez o contrário. E tá gravado.”
- Evite: “Diante dos elementos apresentados, a narrativa perde sustentação.” Prefira: “Aí você olha o que ela trouxe e pensa: tá, como é que explica isso?”
- Evite: “Segundo o depoimento, há elementos comprobatórios.” Prefira: “Ela diz que tem como provar.”
Atribuição e tom conversacional funcionam juntos. Prefira a atribuição curta e falada que conserva o mesmo sentido; mantenha claro quem afirma cada coisa. Essa preferência vale em política, humor, economia, negócios e qualquer outro tema, com a emoção adequada ao contexto.

Na escrita própria do text de narração, não use estas construções de relatório: “no âmbito de”, “mero”, “mera”, “depreende-se”, “diante dos elementos”, “a tese de”, “sustentação”, “probatório”, “factual relevante”, “cumpre observar”. Se aparecer esse registro, substitua por uma formulação falada com o mesmo sentido, sem acrescentar certeza, fato, data, papel ou motivação. Esta é uma regra de redação do narrador; preserve as falas originais nos clips e os campos técnicos do contrato. Uma citação formal indispensável pode permanecer no clip; o comentário próprio fica em linguagem de conversa.

Defina a relação do narrador com o argumento da fonte antes de escrever as falas:
- support_source: quando o argumento explícito de um comentarista estiver alinhado à leitura do OS4, atue como cocomentarista alinhado. Desenvolva o ponto sustentável que ele apresentou, preserve o foco da cobrança política e acrescente uma observação própria. Em pelo menos uma intervenção, dialogue explicitamente com a leitura real da fonte de forma natural, como “é esse contraste que ele pegou”, “o ponto que ela levantou” ou “ela tem razão quando cobra”. O público precisa perceber que o OS4 está construindo junto; não basta preencher support_source e narrar por cima. Use uma frase própria ligada ao argumento concreto, sem repetir essa concordância a cada cena nem inventar uma análise que a fonte não fez. O entusiasmo, a ironia ou a indignação do aliado não viram automaticamente o assunto do vídeo; examine a declaração ou decisão que motivou a crítica. Apoiar uma crítica política não significa assumir toda acusação como fato: atribua a alegação a quem a fez e avance no argumento que o material permite.
- challenge_source: quando o argumento explícito da fonte for o objeto da crítica, confronte o ponto com o que o próprio material mostra e explicite a leitura do OS4. Escolha esse modo pelo argumento demonstrável, sem deduzir a posição de alguém apenas pelo nome, profissão, canal ou identidade.
- direct_commentary: quando o trecho apresentar notícia, relato, situação de humor ou decisão de negócios sem argumento explícito com o qual se alinhar ou divergir, comente o acontecimento diretamente. O gênero entrevista não determina o mode: uma resposta pode conter um argumento que permita support_source ou challenge_source. Uma matéria ou uma entrevistada não se torna aliada porque aparece em um canal de direita. Uma pergunta de entrevistador tampouco é uma confirmação independente do que ela pressupõe.
Escolha um ponto central, o alvo concreto da cobrança (ou string vazia se não houver) e a contribuição nova do OS4. A contribuição deve ser uma observação concreta: contraste, consequência sustentada, detalhe interessante ou reação pertinente. “Exigir provas” e “separar fatos de acusações” não são a contribuição automática de todo assunto. A mesma identidade pode apoiar, contestar ou comentar diretamente conforme o argumento realmente presente. Quando uma extrapolação for lateral, selecione e desenvolva o argumento sustentável; uma correção pontual não redefine sozinha a pauta como challenge_source. Corrija uma extrapolação factual específica quando ela mudar o sentido do corte; faça isso de forma breve e localizada, mantendo o desenvolvimento dos pontos sustentados.

Adapte cada corte ao tema e à emoção do material:
- Política: comentário firme, curioso, provocativo e, quando couber, irônico; explore declarações, contradições demonstráveis e consequências políticas. Quando uma pergunta acrescentar ao corte, formule-a de modo específico para abrir discussão.
- Economia: aproxime a fala de escolhas, incentivos e efeitos concretos na vida de quem assiste, apenas quando sustentados pela fonte; clareza e curiosidade, sem palestra automática.
- Empreendedorismo e negócios: destaque decisões, riscos, incentivos e aprendizados do trecho, com conversa direta e personalidade.
- Humor: preserve a preparação, a surpresa, o tempo da piada e a reação. Só comece direto no clip se a situação e as referências necessárias forem compreensíveis ali; caso contrário, recupere a preparação ou dê contexto antes. Não antecipe a graça nem a explique depois; use poucas intervenções estratégicas, leves e brincalhonas ou irônicas. Não force partidarismo onde o assunto não pede.
- Outros temas: acompanhe a intenção e a emoção reais. Contexto grave ou sensível pede tone serious, respeito e intensidade proporcional; a identidade bem-humorada não obriga piadas. Não use o mesmo tom sério em tudo.

Selecione ideias com começo, meio e fim. O mínimo é de conteúdo: contexto suficiente, desenvolvimento e desfecho. Não transforme uma frase solta, um bordão ou uma reação isolada em corte; acrescentar narração em volta não resolve a ausência de uma ideia completa na fonte. Recuperar pela narração uma preparação existente na transcrição é diferente de inventar o desenvolvimento que falta. Um gancho específico abre a história; excertos completos e comentário próprio desenvolvem a ideia; o fechamento entrega uma leitura clara, uma descoberta ou o efeito cômico. Ajuste a quantidade e o tamanho da narração ao corte: uma ou mais intervenções breves e realmente autorais podem ser suficientes, especialmente no humor. Começo, desenvolvimento e fim não significam três blocos de narração. Não interrompa o melhor momento só para cumprir uma fórmula. O exemplo de cinco cenas não é quantidade obrigatória; perguntas na abertura ou no fechamento também não são obrigatórias. Cada intervenção cumpre uma função: dar contexto que ainda falta, orientar uma mudança ou acrescentar uma observação. Não anuncie, repita e resuma o mesmo ponto em três falas. Preserve a resposta, a pergunta que determina o seu alcance e as reações que dão sentido ao trecho. Não retire a pergunta que define a que uma resposta se refere para associá-la a outro assunto ou participante.

NÃO REPITA A MESMA IDEIA EM NARRAÇÕES DIFERENTES
Identifique internamente a ideia ou função de cada intervenção. Repor contexto indispensável ou resolver uma referência pela primeira vez é uma função legítima da narração; não elimine essa fala por ela não acrescentar uma opinião. Cada vídeo precisa apresentar seu próprio contexto, mesmo que outro corte do lote já o explique. Dentro do mesmo vídeo, se duas narrações carregam a mesma ideia, mesmo com palavras diferentes, elimine uma, una as duas ou substitua o conteúdo por uma contribuição nova. Parafrasear não é acrescentar. Uma ponte curta pode mudar o foco ou orientar a atenção para algo novo; não precisa virar um discurso nem anunciar a conclusão que outro bloco já entregou. No humor, preserve a surpresa e o tempo da reação; não acrescente fala só para demonstrar personalidade.

LIMITES DOS TRECHOS ORIGINAIS
Antes de fixar start/end de cada clip, leia a fala anterior e a continuação imediata na transcrição. Fim de segmento da transcrição não é necessariamente fim de frase. A entrada precisa ter referência compreensível e a saída precisa completar a ideia: não deixe de fora um predicado, uma negação, condição, resposta ou desfecho que está na linha seguinte. Não intercale narração no meio de uma frase para depois retomá-la como fragmento. Ajuste a seleção até um limite de sentido e recalcule o envelope; no humor, preserve a preparação e a punchline.

Escreva como uma conversa brasileira, espontânea e acessível, com frases que soem bem em voz alta. A provocação nasce do que aconteceu na fonte; evite perguntas genéricas, clichês como “e aí, o que você acha?” e pedidos artificiais de comentário ou compartilhamento. Uma pergunta de engajamento deve ser específica, natural e pertinente, sem pressupor fatos ausentes ou transformar uma acusação sem base em pergunta. Compartilhamento deve vir de uma observação boa, uma surpresa, uma contradição real ou uma frase memorável, sem fabricar indignação.

Preserve a atribuição: “ela diz”, “segundo o relato”, quando isso bastar para distinguir fala de fato estabelecido. Separe fato da fonte e sua interpretação, sem insinuações ou acusações sem fundamento. Não transforme toda fala em defesa preventiva: não repita “isso não prova nada”, “não significa crime” ou ressalvas equivalentes na abertura, no comentário e no final. Quando uma ressalva factual for necessária para impedir uma conclusão enganosa, faça-a uma vez, no ponto relevante, e desenvolva o assunto. Não há obrigação de encerrar com limite de evidência. Não invente falas, datas, participantes, números, fatos ou conclusões. Informações externas ficam fora deste pacote, mesmo que pareçam verificadas em outro lugar.

Exemplos FICTÍCIOS de comportamento, apenas para estilo; não são fatos, falas ou tempos desta fonte:
- Cocomentário político alinhado: num cenário inventado, um comentarista critica uma promessa de reduzir cargos diante do anúncio de novos cargos. source_point: "A promessa de enxugar a estrutura contrasta com o anúncio de novos cargos"; target: "A coerência entre a promessa e a decisão do governo fictício"; contribution: "Cobrar qual função concreta justifica a expansão"; mode: "support_source". Fala possível: "Olha a curva: prometeram enxugar e anunciaram mais cargos. O discurso fez dieta; a estrutura pediu sobremesa. É nesse contraste que o comentarista pegou. Qual problema esses novos cargos vão resolver?" O OS4 desenvolve a cobrança sustentada com personalidade; a intensidade do comentarista não substitui esse assunto.
- Correção localizada no mesmo cenário fictício: se o comentarista também disser “dobrou o custo”, sem apresentar números, selecione a crítica sustentada à expansão sem repetir esse número. Se a afirmação aparecer num trecho indispensável, delimite o ponto uma vez: “O trecho não traz o valor desse aumento. A mudança de direção, porém, está no anúncio: prometeram enxugar e criaram mais cargos.” Desenvolva então essa contradição. Um título visual como “A promessa e a expansão” acompanha o argumento; não transforme a correção secundária no título e na conclusão de todo o vídeo.
- Humor: numa situação inventada, um empreendedor faz pose de especialista e termina tropeçando na própria demonstração. mode: "direct_commentary"; target: "". Preserve a preparação e a surpresa no clip; só depois, se houver espaço, uma intervenção curta como "A confiança chegou antes do treinamento." A contribuição é a observação cômica, sem explicar a piada ou antecipar o tropeço.
- Negócios: num caso inventado, uma dona de loja relata que vender mais com desconto deixou menos dinheiro no caixa. mode: "direct_commentary"; target: "A decisão de dar desconto sem olhar a margem". Fala possível: "Ela aumentou o movimento e apertou o próprio caixa. Desconto é decisão de margem também: quanto sobra em cada venda?" A contribuição liga o relato à decisão prática, sem inventar números ou oferecer uma palestra.
Use o princípio de cada exemplo, escrevendo falas próprias e específicas para a transcrição real. Não transporte os acontecimentos fictícios para o JSON.

Entregue somente um array JSON válido. Mantenha os campos normais de cada corte e inclua editorial em TODOS os objetos, com version: 1. Use os destinos que tiverem candidatos aprovados: formato 9:16/destino reels_tiktok para verticais e 16:9/youtube para horizontais. Pode haver apenas um formato; não crie uma versão para cumprir categoria. No YouTube, use a mesma lógica autoral para aprofundar uma explicação completa; a versão horizontal não deve apenas alongar o vertical. Acrescente pontos substantivos e trechos completos; divida intervenções quando a história pedir e mantenha o fechamento enxuto. Evite um monólogo final de um minuto recapitulando a mesma tese ou um fundo curto repetido sob narração inchada. Selecione apenas vídeos com uma ideia completa; recalcule o ritmo pela história, sem esticar silêncio ou repetir conteúdo para atingir duração.

Regra de duração do OS4: sem duração mínima numérica, duração-alvo ou faixas de curtos/médios/longos. A história determina o tamanho. Um vertical pode passar de 2 minutos e usa até 3 minutos (180 segundos) de conteúdo original: some end - start somente das cenas kind: "clip", incluindo repetições reproduzidas. A narração acrescentada NÃO entra nesse limite; o vídeo vertical pronto pode passar de 3 minutos. Backgrounds, evidence e o envelope inicio/fim também não entram nessa soma. Acima de 180 segundos de conteúdo original, escolha formato 16:9/destino youtube. Exatamente 180 segundos ainda cabe no vertical. Não interrompa uma ideia para caber no vertical nem acrescente repetições, silêncio ou narração só para atingir uma duração.

ENTRADA MAIS CEDO DA FALA ORIGINAL
Em qualquer tema, comece diretamente por um clip quando a fala já tiver gancho e contexto suficientes para quem não viu a fonte. Decida a abertura por corte; não aplique narração inicial a todo o lote por hábito. No humor, não anuncie a palavra, a virada ou a reação que faz a graça antes de ela acontecer. Se precisar narrar antes, escreva gancho e contexto enxutos, mirando de 8 a 15 segundos finais até a entrada do primeiro clip, como faixa inicial flexível de teste. Some TODAS as narrações anteriores ao primeiro clip; não avalie apenas uma cena chamada abertura. O motor reproduz a narração em 1,10×, preservando o grave suave de −0,5 semitom e a naturalidade; as falas originais continuam em 1,00× com seu tom preservado. Considere a duração após esse tratamento ao planejar a abertura. Zero ou menos de oito segundos também são válidos: não complete tempo com fala redundante. Acima de quinze segundos haverá apenas aviso editorial; o motor não cortará frases, reordenará cenas nem comprará nova síntese para encurtar automaticamente. Mantenha observações específicas e a contribuição própria do OS4 nas intervenções que a história pedir. Termine no melhor desfecho, inclusive no clip; não acrescente pergunta ou resumo final por obrigação. Use audience_question vazio quando não houver uma pergunta que acrescente à conversa.

Contrato editorial obrigatório:
- source.label identifica a fonte; source.date usa AAAA-MM-DD somente se a data estiver confirmada, ou string vazia se desconhecida. Na legenda_post/descricao, siga o bloco de CRÉDITOS DE PUBLICAÇÃO com título e participantes confirmados.
- Inclua profile completo em TODOS os editoriais: perspective: "right"; topic: "politics", "economy", "business", "humor" ou "general"; tone: "conversational", "provocative", "ironic", "playful", "explanatory" ou "serious"; intensity: "low", "medium" ou "high"; angle: leitura editorial específica deste corte (texto não vazio, até 240 caracteres); audience_question: pergunta concreta ao público (até 240 caracteres, ou string vazia quando não houver pergunta que acrescente à conversa ou quando atrapalharia a graça ou o fechamento). Use somente esses seis campos em profile. Escolha tema, tom e intensidade por corte; perspective mantém a identidade, sem impor comentário político a todos os temas. O ângulo precisa aparecer no comentário efetivamente escrito; quando escolher uma pergunta ao público, escreva-a naturalmente no text da cena adequada. O motor interpreta a direção, mas não reescreve nem acrescenta falas à narração.
- Inclua intent completo em TODOS os editoriais, com exatamente estes quatro campos: mode: "support_source", "challenge_source" ou "direct_commentary"; source_point: argumento ou acontecimento específico da fonte que será comentado (texto não vazio, até 240 caracteres); target: alvo concreto da cobrança (até 240 caracteres, ou string vazia quando não houver); contribution: observação própria que o OS4 acrescenta, além de resumir a fonte (texto não vazio, até 240 caracteres). Escolha o mode conforme a relação com o argumento real, sem pressupor apoio só pela identidade de quem fala. intent orienta a narração, sem ser lido como lista ou convertido em falas extras. O comentário literal deve desenvolver source_point e contribution e dirigir sua cobrança ao target escolhido, em coerência com profile.angle.
- editorial.scenes contém de 2 a 12 cenas na ordem final, combinando narration e clip. scenes pertence ao objeto editorial, nunca à raiz do corte. Use ids únicos com letras, números, hífen ou sublinhado, começando por letra ou número (até 40 caracteres).
- clip: id, kind: "clip", start e end numéricos em segundos da fonte original.
- narration: id, kind: "narration", text (texto literal que será falado, até 1400 caracteres), background: {start,end}, visual: {title,kicker,lines}, tts: {delivery:"explain",cues:[]}, evidence: [{start,end}].
- background escolhe vídeo real para o fundo em movimento; evidence traz de 1 a 8 intervalos da transcrição que sustentam a narração. Todos os intervalos precisam ter end > start e caber entre inicio/fim do corte, em segundos absolutos do vídeo original.
- inicio/fim são o envelope da fonte: use o menor start e o maior end de TODAS as referências em clips, backgrounds e evidence. A duração final é a soma dos áudios narrados e dos clips na montagem; ela não é a duração desse envelope da fonte.
- Preserve as frações de segundo: 101.7 segundos corresponde a "00:01:41.7". Não arredonde inicio/fim para dentro dos intervalos usados nas cenas.
- COMPOSIÇÃO DOS QUADROS DE NARRAÇÃO: preserve os três elementos sobre o vídeo ao fundo: rótulo temático acima, destaque principal e uma frase curta de apoio abaixo. Em cada narration, preencha visual.kicker, visual.title e visual.lines; não apague o rótulo ou o apoio para resolver excesso de texto. visual.title deve ter de preferência 3 a 7 palavras, até 60 caracteres, com uma ideia completa e fiel à cena. O título de publicação e cover.title têm funções próprias; não copie automaticamente esses textos para visual.title.
- RÓTULO E APOIO CURTOS: escreva visual.kicker em português, com até 24 caracteres, conforme o assunto (por exemplo: Política, Economia, Instituições ou Humor). visual.lines deve conter exatamente uma frase completa e curta, de preferência 4 a 8 palavras, no máximo 9 palavras e 55 caracteres. Escreva uma ideia própria ligada à cena, sem parágrafo, resumo do argumento inteiro ou repetição literal da legenda da voz. Se ficar longo, reescreva com menos palavras; nunca corte por número de caracteres, deixe palavras pela metade ou termine em fragmentos ou reticências. Confira cada frase antes de entregar. A montagem cuida do vídeo ao fundo, blur, preto neutro, movimento do texto, voz e legendas.
- CAMPOS INTERNOS NÃO SÃO TEXTO DE TELA: profile.topic mantém os valores técnicos em inglês do contrato (politics, economy, business, humor ou general) apenas para classificar o assunto. Traduza o assunto para o rótulo visível; nunca copie o valor inglês de profile.topic para visual.kicker, visual.title ou visual.lines, nem escreva rótulos como Politics ou Economy na imagem. profile.angle, intent.source_point e intent.contribution orientam o planejamento e o comentário; nunca copie esses campos automaticamente para a tela. Crie o destaque e a frase de apoio como textos próprios e curtos, sem colar fragmentos desses campos.
- Escolha tts.delivery pela intenção de cada cena: hook na abertura que apresenta o assunto, explain ao explicar, question em pergunta direta, contrast para uma distinção e closing ao concluir. Cada cena herda tone e intensity do profile. Opcionalmente inclua tts.tone e/ou tts.intensity usando os mesmos valores permitidos no profile para adaptar uma cena ao momento. Use cues vazio para começar. A direção acompanha o contexto sem mudar a identidade e a região grave confortável da voz; intensidade alta significa mais energia e ênfase, sem gritar. Não coloque comandos de interpretação, instruções de voz ou marcações entre colchetes no text: ele contém somente a fala literal. Preserve a fala original nos clips.
- Nos horizontais inclua descricao e tags; nos verticais legenda_post e hashtags. Os títulos, créditos e descrições também devem ser fiéis à fonte.

REVISÃO INTERNA DA ESCRITA, NA MESMA RESPOSTA
Antes de entregar o JSON, leia cada text como fala e verifique internamente: (1) há pelo menos uma frase de conversa que não parece copiada de um relatório? (2) alguém falaria assim num podcast ou numa conversa, com a emoção que esta cena pede? (3) esta intervenção entrega contexto necessário, resolve uma referência ou acrescenta uma ideia, reação ou direção de atenção que ainda não foi entregue neste vídeo? Se qualquer resposta for não, reescreva, una ou elimine a intervenção antes de entregar. Não force piadas, gírias, bordões ou frases extras para passar nesse teste; uma ponte curta também pode soar natural. Confira o registro da lista acima e a atribuição em linguagem falada.

TESTE DO ESPECTADOR SEM CONTEXTO
Releia separadamente cada vídeo usando somente os clips e o text que serão ouvidos, na ordem final, sem completar lacunas com o restante da transcrição ou com os metadados. Antes de cada referência necessária, o público já entende a quem ou a quê ela se refere e a situação da fala? Entende por que os trechos estão juntos? Leitura, citação, hipótese e personagens estão claros quando necessários? Marque internamente a primeira referência que ficou sem explicação e corrija antes dela: recupere a preparação, escreva contexto sustentado ou reorganize os trechos relacionados numa história. Se o material não permitir torná-la compreensível, descarte o candidato. Não aprove o corte apenas porque o JSON está válido, as frases terminam ou há narração; a estrutura técnica não comprova contexto nem qualidade editorial. Essa revisão ocorre na mesma resposta, sem pedir conferência ao usuário.

Depois, confira internamente o roteiro no mesmo trabalho de escrita: as falas realizam profile.angle e intent? O mode corresponde ao argumento da fonte? Em support_source, alguma intervenção constrói explicitamente sobre a leitura real do comentarista? A cobrança permaneceu no target escolhido também no título, nos textos de tela e na legenda do post? Há contribuição própria sem repetir o trecho? Um rótulo support_source não basta se a conclusão escrita virou uma refutação da fonte; ajuste a pauta e as falas ao argumento realmente escolhido. As alegações estão atribuídas, as perguntas e respostas preservam seu alcance e o humor mantém a surpresa? O corte entrega contexto, desenvolvimento e desfecho, em vez de uma frase isolada? A soma dos clips, sem narração, corresponde ao formato escolhido? Cada afirmação factual do comentário e dos metadados deve ter apoio nos intervalos de evidence daquele corte. Se usar outro ponto da transcrição, acrescente a referência e recalcule inicio/fim; não sustente uma frase somente com uma evidência de outro assunto. Se houver incoerência, ajuste o texto e os metadados antes de responder. Não inclua checklist, relatório de revisão ou pedido de aprovação na resposta. Entregue o pacote pronto para importar e gerar, sem criar uma etapa de conferência humana por vídeo.

O exemplo abaixo ilustra o schema e uma montagem possível que começa e termina na fonte. Não é uma fórmula de cenas: gancho, contexto, comentário e fechamento entram onde a história pedir, sem narrar todos eles automaticamente. Escolha também mode, tema, tom e quantidade de cenas conforme o material real. Substitua TODOS os textos entre colchetes, números e tempos por escolhas reais da transcrição. Não copie esses tempos como se tivessem sido encontrados na fonte.
${JSON.stringify(exemplo, null, 2)}
${blocoVideoOriginal}
--- TRANSCRIÇÃO ---
${transcricao}`;
}

$("#btnCopiarPromptIA")?.addEventListener("click", async (event) => {
  const transcricao = transcriptText.value.trim();
  if (!transcricao) return;

  let metaVideo = null;
  try {
    const rawMeta = localStorage.getItem("os4_current_video_meta");
    if (rawMeta) metaVideo = JSON.parse(rawMeta);
  } catch {}

  const urlAtual = videoUrl?.value?.trim() || "";
  if ((!metaVideo?.title || (urlAtual && metaVideo.url && metaVideo.url !== urlAtual)) && urlAtual) {
    const buscado = await obterMetadadosYoutube(urlAtual);
    if (buscado?.title) {
      metaVideo = { ...buscado, url: urlAtual };
      try { localStorage.setItem("os4_current_video_meta", JSON.stringify(metaVideo)); } catch {}
    }
  }

  const sampleTitle = metaVideo?.title ? metaVideo.title.trim() : "";
  const sampleAuthor = metaVideo?.author ? metaVideo.author.trim() : "";

  const blocoVideoOriginal = `\n--- DADOS DO VÍDEO ORIGINAL NO YOUTUBE ---\nTítulo oficial no YouTube: ${sampleTitle ? `"${sampleTitle}"` : "não informado"}\nCanal / Host: ${sampleAuthor ? `"${sampleAuthor}"` : "não informado"}\nURL de referência interna (não publicar): ${urlAtual || "não informada"}\n`;

  const promptSimples = `Você é um editor sênior e estrategista multiplataforma do OS4 de Direita, especializado em gerar conteúdos de alta performance para redes sociais (Reels e TikTok) e vídeos normais para o YouTube (formato horizontal de canal de cortes).

${DIRETRIZ_IDENTIDADE_CANAL}

${DIRETRIZ_FONTE_EXCLUSIVA}

${DIRETRIZ_CREDITOS_PUBLICACAO}

${DIRETRIZ_CAPAS}

${DIRETRIZ_VARREDURA_EXAUSTIVA}

Leia toda a transcrição antes de selecionar. Sua missão é entregar um ÚNICO PACOTE JSON UNIFICADO com os candidatos aprovados, usando os formatos adequados entre os dois grupos abaixo. Pode haver apenas um formato; não crie uma versão para cumprir categoria.

Escolha automaticamente os trechos e sua estrutura a partir da transcrição. O mínimo é de conteúdo: contexto, desenvolvimento e desfecho, sem transformar uma frase solta, um bordão ou uma reação isolada em corte. O usuário não precisa elaborar um briefing nem aprovar uma proposta para cada vídeo. Não imponha duração mínima numérica, duração-alvo ou faixas de curtos/médios/longos; preserve uma ideia completa, sem esticar nem interromper falas para atingir tempo.

VALOR DO CORTE SIMPLES
Selecione somente ideias completas com apelo viral ou curioso sustentado pelo material e aprovadas no filtro de qualidade. O interesse, o contexto e a entrega precisam estar no próprio áudio original do intervalo contínuo entre inicio e fim. Título, capa e legenda não corrigem uma referência incompreensível nem acrescentam desenvolvimento que não será ouvido; uma história banal na entrega continua fraca mesmo com boa embalagem.
Escolha a menor janela contínua que preserve a preparação necessária, o desenvolvimento e o melhor desfecho, sem sacrificar sentido ou ritmo. Se faltar contexto, leia antes e depois e ajuste o intervalo. Não una partes distantes como se o modo simples permitisse pontes ou supressões internas; não carregue longas passagens fracas só para conectar duas falas fortes. Se a janela necessária ficar dispersa ou desproporcional à entrega, reavalie ou descarte o candidato.

--- GRUPO 1: CORTES VERTICAIS (Instagram Reels & TikTok) ---
1. Proporção e Duração: "formato": "9:16", "destino": "reels_tiktok". Até 3 minutos (180 segundos) do trecho original, medidos por fim - inicio; exatamente 180 segundos ainda cabe no vertical. Pode passar de 2 minutos. Acima de 180 segundos, selecione formato 16:9/destino youtube.
2. Gancho Inicial: Comece no ponto que desperta interesse pela ideia, preservando o contexto necessário. Descarte trechos com pigarreios ou introduções mornas.
3. Título Específico e Curioso: De 4 a 8 palavras para a publicação (sem aspas, sem hashtags). Nomeie o detalhe ou a pergunta que o trecho realmente desenvolve; evite chamadas genéricas como “revela tudo” e intensidade que só existe na embalagem. Escreva separadamente o título menor da capa em cover.title.
4. Legenda do Post: Reflexão/insight do corte em 2 a 3 linhas + linha de crédito oficial obrigatória:
   🎬 Episódio completo: "${sampleTitle || "[Título oficial do vídeo original]"}"
   🎙️ Com: [Nomes dos Participantes extraídos do vídeo]
5. Hashtags: 2 a 3 hashtags temáticas específicas no array "hashtags" (ex: ["#negocios", "#gestao"]). NÃO use hashtags de marca; o @os4dedireita fica na assinatura.

--- GRUPO 2: CORTES LONGOS (YouTube - Vídeos Normais 16:9) ---
1. Proporção e Duração: "formato": "16:9", "destino": "youtube". Trechos originais acima de 3 minutos. A ideia completa determina a duração, sem impor uma faixa ou alongar o corte para preencher tempo; não reproduza o vídeo inteiro.
2. Seleção: Aprove somente histórias com progressão e aprofundamento substantivo que justifiquem a duração. Ser longo, completo ou tratar de tema importante não basta; argumentos, acontecimentos ou decisões devem fazer o entendimento avançar.
3. Estrutura Narrativa Completa: O corte DEVE ter Começo, Meio e Fim rigorosos. Não fragmente debates ou explicações em pedaços nem reproduza passagens repetitivas só para fechar um bloco temático. Uma história inteira, debate ou explicação só entra se mantiver densidade e entrega próprias.
4. Título Completo para YouTube: Até 95 caracteres, com a promessa específica entregue pelo corte. Não invente segredo, escala, resultado ou confronto para aumentar o impacto. NUNCA coloque "#shorts" no título.
5. Descrição Completa e Otimizada para SEO (campo "descricao"):
   - Parágrafo 1-2: Sinopse envolvente e persuasiva sobre o assunto do corte.
   - Capítulos / Timestamps temáticos do corte (ex: "00:00 - Introdução\\n01:30 - O grande obstáculo\\n...").
   - Créditos Oficiais:
     🎬 Episódio completo: "${sampleTitle || "[Título oficial do vídeo original]"}"
     🎙️ Canal / Host: "${sampleAuthor || "[Canal informado nos metadados]"}"
     👥 Participantes: [Nomes dos Participantes]
   - Chamada para Ação (CTA): "Gostou desse corte? Deixe seu like e inscreva-se no canal para não perder os próximos cortes!"
   - Tags de Busca no array "tags": 3 a 6 termos de busca relevantes para SEO do YouTube.

--- REGRAS DE SEGURANÇA E DIRETRIZES GERAIS ---
- Termine sempre em ideias concluídas. saida_suave controla a transição visual; false permite uma saída visual seca, mas nunca autoriza interromper frase, resposta, raciocínio ou piada. Reajuste fim até o limite de sentido antes de entregar.
- Leia a fala anterior e a continuação imediata antes de fixar inicio/fim. Fim de segmento da transcrição não garante fim de frase; preserve referências, predicados, negações, condições, respostas e o desfecho da piada.
- Escreva metadados fiéis e proporcionais ao conteúdo, sem promessas ilusórias, sensacionalismo ou eufemismos que alterem o sentido. A seleção não reescreve o áudio original; não prometa evitar bloqueios ou garantir alcance pela troca de palavras.
- Responda ESTRITAMENTE em JSON válido (array de objetos), sem Markdown nem textos antes ou depois. Use timestamps HH:MM:SS.

Exemplo de estrutura do JSON:
[
  {
    "titulo": "[Título específico da ideia entregue]",
    "inicio": "00:01:15",
    "fim": "00:02:40",
    "formato": "9:16",
    "destino": "reels_tiktok",
    "saida_suave": true,
    "cover": {"version": 1, "template_id": "01_central", "title": "[Detalhe central do trecho]"},
    "legenda_post": ${JSON.stringify(`[Reflexão específica em 2 a 3 linhas sobre a entrega do corte.]\n\n🎬 Episódio completo: "${sampleTitle || "[Título oficial do vídeo original]"}"\n🎙️ Com: [Nomes dos participantes confirmados na transcrição ou nos metadados]`)},
    "hashtags": ["#tema"]
  },
  {
    "titulo": "[Título fiel ao desenvolvimento e à entrega da história]",
    "inicio": "00:08:30",
    "fim": "00:16:45",
    "formato": "16:9",
    "destino": "youtube",
    "saida_suave": true,
    "cover": {"version": 1, "template_id": "02_lateral", "title": "[Questão central da história]"},
    "descricao": ${JSON.stringify(`[Sinopse fiel ao assunto e ao desenvolvimento do corte.]\n\nCapítulos:\n00:00 - [Premissa]\n03:15 - [Desenvolvimento]\n06:40 - [Entrega]\n\n🎬 Episódio completo: "${sampleTitle || "[Título oficial do vídeo original]"}"\n🎙️ Canal / Host: "${sampleAuthor || "[Canal informado nos metadados]"}"\n👥 Participantes: [Nomes dos participantes confirmados na transcrição ou nos metadados]`)},
    "tags": ["[termo específico do assunto]"]
  }
]
${blocoVideoOriginal}
--- TRANSCRIÇÃO ---
${transcricao}`;

  const promptCompleto = simpleCutsInput?.checked === true ? promptSimples
    : criarPromptAutoral({ transcricao, sampleTitle, sampleAuthor, blocoVideoOriginal, motionDark: estiloEditorial(editorialStyleInput?.value) === "motion_dark" });
  const botao = event?.currentTarget || $("#btnCopiarPromptIA");
  const original = botao?.textContent || "Copiar Prompt para IA";
  await navigator.clipboard.writeText(promptCompleto);
  if (botao) {
    botao.textContent = "Prompt Copiado ✓";
    setTimeout(() => (botao.textContent = original), 1500);
  }
});

$("#btnBaixarTranscricao")?.addEventListener("click", () => {
  const blob = new Blob([transcriptText.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "transcricao_para_chatgpt.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function higienizarJsonPacote(texto) {
  let limpo = texto.trim();
  limpo = limpo.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  const inicioArray = limpo.indexOf("[");
  const inicioObj = limpo.indexOf("{");
  let inicio = -1;
  if (inicioArray !== -1 && inicioObj !== -1) {
    inicio = Math.min(inicioArray, inicioObj);
  } else {
    inicio = inicioArray !== -1 ? inicioArray : inicioObj;
  }

  const fimArray = limpo.lastIndexOf("]");
  const fimObj = limpo.lastIndexOf("}");
  const fim = Math.max(fimArray, fimObj);

  if (inicio !== -1 && fim !== -1 && fim > inicio) {
    limpo = limpo.slice(inicio, fim + 1);
  }

  limpo = limpo.replace(/,\s*([}\]])/g, "$1");

  // Converte aspas duplas não-escapadas em torno de créditos para aspas simples ou remove para não quebrar o JSON
  limpo = limpo.replace(/🎬\s*Episódio completo:\s*\\?["“](.*?)\\?["”]/gi, "🎬 Episódio completo: '$1'");
  limpo = limpo.replace(/🎙️\s*(?:Canal\s*\/\s*Host|Com):\s*\\?["“](.*?)\\?["”]/gi, "🎙️ Canal / Host: '$1'");
  limpo = limpo.replace(/👥\s*Participantes:\s*\\?["“](.*?)\\?["”]/gi, "👥 Participantes: '$1'");

  return limpo;
}

function limparFences(texto) {
  return higienizarJsonPacote(texto);
}

function converterTempoSegundos(valor) {
  const text = String(valor ?? "").trim().replace(/\s*:\s*/g, ":").replace(",", ".");
  if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(text)) return NaN;
  const parts = text.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  if (parts.length > 1 && parts[parts.length - 1] >= 60) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function formatarSegundosParaTimestamp(totalSegundos) {
  if (!Number.isFinite(totalSegundos) || totalSegundos < 0) return "";
  // Keep source references inside their envelope when importing fractional times.
  const milissegundos = Math.round(totalSegundos * 1000);
  const sTotal = Math.floor(milissegundos / 1000);
  const h = Math.floor(sTotal / 3600);
  const m = Math.floor((sTotal % 3600) / 60);
  const s = sTotal % 60;
  const fracao = String(milissegundos % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${fracao ? `.${fracao}` : ""}`;
}

function normalizarTimestamp(valor) {
  const seg = converterTempoSegundos(valor);
  if (!Number.isFinite(seg)) return String(valor ?? "").trim();
  return formatarSegundosParaTimestamp(seg);
}

function duracaoConteudoOriginal(corte, inicio, fim, simpleCuts = false) {
  if (simpleCuts || !Object.hasOwn(corte || {}, "editorial")) {
    return Number.isFinite(inicio) && Number.isFinite(fim) ? Number((fim - inicio).toFixed(6)) : NaN;
  }
  const cenas = corte.editorial?.scenes;
  if (!Array.isArray(cenas)) return NaN;
  const clips = cenas.filter(cena => cena?.kind === "clip");
  if (!clips.length || clips.some(cena => !Number.isFinite(cena.start) || !Number.isFinite(cena.end)
    || cena.start < 0 || cena.end <= cena.start)) return NaN;
  // Count each original excerpt as played; narration, backgrounds and evidence do not count.
  return Number(clips.reduce((total, cena) => total + cena.end - cena.start, 0).toFixed(6));
}

function normalizarTextoMarca(value) {
  // Only owned publication fields use this function; keep source URLs intact.
  return String(value ?? "").split(/(https?:\/\/[^\s<>]+)/gi).map((part, index) => index % 2 ? part : part
    .replace(/Siga\s+@os4(?:[._]?cortes|dedireita)\s+para mais (?:insights diários sobre negócios e liderança|análises e comentários de direita)\.?/gi,
      "Siga @os4dedireita para mais insights com análises e comentários.")
    .replace(/(?<![\w@])@os4[._]?cortes(?!\w|\.\w)/gi, "@os4dedireita")
    .replace(/(?<![\w#])#os4[._]?cortes(?!\w|\.\w)/gi, "#os4dedireita")
    .replace(/(?<![\w/@#\\])os4\s+cortes\b/gi, "OS4 de Direita")
    .replace(/(?<![\w/@#\\])os4[._]?cortes(?!\w|\.\w)/gi, "os4dedireita")
  ).join("");
}

function atualizarIdentidadePacote(data) {
  const updateCut = cut => {
    if (!cut || typeof cut !== "object" || Array.isArray(cut)) return cut;
    const updated = { ...cut };
    for (const key of ["titulo", "legenda_post", "descricao", "descricao_completa", "hashtags", "tags"]) {
      if (typeof updated[key] === "string") updated[key] = normalizarTextoMarca(updated[key]);
      else if (Array.isArray(updated[key])) updated[key] = updated[key].map(value =>
        typeof value === "string" ? normalizarTextoMarca(value) : value);
    }
    return updated;
  };
  if (Array.isArray(data)) return data.map(updateCut);
  if (data && Array.isArray(data.cortes)) return { ...data, cortes: data.cortes.map(updateCut) };
  return data;
}

const MODELOS_CAPA = {
  "01_central": "1 — Central",
  "02_lateral": "2 — Lateral",
  "03_close": "3 — Close",
};

function capaPadrao(titulo, formato) {
  return { version: 1, template_id: formato === "16:9" ? "02_lateral" : "01_central", title: titulo };
}

function normalizarCapa(cover, formato = "9:16") {
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) throw new Error("cover precisa ser um objeto JSON.");
  if (Object.keys(cover).length !== 3 || !["version", "template_id", "title"].every(key => Object.hasOwn(cover, key))) {
    throw new Error("cover precisa conter somente version, template_id e title.");
  }
  if (cover.version !== 1) throw new Error("cover.version precisa ser 1.");
  const templateId = cover.template_id === "04_duas_pessoas" ? capaPadrao("", formato).template_id : cover.template_id;
  if (typeof templateId !== "string" || !Object.hasOwn(MODELOS_CAPA, templateId)) {
    throw new Error("cover.template_id precisa ser 01_central, 02_lateral ou 03_close.");
  }
  if (typeof cover.title !== "string" || !cover.title.trim() || Array.from(cover.title).length > 60
      || /[\p{C}\u2028\u2029<>`]|\*\*|__|\[[^\]]*\]\(/u.test(cover.title)) {
    throw new Error("cover.title precisa ser texto simples em uma linha, não vazio, com até 60 caracteres. Edite o título da capa.");
  }
  return { version: 1, template_id: templateId, title: cover.title.trim() };
}

function normalizarPacote(data, { simpleCuts = simpleCutsInput?.checked === true } = {}) {
  data = atualizarIdentidadePacote(data);
  const lista = Array.isArray(data) ? data : data?.cortes;
  if (!Array.isArray(lista) || !lista.length) throw new Error("Nenhum corte encontrado no JSON.");

  return lista.map((c, i) => {
    const temEditorial = Object.hasOwn(c || {}, "editorial");
    if (temEditorial && (!c.editorial || typeof c.editorial !== "object" || Array.isArray(c.editorial))) {
      throw new Error(`Corte ${i + 1}: editorial precisa ser um objeto JSON.`);
    }
    const inicio = normalizarTimestamp(c?.inicio);
    const fim = normalizarTimestamp(c?.fim);
    const segInicio = converterTempoSegundos(inicio);
    const segFim = converterTempoSegundos(fim);
    const duracao = duracaoConteudoOriginal(c, segInicio, segFim, simpleCuts);

    let formato = String(c?.formato || "").trim().toLowerCase();
    let destino = String(c?.destino || c?.plataforma || "").trim().toLowerCase();

    if (destino === "youtube" || formato === "16:9" || duracao > 180) {
      formato = "16:9";
      destino = "youtube";
    } else {
      formato = "9:16";
      destino = "reels_tiktok";
    }

    const descricao = String(c?.descricao || c?.descricao_completa || c?.legenda_post || "").trim();
    const legendaPost = String(c?.legenda_post || descricao).trim();
    const tagsArr = c?.tags || c?.hashtags;
    const hashtags = Array.isArray(tagsArr) ? tagsArr.join(" ") : String(tagsArr || "").trim();
    const titulo = String(c?.titulo || `Corte ${i + 1}`).trim();
    let cover;
    try {
      cover = Object.hasOwn(c || {}, "cover") ? normalizarCapa(c.cover, formato) : normalizarCapa(capaPadrao(titulo, formato), formato);
    } catch (erro) {
      if (Object.hasOwn(c || {}, "cover")) throw new Error(`Corte ${i + 1}: ${erro.message}`);
      // Import legacy publication titles intact; the editor asks for a short cover title before rendering.
    }

    return {
      titulo,
      inicio,
      fim,
      formato,
      destino,
      descricao: formato === "16:9" ? (descricao || legendaPost) : "",
      legenda_post: formato === "16:9" ? (descricao || legendaPost) : legendaPost,
      hashtags,
      tags: hashtags,
      saida_suave: c?.saida_suave !== false,
      ...(cover ? { cover } : {}),
      ...(temEditorial ? { editorial: c.editorial } : {}),
    };
  });
}

function criarCampo(label, valor, tipo = "input") {
  const wrap = document.createElement("label");
  wrap.className = "cut-field";
  const span = document.createElement("span");
  span.textContent = label;
  const campo = tipo === "textarea" ? document.createElement("textarea") : document.createElement("input");
  campo.value = valor;
  if (tipo === "textarea") campo.rows = 4;
  wrap.append(span, campo);
  return { wrap, campo };
}

function adicionarRotuloEditorial(cabecalho, metadados) {
  if (!Object.hasOwn(metadados || {}, "editorial")) return;
  const badge = document.createElement("span");
  badge.className = "network-badge";
  badge.textContent = "Mini vídeo narrado";
  cabecalho.appendChild(badge);
}

const TEMAS_EDITORIAIS = { politics: "Política", economy: "Economia", business: "Empreendedorismo e negócios", humor: "Humor", general: "Geral" };
const TONS_EDITORIAIS = { conversational: "Conversado", provocative: "Provocativo", ironic: "Irônico", playful: "Brincalhão", explanatory: "Explicativo", serious: "Sério" };
const INTENSIDADES_EDITORIAIS = { low: "Leve", medium: "Média", high: "Alta" };
const MODOS_COMENTARIO = { support_source: "Cocomentário alinhado", challenge_source: "Crítica ao argumento da fonte", direct_commentary: "Comentário direto" };
const rotuloDirecao = (opcoes, valor) => typeof valor === "string" && Object.hasOwn(opcoes, valor) ? opcoes[valor] : "Inválido";

function criarResumoEditorial(plano) {
  const detalhes = document.createElement("details");
  detalhes.className = "editorial-direction";
  const titulo = document.createElement("summary");
  titulo.textContent = "Direção do comentarista";
  detalhes.appendChild(titulo);
  const perfil = plano?.profile;
  const tema = perfil?.topic ?? "general";
  const tom = perfil?.tone ?? "conversational";
  const intensidade = perfil?.intensity ?? "medium";
  const linha = (texto) => {
    const paragrafo = document.createElement("p");
    paragrafo.textContent = texto;
    detalhes.appendChild(paragrafo);
  };
  linha(`Comentarista de direita • ${rotuloDirecao(TEMAS_EDITORIAIS, tema)} • ${rotuloDirecao(TONS_EDITORIAIS, tom)} • Intensidade ${rotuloDirecao(INTENSIDADES_EDITORIAIS, intensidade)}`);
  if (perfil?.angle) linha(`Ângulo: ${typeof perfil.angle === "string" ? perfil.angle : "Inválido"}`);
  if (perfil?.audience_question) linha(`Pergunta ao público: ${typeof perfil.audience_question === "string" ? perfil.audience_question : "Inválida"}`);
  if (!perfil) linha("Pacote anterior: direção padrão conversada. Para adaptar o comentário a cada tema, copie o prompt atualizado e gere um novo pacote.");
  const intencao = plano?.intent;
  if (intencao && typeof intencao === "object" && !Array.isArray(intencao)) {
    linha(`Papel do narrador: ${rotuloDirecao(MODOS_COMENTARIO, intencao.mode)}`);
    if (intencao.source_point) linha(`Ponto da fonte: ${typeof intencao.source_point === "string" ? intencao.source_point : "Inválido"}`);
    linha(`Alvo da cobrança: ${typeof intencao.target === "string" ? intencao.target || "Sem cobrança específica" : "Inválido"}`);
    if (intencao.contribution) linha(`Contribuição do OS4: ${typeof intencao.contribution === "string" ? intencao.contribution : "Inválida"}`);
  }
  for (const cena of Array.isArray(plano?.scenes) ? plano.scenes : []) {
    if (!cena || cena.kind !== "narration") continue;
    const tomCena = cena.tts?.tone ?? tom;
    const intensidadeCena = cena.tts?.intensity ?? intensidade;
    linha(`${typeof cena.id === "string" ? cena.id : "Narração"}: ${rotuloDirecao(TONS_EDITORIAIS, tomCena)}; intensidade ${rotuloDirecao(INTENSIDADES_EDITORIAIS, intensidadeCena)}${cena.tts?.tone == null && cena.tts?.intensity == null ? " (acompanha o corte)" : ""}.`);
  }
  return detalhes;
}

function renderizarEditor(cortes) {
  cutsEditor.innerHTML = "";
  cortes.forEach((corte, index) => {
    const card = document.createElement("article");
    card.className = "cut-card";
    card.dataset.index = String(index);
    const isYoutube = corte.formato === "16:9" || corte.destino === "youtube";
    card.dataset.formato = isYoutube ? "16:9" : "9:16";
    card.dataset.destino = isYoutube ? "youtube" : "reels_tiktok";
    // Keep metadata on its card so editing or reordering cannot associate it with another cut.
    card.os4CutMetadata = {
      saida_suave: corte.saida_suave !== false,
      cover: corte.cover || capaPadrao(corte.titulo, card.dataset.formato),
      legacyCover: !Object.hasOwn(corte, "cover"),
      ...(Object.hasOwn(corte, "editorial") ? { editorial: corte.editorial } : {}),
    };

    const top = document.createElement("div");
    top.className = "cut-card-head";
    const strong = document.createElement("strong");
    strong.textContent = `Corte ${index + 1}`;

    const badge = document.createElement("span");
    badge.className = `network-badge ${isYoutube ? "yt-badge" : "vertical-badge"}`;
    badge.textContent = isYoutube ? "▶️ YouTube (16:9)" : "📱 Reels & TikTok (9:16)";
    strong.appendChild(badge);
    adicionarRotuloEditorial(strong, card.os4CutMetadata);

    const actions = document.createElement("div");
    actions.className = "cut-card-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mini-button";
    copy.textContent = isYoutube ? "Copiar descrição" : "Copiar legenda";

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.className = "mini-button btn-delete-cut";
    btnDelete.title = "Excluir este corte";
    btnDelete.setAttribute("aria-label", `Excluir corte ${index + 1}`);
    btnDelete.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px;">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
      <span>Excluir</span>
    `;

    actions.append(copy, btnDelete);
    top.append(strong, actions);

    const labelTitulo = isYoutube ? "Título no YouTube (Até 95 chars)" : "Título";
    const titulo = criarCampo(labelTitulo, corte.titulo);
    titulo.campo.dataset.field = "titulo";
    const capa = card.os4CutMetadata.cover;
    const modeloCapa = document.createElement("p");
    modeloCapa.className = "cover-template";
    modeloCapa.textContent = `Modelo da capa: ${MODELOS_CAPA[capa.template_id]}`;
    const tituloCapa = criarCampo("Título da capa (opcional, até 60 caracteres)", capa.title);
    tituloCapa.campo.dataset.field = "cover_title";
    tituloCapa.campo.maxLength = 60;
    tituloCapa.campo.placeholder = "Vazio: usar o título do corte";
    const tempos = document.createElement("div");
    tempos.className = "cut-times";
    const inicio = criarCampo("Início", corte.inicio);
    inicio.campo.dataset.field = "inicio";
    const fim = criarCampo("Fim", corte.fim);
    fim.campo.dataset.field = "fim";

    const limparErro = () => {
      card.classList.remove("has-error");
      inicio.wrap.classList.remove("has-error");
      fim.wrap.classList.remove("has-error");
    };
    inicio.campo.addEventListener("input", limparErro);
    fim.campo.addEventListener("input", limparErro);

    tempos.append(inicio.wrap, fim.wrap);
    const labelTexto = isYoutube ? "Descrição completa do YouTube (com sinopse, capítulos e créditos)" : "Legenda da postagem";
    const legenda = criarCampo(labelTexto, corte.descricao || corte.legenda_post, "textarea");
    legenda.campo.dataset.field = "legenda_post";
    if (isYoutube) legenda.campo.rows = 6;

    const labelTags = isYoutube ? "Tags / Palavras-chave de SEO" : "Hashtags";
    const hashtags = criarCampo(labelTags, corte.hashtags || corte.tags);
    hashtags.campo.dataset.field = "hashtags";

    copy.addEventListener("click", async () => {
      const texto = isYoutube
        ? `${titulo.campo.value.trim()}\n\n${legenda.campo.value.trim()}\n\nTags: ${hashtags.campo.value.trim()}`.trim()
        : `${legenda.campo.value.trim()}\n\n${hashtags.campo.value.trim()}`.trim();
      await navigator.clipboard.writeText(texto);
      const original = copy.textContent;
      copy.textContent = "Copiado ✓";
      setTimeout(() => (copy.textContent = original), 1200);
    });

    btnDelete.addEventListener("click", () => {
      if (btnGerarCortes.disabled) {
        alert("Não é possível excluir cortes enquanto o processamento estiver em andamento.");
        return;
      }

      const todosCards = [...cutsEditor.querySelectorAll(".cut-card")];
      const idxAtual = todosCards.indexOf(card);
      const numAtual = idxAtual !== -1 ? idxAtual + 1 : index + 1;
      const titAtual = titulo.campo.value.trim() || `Corte ${numAtual}`;

      if (!confirm(`Deseja realmente excluir o Corte ${numAtual} ("${titAtual}")?`)) {
        return;
      }

      card.remove();

      const cardsRestantes = [...cutsEditor.querySelectorAll(".cut-card")];
      cardsRestantes.forEach((c, i) => {
        c.dataset.index = String(i);
        const lbl = c.querySelector(".cut-card-head strong");
        const isYt = c.dataset.formato === "16:9";
        if (lbl) {
          lbl.innerHTML = `Corte ${i + 1} <span class="network-badge ${isYt ? "yt-badge" : "vertical-badge"}">${isYt ? "▶️ YouTube (16:9)" : "📱 Reels & TikTok (9:16)"}</span>`;
          adicionarRotuloEditorial(lbl, c.os4CutMetadata);
        }
        const bDel = c.querySelector(".btn-delete-cut");
        if (bDel) bDel.setAttribute("aria-label", `Excluir corte ${i + 1}`);
      });

      cortesImportados = lerCortesEditor();
      if (pacote) {
        pacote.value = JSON.stringify(cortesImportados, null, 2);
        try { localStorage.setItem(STORAGE_PACKAGE, pacote.value); } catch {}
      }

      if (cardsRestantes.length > 0) {
        setStatus("cortes", `${cardsRestantes.length} cortes prontos para gerar`, "active");
      } else {
        cutsEditor.classList.add("hidden");
        btnGerarCortes.classList.add("hidden");
        setStatus("cortes", "Aguardando pacote", "idle");
      }
    });

    card.append(top, titulo.wrap, modeloCapa, tituloCapa.wrap, tempos, legenda.wrap, hashtags.wrap);
    if (Object.hasOwn(corte, "editorial")) card.appendChild(criarResumoEditorial(corte.editorial));
    for (const campo of [...card.querySelectorAll("input"), ...card.querySelectorAll("textarea")]) {
      campo.addEventListener("input", sincronizarPacoteEditor);
    }
    cutsEditor.appendChild(card);
  });

  cutsEditor.classList.remove("hidden");
  btnGerarCortes.classList.remove("hidden");
  setStatus("cortes", `${cortes.length} cortes prontos para gerar`, "active");
  sincronizarPacoteEditor();
}

function sincronizarPacoteEditor() {
  cortesImportados = lerCortesEditor();
  pacote.value = JSON.stringify(cortesImportados, null, 2);
  try { localStorage.setItem(STORAGE_PACKAGE, pacote.value); } catch {}
}

btnImportar?.addEventListener("click", () => {
  const texto = pacote.value.trim();
  if (!texto) {
    alert("Cole o pacote editorial primeiro.");
    return;
  }

  try {
    const dados = JSON.parse(higienizarJsonPacote(texto));
    cortesImportados = normalizarPacote(dados);
    renderizarEditor(cortesImportados);
  } catch (erro) {
    alert(`Pacote inválido: ${erro.message}`);
  }
});

function lerCortesEditor() {
  return [...cutsEditor.querySelectorAll(".cut-card")].map((card) => {
    const formato = card.dataset.formato || "9:16";
    const destino = card.dataset.destino || (formato === "16:9" ? "youtube" : "reels_tiktok");
    const textoPost = card.querySelector('[data-field="legenda_post"]')?.value?.trim() || "";
    const tagsVal = card.querySelector('[data-field="hashtags"]')?.value?.trim() || "";
    const metadados = card.os4CutMetadata || {};
    const titulo = card.querySelector('[data-field="titulo"]').value.trim();
    const cover = {
      ...(metadados.cover || capaPadrao(titulo, formato)),
      title: card.querySelector('[data-field="cover_title"]')?.value?.trim() || titulo,
    };
    let incluirCapa = true;
    if (metadados.legacyCover && cover.title === titulo) {
      try { normalizarCapa(cover); } catch { incluirCapa = false; }
    }
    return {
      titulo,
      inicio: card.querySelector('[data-field="inicio"]').value.trim(),
      fim: card.querySelector('[data-field="fim"]').value.trim(),
      formato,
      destino,
      descricao: formato === "16:9" ? textoPost : "",
      legenda_post: textoPost,
      hashtags: tagsVal,
      tags: tagsVal,
      saida_suave: metadados.saida_suave !== false,
      ...(incluirCapa ? { cover } : {}),
      ...(Object.hasOwn(metadados, "editorial") ? { editorial: metadados.editorial } : {}),
    };
  });
}

function planoAutoralValido(corte) {
  const plano = corte.editorial;
  const cenas = plano?.scenes;
  if (plano?.version !== 1 || !Array.isArray(cenas) || cenas.length < 2 || cenas.length > 12) return false;
  const intervalo = (valor) => Number.isFinite(valor?.start) && Number.isFinite(valor?.end)
    && valor.start >= 0 && valor.end > valor.start;
  const tipos = new Set();
  for (const cena of cenas) {
    if (!cena || typeof cena !== "object") return false;
    tipos.add(cena.kind);
    if (cena.kind === "clip") {
      if (!intervalo(cena)) return false;
    } else if (cena.kind === "narration") {
      if (typeof cena.text !== "string" || !cena.text.trim() || !intervalo(cena.background)
        || typeof cena.visual?.title !== "string" || !cena.visual.title.trim()
        || !Array.isArray(cena.evidence) || !cena.evidence.length || !cena.evidence.every(intervalo)) return false;
    } else return false;
  }
  return tipos.has("narration") && tipos.has("clip");
}

function erroPlanoAutoral(corte) {
  if (!planoAutoralValido(corte)) {
    return "o modo autoral precisa de um plano editorial version: 1 com narração, evidências e trechos da fonte. Use “Copiar Prompt para IA” para gerar um pacote novo ou marque “Usar corte simples (formato antigo)”.";
  }
  const erroDirecao = erroDirecaoEditorial(corte.editorial);
  if (erroDirecao) return erroDirecao;
  const inicio = converterTempoSegundos(corte.inicio);
  const fim = converterTempoSegundos(corte.fim);
  for (const cena of corte.editorial.scenes) {
    const referencias = cena.kind === "clip" ? [["clip", cena]]
      : [["background", cena.background], ...cena.evidence.map((evidencia, i) => [`evidence[${i}]`, evidencia])];
    for (const [campo, intervalo] of referencias) {
      if (intervalo.start < inicio - 0.001 || intervalo.end > fim + 0.001) {
        return `a cena “${cena.id}”, campo ${campo}, usa ${intervalo.start}–${intervalo.end} segundos, fora de Início/Fim (${inicio}–${fim}). Ajuste os limites para incluir as referências do plano, preservando as frações de segundo.`;
      }
    }
  }
  return null;
}

function erroDirecaoEditorial(plano) {
  const objeto = valor => valor && typeof valor === "object" && !Array.isArray(valor);
  if (Object.hasOwn(plano, "profile")) {
    const perfil = plano.profile;
    if (!objeto(perfil)) return "a direção do comentarista (editorial.profile) precisa ser um objeto JSON.";
    const campos = ["perspective", "topic", "tone", "intensity", "angle", "audience_question"];
    if (Object.keys(perfil).some(campo => !campos.includes(campo))) return "a direção do comentarista contém um campo desconhecido em editorial.profile. Corrija o pacote antes de gerar.";
    if (campos.some(campo => !Object.hasOwn(perfil, campo))) return "a direção do comentarista está incompleta em editorial.profile. Informe perspectiva, tema, tom, intensidade, ângulo e pergunta (que pode ser vazia).";
    if (perfil.perspective !== "right") return "a perspectiva editorial precisa ser right (comentarista de direita).";
    if (typeof perfil.topic !== "string" || !Object.hasOwn(TEMAS_EDITORIAIS, perfil.topic)) return "o tema editorial é inválido. Use politics, economy, business, humor ou general.";
    if (typeof perfil.tone !== "string" || !Object.hasOwn(TONS_EDITORIAIS, perfil.tone)) return "o tom editorial é inválido. Use conversational, provocative, ironic, playful, explanatory ou serious.";
    if (typeof perfil.intensity !== "string" || !Object.hasOwn(INTENSIDADES_EDITORIAIS, perfil.intensity)) return "a intensidade editorial é inválida. Use low, medium ou high.";
    if (typeof perfil.angle !== "string" || !perfil.angle.trim() || perfil.angle.length > 240) return "o ângulo editorial precisa ser um texto não vazio com até 240 caracteres.";
    if (typeof perfil.audience_question !== "string" || perfil.audience_question.length > 240) return "a pergunta ao público precisa ser um texto com até 240 caracteres, ou string vazia.";
  }
  if (Object.hasOwn(plano, "intent")) {
    const intencao = plano.intent;
    if (!objeto(intencao)) return "a intenção do comentário (editorial.intent) precisa ser um objeto JSON.";
    const campos = ["mode", "source_point", "target", "contribution"];
    if (Object.keys(intencao).some(campo => !campos.includes(campo))) return "a intenção do comentário contém um campo desconhecido em editorial.intent. Use apenas mode, source_point, target e contribution.";
    if (campos.some(campo => !Object.hasOwn(intencao, campo))) return "a intenção do comentário está incompleta em editorial.intent. Informe mode, source_point, target (que pode ser vazio) e contribution.";
    if (typeof intencao.mode !== "string" || !Object.hasOwn(MODOS_COMENTARIO, intencao.mode)) return "o papel do narrador é inválido. Use support_source, challenge_source ou direct_commentary.";
    if (typeof intencao.source_point !== "string" || !intencao.source_point.trim() || intencao.source_point.length > 240) return "o ponto da fonte em editorial.intent.source_point precisa ser um texto não vazio com até 240 caracteres.";
    if (typeof intencao.target !== "string" || intencao.target.length > 240) return "o alvo da cobrança em editorial.intent.target precisa ser um texto com até 240 caracteres, ou string vazia.";
    if (typeof intencao.contribution !== "string" || !intencao.contribution.trim() || intencao.contribution.length > 240) return "a contribuição do OS4 em editorial.intent.contribution precisa ser um texto não vazio com até 240 caracteres.";
  }
  for (const cena of plano.scenes) {
    if (cena.kind !== "narration" || !Object.hasOwn(cena, "tts")) continue;
    if (!objeto(cena.tts)) return `a direção de voz da cena “${cena.id}” precisa ser um objeto JSON.`;
    if (Object.hasOwn(cena.tts, "tone") && (typeof cena.tts.tone !== "string" || !Object.hasOwn(TONS_EDITORIAIS, cena.tts.tone))) return `o tom da voz da cena “${cena.id}” é inválido. Use os mesmos tons permitidos no corte.`;
    if (Object.hasOwn(cena.tts, "intensity") && (typeof cena.tts.intensity !== "string" || !Object.hasOwn(INTENSIDADES_EDITORIAIS, cena.tts.intensity))) return `a intensidade da voz da cena “${cena.id}” é inválida. Use low, medium ou high.`;
  }
  return null;
}

btnGerarCortes?.addEventListener("click", async () => {
  if (!sessaoTranscricao) {
    alert("Primeiro transcreva um vídeo.");
    return;
  }

  // Limpa estados de erro anteriores
  cutsEditor.querySelectorAll(".cut-card.has-error").forEach((el) => el.classList.remove("has-error"));
  cutsEditor.querySelectorAll(".cut-field.has-error").forEach((el) => el.classList.remove("has-error"));

  const cards = [...cutsEditor.querySelectorAll(".cut-card")];
  if (!cards.length) {
    alert("Importe pelo menos um corte.");
    return;
  }

  // Validação prévia de todos os cortes no frontend
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const campoInicio = card.querySelector('[data-field="inicio"]');
    const campoFim = card.querySelector('[data-field="fim"]');
    const secInicio = converterTempoSegundos(campoInicio?.value);
    const secFim = converterTempoSegundos(campoFim?.value);

    let erroMsg = "";
    let campoFoco = null;

    if (!Number.isFinite(secInicio) && !Number.isFinite(secFim)) {
      erroMsg = `Corte ${i + 1}: informe início e fim válidos (ex: 00:15:30 ou 15:30).`;
      campoFoco = campoInicio;
    } else if (!Number.isFinite(secInicio)) {
      erroMsg = `Corte ${i + 1}: horário de início inválido. Use formato MM:SS ou HH:MM:SS.`;
      campoFoco = campoInicio;
    } else if (!Number.isFinite(secFim)) {
      erroMsg = `Corte ${i + 1}: horário de fim inválido. Use formato MM:SS ou HH:MM:SS.`;
      campoFoco = campoFim;
    } else if (secFim <= secInicio) {
      erroMsg = `Corte ${i + 1}: o horário final deve ser maior que o inicial.`;
      campoFoco = campoFim;
    }

    if (erroMsg) {
      card.classList.add("has-error");
      campoFoco?.closest(".cut-field")?.classList.add("has-error");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      campoFoco?.focus();
      setStatus("cortes", "Erro nos tempos", "error");
      atualizarProgresso({ percent: 0, title: "Não foi possível iniciar os cortes", detail: erroMsg });
      return;
    }
  }

  const simpleCuts = sessaoTranscricao.simpleCuts === true;
  const editorialStyle = estiloEditorial(sessaoTranscricao.editorialStyle);
  const cortesEditados = lerCortesEditor();
  let rotas;
  try {
    rotas = normalizarPacote(cortesEditados, { simpleCuts });
    rotas.forEach((corte, i) => {
      try { corte.cover = normalizarCapa(corte.cover || capaPadrao(corte.titulo, corte.formato), corte.formato); }
      catch (erro) { throw new Error(`Corte ${i + 1}: ${erro.message}`); }
    });
  } catch (erro) {
    setStatus("cortes", "Revise a capa", "error");
    atualizarProgresso({ percent: 0, title: "O título da capa precisa de ajuste", detail: erro.message });
    alert(erro.message);
    return;
  }
  const cuts = cortesEditados.map((corte, i) => ({
    ...corte, formato: rotas[i].formato, destino: rotas[i].destino, cover: rotas[i].cover,
    descricao: rotas[i].formato === "16:9" ? (corte.descricao || corte.legenda_post) : corte.descricao,
  }));
  if (!simpleCuts) {
    const erros = cuts.map(erroPlanoAutoral);
    const invalido = erros.findIndex(Boolean);
    if (invalido !== -1) {
      const mensagem = `Corte ${invalido + 1}: ${erros[invalido]}`;
      cards[invalido].classList.add("has-error");
      cards[invalido].scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus("cortes", "Revise o plano autoral", "error");
      atualizarProgresso({ percent: 0, title: "O pacote autoral precisa de ajuste", detail: mensagem });
      alert(mensagem);
      return;
    }
  }

  if (cuts.some((corte, i) => corte.formato !== cortesEditados[i].formato || corte.destino !== cortesEditados[i].destino)) {
    renderizarEditor(cuts);
  }
  btnGerarCortes.disabled = true;
  btnGerarCortes.textContent = "Iniciando...";
  ultimoJob = null;
  document.getElementById("cutsFailurePanel")?.classList.add("hidden");
  document.getElementById("cutsFailureActions")?.classList.add("hidden");
  const controlMessage = document.getElementById("cutsControlMessage");
  if (controlMessage) controlMessage.textContent = "";
  resultsSection.classList.add("hidden");
  document.getElementById("cutsLiveProgress")?.classList.remove("hidden");
  setStatus("cortes", "Preparando", "active");
  atualizarProgresso({ percent: 1, title: "Enviando cortes para processamento", detail: `${cuts.length} cortes na fila` });

  try {
    const burnCaptions = burnCaptionsInput?.checked === true;
    const dados = await api("/.netlify/functions/workflow-start", {
      method: "POST",
      body: JSON.stringify({
        kind: "render",
        folderId: sessaoTranscricao.folderId,
        videoFileId: sessaoTranscricao.videoFileId,
        transcriptJsonFileId: sessaoTranscricao.transcriptJsonFileId,
        hasLowerThird: sessaoTranscricao.hasLowerThird === true,
        simpleCuts,
        burnCaptions,
        ...(!simpleCuts ? { editorialStyle } : {}),
        cuts,
      }),
    });
    localStorage.setItem(STORAGE_JOB, JSON.stringify({ id: dados.requestId, kind: "render", videoUrl: sessaoTranscricao.videoUrl, hasLowerThird: sessaoTranscricao.hasLowerThird === true, simpleCuts, burnCaptions, editorialStyle, timestamp: Date.now() }));
    alternarBotaoCancelar(true);
    acompanharJob(dados.requestId, "render");
  } catch (erro) {
    btnGerarCortes.disabled = false;
    btnGerarCortes.textContent = "Gerar todos os cortes";
    setStatus("cortes", "Erro", "error");
    atualizarProgresso({ percent: 0, title: "Não foi possível iniciar os cortes", detail: erro.message });

    const match = erro.message?.match(/Corte\s+(\d+)/i);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      const allCards = [...cutsEditor.querySelectorAll(".cut-card")];
      if (allCards[idx]) {
        allCards[idx].classList.add("has-error");
        allCards[idx].scrollIntoView({ behavior: "smooth", block: "center" });
        const fimInput = allCards[idx].querySelector('[data-field="fim"]');
        fimInput?.focus();
      }
    }
  }
});

pacote?.addEventListener("input", () => {
  try { localStorage.setItem(STORAGE_PACKAGE, pacote.value); } catch {}
});

function extrairDriveFileId(url) {
  const match = String(url || "").match(/\/file\/d\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  try {
    return new URL(url).searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function urlDownloadDrive(fileId) {
  const url = new URL("https://drive.google.com/uc");
  url.searchParams.set("id", fileId);
  url.searchParams.set("export", "download");
  const email = $("#userEmail")?.textContent?.trim();
  if (email) url.searchParams.set("authuser", email);
  return url.href;
}

function driveAccountUrl(value) {
  const url = new URL(value);
  const email = $("#userEmail")?.textContent?.trim();
  if (url.hostname === "drive.google.com" && email) url.searchParams.set("authuser", email);
  return url.href;
}

function resultLink(texto, url, primary = false) {
  const a = document.createElement("a");
  const fileId = primary ? extrairDriveFileId(url) : "";
  if (primary && fileId) {
    a.href = urlDownloadDrive(fileId);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.downloadDireto = "1";
    a.textContent = texto.toLowerCase().startsWith("baixar") ? texto : `Baixar ${texto.toLowerCase()}`;
    a.title = "Baixar usando a conta Google conectada ao OS4. Se o Google solicitar, confirme essa conta.";
  } else {
    a.href = driveAccountUrl(url);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = texto;
  }
  a.className = primary ? "result-link primary" : "result-link";
  return a;
}

function mostrarResultados(result, autoSend = true, { live = false, interrupted = Boolean(result?.stoppedReason) } = {}) {
  if (!result?.cuts) return;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const pendingCuts = Array.isArray(result.pendingCuts) ? result.pendingCuts : [];
  const completedCount = Number.isInteger(result.completedCount) && result.completedCount >= 0
    ? result.completedCount : result.cuts.length;
  const requestedCount = Math.max(completedCount + errors.length,
    Number.isInteger(result.requestedCount) && result.requestedCount >= 0 ? result.requestedCount : result.cuts.length);
  const partial = errors.length > 0 || pendingCuts.length > 0 || completedCount < requestedCount;
  const summary = partial
    ? `${completedCount}/${requestedCount} cortes prontos; ${errors.length} com falha${pendingCuts.length ? `; ${pendingCuts.length} vídeo(s) com capa pendente` : ""}`
    : `${completedCount}/${requestedCount} cortes concluídos e salvos no Google Drive`;
  resultsList.innerHTML = "";
  resultsDriveLink.href = driveAccountUrl(result.driveFolderUrl || `https://drive.google.com/drive/folders/${result.folderId}`);

  const tituloEl = resultsSection?.querySelector(".section-title h2");
  if (tituloEl) {
    tituloEl.textContent = summary;
  }

  result.cuts.forEach((corte) => {
    const card = document.createElement("article");
    card.className = "result-card";
    const is16x9 = corte.formato === "16:9" || corte.destino === "youtube";
    const title = document.createElement("strong");
    title.textContent = `${String(corte.index).padStart(2, "0")}. ${corte.titulo}${is16x9 ? " (YouTube 16:9)" : ""}`;
    const links = document.createElement("div");
    links.className = "result-links";
    if (is16x9) {
      links.append(
        resultLink("Vídeo YouTube (16:9)", (corte.files.video || corte.files.videoLegenda).url, true),
        resultLink("Abrir no Drive", (corte.files.video || corte.files.videoLegenda).url),
        resultLink("Texto da postagem", corte.files.post.url),
      );
      if (corte.files.srt?.url) links.append(resultLink("SRT", corte.files.srt.url));
      if (corte.files.capa?.url) {
        links.append(resultLink("Capa / Thumbnail", corte.files.capa.url));
      }
    } else {
      const temLegendaDistinta = corte.files?.video?.id && corte.files?.videoLegenda?.id && corte.files.video.id !== corte.files.videoLegenda.id;
      if (temLegendaDistinta) {
        links.append(
          resultLink("Vídeo com legenda", corte.files.videoLegenda.url, true),
          resultLink("Abrir legendado no Drive", corte.files.videoLegenda.url),
          resultLink("Vídeo sem legenda", corte.files.video.url),
        );
      } else {
        const videoPrincipal = corte.files.video || corte.files.videoLegenda;
        links.append(
          resultLink("Vídeo vertical", videoPrincipal.url, true),
          resultLink("Abrir no Drive", videoPrincipal.url),
        );
      }
      if (corte.files.srt?.url) links.append(resultLink("SRT", corte.files.srt.url));
      if (corte.files.post?.url) links.append(resultLink("Texto da postagem", corte.files.post.url));
      if (corte.files.capa?.url) {
        links.append(resultLink("Capa", corte.files.capa.url));
      }
    }
    card.append(title, links);
    resultsList.appendChild(card);
  });

  pendingCuts.forEach((corte) => {
    const card = document.createElement("article");
    card.className = "result-card result-pending";
    const title = document.createElement("strong");
    title.textContent = `${String(corte.index).padStart(2, "0")}. ${corte.titulo || "Corte sem título"} — Vídeo salvo; capa pendente`;
    const message = document.createElement("p");
    message.className = "hint";
    message.textContent = `${corte.error || "Não foi possível finalizar a capa."} O vídeo foi preservado no Drive. A publicação aguarda a capa.`;
    const links = document.createElement("div");
    links.className = "result-links";
    const video = corte.files?.videoLegenda || corte.files?.video;
    const url = file => file?.url || (file?.id ? `https://drive.google.com/file/d/${file.id}/view` : "");
    if (url(video)) links.append(resultLink("Baixar vídeo salvo", url(video), true), resultLink("Abrir vídeo no Drive", url(video)));
    if (url(corte.files?.srt)) links.append(resultLink("SRT", url(corte.files.srt)));
    if (url(corte.files?.post)) links.append(resultLink("Texto da postagem", url(corte.files.post)));
    card.append(title, message, links);
    resultsList.appendChild(card);
  });

  errors.filter(error => !pendingCuts.some(cut => cut.index === error.index)).forEach((error) => {
    const card = document.createElement("article");
    card.className = "result-card result-error";
    const title = document.createElement("strong");
    const index = Number.isInteger(error.index) ? String(error.index).padStart(2, "0") : "Corte";
    title.textContent = `${index}. ${error.titulo || "Corte sem título"} — falhou`;
    const message = document.createElement("p");
    message.className = "hint";
    message.textContent = error.error || "Este corte não foi concluído.";
    card.append(title, message);
    resultsList.appendChild(card);
  });

  try {
    localStorage.setItem(STORAGE_RESULTS, JSON.stringify(result));
  } catch {}

  if (!live && !errors.length && !interrupted) document.getElementById("cutsLiveProgress")?.classList.add("hidden");
  resultsSection.classList.remove("hidden");
  if (!live) resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!live) setStatus("cortes", interrupted ? "Interrompido" : partial ? summary : `${completedCount} concluídos`, interrupted || errors.length ? "error" : partial ? "active" : "ok");
  if (partial && !live) {
    atualizarProgresso({ percent: requestedCount ? completedCount / requestedCount * 100 : 0,
      title: interrupted ? "Processamento interrompido" : errors.length ? "Lote com falhas" : "Cortes prontos", detail: result.stoppedReason ? `${result.stoppedReason} ${summary}` : summary });
  }
  if (!result.cuts.length) document.getElementById("publisherAutoBanner")?.classList.add("hidden");

  // Envia automaticamente para o OS4 Publicador somente após conclusão de renderização fresca
  if (autoSend && result.cuts.length) {
    enviarParaPublicadorLocal(result, false);
  }
}

async function enviarParaPublicadorLocal(result, manual = false) {
  const banner = document.getElementById("publisherAutoBanner");
  const titleEl = document.getElementById("publisherBannerTitle");
  const msgEl = document.getElementById("publisherBannerMsg");
  const btnReenviar = document.getElementById("btnEnviarPublicador");

  if (!result || !result.cuts || result.cuts.length === 0) return;

  if (manual && btnReenviar) {
    btnReenviar.disabled = true;
    btnReenviar.textContent = "Conectando...";
  }

  try {
    const health = await fetch("http://127.0.0.1:49152/health", {
      method: "GET",
      signal: AbortSignal.timeout(3500)
    }).then(r => r.json()).catch(() => null);

    if (!health || !health.ok) {
      if (banner) banner.classList.remove("hidden");
      if (titleEl) {
        titleEl.textContent = manual ? "OS4 Publicador não detectado" : "OS4 Publicador pronto para conexão";
        titleEl.style.color = manual ? "#f87171" : "#facc15";
      }
      if (msgEl) msgEl.textContent = "Abra o aplicativo OS4 Publicador no seu Windows e clique no botão para iniciar a fila de postagens automaticamente.";
      if (btnReenviar) {
        btnReenviar.disabled = false;
        btnReenviar.textContent = "Enviar para Publicador";
      }
      return;
    }

    const res = await fetch("http://127.0.0.1:49152/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    }).then(r => r.json());

    if (res && res.ok) {
      if (banner) banner.classList.remove("hidden");
      if (titleEl) {
        titleEl.textContent = "🚀 Enviado para o OS4 Publicador Local!";
        titleEl.style.color = "#4ade80";
      }
      if (msgEl) msgEl.textContent = `Lote de ${result.cuts.length} cortes recebido! Downloads e fila de postagem (com pausas de 3–5 min por rede) já iniciados no seu computador.`;
      if (btnReenviar) {
        btnReenviar.disabled = false;
        btnReenviar.textContent = "Enviado com sucesso ✓";
        setTimeout(() => { btnReenviar.textContent = "Reenviar para Publicador"; }, 4000);
      }
    }
  } catch (err) {
    if (banner) banner.classList.remove("hidden");
    if (titleEl) {
      titleEl.textContent = manual ? "Falha ao enviar" : "OS4 Publicador aguardando";
      titleEl.style.color = manual ? "#f87171" : "#facc15";
    }
    if (msgEl) msgEl.textContent = `Abra o aplicativo OS4 Publicador no seu computador e clique em 'Enviar para Publicador'. (${err.message})`;
    if (btnReenviar) {
      btnReenviar.disabled = false;
      btnReenviar.textContent = "Tentar enviar";
    }
  }
}

document.getElementById("btnEnviarPublicador")?.addEventListener("click", () => {
  const stored = JSON.parse(localStorage.getItem(STORAGE_RESULTS) || "null");
  enviarParaPublicadorLocal(stored, true);
});


if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((erro) => {
      console.warn("Service Worker não registrado:", erro);
    });
  });
}

atualizarProgresso({
  percent: 0,
  title: "Aguardando processamento",
  detail: "Cole uma URL e inicie a transcrição.",
  time: "",
});

carregarSessao();
