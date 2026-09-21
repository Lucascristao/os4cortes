const http = require('node:http');
const { downloadBatch, downloadCorte } = require('./downloader.cjs');

const PORT = 49152;
const HOST = '127.0.0.1';

class LocalBridgeServer {
  constructor({ executor, onLog = () => {} }) {
    this.executor = executor;
    this.onLog = onLog;
    this.server = null;
    this.activeBatch = null;
  }

  start() {
    this.server = http.createServer(async (req, res) => {
      // Configuração de CORS e Private Network Access (PNA) para permitir requisições do site do OS4
      const origin = req.headers.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, Access-Control-Request-Private-Network');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      const url = new URL(req.url, `http://${HOST}:${PORT}`);

      // GET /health
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          app: 'OS4 Publicador',
          executorStatus: this.executor?.getStatus() || null,
          activeBatch: this.activeBatch
        }));
      }

      // POST /enqueue - Recebe pacote de cortes da renderização do OS4
      if (req.method === 'POST' && url.pathname === '/enqueue') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            if (!data.cuts || !Array.isArray(data.cuts) || data.cuts.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Pacote de cortes vazio ou inválido.' }));
            }

            console.log(`[Bridge] Novo lote recebido: ${data.cuts.length} cortes para a sessão ${data.requestId || data.folderId}`);
            this.onLog(`Recebido novo lote com ${data.cuts.length} cortes. Iniciando downloads em segundo plano...`);

            this.activeBatch = {
              requestId: data.requestId || `sessao_${Date.now()}`,
              folderId: data.folderId,
              driveFolderUrl: data.driveFolderUrl,
              totalCuts: data.cuts.length,
              downloadedCuts: [],
              receivedAt: Date.now()
            };

            // Responde imediatamente à página web para não travar a requisição
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              message: `Lote com ${data.cuts.length} cortes recebido com sucesso! Downloads iniciados.`,
              requestId: this.activeBatch.requestId
            }));

            // Processa os downloads e enfileiramento em segundo plano
            this.processBatchInBackground(data);
          } catch (err) {
            console.error('[Bridge] Erro ao processar payload /enqueue:', err);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Rota não encontrada' }));
    });

    this.server.listen(PORT, HOST, () => {
      console.log(`[Bridge] Servidor ponte local rodando em http://${HOST}:${PORT}`);
    });

    this.server.on('error', (err) => {
      console.error('[Bridge] Erro no servidor ponte:', err.message);
    });
  }

  async processBatchInBackground(batch) {
    try {
      await downloadBatch(batch, (downloadedCut) => {
        // Assim que o corte é baixado, enfileira no SQLite
        const addedIds = this.executor.enqueueCorte({
          cutIndex: downloadedCut.cutIndex,
          titulo: downloadedCut.titulo,
          videoPath: downloadedCut.videoPath,
          postPath: downloadedCut.postPath,
          postText: downloadedCut.postText,
          requestId: batch.requestId,
          folderId: batch.folderId
        });
        if (addedIds && addedIds.length > 0) {
          this.onLog(`Download concluído: Corte ${downloadedCut.cutIndex} (${downloadedCut.sizeMb} MB em ${downloadedCut.durationSec}s). Enfileirado para publicação.`);
        } else {
          this.onLog(`Corte ${downloadedCut.cutIndex}: Arquivos locais prontos (já constava na fila ou concluído).`);
        }
      });
      this.onLog(`Todos os downloads da sessão ${batch.requestId} foram concluídos! Fila em execução.`);
    } catch (err) {
      console.error('[Bridge] Erro durante download em lote:', err);
      this.onLog(`Erro nos downloads do lote: ${err.message}`);
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = { LocalBridgeServer, PORT, HOST };
