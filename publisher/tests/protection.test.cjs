const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Queue } = require('../src/queue.cjs');
const { QueueExecutor } = require('../src/executor.cjs');

test('QueueExecutor fornece cooldowns por rede e preserva cooldown em retry manual', () => {
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

  // Retry manual mantém o intervalo pendente
  executor.retryJob('test_corte1_tiktok');
  assert.equal(executor.nextAvailable.tiktok, now + 120000);
  const s2 = executor.getStatus();
  assert.ok(s2.cooldowns.tiktok > 100);

  // Retry em lote também preserva os intervalos
  executor.nextAvailable.youtube = now + 300000;
  executor.nextAvailable.instagram = now + 180000;
  executor.retryAllFailed();
  assert.equal(executor.nextAvailable.youtube, now + 300000);
  assert.equal(executor.nextAvailable.tiktok, now + 120000);
  assert.equal(executor.nextAvailable.instagram, now + 180000);

  executor.stop();
  q.close();
});

test('enqueueCorte roteia 16:9 exclusivamente para YouTube e 9:16 para TikTok e Instagram', () => {
  const q = new Queue(':memory:');
  const executor = new QueueExecutor(q);
  executor.ensureWorkerRunning = () => {};

  // Corte 1: 16:9 longo para YouTube
  const ytJobIds = executor.enqueueCorte({
    cutIndex: 1,
    titulo: 'Revelações Inéditas de Bastidores',
    videoPath: 'C:\\Videos\\corte_01_revelacoes_16x9.mp4',
    capaPath: 'C:\\Videos\\corte_01_revelacoes_capa.jpg',
    formato: '16:9',
    requestId: 'sessao1'
  });

  assert.equal(ytJobIds.length, 1);
  const ytJob = q.list().find(j => j.id === ytJobIds[0]);
  assert.equal(ytJob.payload.network, 'youtube');
  assert.equal(ytJob.payload.formato, '16:9');
  assert.equal(ytJob.payload.capaPath, 'C:\\Videos\\corte_01_revelacoes_capa.jpg');

  // Corte 2: 9:16 vertical para Reels e TikTok
  const verticalJobIds = executor.enqueueCorte({
    cutIndex: 2,
    titulo: 'Momento de Tensão no Estúdio',
    videoPath: 'C:\\Videos\\corte_02_tensao_legenda.mp4',
    formato: '9:16',
    requestId: 'sessao1'
  });

  assert.equal(verticalJobIds.length, 2);
  const verticalNets = verticalJobIds.map(id => q.list().find(j => j.id === id).payload.network);
  assert.deepEqual(verticalNets.sort(), ['instagram', 'tiktok'].sort());

  executor.stop();
  q.close();
});

