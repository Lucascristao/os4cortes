// Mutex para compartilhamento seguro do perfil do Google Chrome (profiles/youtube)
// Evita colisão entre o download do Drive e a publicação no YouTube Shorts
let lock = Promise.resolve();

function withGoogleLock(fn) {
  let release;
  const nextLock = new Promise(resolve => {
    release = resolve;
  });
  const currentLock = lock;
  lock = nextLock;

  return currentLock
    .then(async () => {
      return await fn();
    })
    .finally(() => {
      release();
    });
}

module.exports = { withGoogleLock };
