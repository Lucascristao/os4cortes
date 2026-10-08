async function waitForUploadReady(button, page, attempt, timeout = 180000, now = Date.now) {
  attempt?.stage('Aguardando processamento do vídeo na plataforma');
  const deadline = now() + timeout;
  while (now() < deadline) {
    attempt?.check();
    if (await button.isEnabled() && await button.getAttribute('aria-disabled') !== 'true') return;
    await page.waitForTimeout(1000);
  }
  throw new Error('A plataforma não liberou a publicação após o processamento do vídeo.');
}
module.exports = { waitForUploadReady };
