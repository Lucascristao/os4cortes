import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace(/\ncarregarSessao\(\);\s*$/, '\n');
const SESSION = 'os4_transcription_session';
const JOB = 'os4_current_job';
const originalUrl = 'https://www.youtube.com/watch?v=PMGxFRAea_I';
const otherUrl = 'https://youtu.be/X3HOegrwb8U';
const session = (extra = {}) => ({
  folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript',
  transcript: 'Texto de teste', videoUrl: originalUrl, hasLowerThird: true, simpleCuts: true, ...extra,
});

class Element {
  value = '';
  checked = false;
  disabled = false;
  textContent = '';
  innerHTML = '';
  style = {};
  listeners = new Map();
  cards = [];
  classList = { add() {}, remove() {} };
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  async fire(name) { await this.listeners.get(name)?.({ currentTarget: this }); }
  setAttribute() {}
  scrollIntoView() {}
  focus() {}
  querySelectorAll(selector) { return selector === '.cut-card' ? this.cards : []; }
}

function harness(initial = {}) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const storage = new Map(Object.entries(initial));
  const requests = [];
  const state = { job: { status: 'running', stage: 'download', percent: 10 } };
  const context = {
    URL, URLSearchParams, console,
    document: { querySelector: get, getElementById: (id) => get(`#${id}`) },
    window: { addEventListener() {} }, navigator: {}, location: { search: '', href: '' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    alert: (message) => { throw new Error(message); }, confirm: () => true,
    fetch: async (path, options = {}) => {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      const data = path.includes('workflow-status') ? { job: state.job }
        : path.includes('workflow-start') ? { requestId: 'request' } : { ok: false };
      return { ok: true, json: async () => data };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext('githubConnected = true;', context);
  return {
    context, get, storage, requests, state,
    saved: () => JSON.parse(storage.get(SESSION) || 'null'),
    startRequests: () => requests.filter((r) => r.path.includes('workflow-start')),
    async url(value) { get('#videoUrl').value = value; await get('#videoUrl').fire('input'); },
    async mark(value) { get('#hasLowerThird').checked = value; await get('#hasLowerThird').fire('change'); },
    prepareCut() {
      const fields = new Map(Object.entries({ titulo: 'Corte', inicio: '00:00', fim: '00:15', legenda_post: '', hashtags: '' })
        .map(([name, value]) => [name, { value }]));
      get('#cutsEditor').cards = [{
        dataset: { formato: '16:9', destino: 'youtube' },
        querySelector: (selector) => fields.get(selector.match(/data-field="([^"]+)"/)[1]),
      }];
    },
  };
}

const flush = () => new Promise(setImmediate);

test('envia a marcação uma vez por vídeo ao transcrever e a guarda no job local', async () => {
  const h = harness();
  await h.url(originalUrl);
  await h.mark(true);
  await h.get('#btnTranscrever').fire('click');
  assert.equal(h.startRequests()[0].body.hasLowerThird, true);
  assert.equal(h.startRequests()[0].body.videoUrl, originalUrl);
  const job = JSON.parse(h.storage.get(JOB));
  assert.equal(job.hasLowerThird, true);
  assert.equal(job.videoUrl, originalUrl);
});

test('conclusão da transcrição restaura a marcação do job retornado pelo servidor', async () => {
  const h = harness({ [JOB]: JSON.stringify({ id: 'request', kind: 'transcribe', videoUrl: originalUrl, hasLowerThird: false }) });
  h.state.job = { status: 'completed', stage: 'concluido', hasLowerThird: true, result: session({ hasLowerThird: undefined, videoUrl: undefined }) };
  h.context.acompanharJob('request', 'transcribe');
  await flush();
  assert.equal(h.saved().hasLowerThird, true);
  assert.equal(h.saved().videoUrl, originalUrl);
  assert.equal(h.get('#hasLowerThird').checked, true);
  assert.equal(h.storage.has(JOB), false);
});

test('sessão restaurada permite alterar a marcação e renderizar YouTube sem retranscrever', async () => {
  const h = harness({ [SESSION]: JSON.stringify(session()) });
  h.context.restaurarSessao();
  assert.equal(h.get('#videoUrl').value, originalUrl);
  assert.equal(h.get('#hasLowerThird').checked, true);
  await h.mark(false);
  assert.equal(h.saved().hasLowerThird, false);
  h.prepareCut();
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.startRequests().length, 1);
  assert.equal(h.startRequests()[0].body.kind, 'render');
  assert.equal(h.startRequests()[0].body.hasLowerThird, false);
  assert.equal(h.startRequests()[0].body.cuts[0].formato, '16:9');
});

test('outro vídeo não herda nem altera a marcação da sessão anterior', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.url(otherUrl);
  assert.equal(h.get('#hasLowerThird').checked, false);
  await h.mark(true);
  await h.mark(false);
  assert.equal(h.saved().hasLowerThird, true);
  h.prepareCut();
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.startRequests()[0].body.hasLowerThird, true);
  await h.url(originalUrl);
  assert.equal(h.get('#hasLowerThird').checked, true);
});

