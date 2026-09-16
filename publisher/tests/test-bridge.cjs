const { LocalBridgeServer, PORT, HOST } = require('../src/bridge.cjs');
const { Queue } = require('../src/queue.cjs');
const { QueueExecutor } = require('../src/executor.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  console.log('--- TESTANDO PONTE LOCAL HTTP ---');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os4-bridge-test-'));
  const q = new Queue(path.join(tmpDir, 'test.sqlite'));
  const executor = new QueueExecutor(q);

  let loggedMsg = '';
  const bridge = new LocalBridgeServer({
    executor,
    onLog: (m) => { loggedMsg = m; }
  });

  bridge.start();
  await new Promise(r => setTimeout(r, 600));

  try {
    // 1. Testa GET /health
    const resHealth = await fetch(`http://${HOST}:${PORT}/health`);
    const dataHealth = await resHealth.json();
    console.log('GET /health Status:', resHealth.status, 'Response:', JSON.stringify(dataHealth));
    if (!dataHealth.ok || dataHealth.app !== 'OS4 Publicador') {
      throw new Error('Falha no health check da ponte');
    }

    // 2. Testa POST /enqueue com dados simulados
    const mockPayload = {
      requestId: 'teste_batch_01',
      folderId: 'folder_123',
      driveFolderUrl: 'https://drive.google.com/drive/folders/folder_123',
      cuts: [
        {
          index: 1,
          titulo: 'Corte de Teste 01',
          files: {
            videoLegenda: { id: 'file_vid_123' },
            post: { id: 'file_post_123' }
          }
        }
      ]
    };

    const resEnqueue = await fetch(`http://${HOST}:${PORT}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mockPayload)
    });
    const dataEnqueue = await resEnqueue.json();
    console.log('POST /enqueue Status:', resEnqueue.status, 'Response:', JSON.stringify(dataEnqueue));
    if (!dataEnqueue.ok) {
      throw new Error('Falha ao enfileirar lote');
    }

    console.log('✅ TESTE DA PONTE LOCAL APROVADO COM 100% DE SUCESSO!');
  } finally {
    bridge.stop();
    executor.stop();
    q.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})();
