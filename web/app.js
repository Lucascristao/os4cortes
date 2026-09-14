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

const STORAGE_SESSION = "os4_transcription_session";
const STORAGE_JOB = "os4_current_job";

function atualizarProgresso({ percent = 0, title = "Aguardando processamento", detail = "", time = "" } = {}) {
  const valor = Math.max(0, Math.min(100, Number(percent) || 0));
  const inteiro = Math.round(valor);

  if (progressBar) progressBar.style.width = `${valor}%`;
  if (progressPercent) progressPercent.textContent = `${inteiro}%`;
  if (progressTitle) progressTitle.textContent = title;
  if (progressDetail) progressDetail.textContent = detail;
  if (progressTime) progressTime.textContent = time;
  if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(inteiro));
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
    tracking: "Enquadrando vídeo em 9:16",
    legendas: "Aplicando legendas",
    cortes: "Finalizando cortes",
    concluido: kind === "render" ? "Cortes concluídos" : "Transcrição concluída",
    erro: "O processamento encontrou um erro",
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
    if (!raw) return;
    const sessao = JSON.parse(raw);
    if (!sessao?.folderId || !sessao?.videoFileId || !sessao?.transcriptJsonFileId) return;
    mostrarTranscricao(sessao);
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

async function carregarSessao() {
  try {
    const dados = await api("/.netlify/functions/auth-session");
    const user = dados.user;

    $("#userName").textContent = user.name || "Conta Google";
    $("#userEmail").textContent = user.email || "";

    if (user.picture) {
      const foto = $("#userPicture");
      foto.src = user.picture;
      foto.classList.remove("hidden");
    }

    loginView.classList.add("hidden");
    appView.classList.remove("hidden");

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
  sessaoTranscricao = null;
  cortesImportados = [];
  localStorage.removeItem(STORAGE_SESSION);
  transcriptSection?.classList.add("hidden");
  packageSection?.classList.add("hidden");
  resultsSection?.classList.add("hidden");
  cutsEditor.innerHTML = "";
  cutsEditor.classList.add("hidden");
  btnGerarCortes.classList.add("hidden");
  pacote.value = "";
  setStatus("video", "Preparando", "active");
  setStatus("transcricao", "Aguardando", "idle");
  setStatus("cortes", "Aguardando", "idle");
}

btnTranscrever?.addEventListener("click", async () => {
  const url = videoUrl.value.trim();
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
  btnTranscrever.disabled = true;
  btnTranscrever.textContent = "Iniciando...";
  atualizarProgresso({ percent: 1, title: "Enviando para o GitHub Actions", detail: "Preparando a transcrição..." });

  try {
    const dados = await api("/.netlify/functions/workflow-start", {
      method: "POST",
      body: JSON.stringify({ kind: "transcribe", videoUrl: url }),
    });
    localStorage.setItem(STORAGE_JOB, JSON.stringify({ id: dados.requestId, kind: "transcribe", timestamp: Date.now() }));
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

function cancelarJobAtual() {
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
    detail: "Processamento cancelado. Cole a URL e inicie a transcrição.",
    time: "",
  });
}

btnCancelarJob?.addEventListener("click", () => {
  if (confirm("Deseja cancelar o acompanhamento e destravar os botões para tentar novamente?")) {
    cancelarJobAtual();
  }
});

function atualizarTelaJob(job, kind) {
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
    setStatus("cortes", job.stage === "concluido" ? "Concluídos" : (job.detail || "Processando"), job.stage === "concluido" ? "ok" : "active");
  }
}

function acompanharJob(id, kind) {
  if (pollTimer) clearInterval(pollTimer);
  let consulting = false;
  btnTranscrever.disabled = true;
  btnGerarCortes.disabled = true;
  alternarBotaoCancelar(true);

  const consultar = async () => {
    if (consulting) return;
    consulting = true;
    try {
      const dados = await api(`/.netlify/functions/workflow-status?id=${encodeURIComponent(id)}`);
      const job = dados.job;
      atualizarTelaJob(job, kind);

      if (job.status === "completed") {
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.removeItem(STORAGE_JOB);
        alternarBotaoCancelar(false);
        btnTranscrever.disabled = false;
        btnGerarCortes.disabled = false;

        if (kind === "transcribe") {
          mostrarTranscricao(job.result);
          btnTranscrever.disabled = false;
          btnTranscrever.textContent = "Transcrever outro";
        } else {
          mostrarResultados(job.result);
          btnGerarCortes.disabled = false;
          btnGerarCortes.textContent = "Gerar todos os cortes";
        }
      } else if (job.status === "error") {
        clearInterval(pollTimer);
        pollTimer = null;
        localStorage.removeItem(STORAGE_JOB);
        alternarBotaoCancelar(false);
        setStatus(kind === "render" ? "cortes" : "video", "Erro", "error");
        atualizarProgresso({ percent: job.percent || 100, title: "Processamento interrompido", detail: job.error || job.detail || "Falha no processamento." });
        btnTranscrever.disabled = false;
        btnTranscrever.textContent = "Transcrever";
        btnGerarCortes.disabled = false;
        btnGerarCortes.textContent = "Gerar todos os cortes";
      } else if (job.status === "queued") {
        const jobCreatedAt = job.createdAt ? new Date(job.createdAt).getTime() : 0;
        if (jobCreatedAt && (Date.now() - jobCreatedAt > 3 * 60 * 1000)) {
          clearInterval(pollTimer);
          pollTimer = null;
          localStorage.removeItem(STORAGE_JOB);
          alternarBotaoCancelar(false);
          btnTranscrever.disabled = false;
          btnTranscrever.textContent = "Transcrever";
          btnGerarCortes.disabled = false;
          btnGerarCortes.textContent = "Gerar todos os cortes";
          setStatus(kind === "render" ? "cortes" : "video", "Aguardando", "idle");
          atualizarProgresso({
            percent: 0,
            title: "Processamento expirado",
            detail: "O processamento anterior demorou muito para iniciar na fila do GitHub Actions. O botão foi liberado.",
          });
        }
      }
    } catch (erro) {
      console.warn("Falha ao consultar andamento:", erro);
      progressDetail.textContent = [401, 403].includes(erro.status)
        ? "Sua sessão expirou. Entre novamente para acompanhar o processamento."
        : `Não foi possível atualizar o andamento: ${erro.message}. Tentando novamente…`;
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
    // Se o job salvo no navegador for anterior a 5 minutos, descarta para evitar travamento
    if (job.timestamp && (Date.now() - Number(job.timestamp) > 5 * 60 * 1000)) {
      localStorage.removeItem(STORAGE_JOB);
      return;
    }
    if (job.kind === "transcribe") {
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
  sessaoTranscricao = result;
  try { localStorage.setItem(STORAGE_SESSION, JSON.stringify(result)); } catch {}

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
  await navigator.clipboard.writeText(transcriptText.value);
  const botao = event.currentTarget;
  const original = botao.textContent;
  botao.textContent = "Copiada ✓";
  setTimeout(() => (botao.textContent = original), 1300);
});

$("#btnCopiarPromptIA")?.addEventListener("click", async (event) => {
  const transcricao = transcriptText.value.trim();
  if (!transcricao) return;

  const promptCompleto = `Você é um especialista em seleção e edição de cortes verticais (9:16) para TikTok, Reels e YouTube Shorts.
Analise a transcrição abaixo e selecione os melhores trechos de alto engajamento.

Regras editoriais obrigatórias:
1. Duração: Cada corte deve ter entre 30 e 75 segundos.
2. Gancho: O início precisa ter um gancho forte nos primeiros 3 segundos.
3. Conclusão: Não corte pensamentos no meio; garanta encerramento com sentido completo.
4. Responda ESTRITAMENTE em formato JSON válido, sem texto explicativo antes ou depois:

[
  {
    "titulo": "Título curto e impactante",
    "inicio": "MM:SS",
    "fim": "MM:SS",
    "legenda_post": "Texto magnético para a legenda da postagem...",
    "hashtags": ["#marketing", "#negocios", "#dicas"]
  }
]

--- TRANSCRIÇÃO ---
${transcricao}`;

  await navigator.clipboard.writeText(promptCompleto);
  const botao = event.currentTarget;
  const original = botao.textContent;
  botao.textContent = "Prompt Copiado ✓";
  setTimeout(() => (botao.textContent = original), 1500);
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
  return limpo;
}

function limparFences(texto) {
  return higienizarJsonPacote(texto);
}

function normalizarPacote(data) {
  const lista = Array.isArray(data) ? data : data?.cortes;
  if (!Array.isArray(lista) || !lista.length) throw new Error("Nenhum corte encontrado no JSON.");
  if (lista.length > 30) throw new Error("O máximo é 30 cortes por vez.");

  return lista.map((c, i) => ({
    titulo: String(c?.titulo || `Corte ${i + 1}`).trim(),
    inicio: String(c?.inicio ?? "").trim(),
    fim: String(c?.fim ?? "").trim(),
    legenda_post: String(c?.legenda_post || "").trim(),
    hashtags: Array.isArray(c?.hashtags) ? c.hashtags.join(" ") : String(c?.hashtags || "").trim(),
  }));
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

function renderizarEditor(cortes) {
  cutsEditor.innerHTML = "";
  cortes.forEach((corte, index) => {
    const card = document.createElement("article");
    card.className = "cut-card";
    card.dataset.index = String(index);

    const top = document.createElement("div");
    top.className = "cut-card-head";
    const strong = document.createElement("strong");
    strong.textContent = `Corte ${index + 1}`;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mini-button";
    copy.textContent = "Copiar legenda";
    top.append(strong, copy);

    const titulo = criarCampo("Título", corte.titulo);
    titulo.campo.dataset.field = "titulo";
    const tempos = document.createElement("div");
    tempos.className = "cut-times";
    const inicio = criarCampo("Início", corte.inicio);
    inicio.campo.dataset.field = "inicio";
    const fim = criarCampo("Fim", corte.fim);
    fim.campo.dataset.field = "fim";
    tempos.append(inicio.wrap, fim.wrap);
    const legenda = criarCampo("Legenda da postagem", corte.legenda_post, "textarea");
    legenda.campo.dataset.field = "legenda_post";
    const hashtags = criarCampo("Hashtags", corte.hashtags);
    hashtags.campo.dataset.field = "hashtags";

    copy.addEventListener("click", async () => {
      const texto = `${legenda.campo.value.trim()}\n\n${hashtags.campo.value.trim()}`.trim();
      await navigator.clipboard.writeText(texto);
      const original = copy.textContent;
      copy.textContent = "Copiado ✓";
      setTimeout(() => (copy.textContent = original), 1200);
    });

    card.append(top, titulo.wrap, tempos, legenda.wrap, hashtags.wrap);
    cutsEditor.appendChild(card);
  });

  cutsEditor.classList.remove("hidden");
  btnGerarCortes.classList.remove("hidden");
  setStatus("cortes", `${cortes.length} cortes prontos para gerar`, "active");
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
  return [...cutsEditor.querySelectorAll(".cut-card")].map((card) => ({
    titulo: card.querySelector('[data-field="titulo"]').value.trim(),
    inicio: card.querySelector('[data-field="inicio"]').value.trim(),
    fim: card.querySelector('[data-field="fim"]').value.trim(),
    legenda_post: card.querySelector('[data-field="legenda_post"]').value.trim(),
    hashtags: card.querySelector('[data-field="hashtags"]').value.trim(),
  }));
}

btnGerarCortes?.addEventListener("click", async () => {
  if (!sessaoTranscricao) {
    alert("Primeiro transcreva um vídeo.");
    return;
  }

  const cuts = lerCortesEditor();
  if (!cuts.length) {
    alert("Importe pelo menos um corte.");
    return;
  }

  btnGerarCortes.disabled = true;
  btnGerarCortes.textContent = "Iniciando...";
  resultsSection.classList.add("hidden");
  setStatus("cortes", "Preparando", "active");
  atualizarProgresso({ percent: 1, title: "Enviando cortes para processamento", detail: `${cuts.length} cortes na fila` });

  try {
    const dados = await api("/.netlify/functions/workflow-start", {
      method: "POST",
      body: JSON.stringify({
        kind: "render",
        folderId: sessaoTranscricao.folderId,
        videoFileId: sessaoTranscricao.videoFileId,
        transcriptJsonFileId: sessaoTranscricao.transcriptJsonFileId,
        cuts,
      }),
    });
    localStorage.setItem(STORAGE_JOB, JSON.stringify({ id: dados.requestId, kind: "render", timestamp: Date.now() }));
    alternarBotaoCancelar(true);
    acompanharJob(dados.requestId, "render");
  } catch (erro) {
    btnGerarCortes.disabled = false;
    btnGerarCortes.textContent = "Gerar todos os cortes";
    setStatus("cortes", "Erro", "error");
    atualizarProgresso({ percent: 0, title: "Não foi possível iniciar os cortes", detail: erro.message });
  }
});

function resultLink(texto, url, primary = false) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = primary ? "result-link primary" : "result-link";
  a.textContent = texto;
  return a;
}

function mostrarResultados(result) {
  if (!result?.cuts) return;
  resultsList.innerHTML = "";
  resultsDriveLink.href = result.driveFolderUrl || `https://drive.google.com/drive/folders/${result.folderId}`;

  result.cuts.forEach((corte) => {
    const card = document.createElement("article");
    card.className = "result-card";
    const title = document.createElement("strong");
    title.textContent = `${String(corte.index).padStart(2, "0")}. ${corte.titulo}`;
    const links = document.createElement("div");
    links.className = "result-links";
    links.append(
      resultLink("Vídeo com legenda", corte.files.videoLegenda.url, true),
      resultLink("Vídeo sem legenda", corte.files.video.url),
      resultLink("SRT", corte.files.srt.url),
      resultLink("Texto da postagem", corte.files.post.url),
    );
    card.append(title, links);
    resultsList.appendChild(card);
  });

  resultsSection.classList.remove("hidden");
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("cortes", `${result.cuts.length} concluídos`, "ok");
}

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
