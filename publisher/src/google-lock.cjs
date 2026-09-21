// Mutex para compartilhamento seguro do perfil do Google Chrome (profiles/youtube)
// Evita colisão entre o download do Drive e a publicação no YouTube Shorts
let lock = Promise.resolve();
let currentOwner = null;

function withGoogleLock(fn, label = 'operacao', timeoutMs = 300000) {
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
  lock = Promise.resolve();
  currentOwner = null;
}

module.exports = { withGoogleLock, resetGoogleLock };

