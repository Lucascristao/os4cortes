const $ = (selector) => document.querySelector(selector);

const loginView = $("#loginView");
const appView = $("#appView");
const btnTranscrever = $("#btnTranscrever");
const btnImportar = $("#btnImportar");
const btnMostrarDriveSetup = $("#btnMostrarDriveSetup");
const driveSetupCard = $("#driveSetupCard");
const driveSetupData = $("#driveSetupData");
const videoUrl = $("#videoUrl");
const pacote = $("#pacote");
const progressBar = $("#progressBar");
const progressPercent = $("#progressPercent");
const progressTitle = $("#progressTitle");
const progressDetail = $("#progressDetail");
const progressTime = $("#progressTime");
const progressTrack = $(".progress-track");

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

async function verificarSetupDrive() {
  if (!driveSetupCard) return;
  driveSetupCard.classList.add("hidden");

  try {
    const resposta = await fetch("/.netlify/functions/drive-setup?check=1", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!resposta.ok) return;

    const dados = await resposta.json();
    if (dados.available) {
      driveSetupCard.classList.remove("hidden");
      return;
    }

    if (!dados.completed) {
      await fetch("/.netlify/functions/drive-setup?complete=1", {
        credentials: "same-origin",
        cache: "no-store",
      });
    }
  } catch {
    // A configuração inicial não deve bloquear o uso normal do app.
  }
}

async function carregarSessao() {
  try {
    const resposta = await fetch("/.netlify/functions/auth-session", {
      credentials: "same-origin",
      cache: "no-store",
    });

    if (!resposta.ok) throw new Error("Não autenticado");

    const dados = await resposta.json();
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
    const resposta = await fetch("/.netlify/functions/drive-setup", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const dados = await resposta.json();

    if (!resposta.ok || !dados.available) {
      throw new Error("Os dados temporários não estão mais disponíveis. Faça login novamente com o Google para gerar um novo refresh token.");
    }

    driveSetupData.innerHTML = `
      <label>GOOGLE_REFRESH_TOKEN</label>
      <textarea id="setupRefresh" rows="5" readonly></textarea>
      <button type="button" class="secondary" data-copy="setupRefresh">Copiar refresh token</button>
      <label>GOOGLE_DRIVE_FOLDER_ID</label>
      <input id="setupFolder" readonly>
      <button type="button" class="secondary" data-copy="setupFolder">Copiar folder ID</button>
      <p class="hint">Esses valores devem ser colocados nos Secrets do repositório GitHub. O refresh token só é exibido nesta configuração inicial.</p>
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

btnTranscrever?.addEventListener("click", () => {
  const url = videoUrl.value.trim();
  if (!url) {
    alert("Cole a URL do vídeo primeiro.");
    return;
  }
  alert("Interface pronta. Na próxima etapa vamos conectar este botão ao GitHub Actions.");
});

btnImportar?.addEventListener("click", () => {
  const texto = pacote.value.trim();
  if (!texto) {
    alert("Cole o pacote editorial primeiro.");
    return;
  }

  try {
    const dados = JSON.parse(texto);
    const total = Array.isArray(dados) ? dados.length : (dados.cortes?.length ?? 0);
    alert(`Pacote válido. Cortes encontrados: ${total}.`);
  } catch {
    alert("O pacote ainda não é um JSON válido.");
  }
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
