import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  .replace(/\ncarregarSessao\(\);\s*$/, '\n');
const plain = value => JSON.parse(JSON.stringify(value));
const packageKey = 'os4_editor_package';

class Element {
  value = '';
  checked = false;
  disabled = false;
  className = '';
  dataset = {};
  style = {};
  children = [];
  listeners = new Map();
  ownText = '';
  parentNode = null;
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' ').trim(); },
    remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
  };
  constructor(tagName = 'div') { this.tagName = tagName.toLowerCase(); }
  set textContent(value) { this.ownText = value; this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.ownText = value; this.children = []; }
  get innerHTML() { return this.ownText; }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  remove() { this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  async fire(name) { await this.listeners.get(name)?.({ currentTarget: this }); }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() {}
  focus() {}
  matches(selector) {
    const field = selector.match(/^\[data-field="([^"]+)"\]$/);
    if (field) return this.dataset.field === field[1];
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.className.split(/\s+/).includes(name));
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const parts = selector.split(' ');
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(child => {
      if (selector === '*') return true;
      if (!child.matches(parts.at(-1))) return false;
      let ancestor = child.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && !ancestor.matches(parts[i])) ancestor = ancestor.parentNode;
        if (!ancestor) return false;
        ancestor = ancestor.parentNode;
      }
      return true;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function harness(saved = {}) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const storage = new Map(Object.entries(saved));
  const requests = [];
  const alerts = [];
  const copied = [];
  const state = { job: { status: 'running', percent: 1 } };
  const context = {
    URL, URLSearchParams, console,
    document: { querySelector: get, getElementById: id => get(`#${id}`), createElement: tag => new Element(tag) },
    window: { addEventListener() {} }, navigator: { clipboard: { writeText: async text => copied.push(text) } }, location: { search: '', href: '' },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    alert: message => alerts.push(message), confirm: () => true,
    fetch: async (path, options = {}) => {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      const data = path.includes('workflow-start') ? { requestId: 'request' }
        : path.includes('workflow-status') ? { job: state.job } : { ok: false };
      return { ok: true, json: async () => data };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext('githubConnected = true;', context);
  return {
    context, get, storage, requests, alerts, copied, state,
    cards: () => get('#cutsEditor').querySelectorAll('.cut-card'),
    async import(cuts) {
      get('#pacote').value = JSON.stringify(cuts);
      await get('#btnImportar').fire('click');
    },
  };
}

const plan = () => ({
  version: 'future-format-1',
  scenes: [
    { type: 'narration', text: 'Qual é a diferença?', evidence_ids: ['fala-1'], visual: { blur: 24, darken: 0.4 } },
    { type: 'source', start_seconds: 10.125, end_seconds: 14.75 },
  ],
  extensions: { enabled: false, values: [1, 'áudio', null] },
});
const cut = extra => ({ titulo: 'Uma pergunta', inicio: '00:10', fim: '00:20', formato: '9:16', saida_suave: false, ...extra });

test('normalização conserva o objeto editorial sem filtrar campos ou inventar uma versão', () => {
  const h = harness();
  const editorial = plan();
  const result = h.context.normalizarPacote([cut({ editorial })]);
  assert.equal(result[0].editorial, editorial);
  assert.deepEqual(plain(result[0].editorial), editorial);
  assert.equal(result[0].saida_suave, false);
  assert.deepEqual(plain(h.context.normalizarPacote([cut({ editorial: {} })])[0].editorial), {});
});

test('editorial presente precisa ser objeto e pacotes antigos continuam sem a propriedade', () => {
  const h = harness();
  for (const editorial of [null, [], 'narrado', true, 1]) {
    assert.throws(() => h.context.normalizarPacote([cut({ editorial })]), /Corte 1: editorial precisa ser um objeto JSON/);
  }
  const legacy = h.context.normalizarPacote([cut({ saida_suave: undefined })])[0];
  assert.equal(Object.hasOwn(legacy, 'editorial'), false);
  assert.equal(legacy.saida_suave, true);
});

test('editar título e tempos mantém plano e saída suave associados ao cartão e ao envio', async () => {
  const h = harness();
  const editorial = plan();
  await h.import([cut({ editorial }), cut({ titulo: 'Legado', saida_suave: true })]);
  const [narrated, legacy] = h.cards();
  assert.match(narrated.textContent, /Mini vídeo narrado/);
  assert.doesNotMatch(legacy.textContent, /Mini vídeo narrado/);
  narrated.querySelector('[data-field="titulo"]').value = 'Título revisado';
  narrated.querySelector('[data-field="inicio"]').value = '00:11';
  narrated.querySelector('[data-field="fim"]').value = '00:25';
  h.context.mostrarTranscricao({ folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript', simpleCuts: true });
  await h.get('#btnGerarCortes').fire('click');
  const sent = h.requests.find(request => request.path.includes('workflow-start')).body.cuts;
  assert.deepEqual(sent[0].editorial, editorial);
  assert.equal(sent[0].titulo, 'Título revisado');
  assert.equal(sent[0].inicio, '00:11');
  assert.equal(sent[0].fim, '00:25');
  assert.equal(sent[0].saida_suave, false);
  assert.equal(Object.hasOwn(sent[1], 'editorial'), false);
  assert.equal(sent[1].saida_suave, true);
});

test('excluir outro corte, salvar e restaurar conserva o plano do cartão sobrevivente', async () => {
  const h = harness();
  const editorial = plan();
  await h.import([cut({ titulo: 'Excluir' }), cut({ titulo: 'Preservar', editorial })]);
  await h.cards()[0].querySelector('.btn-delete-cut').fire('click');
  assert.equal(h.cards().length, 1);
  assert.equal(h.cards()[0].dataset.index, '0');
  assert.match(h.cards()[0].textContent, /Mini vídeo narrado/);
  const saved = JSON.parse(h.storage.get(packageKey));
  assert.equal(saved[0].titulo, 'Preservar');
  assert.equal(saved[0].saida_suave, false);
  assert.deepEqual(saved[0].editorial, editorial);
  const restored = harness({ [packageKey]: JSON.stringify(saved) });
  restored.context.restaurarSessao();
  await restored.get('#btnImportar').fire('click');
  assert.deepEqual(plain(restored.context.lerCortesEditor()[0].editorial), editorial);
  assert.equal(restored.context.lerCortesEditor()[0].saida_suave, false);
});

test('importação inválida informa o erro e não cria cartões nem dispara processamento', async () => {
  const h = harness();
  await h.import([cut({ editorial: null })]);
  assert.equal(h.cards().length, 0);
  assert.match(h.alerts[0], /Pacote inválido: Corte 1: editorial precisa ser um objeto JSON/);
  assert.equal(h.requests.length, 0);
});

const originalUrl = 'https://www.youtube.com/watch?v=PMGxFRAea_I';
const sessionKey = 'os4_transcription_session';
const jobKey = 'os4_current_job';
const session = extra => ({ folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript', videoUrl: originalUrl, transcript: 'Transcrição com tempos reais.', ...extra });
const validPlan = () => ({
  version: 1, source: { label: 'Fonte do vídeo', date: '' },
  scenes: [
    { id: 'abertura', kind: 'narration', text: 'O que esta resposta esclarece?', background: { start: 10, end: 14 }, visual: { title: 'Uma pergunta', kicker: 'SEGUNDO A FONTE', lines: ['Um ponto'] }, tts: { delivery: 'explain', cues: [] }, evidence: [{ start: 10, end: 14 }] },
    { id: 'entrevista-1', kind: 'clip', start: 10, end: 19 },
  ],
  extensions: { preserved: true },
});
const starts = h => h.requests.filter(request => request.path.includes('workflow-start'));

test('modo autoral é o padrão no HTML, em sessão legada e no novo prompt', async () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const checkbox = html.match(/<input\b[^>]*id="simpleCuts"[^>]*>/)[0];
  assert.doesNotMatch(checkbox, /\bchecked\b/);
  const h = harness();
  assert.equal(h.get('#simpleCuts').checked, false);
  h.context.mostrarTranscricao(session());
  assert.equal(JSON.parse(h.storage.get(sessionKey)).simpleCuts, false);
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  assert.match(prompt, /"version": 1/);
  assert.match(prompt, /"kind": "narration"/);
  assert.match(prompt, /"kind": "clip"/);
  assert.match(prompt, /começo, meio e fim/);
  assert.match(prompt, /"evidence"/);
  assert.match(prompt, /"label": "Fonte original"/);
  assert.match(prompt, /os DOIS destinos quando a fonte sustentar/);
  assert.match(prompt, /aprofundar uma explicação completa/);
  assert.match(prompt, /o menor start e o maior end de TODAS as referências/);
  assert.match(prompt, /A duração final é a soma dos áudios narrados e dos clips/);
  assert.match(prompt, /"delivery": "hook"/);
  assert.match(prompt, /"delivery": "explain"/);
  assert.match(prompt, /"delivery": "closing"/);
  assert.match(prompt, /sem insinuações ou acusações/);
  assert.doesNotMatch(prompt, /Diretriz Anti-Bloqueio/);
});

test('modo simples preserva o prompt anterior sem incluir plano editorial', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ simpleCuts: true }));
  await h.get('#btnCopiarPromptIA').fire('click');
  assert.match(h.copied[0], /editor sênior e estrategista multiplataforma/);
  assert.match(h.copied[0], /GRUPO 2: CORTES LONGOS/);
  assert.match(h.copied[0], /Diretriz Anti-Bloqueio/);
  assert.doesNotMatch(h.copied[0], /"editorial"/);
});

test('modo simples persiste por sessão e por vídeo sem acoplar a marcação de tarja', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ hasLowerThird: true }));
  h.get('#simpleCuts').checked = true;
  await h.get('#simpleCuts').fire('change');
  let saved = JSON.parse(h.storage.get(sessionKey));
  assert.equal(saved.simpleCuts, true);
  assert.equal(saved.hasLowerThird, true);
  const restored = harness({ [sessionKey]: JSON.stringify(saved) });
  restored.context.restaurarSessao();
  assert.equal(restored.get('#simpleCuts').checked, true);
  restored.get('#videoUrl').value = 'https://youtu.be/X3HOegrwb8U';
  await restored.get('#videoUrl').fire('input');
  assert.equal(restored.get('#simpleCuts').checked, false);
  assert.equal(restored.get('#hasLowerThird').checked, false);
  restored.get('#simpleCuts').checked = true;
  await restored.get('#simpleCuts').fire('change');
  assert.equal(JSON.parse(restored.storage.get(sessionKey)).simpleCuts, true);
  restored.get('#videoUrl').value = 'https://youtu.be/PMGxFRAea_I?si=outra-url';
  await restored.get('#videoUrl').fire('change');
  assert.equal(restored.get('#simpleCuts').checked, true);
  assert.equal(restored.get('#hasLowerThird').checked, true);
  restored.get('#simpleCuts').checked = false;
  await restored.get('#simpleCuts').fire('change');
  saved = JSON.parse(restored.storage.get(sessionKey));
  assert.equal(saved.simpleCuts, false);
  assert.equal(saved.hasLowerThird, true);
});

