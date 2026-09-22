const { execSync } = require('node:child_process');

// Mutex para compartilhamento seguro do perfil do Google Chrome (profiles/youtube)
// Evita colisão entre o download do Drive e a publicação no YouTube Shorts
let lock = Promise.resolve();
let currentOwner = null;

function killOrphanChromeAutomation() {
  try {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*OS4Publicador*profiles*youtube*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore' });
    console.log('[GoogleLock] Processos órfãos do Chrome de automação finalizados.');
  } catch (_) {}
}

function withGoogleLock(fn, label = 'operacao', timeoutMs = 600000) {
  let release;
  const nextLock = new Promise(resolve => {
    release = resolve;
  });
  const previousLock = lock;
  lock = nextLock;

  return previousLock
    .then(() => {
      currentOwner = label;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            console.error(`[GoogleLock] ⚠️ Timeout de segurança (${Math.round(timeoutMs / 1000)}s) na trava do Google: ${label}`);
            killOrphanChromeAutomation();
            reject(new Error(`Timeout de segurança (${Math.round(timeoutMs / 1000)}s) na trava do Google (${label})`));
          }
        }, timeoutMs);

        Promise.resolve()
          .then(() => fn())
          .then(res => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(res);
            }
          })
          .catch(err => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          });
      });
    })
    .finally(() => {
      currentOwner = null;
      release();
    });
}

function resetGoogleLock() {
  console.log('[GoogleLock] Resetando trava do Google forçadamente.');
  killOrphanChromeAutomation();
  lock = Promise.resolve();
  currentOwner = null;
}

module.exports = { withGoogleLock, resetGoogleLock, killOrphanChromeAutomation };

