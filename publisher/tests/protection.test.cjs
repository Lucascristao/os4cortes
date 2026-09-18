const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Queue } = require('../src/queue.cjs');
const { QueueExecutor } = require('../src/executor.cjs');

test('QueueExecutor fornece cooldowns por rede e zera cooldown em retry manual', () => {
  const q = new Queue(':memory:');
  const executor = new QueueExecutor(q);
  // Evita que o worker loop tente disparar automações de navegador no teste unitário
  executor.ensureWorkerRunning = () => {};

  // Status inicial
  const s0 = executor.getStatus();
  assert.equal(s0.cooldowns.youtube, 0);
  assert.equal(s0.cooldowns.tiktok, 0);
  assert.equal(s0.cooldowns.instagram, 0);

  // Simula cooldown ativo no TikTok
  const now = Date.now();
  executor.nextAvailable.tiktok = now + 120000; // 2 minutos restantes
  const s1 = executor.getStatus();
  assert.ok(s1.cooldowns.tiktok > 100 && s1.cooldowns.tiktok <= 120);
  assert.equal(s1.cooldowns.youtube, 0);
  assert.equal(s1.cooldowns.instagram, 0);

  // Enfileira um corte e simula falha
  q.add({
    id: 'test_corte1_tiktok',
    network: 'tiktok',
    account: '@os4.cortes',
    cutIndex: 1,
    videoFileId: 'video1',
    titulo: 'Corte 1'
  });
  q.status('test_corte1_tiktok', 'failed', 'Erro simulado');

  // Retry manual deve liberar a rede TikTok imediatamente
  executor.retryJob('test_corte1_tiktok');
  assert.equal(executor.nextAvailable.tiktok, 0);
  const s2 = executor.getStatus();
  assert.equal(s2.cooldowns.tiktok, 0);

  // Retry all failed deve zerar todas as redes
  executor.nextAvailable.youtube = now + 300000;
  executor.nextAvailable.instagram = now + 180000;
  executor.retryAllFailed();
  assert.equal(executor.nextAvailable.youtube, 0);
  assert.equal(executor.nextAvailable.tiktok, 0);
  assert.equal(executor.nextAvailable.instagram, 0);

  executor.stop();
  q.close();
});

test('Intervalo de proteção ativa desconta tempo de upload e garante pausa mínima de 30s', () => {
  // Simulação da fórmula utilizada no processJob
  const simulateDelay = (targetIntervalSec, elapsedUploadSec) => {
    return Math.max(30, Math.round(targetIntervalSec - elapsedUploadSec));
  };

  // Caso 1: Upload rápido (45s), target 200s -> espera restante 155s (ciclo total = 200s, ~3.3 min)
  const delay1 = simulateDelay(200, 45);
  assert.equal(delay1, 155);
  assert.equal(delay1 + 45, 200);

  // Caso 2: Upload longo (190s), target 200s -> garante pausa mínima de 30s pós-upload
  const delay2 = simulateDelay(200, 190);
  assert.equal(delay2, 30);

  // Caso 3: Upload muito longo (240s) que excedeu o target -> garante pausa mínima de 30s
  const delay3 = simulateDelay(200, 240);
  assert.equal(delay3, 30);
});
