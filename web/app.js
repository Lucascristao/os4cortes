const $ = (selector) => document.querySelector(selector);

const btnTranscrever = $("#btnTranscrever");
const btnImportar = $("#btnImportar");
const videoUrl = $("#videoUrl");
const pacote = $("#pacote");

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