test('transcrição envia booleano explícito de modo nos dois modelos e o salva no job', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.get('#videoUrl').value = originalUrl;
    await h.get('#videoUrl').fire('input');
    h.get('#simpleCuts').checked = simpleCuts;
    await h.get('#simpleCuts').fire('change');
    h.get('#hasLowerThird').checked = true;
    await h.get('#btnTranscrever').fire('click');
    assert.equal(starts(h)[0].body.simpleCuts, simpleCuts);
    assert.equal(starts(h)[0].body.hasLowerThird, true);
    assert.equal(JSON.parse(h.storage.get(jobKey)).simpleCuts, simpleCuts);
  }
});

test('modo simples aceita legado e envia o modo independentemente da tarja', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ simpleCuts: true, hasLowerThird: false }));
  await h.import([cut()]);
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  assert.equal(starts(h).length, 1);
  assert.equal(starts(h)[0].body.simpleCuts, true);
  assert.equal(starts(h)[0].body.hasLowerThird, false);
  assert.equal(Object.hasOwn(starts(h)[0].body.cuts[0], 'editorial'), false);
  assert.equal(JSON.parse(h.storage.get(jobKey)).simpleCuts, true);
});

test('modo autoral bloqueia pacote legado ou plano incompleto antes de qualquer rede', async () => {
  for (const editorial of [undefined, {}, { version: 1, scenes: [] }]) {
    const h = harness();
    h.context.mostrarTranscricao(session());
    await h.import([cut(editorial === undefined ? {} : { editorial })]);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(h.requests.length, 0);
    assert.equal(h.get('#btnGerarCortes').disabled, false);
    assert.match(h.alerts[0], /modo autoral precisa de um plano editorial/);
    assert.match(h.alerts[0], /Copiar Prompt para IA/);
    assert.match(h.alerts[0], /Usar corte simples/);
  }
});