test('links alternativos do mesmo vídeo YouTube preservam a configuração', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.url('https://youtu.be/PMGxFRAea_I?si=compartilhamento');
  assert.equal(h.get('#hasLowerThird').checked, true);
  await h.mark(false);
  assert.equal(h.saved().hasLowerThird, false);
});

test('sessões e jobs legados assumem false, inclusive ao concluir transcrição', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ hasLowerThird: undefined, videoUrl: undefined }));
  assert.equal(h.get('#hasLowerThird').checked, false);
  await h.mark(true);
  assert.equal(h.saved().hasLowerThird, true);
  h.state.job = { status: 'completed', stage: 'concluido', result: session({ hasLowerThird: true }) };
  h.context.acompanharJob('legacy', 'transcribe');
  await flush();
  assert.equal(h.saved().hasLowerThird, false);
  assert.equal(h.get('#hasLowerThird').checked, false);
});

test('recarregar durante a transcrição mantém a configuração do vídeo pendente', async () => {
  const h = harness({ [JOB]: JSON.stringify({ id: 'request', kind: 'transcribe', videoUrl: originalUrl, hasLowerThird: true, timestamp: Date.now() }) });
  h.context.retomarJob();
  assert.equal(h.get('#videoUrl').value, originalUrl);
  assert.equal(h.get('#hasLowerThird').checked, true);
  await flush();
});

test('recarregar transcrição restaura o modo simples salvo no job sem mudar a tarja', async () => {
  const h = harness({ [JOB]: JSON.stringify({ id: 'request', kind: 'transcribe', videoUrl: originalUrl, hasLowerThird: false, simpleCuts: true, timestamp: Date.now() }) });
  h.context.retomarJob();
  assert.equal(h.get('#simpleCuts').checked, true);
  assert.equal(h.get('#hasLowerThird').checked, false);
  await flush();
});

test('conclusão mantém o modo escolhido no job local quando servidor não o informa', async () => {
  const h = harness({ [JOB]: JSON.stringify({ id: 'request', kind: 'transcribe', videoUrl: originalUrl, simpleCuts: true }) });
  h.state.job = { status: 'completed', stage: 'concluido', result: session({ simpleCuts: undefined }) };
  h.context.acompanharJob('request', 'transcribe');
  await flush();
  assert.equal(h.saved().simpleCuts, true);
  assert.equal(h.get('#simpleCuts').checked, true);
});

test('modo autoral explícito no job concluído prevalece sobre modo simples local', async () => {
  const h = harness({ [JOB]: JSON.stringify({ id: 'request', kind: 'transcribe', videoUrl: originalUrl, simpleCuts: true }) });
  h.state.job = { status: 'completed', stage: 'concluido', simpleCuts: false, result: session() };
  h.context.acompanharJob('request', 'transcribe');
  await flush();
  assert.equal(h.saved().simpleCuts, false);
  assert.equal(h.get('#simpleCuts').checked, false);
});
