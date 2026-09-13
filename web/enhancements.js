(() => {
  const $ = (selector) => document.querySelector(selector);

  const pacote = $("#pacote");
  const btnImportar = $("#btnImportar");
  const btnGerarCortes = $("#btnGerarCortes");
  const packageSection = $("#packageSection");
  const cutsEditor = $("#cutsEditor");
  const resultsSection = $("#resultsSection");
  const resultsList = $("#resultsList");
  const progressBar = $("#progressBar");
  const progressPercent = $("#progressPercent");
  const progressTitle = $("#progressTitle");
  const progressDetail = $("#progressDetail");
  const progressTime = $("#progressTime");

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
    const resultsObserver = new MutationObserver(melhorarLinksResultados);
    resultsObserver.observe(resultsList, { childList: true, subtree: true });
  }
})();