test('modo autoral exige plano em todos os cortes e permite usar simples sem reimportar', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.import([cut({ editorial: validPlan() }), cut({ titulo: 'Legado' })]);
  await h.get('#btnGerarCortes').fire('click');
  assert.match(h.alerts[0], /Corte 2:/);
  assert.equal(h.requests.length, 0);
  h.get('#simpleCuts').checked = true;
  await h.get('#simpleCuts').fire('change');
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(starts(h).length, 1);
  assert.equal(starts(h)[0].body.simpleCuts, true);
});

test('modo autoral envia planos válidos intactos e modo false explícito', async () => {
  const h = harness();
  const editorial = validPlan();
  h.context.mostrarTranscricao(session({ hasLowerThird: true }));
  await h.import([cut({ editorial })]);
  h.cards()[0].querySelector('[data-field="titulo"]').value = 'Título revisado';
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  assert.equal(starts(h).length, 1);
  assert.equal(starts(h)[0].body.simpleCuts, false);
  assert.equal(starts(h)[0].body.hasLowerThird, true);
  assert.deepEqual(starts(h)[0].body.cuts[0].editorial, editorial);
  assert.equal(starts(h)[0].body.cuts[0].titulo, 'Título revisado');
});

const readyCut = () => ({
  index: 2, titulo: 'Corte pronto', formato: '9:16',
  files: Object.fromEntries(['video', 'videoLegenda', 'srt', 'post'].map(name => [name, { id: `file-${name}`, url: `https://drive.google.com/file/d/file-${name}/view` }])),
});
function resultHeading(h) {
  const title = new Element('h2');
  const section = new Element('div');
  section.className = 'section-title';
  section.append(title);
  h.get('#resultsSection').append(section);
  return title;
}

