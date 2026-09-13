(() => {
  const $ = (selector) => document.querySelector(selector);

  const pacote = $("#pacote");
  const btnImportar = $("#btnImportar");
  const btnGerarCortes = $("#btnGerarCortes");
  const btnTranscrever = $("#btnTranscrever");
  const packageSection = $("#packageSection");
  const cutsEditor = $("#cutsEditor");
  const resultsSection = $("#resultsSection");
  const resultsList = $("#resultsList");
  const resultsDriveLink = $("#resultsDriveLink");
  const progressBar = $("#progressBar");
  const progressPercent = $("#progressPercent");
  const progressTitle = $("#progressTitle");
  const progressDetail = $("#progressDetail");
  const progressTime = $("#progressTime");
  const logoutLink = $(".logout-link");

  const STORAGE_SESSION = "os4_transcription_session";
  const STORAGE_JOB = "os4_current_job";
  const STORAGE_PACKAGE = "os4_editor_package";
  const STORAGE_CUTS = "os4_editor_cuts";
  const STORAGE_RESULTS = "os4_last_results_view";

  function salvar(key, value) {
    try {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {}
  }

  function lerJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function limparTrabalhoLocal({ incluirSessao = false, incluirJob = false } = {}) {
    [STORAGE_PACKAGE, STORAGE_CUTS, STORAGE_RESULTS].forEach((key) => localStorage.removeItem(key));
    if (incluirSessao) localStorage.removeItem(STORAGE_SESSION);
    if (incluirJob) localStorage.removeItem(STORAGE_JOB);
  }

  function normalizarTextoPacote(texto) {
    let limpo = String(texto || "").trim();

    limpo = limpo
      .replace(/^```(?:json|javascript|js|python)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    limpo = limpo
      .replace(/^(?:(?:const|let|var)\s+)?CORTES\s*=\s*/i, "")
      .replace(/;\s*$/, "")
      .trim();

    return limpo;
  }

  btnImportar?.addEventListener("click", () => {
    if (!pacote?.value) return;
    pacote.value = normalizarTextoPacote(pacote.value);
  }, true);

  function extrairDriveFileId(url) {
    const valor = String(url || "");
    const porCaminho = valor.match(/\/file\/d\/([^/?#]+)/i);
    if (porCaminho?.[1]) return porCaminho[1];

    try {
      const parsed = new URL(valor);
      return parsed.searchParams.get("id") || "";
    } catch {
      return "";
    }
  }

  function urlDownloadDrive(fileId) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  }

  function melhorarLinksResultados() {
    if (!resultsList) return;

    const cards = [...resultsList.querySelectorAll(".result-card")];
    cards.forEach((card) => {
      const principal = card.querySelector(".result-link.primary");
      if (!principal || principal.dataset.downloadDireto === "1") return;

      const fileId = extrairDriveFileId(principal.href);
      if (!fileId) return;

      principal.href = urlDownloadDrive(fileId);
      principal.removeAttribute("target");
      principal.removeAttribute("rel");
      principal.setAttribute("download", "");
      principal.dataset.downloadDireto = "1";
      principal.textContent = "Baixar vídeo com legenda";
      principal.title = "Baixar o MP4 diretamente";
    });

    if (cards.length && resultsSection) {
      const titulo = resultsSection.querySelector(".section-title h2");
      if (titulo) titulo.textContent = `${cards.length}/${cards.length} cortes concluídos e salvos no Google Drive`;
    }
  }

  function lerCortesDaTela() {
    if (!cutsEditor) return [];
    return [...cutsEditor.querySelectorAll(".cut-card")].map((card) => ({
      titulo: card.querySelector('[data-field="titulo"]')?.value?.trim() || "",
      inicio: card.querySelector('[data-field="inicio"]')?.value?.trim() || "",
      fim: card.querySelector('[data-field="fim"]')?.value?.trim() || "",
      legenda_post: card.querySelector('[data-field="legenda_post"]')?.value?.trim() || "",
      hashtags: card.querySelector('[data-field="hashtags"]')?.value?.trim() || "",
    }));
  }

  function salvarEditorAtual() {
    if (pacote) salvar(STORAGE_PACKAGE, pacote.value || "");
    const cortes = lerCortesDaTela();
    if (cortes.length) salvar(STORAGE_CUTS, cortes);
  }

  function serializarResultados() {
    if (!resultsList) return null;
    const cards = [...resultsList.querySelectorAll(".result-card")];
    if (!cards.length) return null;

    return {
      driveFolderUrl: resultsDriveLink?.href || "",
      cards: cards.map((card) => ({
        titulo: card.querySelector(":scope > strong")?.textContent || "",
        links: [...card.querySelectorAll(".result-link")].map((link) => ({
          texto: link.textContent || "",
          href: link.href || "",
          primary: link.classList.contains("primary"),
          downloadDireto: link.dataset.downloadDireto === "1",
        })),
      })),
    };
  }

  function salvarResultadosAtuais() {
    const dados = serializarResultados();
    if (dados) salvar(STORAGE_RESULTS, dados);
  }

  function criarLinkResultado(item) {
    const a = document.createElement("a");
    a.href = item.href;
    a.className = item.primary ? "result-link primary" : "result-link";
    a.textContent = item.texto;

    if (item.primary || item.downloadDireto) {
      a.removeAttribute("target");
      a.removeAttribute("rel");
      a.setAttribute("download", "");
      a.dataset.downloadDireto = "1";
      a.title = "Baixar o MP4 diretamente";
    } else {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }

    return a;
  }

  function restaurarResultadosSalvos() {
    if (!resultsSection || !resultsList || localStorage.getItem(STORAGE_JOB)) return false;
    const salvo = lerJSON(STORAGE_RESULTS);
    if (!salvo?.cards?.length) return false;

    resultsList.innerHTML = "";
    if (resultsDriveLink && salvo.driveFolderUrl) resultsDriveLink.href = salvo.driveFolderUrl;

    salvo.cards.forEach((item) => {
      const card = document.createElement("article");
      card.className = "result-card";

      const title = document.createElement("strong");
      title.textContent = item.titulo || "Corte";

      const links = document.createElement("div");
      links.className = "result-links";
      (item.links || []).forEach((link) => links.appendChild(criarLinkResultado(link)));

      card.append(title, links);
      resultsList.appendChild(card);
    });

    resultsSection.classList.remove("hidden");
    melhorarLinksResultados();

    const total = salvo.cards.length;
    const status = $("#cortesStatus");
    const dot = $("#cortesDot");
    if (status) status.textContent = `${total} concluídos`;
    if (dot) dot.className = "status-dot ok";
    if (progressBar) progressBar.style.width = "100%";
    if (progressPercent) progressPercent.textContent = "100%";
    if (progressTitle) progressTitle.textContent = "Cortes concluídos";
    if (progressDetail) progressDetail.textContent = `${total}/${total} cortes concluídos e salvos no Google Drive`;
    if (progressTime) progressTime.textContent = `${total} de ${total}`;

    return true;
  }

  function restaurarEditorSalvo() {
    if (!pacote || !btnImportar || !packageSection || packageSection.classList.contains("hidden")) return false;

    const textoPacote = localStorage.getItem(STORAGE_PACKAGE);
    const cortes = lerJSON(STORAGE_CUTS);

    if (textoPacote != null) pacote.value = textoPacote;

    if (Array.isArray(cortes) && cortes.length && !cutsEditor?.querySelector(".cut-card")) {
      const original = pacote.value;
      pacote.value = JSON.stringify(cortes);
      btnImportar.click();
      setTimeout(() => {
        pacote.value = original;
      }, 0);
    }

    return Boolean(textoPacote != null || (Array.isArray(cortes) && cortes.length));
  }

  function tentarRestaurarTrabalho() {
    if (!packageSection || packageSection.classList.contains("hidden")) return false;
    restaurarEditorSalvo();
    restaurarResultadosSalvos();
    return true;
  }

  pacote?.addEventListener("input", () => salvar(STORAGE_PACKAGE, pacote.value || ""));

  cutsEditor?.addEventListener("input", salvarEditorAtual);
  cutsEditor?.addEventListener("change", salvarEditorAtual);

  btnImportar?.addEventListener("click", () => {
    setTimeout(() => salvarEditorAtual(), 0);
  });

  btnGerarCortes?.addEventListener("click", () => {
    salvarEditorAtual();
  }, true);

  btnTranscrever?.addEventListener("click", () => {
    setTimeout(() => {
      if (btnTranscrever.disabled) {
        limparTrabalhoLocal();
      }
    }, 0);
  });

  logoutLink?.addEventListener("click", () => {
    limparTrabalhoLocal({ incluirSessao: true, incluirJob: true });
  }, true);

  function instalarProgressoInline() {
    if (!packageSection || !btnGerarCortes || $("#cutsLiveProgress")) return;

    const style = document.createElement("style");
    style.textContent = `
      .cuts-live-progress{margin-top:16px;border:1px solid #343434;background:#101010;border-radius:14px;padding:14px}
      .cuts-live-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
      .cuts-live-head strong{color:#ffc928;font-size:.88rem}
      .cuts-live-count{color:#ddd;font-size:.8rem;font-weight:800;white-space:nowrap}
      .cuts-live-detail{color:#969696;font-size:.8rem;line-height:1.45;margin:8px 0 0}
      .cuts-live-track{height:9px;border-radius:999px;background:#0b0b0b;border:1px solid #303030;overflow:hidden}
      .cuts-live-bar{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#b98a00,#ffc928);transition:width .35s ease}
      @media(max-width:680px){.cuts-live-head{align-items:flex-start;flex-direction:column;gap:4px}.cuts-live-count{white-space:normal}}
    `;
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.id = "cutsLiveProgress";
    box.className = "cuts-live-progress hidden";
    box.setAttribute("aria-live", "polite");
    box.innerHTML = `
      <div class="cuts-live-head">
        <strong id="cutsLiveStage">Preparando cortes</strong>
        <span id="cutsLiveCount" class="cuts-live-count">Aguardando</span>
      </div>
      <div class="cuts-live-track"><div id="cutsLiveBar" class="cuts-live-bar"></div></div>
      <p id="cutsLiveDetail" class="cuts-live-detail">O andamento aparecerá aqui.</p>
    `;

    packageSection.insertBefore(box, btnGerarCortes);

    const stage = $("#cutsLiveStage");
    const count = $("#cutsLiveCount");
    const detail = $("#cutsLiveDetail");
    const bar = $("#cutsLiveBar");

    const sincronizar = () => {
      const resultadosVisiveis = resultsSection && !resultsSection.classList.contains("hidden");
      const totalConcluido = resultsList?.querySelectorAll(".result-card").length || 0;
      const processandoCortes = !packageSection.classList.contains("hidden") && btnGerarCortes.disabled;

      if (!processandoCortes && !resultadosVisiveis) {
        box.classList.add("hidden");
        return;
      }

      box.classList.remove("hidden");

      const percent = String(progressPercent?.textContent || "0%").trim();
      const width = progressBar?.style.width || percent;
      if (bar) bar.style.width = width;
      if (stage) stage.textContent = progressTitle?.textContent || "Gerando cortes";
      if (detail) detail.textContent = progressDetail?.textContent || "Processando...";

      if (resultadosVisiveis && totalConcluido) {
        if (count) count.textContent = `${totalConcluido} de ${totalConcluido} concluídos • 100%`;
        if (bar) bar.style.width = "100%";
        if (stage) stage.textContent = "Cortes concluídos";
        if (detail) detail.textContent = "Todos os arquivos foram salvos no Google Drive.";
        return;
      }

      const andamento = String(progressTime?.textContent || "").trim();
      if (count) count.textContent = andamento ? `${andamento} • ${percent}` : percent;
    };

    btnGerarCortes.addEventListener("click", () => {
      box.classList.remove("hidden");
      if (stage) stage.textContent = "Iniciando processamento";
      if (count) count.textContent = "Preparando...";
      if (detail) detail.textContent = "Enviando os cortes para o GitHub Actions.";
      if (bar) bar.style.width = "1%";
    }, true);

    const observer = new MutationObserver(() => {
      sincronizar();
      melhorarLinksResultados();
    });

    [progressBar, progressPercent, progressTitle, progressDetail, progressTime, btnGerarCortes, resultsSection, resultsList]
      .filter(Boolean)
      .forEach((el) => observer.observe(el, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeFilter: ["style", "class", "disabled"],
      }));

    sincronizar();
  }

  instalarProgressoInline();
  melhorarLinksResultados();

  if (resultsList) {
    const resultsObserver = new MutationObserver(() => {
      melhorarLinksResultados();
      salvarResultadosAtuais();
    });
    resultsObserver.observe(resultsList, { childList: true, subtree: true });
  }

  if (packageSection) {
    const restoreObserver = new MutationObserver(() => {
      if (!packageSection.classList.contains("hidden")) {
        tentarRestaurarTrabalho();
      }
    });
    restoreObserver.observe(packageSection, { attributes: true, attributeFilter: ["class"] });
  }

  let tentativas = 0;
  const restoreTimer = setInterval(() => {
    tentativas += 1;
    if (tentarRestaurarTrabalho() || tentativas >= 40) clearInterval(restoreTimer);
  }, 250);
})();