test('resultado parcial mostra solicitado/pronto/falha e só encaminha cortes prontos', () => {
  const h = harness();
  const title = resultHeading(h);
  const sent = [];
  h.context.enviarParaPublicadorLocal = result => sent.push(plain(result));
  const result = { folderId: 'folder', requestedCount: 2, completedCount: 1,
    cuts: [readyCut()], errors: [{ index: 1, titulo: 'Corte com erro', error: 'Falha controlada na síntese.' }] };
  h.context.mostrarResultados(result);
  assert.match(title.textContent, /1\/2 cortes prontos; 1 com falha/);
  assert.doesNotMatch(title.textContent, /1\/1|2\/2|concluídos/);
  assert.equal(h.get('#progressPercent').textContent, '50%');
  assert.match(h.get('#cortesStatus').textContent, /1\/2/);
  const failures = h.get('#resultsList').querySelectorAll('.result-error');
  assert.equal(failures.length, 1);
  assert.match(failures[0].textContent, /01\. Corte com erro — falhou/);
  assert.match(failures[0].textContent, /Falha controlada na síntese/);
  assert.equal(h.get('#resultsList').querySelectorAll('.result-card').length, 2);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].cuts.map(cut => cut.index), [2]);
});

test('lote sem êxitos mostra os erros recebidos pelo polling sem enviar à publicação', async () => {
  const h = harness();
  const title = resultHeading(h);
  const sent = [];
  h.context.enviarParaPublicadorLocal = result => sent.push(result);
  const result = { folderId: 'folder', requestedCount: 2, completedCount: 0, cuts: [],
    errors: [{ index: 1, titulo: 'Primeiro', error: 'Erro na voz.' }, { index: 2, titulo: 'Segundo', error: 'Erro de renderização.' }] };
  h.state.job = { status: 'error', stage: 'erro', percent: 100, result, error: 'Nenhum corte foi concluído.' };
  h.context.acompanharJob('request', 'render');
  await new Promise(setImmediate);
  assert.match(title.textContent, /0\/2 cortes prontos; 2 com falha/);
  assert.equal(h.get('#progressPercent').textContent, '0%');
  assert.equal(h.get('#resultsList').querySelectorAll('.result-error').length, 2);
  assert.equal(sent.length, 0);
  assert.ok(h.get('#publisherAutoBanner').className.includes('hidden'));
  assert.equal(JSON.parse(h.storage.get('os4_last_results_view')).errors.length, 2);
});
