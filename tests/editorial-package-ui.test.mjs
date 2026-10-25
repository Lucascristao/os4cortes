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
  const confirmations = [];
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
    alert: message => alerts.push(message), confirm: message => { confirmations.push(message); return true; },
    fetch: async (path, options = {}) => {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      const data = path.includes('workflow-start') ? { requestId: 'request' }
        : path.includes('workflow-control') ? { ok: true }
        : path.includes('workflow-status') ? { job: state.job } : { ok: false };
      return { ok: true, json: async () => data };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext('githubConnected = true;', context);
  return {
    context, get, storage, requests, alerts, copied, confirmations, state,
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
const cover = (template_id = '03_close', title = 'O QUE ELA CONFIRMA?') => ({ version: 1, template_id, title });

test('capa permanece no cartão ao editar, reordenar, excluir, exportar, restaurar e enviar', async () => {
  const h = harness();
  const original = [
    cut({ titulo: 'Primeiro', cover: cover('03_close', 'A DECISÃO É ESSA?') }),
    cut({ titulo: 'Excluir', cover: cover('02_lateral', 'UM OUTRO CAMINHO') }),
    cut({ titulo: 'Último', cover: cover('04_duas_pessoas', 'O QUE ELES DECIDEM?') }),
  ];
  await h.import(original);
  const [first, middle, last] = h.cards();
  assert.match(first.querySelector('.cover-template').textContent, /3 — Close/);
  assert.match(last.querySelector('.cover-template').textContent, /1 — Central/);
  last.querySelector('[data-field="cover_title"]').value = 'A DISCUSSÃO MUDOU?';
  await last.querySelector('[data-field="cover_title"]').fire('input');
  assert.equal(JSON.parse(h.storage.get(packageKey))[2].cover.title, 'A DISCUSSÃO MUDOU?');
  h.get('#cutsEditor').children = [last, middle, first];
  await middle.querySelector('.btn-delete-cut').fire('click');
  const exported = JSON.parse(h.get('#pacote').value);
  assert.deepEqual(exported.map(c => c.cover), [cover('01_central', 'A DISCUSSÃO MUDOU?'), original[0].cover]);
  assert.deepEqual(JSON.parse(h.storage.get(packageKey)), exported);
  const restored = harness({ [packageKey]: h.storage.get(packageKey) });
  restored.context.restaurarSessao();
  await restored.get('#btnImportar').fire('click');
  restored.context.mostrarTranscricao({ folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript', simpleCuts: true });
  await restored.get('#btnGerarCortes').fire('click');
  const sent = restored.requests.find(r => r.path.includes('workflow-start')).body.cuts;
  assert.deepEqual(sent.map(c => c.cover), exported.map(c => c.cover));
  assert.equal(original[2].cover.title, 'O QUE ELES DECIDEM?');
});

test('legados recebem capa conforme formato e título opcional vazio usa o título editado', async () => {
  const h = harness();
  const normalized = plain(h.context.normalizarPacote([cut(), cut({ formato: '16:9' }), cut({ inicio: 0, fim: 181 })], { simpleCuts: true }));
  assert.deepEqual(normalized.map(c => c.cover), [cover('01_central', 'Uma pergunta'), cover('02_lateral', 'Uma pergunta'), cover('02_lateral', 'Uma pergunta')]);
  await h.import([cut({ cover: cover() })]);
  const card = h.cards()[0];
  card.querySelector('[data-field="titulo"]').value = 'Uma nova pergunta';
  card.querySelector('[data-field="cover_title"]').value = '';
  await card.querySelector('[data-field="cover_title"]').fire('input');
  assert.deepEqual(plain(h.context.lerCortesEditor()[0].cover), cover('03_close', 'Uma nova pergunta'));
});

test('modelo aposentado migra conforme formato efetivo sem trocar título nem close', () => {
  const h = harness();
  const legacy = cover('04_duas_pessoas', 'A DECISÃO É ESSA?');
  const input = [cut({ cover: legacy }), cut({ formato: '16:9', cover: legacy }),
    cut({ destino: 'youtube', cover: legacy }), cut({ inicio: 0, fim: 181, cover: legacy }),
    cut({ formato: '16:9', cover: cover() })];
  const normalized = plain(h.context.normalizarPacote(input, { simpleCuts: true }));
  assert.deepEqual(normalized.map(c => c.cover), [cover('01_central', legacy.title),
    cover('02_lateral', legacy.title), cover('02_lateral', legacy.title),
    cover('02_lateral', legacy.title), cover()]);
  assert.equal(legacy.template_id, '04_duas_pessoas', 'não altera o pacote de origem');

  const editorial = { scenes: [{ kind: 'clip', start: 10, end: 20 }] };
  const shortEditorial = cut({ inicio: 0, fim: 181, cover: legacy, editorial });
  assert.equal(h.context.normalizarPacote([shortEditorial], { simpleCuts: false })[0].cover.template_id, '01_central');
});

test('capa inválida é rejeitada sem descartar silenciosamente modelo ou título', () => {
  const h = harness();
  const invalid = [null, [], 'close', {}, cover('modelo_inexistente'), { ...cover(), version: true },
    { ...cover(), version: 2 }, cover('01_central', ''), cover('01_central', 'a'.repeat(61)),
    cover('01_central', 'Duas\nlinhas'), cover('01_central', '<b>Título</b>'), cover('01_central', '**Título**'),
    cover('01_central', '`Título`'), cover('01_central', '[Título](https://example.test)'),
    cover('01_central', 'Título\u200boculto'), cover('01_central', 'Duas\u2028linhas'), { ...cover(), extra: true }];
  for (const value of invalid) assert.throws(() => h.context.normalizarPacote([cut({ cover: value })]), /Corte 1: cover/);
  const unicode = cover('01_central', 'á'.repeat(60));
  assert.deepEqual(plain(h.context.normalizarPacote([cut({ cover: unicode })])[0].cover), unicode);
});

test('título legado longo fica intacto e pede título curto de capa antes da geração', async () => {
  const h = harness();
  const title = 'Um título antigo de publicação que tem mais de sessenta caracteres e continua intacto';
  await h.import([cut({ titulo: title, formato: '16:9' })]);
  assert.equal(h.cards()[0].querySelector('[data-field="titulo"]').value, title);
  assert.equal(Object.hasOwn(JSON.parse(h.storage.get(packageKey))[0], 'cover'), false);
  const restored = harness({ [packageKey]: h.storage.get(packageKey) });
  restored.context.restaurarSessao();
  await restored.get('#btnImportar').fire('click');
  assert.equal(restored.cards().length, 1, 'o legado continua editável após recarregar antes de definir a capa');
  h.context.mostrarTranscricao({ folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript', simpleCuts: true });
  await h.get('#btnGerarCortes').fire('click');
  assert.match(h.alerts.at(-1), /cover.title.*até 60 caracteres/);
  assert.equal(h.requests.some(r => r.path.includes('workflow-start')), false);
  h.cards()[0].querySelector('[data-field="cover_title"]').value = 'O QUE MUDA AGORA?';
  await h.get('#btnGerarCortes').fire('click');
  const sent = h.requests.find(r => r.path.includes('workflow-start')).body.cuts[0];
  assert.equal(sent.titulo, title);
  assert.deepEqual(sent.cover, cover('02_lateral', 'O QUE MUDA AGORA?'));
});

test('pacote legado atualiza publicação sem alterar fonte, URLs ou narração', () => {
  const h = harness();
  const editorial = plan();
  editorial.source = { label: 'OS4 Cortes', url: 'https://example.test/os4cortes' };
  editorial.scenes[0].text = 'A fonte disse OS4 Cortes e @os4.cortes.';
  const original = cut({ titulo: 'OS4 CORTES comenta', editorial,
    legenda_post: 'Siga @os4.cortes para mais insights diários sobre negócios e liderança.\nhttps://os4cortes.netlify.app\n@os4cortes.extra',
    hashtags: ['#politica', '#os4cortes'] });
  const [updated] = h.context.normalizarPacote([original]);
  assert.equal(updated.titulo, 'OS4 de Direita comenta');
  assert.match(updated.legenda_post, /Siga @os4dedireita para mais insights com análises e comentários\./);
  assert.match(updated.legenda_post, /https:\/\/os4cortes.netlify.app/);
  assert.match(updated.legenda_post, /@os4cortes.extra/);
  assert.equal(updated.hashtags, '#politica #os4dedireita');
  assert.equal(updated.editorial, editorial);
  assert.deepEqual(plain(h.context.normalizarPacote([updated])), plain([updated]));
  assert.equal(original.titulo, 'OS4 CORTES comenta');
});

test('restaurar pacote legado migra somente metadados preservando o contrato salvo', () => {
  const original = { cortes: [cut({ titulo: 'OS4 Cortes', legenda_post: 'Siga @os4cortes', editorial: plan() })], extension: 7 };
  const h = harness({ [packageKey]: JSON.stringify(original) });
  h.context.restaurarSessao();
  const saved = JSON.parse(h.storage.get(packageKey));
  assert.equal(saved.extension, 7);
  assert.equal(saved.cortes[0].titulo, 'OS4 de Direita');
  assert.equal(saved.cortes[0].legenda_post, 'Siga @os4dedireita');
  assert.deepEqual(saved.cortes[0].editorial, original.cortes[0].editorial);
  assert.deepEqual(JSON.parse(h.get('#pacote').value), saved);
});

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

test('resumo da direção tolera cena nula e a validação bloqueia o plano sem iniciar processamento', async () => {
  const h = harness();
  h.context.mostrarTranscricao({ folderId: 'folder', videoFileId: 'video', transcriptJsonFileId: 'transcript' });
  await h.import([cut({ editorial: { version: 1, scenes: [null, { id: 'fonte', kind: 'clip', start: 10, end: 20 }] } })]);
  assert.equal(h.cards().length, 1);
  assert.equal(h.alerts.length, 0);
  await h.get('#btnGerarCortes').fire('click');
  assert.match(h.alerts[0], /plano editorial/);
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

function promptExample(prompt) {
  const json = prompt.match(/^\[\r?\n[\s\S]*?^\]/m)?.[0];
  assert.ok(json, 'o prompt deve incluir um exemplo de array JSON válido');
  return JSON.parse(json);
}

test('prompts escolhem três capas para os dois formatos e delegam a composição ao motor', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    for (const id of ['01_central', '02_lateral', '03_close']) assert.ok(prompt.includes(id));
    assert.ok(!prompt.includes('04_duas_pessoas'));
    assert.match(prompt, /um dos três modelos/);
    assert.match(prompt, /Escolha aleatoriamente/);
    assert.match(prompt, /o motor seleciona os frames reais dos trechos originais e monta a capa/);
    assert.match(prompt, /de 3 a 6 palavras, preferencialmente até 32 caracteres/);
    assert.match(prompt, /03_close, prefira até 24/);
    assert.match(prompt, /tanto em 9:16 quanto em 16:9/);
    for (const example of promptExample(prompt)) assert.deepEqual(Object.keys(example.cover).sort(), ['template_id', 'title', 'version']);
    if (!simpleCuts) {
      assert.match(prompt, /Em qualquer tema, comece diretamente por um clip/);
      assert.match(prompt, /de 8 a 15 segundos finais/);
      assert.match(prompt, /Some TODAS as narrações anteriores ao primeiro clip/);
      assert.match(prompt, /1,10×.*−0,5 semitom/);
      assert.match(prompt, /Zero ou menos de oito segundos também são válidos/);
      assert.match(prompt, /Acima de quinze segundos haverá apenas aviso editorial/);
    }
  }
});

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
  assert.match(prompt, /aprofundar uma explicação completa/);
  assert.match(prompt, /o menor start e o maior end de TODAS as referências/);
  assert.match(prompt, /A duração final é a soma dos áudios narrados e dos clips/);
  assert.match(prompt, /hook na abertura.*explain ao explicar.*closing ao concluir/);
  assert.match(prompt, /sem insinuações ou acusações/);
  assert.doesNotMatch(prompt, /Diretriz Anti-Bloqueio/);
});

test('modo simples pede cortes da fonte sem incluir plano editorial ou eufemismos automáticos', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ simpleCuts: true }));
  await h.get('#btnCopiarPromptIA').fire('click');
  assert.match(h.copied[0], /editor sênior e estrategista multiplataforma/);
  assert.match(h.copied[0], /GRUPO 2: CORTES LONGOS/);
  assert.doesNotMatch(h.copied[0], /Diretriz Anti-Bloqueio|Use eufemismos conceituais neutros/);
  assert.doesNotMatch(h.copied[0], /"editorial"/);
});

test('exemplos dos dois prompts continuam importáveis no modo correspondente', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const examples = promptExample(h.copied[0]);
    await h.import(examples);
    assert.deepEqual(h.alerts, []);
    assert.equal(h.cards().length, examples.length);
    const imported = JSON.parse(h.storage.get(packageKey));
    assert.deepEqual(imported.map(cut => cut.cover), examples.map(cut => cut.cover));
    assert.deepEqual(imported.map(cut => cut.editorial), examples.map(cut => cut.editorial));
    assert.equal(starts(h).length, 0, 'importar exemplos não inicia a produção');
  }
});

test('ambos os modos recebem o mesmo filtro editorial antes do schema e da transcrição', async () => {
  const sharedFilters = [];
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    const filter = vm.runInContext('DIRETRIZ_VARREDURA_EXAUSTIVA', h.context);
    const filterIndex = prompt.indexOf(filter);
    assert.ok(filterIndex >= 0, 'a seleção compartilhada integra o prompt copiado');
    assert.equal(prompt.indexOf(filter, filterIndex + filter.length), -1, 'o filtro não é duplicado');
    assert.ok(filterIndex < prompt.indexOf('\n[\n'), 'seleção precede o exemplo de escrita e montagem');
    assert.ok(filterIndex < prompt.indexOf('--- TRANSCRIÇÃO ---'));
    const stages = ['Descoberta completa', 'Prova de valor e filtro de aprovação', 'Recuperação e comparação do lote', 'Auditoria de cobertura e de excesso', 'Produção silenciosa do JSON'];
    const positions = stages.map(stage => filter.indexOf(stage));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), 'descoberta, filtro e dupla auditoria precedem a produção');
    assert.match(filter, /interesse específico, entrega real, autonomia, densidade, fidelidade e distinção/);
    assert.match(filter, /Todo resgate volta ao mesmo filtro de aprovação; descoberta tardia não garante inclusão/);
    if (!simpleCuts) assert.ok(filterIndex < prompt.indexOf('PRIORIDADE DE ESCRITA'), 'aprovação editorial precede a redação autoral');
    assert.doesNotMatch(prompt, /não economize cortes|sem economia|descarte apenas|12,\s*15 ou mais|resgate-a e incorpore-a/i);
    assert.doesNotMatch(prompt, /contendo DOIS TIPOS DE CORTES|Proponha os DOIS destinos/);
    assert.match(prompt, /Pode haver apenas um formato; não crie uma versão para cumprir categoria/);
    sharedFilters.push(filter);
  }
  assert.equal(sharedFilters[0], sharedFilters[1]);
});

test('o valor exigido corresponde ao áudio contínuo no simples e à contribuição concreta no autoral', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    const heading = simpleCuts ? 'VALOR DO CORTE SIMPLES' : 'VALOR DO FORMATO AUTORAL';
    const start = prompt.indexOf(heading);
    assert.ok(start >= 0);
    const section = prompt.slice(start, prompt.indexOf('\n\n', start));
    if (simpleCuts) {
      assert.match(section, /no próprio áudio original do intervalo contínuo entre inicio e fim/);
      assert.match(section, /Se faltar contexto, leia antes e depois e ajuste o intervalo/);
      assert.match(section, /Não una partes distantes como se o modo simples permitisse pontes ou supressões internas/);
    } else {
      assert.match(section, /Avalie primeiro a entrega da fonte e depois a contribuição do OS4/);
      assert.match(section, /Uma contribuição não pode ser apenas descrever o que a fonte disse/);
      assert.match(section, /se o roteiro apenas anuncia, reproduz e parafraseia/i);
    }
  }
});

test('ambos os prompts identificam o canal e o @ atual em todas as redes', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    assert.match(prompt, /Nome oficial: OS4 de Direita/);
    assert.match(prompt, /@os4dedireita em todas as redes: Instagram, TikTok e YouTube/);
    assert.match(prompt, /Preserve a identidade visual e o logo OS4/);
    assert.match(prompt, /inclua uma única assinatura/);
    assert.doesNotMatch(prompt, /OS4 Cortes|@os4\.cortes|#os4cortes/);
  }
});

test('ambos os prompts exigem créditos por título e participantes confirmados sem publicar a URL', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    const credits = prompt.split('CRÉDITOS DE PUBLICAÇÃO')[1]?.split(/\r?\n\s*\r?\n/)[0] || '';
    assert.ok(credits, 'os dois modos precisam compartilhar a diretriz de créditos');
    assert.match(credits, /título oficial/i);
    assert.match(credits, /participantes[^\n.]*confirmad[^\n.]*transcrição[^\n.]*metadados/i);
    const urlRule = credits.split(/\r?\n/).find(line => /URL/i.test(line) && /legenda_post/.test(line) && /descricao/.test(line));
    assert.ok(urlRule, 'a diretriz deve tratar os dois campos de publicação');
    assert.match(urlRule, /não/i);
    assert.match(prompt, /URL[^\n.]*referência interna/i);
    assert.ok(prompt.includes(originalUrl), 'o vídeo continua identificado no contexto interno da IA');
    assert.doesNotMatch(prompt, /A URL identifica e credita o vídeo/);
  }
});

test('exemplos dos dois modos usam o título conhecido e pedem participantes confirmados sem link', async () => {
  const title = 'ANA E BRUNO: "NEGÓCIOS E DECISÕES" | Episódio 42';
  const meta = { title, author: 'Canal Entrevistas', url: originalUrl };
  for (const simpleCuts of [false, true]) {
    const h = harness({ os4_current_video_meta: JSON.stringify(meta) });
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const examples = promptExample(h.copied[0]);
    const publicationTexts = examples.flatMap(cut => [cut.legenda_post, cut.descricao].filter(value => typeof value === 'string'));
    assert.ok(publicationTexts.length > 0);
    for (const text of publicationTexts) {
      assert.ok(text.includes(title), 'o crédito deve trazer o título real obtido nos metadados');
      assert.match(text, /\n\n🎬 Episódio completo:/, 'o JSON deve preservar as quebras de linha do crédito');
      assert.match(text, /(?:🎙️ Com:|👥 Participantes:)\s*\[[^\]]*participantes[^\]]*confirmad[^\]]*transcrição[^\]]*metadados[^\]]*\]/i);
      assert.doesNotMatch(text, /https?:\/\/|youtu(?:\.be|be\.com)|Participante A e Participante B/i);
    }
  }
});

test('sem metadados os créditos orientam omissão dos dados ausentes sem inventar título, canal ou nomes', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    const credits = prompt.split('CRÉDITOS DE PUBLICAÇÃO')[1]?.split(/\r?\n\s*\r?\n/)[0] || '';
    assert.match(credits, /não invente[^\n.]*(?:títulos?|nomes?|canal|host)/i);
    assert.match(credits, /omit[ae][^\n.]*(?:crédito|linha|dado)/i);
    const examples = promptExample(prompt);
    for (const example of examples) {
      for (const text of [example.legenda_post, example.descricao].filter(value => typeof value === 'string')) {
        assert.match(text, /Episódio completo:\s*"?\[[^\]]*título oficial[^\]]*\]/i);
        assert.doesNotMatch(text, /Canal Oficial|Participante A e Participante B|https?:\/\//i);
      }
    }
  }
});

test('prompts delegam seleção à IA e pedem ideia completa com apelo sem faixas de duração', async () => {
  for (const simpleCuts of [false, true]) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts }));
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    assert.match(prompt, /automaticamente/);
    assert.match(prompt, /FONTE EXCLUSIVA DESTE TRABALHO/);
    assert.match(prompt, /Não navegue, não pesquise sites, notícias ou artigos de apoio/);
    assert.match(prompt, /URL[^\n.]*referência interna/i);
    assert.match(prompt, /Fim de segmento da transcrição não (?:é necessariamente|garante) fim de frase/);
    assert.doesNotMatch(prompt, /dados externos sem fonte verificada/);
    assert.match(prompt, /apelo viral ou curioso sustentado pelo material/);
    assert.match(prompt, /frase solta/);
    assert.match(prompt, /história (?:completa, mas banal|banal)/);
    assert.match(prompt, /180 segundos/);
    assert.match(prompt, /duração mínima numérica/);
    assert.doesNotMatch(prompt, /25 a 60|60 a 120|120 a 175|limite máximo: 175|65[–-]85|4 a 20 minutos|25 a 30 minutos/);
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.requests.some(request => /review|editorial-check|generate-script/.test(request.path)), false);
    if (!simpleCuts) {
      assert.match(prompt, /A narração acrescentada NÃO entra nesse limite/);
      assert.match(prompt, /vídeo vertical pronto pode passar de 3 minutos/);
      assert.match(prompt, /some end - start somente das cenas kind: "clip"/);
      assert.match(prompt, /scenes pertence ao objeto editorial/);
    }
  }
});

test('roteamento usa apenas clips: até 180 segundos vertical, acima YouTube, com envelope e narração à parte', async () => {
  for (const [seconds, expected] of [[179.9, '9:16'], [180, '9:16'], [180.1, '16:9']]) {
    const h = harness();
    h.context.mostrarTranscricao(session());
    const editorial = validPlan();
    editorial.scenes[0].text = 'Uma observação própria sobre a fala, com contexto e desenvolvimento. '.repeat(10);
    editorial.scenes[0].background = { start: 300, end: 400 };
    editorial.scenes[0].evidence = [{ start: 10, end: 590 }];
    editorial.scenes[1] = { id: 'fala', kind: 'clip', start: 10, end: 10 + seconds };
    await h.import([cut({ inicio: 0, fim: 600, destino: 'reels_tiktok', editorial,
      legenda_post: 'Crédito e comentário.', hashtags: ['#assunto'] })]);
    assert.equal(h.cards()[0].dataset.formato, expected);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(h.alerts.length, 0);
    const sent = starts(h)[0].body.cuts[0];
    assert.equal(sent.formato, expected);
    assert.equal(sent.destino, expected === '16:9' ? 'youtube' : 'reels_tiktok');
    assert.equal(sent.legenda_post, 'Crédito e comentário.');
    assert.equal(sent.hashtags, '#assunto');
    assert.deepEqual(sent.editorial, editorial);
  }
});

test('clips descontínuos conservam 180 segundos e repetições contam novamente sem inferir pelo envelope', () => {
  const h = harness();
  const editorial = validPlan();
  editorial.scenes[1] = { id: 'fala-1', kind: 'clip', start: 101.7, end: 201.7 };
  editorial.scenes.push({ id: 'fala-2', kind: 'clip', start: 265.2, end: 345.2 });
  const raw = cut({ inicio: 0, fim: 600, formato: undefined, editorial });
  assert.equal(h.context.normalizarPacote([raw])[0].formato, '9:16');
  editorial.scenes[2] = { id: 'reprise', kind: 'clip', start: 101.7, end: 201.7 };
  assert.equal(h.context.normalizarPacote([raw])[0].formato, '16:9');
  assert.equal(h.context.normalizarPacote([cut({ inicio: 0, fim: 600, formato: '16:9', editorial: validPlan() })])[0].formato, '16:9');
});

test('corte simples usa o trecho original e inclui exatamente três minutos no vertical', () => {
  const h = harness();
  for (const [end, expected] of [[189.9, '9:16'], [190, '9:16'], [190.1, '16:9']]) {
    const normalized = h.context.normalizarPacote([cut({ inicio: 10, fim: end })])[0];
    assert.equal(normalized.formato, expected);
    assert.equal(Object.hasOwn(normalized, 'editorial'), false);
  }
});

test('trocar para simples sem reimportar usa o intervalo inteiro e atualiza o destino no envio', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  const editorial = validPlan();
  await h.import([cut({ inicio: 0, fim: 600, editorial, legenda_post: 'Texto e crédito.' })]);
  assert.equal(h.cards()[0].dataset.formato, '9:16');
  h.get('#simpleCuts').checked = true;
  await h.get('#simpleCuts').fire('change');
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  const sent = starts(h)[0].body;
  assert.equal(sent.simpleCuts, true);
  assert.equal(sent.cuts[0].formato, '16:9');
  assert.equal(sent.cuts[0].destino, 'youtube');
  assert.equal(sent.cuts[0].descricao, 'Texto e crédito.');
  assert.equal(h.cards()[0].dataset.formato, '16:9');
});

test('editar o intervalo simples recalcula o destino sem alterar os tempos digitados', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ simpleCuts: true }));
  await h.import([cut({ inicio: 10, fim: 170, legenda_post: 'Texto e crédito.' })]);
  h.cards()[0].querySelector('[data-field="fim"]').value = '03:20';
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  const sent = starts(h)[0].body.cuts[0];
  assert.equal(sent.fim, '03:20');
  assert.equal(sent.formato, '16:9');
  assert.equal(sent.destino, 'youtube');
  assert.equal(sent.descricao, 'Texto e crédito.');
});

test('prompt autoral dá personalidade e adapta comentário e interpretação a cada contexto', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  assert.match(prompt, /comentarista de direita, de bem com a vida/);
  assert.match(prompt, /leitura editorial de direita/);
  assert.match(prompt, /Não force partidarismo onde o assunto não pede/);
  assert.match(prompt, /preparação, a surpresa, o tempo da piada/);
  assert.match(prompt, /três blocos de narração/);
  assert.match(prompt, /perguntas na abertura ou no fechamento também não são obrigatórias/);
  assert.match(prompt, /Não há obrigação de encerrar com limite de evidência/);
  assert.match(prompt, /quando atrapalharia a graça ou o fechamento/);
  assert.match(prompt, /Contexto grave ou sensível pede tone serious/);
  assert.match(prompt, /Cada cena herda tone e intensity do profile/);
  assert.match(prompt, /tts\.tone e\/ou tts\.intensity/);
  assert.match(prompt, /somente a fala literal/);
  assert.match(prompt, /Não invente falas, datas, participantes/);
  assert.doesNotMatch(prompt, /\[Resposta à pergunta inicial, limite da evidência/);
  const example = JSON.parse(prompt.match(/(\[\n  \{\n    "titulo"[\s\S]+?\n\])\n/)[1]);
  const profile = example[0].editorial.profile;
  assert.deepEqual(Object.keys(profile).sort(), ['angle', 'audience_question', 'intensity', 'perspective', 'tone', 'topic']);
  assert.equal(profile.perspective, 'right');
  assert.equal(profile.topic, 'politics');
  assert.equal(profile.tone, 'provocative');
  assert.equal(profile.audience_question, '', 'o exemplo não deve impor pergunta ao público');
  assert.equal(example[0].editorial.scenes[0].kind, 'clip', 'o exemplo demonstra entrada direta pela fonte');
  assert.ok(example[0].editorial.scenes.some(scene => scene.kind === 'narration'), 'o exemplo continua autoral');
});

test('prompt autoral mantém rótulo em português, destaque e apoio curto sem truncar palavras', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  assert.match(prompt, /rótulo temático acima, destaque principal e uma frase curta de apoio abaixo/);
  assert.match(prompt, /não apague o rótulo ou o apoio para resolver excesso de texto/);
  assert.match(prompt, /3 a 7 palavras, até 60 caracteres/);
  assert.match(prompt, /reescreva com menos palavras; nunca corte por número de caracteres/);
  assert.match(prompt, /visual\.kicker em português, com até 24 caracteres/);
  assert.match(prompt, /exatamente uma frase completa e curta.*4 a 8 palavras.*9 palavras e 55 caracteres/);
  assert.match(prompt, /sem parágrafo, resumo do argumento inteiro ou repetição literal da legenda da voz/);
  assert.match(prompt, /profile\.topic mantém os valores técnicos em inglês do contrato/);
  assert.match(prompt, /nunca copie o valor inglês de profile\.topic para visual\.kicker, visual\.title ou visual\.lines/);
  assert.match(prompt, /profile\.angle, intent\.source_point e intent\.contribution.*nunca copie esses campos automaticamente para a tela/);
  assert.doesNotMatch(prompt, /sempre envie visual\.kicker: ""|visual\.lines: \[\]|visual\.title é o único destaque/);
  const [example] = promptExample(prompt);
  assert.equal(example.editorial.profile.topic, 'politics', 'o enum interno continua compatível com o contrato');
  for (const scene of example.editorial.scenes.filter(scene => scene.kind === 'narration')) {
    assert.equal(scene.visual.kicker, 'Política');
    assert.equal(scene.visual.lines.length, 1);
    assert.ok(scene.visual.lines[0].length <= 55);
    assert.ok(scene.visual.lines[0].split(/\s+/).length <= 9);
    assert.ok(scene.visual.title.length <= 60);
  }
});

test('importação conserva rótulos e apoio e aceita pacotes anteriores com campos vazios', async () => {
  for (const cleanVisual of [true, false]) {
    const h = harness();
    h.context.mostrarTranscricao(session());
    const editorial = validPlan();
    if (cleanVisual) editorial.scenes[0].visual = { title: 'Quem decide as regras?', kicker: '', lines: [] };
    const original = structuredClone(editorial);
    await h.import([cut({ editorial })]);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(h.alerts.length, 0);
    assert.equal(starts(h).length, 1);
    assert.deepEqual(starts(h)[0].body.cuts[0].editorial, original);
  }
});

test('prompt transmite cocomentário, intenção e exemplos com conferência interna na mesma resposta', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  assert.match(prompt, /Identidade permanente do OS4/);
  assert.match(prompt, /atue como cocomentarista alinhado/);
  assert.match(prompt, /preserve o foco da cobrança política/);
  assert.match(prompt, /pelo argumento demonstrável/);
  assert.match(prompt, /não se torna aliada porque aparece em um canal de direita/);
  assert.match(prompt, /Uma pergunta de entrevistador tampouco é uma confirmação independente/);
  assert.match(prompt, /Exemplos FICTÍCIOS/);
  assert.match(prompt, /Cocomentário político alinhado/);
  assert.match(prompt, /Humor: numa situação inventada/);
  assert.match(prompt, /Negócios: num caso inventado/);
  assert.match(prompt, /Não transporte os acontecimentos fictícios para o JSON/);
  assert.match(prompt, /exatamente estes quatro campos/);
  assert.match(prompt, /Confira|confira internamente o roteiro no mesmo trabalho de escrita/);
  assert.match(prompt, /sem criar uma etapa de conferência humana por vídeo/);
  assert.match(prompt, /sem repetir o trecho/);
  assert.match(prompt, /monólogo final de um minuto/);
  const example = JSON.parse(prompt.match(/(\[\n  \{\n    "titulo"[\s\S]+?\n\])\n/)[1]);
  assert.deepEqual(Object.keys(example[0].editorial.intent).sort(), ['contribution', 'mode', 'source_point', 'target']);
  assert.equal(example[0].editorial.intent.mode, 'support_source');
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.requests.some(request => /review|editorial-check|generate-script/.test(request.path)), false);
});

test('prompt copiado exige contexto audível antes das referências e preserva a situação da fala', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  const contextStart = prompt.indexOf('CADA CORTE PRECISA SE EXPLICAR SOZINHO');
  assert.ok(contextStart > prompt.indexOf('FONTE EXCLUSIVA DESTE TRABALHO'));
  assert.ok(contextStart < prompt.indexOf('Identidade permanente do OS4'));
  assert.match(prompt, /pessoa que não viu a fonte nem os outros cortes/);
  assert.match(prompt, /Frases completas não garantem uma história compreensível/);
  assert.match(prompt, /precisa ser ouvido nos clips ou no text das narrações/);
  assert.match(prompt, /source, profile, intent e evidence não substituem essa apresentação ao público/);
  assert.match(prompt, /Antes da primeira referência que dependa de algo anterior/);
  assert.match(prompt, /pergunta respondida, pessoa ou relação relevante, apelido, comparação, personagem, metáfora/);
  assert.match(prompt, /lendo um artigo, citando outra pessoa, encenando ou imaginando uma hipótese/);
  assert.match(prompt, /Preserve a diferença entre o que ela afirma e o que imagina/);
  assert.match(prompt, /Só comece direto no clip se a situação e as referências necessárias forem compreensíveis ali/);
  assert.match(prompt, /associe-as a evidence e ajuste o envelope/);
  assert.match(prompt, /TESTE DO ESPECTADOR SEM CONTEXTO/);
  assert.match(prompt, /somente os clips e o text que serão ouvidos, na ordem final/);
  assert.match(prompt, /Marque internamente a primeira referência que ficou sem explicação e corrija antes dela/);
  assert.match(prompt, /a estrutura técnica não comprova contexto nem qualidade editorial/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.requests.some(request => /review|editorial-check|generate-script/.test(request.path)), false);
});

test('prompt reúne histórias dependentes sem inventar elos e aceita narração para contextualizar', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  await h.get('#btnCopiarPromptIA').fire('click');
  const prompt = h.copied[0];
  assert.match(prompt, /Avalie os candidatos em conjunto antes de fechar o lote/);
  assert.match(prompt, /mesma preparação e desenvolvem a mesma história, reúna-os em um único corte se isso completar seu arco/);
  assert.match(prompt, /Não entregue pedaços que só fazem sentido quando o público já viu outro vídeo/);
  assert.match(prompt, /ponte que explique o elo real ou a mudança de assunto/);
  assert.match(prompt, /não invente causalidade, intenção ou sequência temporal entre elas/);
  assert.match(prompt, /Compartilhar pessoa, tema ou vídeo de origem não basta para juntar histórias diferentes/);
  assert.match(prompt, /Recalcule as referências, o envelope e a soma dos clips após reorganizar/);
  assert.match(prompt, /Repor contexto indispensável ou resolver uma referência pela primeira vez é uma função legítima da narração/);
  assert.match(prompt, /não elimine essa fala por ela não acrescentar uma opinião/);
  assert.match(prompt, /\(3\) esta intervenção entrega contexto necessário, resolve uma referência ou acrescenta uma ideia/);
  assert.match(prompt, /Se o material não permitir torná-la compreensível, descarte o candidato/);
  assert.match(prompt, /sem pedir conferência ao usuário/);
  assert.match(prompt, /Não force uma quantidade mínima de cortes/);
  assert.match(prompt, /Não imponha|sem duração mínima numérica/);
  assert.match(prompt, /não significam três blocos de narração/);
  assert.doesNotMatch(prompt, /Lulinha|Dois Diabinhos|samba de Lula/);
});

const contextualProfile = extra => ({
  perspective: 'right', topic: 'politics', tone: 'provocative', intensity: 'medium',
  angle: 'O peso político da resposta que ouvimos.', audience_question: 'Qual resposta faltou nesta conversa?', ...extra,
});

test('perfil e direção por cena sobrevivem edição, exclusão, restauração e envio sem alteração', async () => {
  const h = harness();
  const editorial = validPlan();
  editorial.profile = contextualProfile({ topic: 'humor', tone: 'playful', intensity: 'low', audience_question: '' });
  editorial.scenes[0].tts = { delivery: 'hook', cues: [], tone: 'ironic', intensity: 'medium' };
  await h.import([cut({ titulo: 'Excluir' }), cut({ editorial })]);
  h.cards()[1].querySelector('[data-field="titulo"]').value = 'Humor revisado';
  await h.cards()[0].querySelector('.btn-delete-cut').fire('click');
  const saved = JSON.parse(h.storage.get(packageKey));
  assert.deepEqual(saved[0].editorial, editorial);
  const restored = harness({ [packageKey]: JSON.stringify(saved), [sessionKey]: JSON.stringify(session()) });
  restored.context.restaurarSessao();
  await restored.get('#btnImportar').fire('click');
  await restored.get('#btnGerarCortes').fire('click');
  assert.equal(restored.alerts.length, 0);
  assert.equal(starts(restored)[0].body.cuts[0].titulo, 'Humor revisado');
  assert.deepEqual(starts(restored)[0].body.cuts[0].editorial, editorial);
});

test('cartão permite revisar tema, tom, intensidade, ângulo, pergunta e herança da voz sem HTML', async () => {
  const h = harness();
  const editorial = validPlan();
  const literal = '<img src=x onerror=alert(1)>';
  editorial.profile = contextualProfile({ angle: literal });
  editorial.intent = { mode: 'support_source', source_point: literal, target: literal, contribution: literal };
  await h.import([cut({ editorial })]);
  const details = h.cards()[0].querySelector('.editorial-direction');
  assert.match(details.textContent, /Comentarista de direita.*Política.*Provocativo.*Média/);
  assert.ok(details.textContent.includes(`Ângulo: ${literal}`));
  assert.match(details.textContent, /Pergunta ao público: Qual resposta faltou/);
  assert.match(details.textContent, /abertura: Provocativo; intensidade Média \(acompanha o corte\)/);
  assert.match(details.textContent, /Papel do narrador: Cocomentário alinhado/);
  for (const label of ['Ponto da fonte', 'Alvo da cobrança', 'Contribuição do OS4']) {
    assert.ok(details.querySelectorAll('p').some(line => line.textContent === `${label}: ${literal}`));
  }
  assert.equal(details.querySelector('img'), null);
  assert.ok(details.querySelectorAll('p').some(line => line.textContent === `Ângulo: ${literal}`));
});

test('os três papéis atravessam importação, edição e restauração e geram sem aprovação adicional', async () => {
  const intents = JSON.parse(fs.readFileSync(new URL('./fixtures/editorial-commentary-intents.json', import.meta.url), 'utf8'));
  assert.deepEqual(intents.map(intent => intent.mode).sort(), ['challenge_source', 'direct_commentary', 'support_source']);
  for (const intent of intents) {
    const h = harness();
    const editorial = validPlan();
    editorial.profile = contextualProfile();
    editorial.intent = intent;
    h.context.mostrarTranscricao(session());
    await h.import([cut({ titulo: 'Excluir' }), cut({ editorial })]);
    h.cards()[1].querySelector('[data-field="titulo"]').value = 'Comentário com intenção';
    await h.cards()[0].querySelector('.btn-delete-cut').fire('click');
    // Deletion still has its existing confirmation; generating adds no approval.
    h.confirmations.length = 0;
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(h.alerts.length, 0, intent.mode);
    assert.equal(h.confirmations.length, 0, intent.mode);
    assert.deepEqual(starts(h)[0].body.cuts[0].editorial, editorial);
    const saved = JSON.parse(h.storage.get(packageKey));
    assert.deepEqual(saved[0].editorial.intent, intent);
    const restored = harness({ [packageKey]: JSON.stringify(saved), [sessionKey]: JSON.stringify(session()) });
    restored.context.restaurarSessao();
    await restored.get('#btnImportar').fire('click');
    await restored.get('#btnGerarCortes').fire('click');
    assert.deepEqual(starts(restored)[0].body.cuts[0].editorial.intent, intent);
    assert.equal(restored.confirmations.length, 0, intent.mode);
    assert.ok(restored.requests.every(request => /workflow-(start|status)/.test(request.path)), intent.mode);
    if (intent.target === '') assert.match(restored.cards()[0].textContent, /Sem cobrança específica/);
  }
});

test('intenção é opcional para pacotes anteriores e não é fabricada pelo importador', async () => {
  const h = harness();
  const editorial = validPlan();
  editorial.profile = contextualProfile();
  h.context.mostrarTranscricao(session());
  await h.import([cut({ editorial })]);
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(starts(h)[0].body.cuts[0].editorial, editorial);
  assert.equal(Object.hasOwn(starts(h)[0].body.cuts[0].editorial, 'intent'), false);
});

test('intenção presente exige quatro campos válidos, sem descartar o pacote antes do diagnóstico', async () => {
  const validIntent = { mode: 'direct_commentary', source_point: 'O assunto da fonte.', target: '', contribution: 'Uma observação própria.' };
  const invalid = [null, [], 'support_source', {},
    { ...validIntent, mode: 'right' }, { ...validIntent, mode: 'toString' },
    { ...validIntent, source_point: '' }, { ...validIntent, source_point: ' ' }, { ...validIntent, source_point: 1 },
    { ...validIntent, source_point: 'a'.repeat(241) }, { ...validIntent, target: null },
    { ...validIntent, target: 'a'.repeat(241) }, { ...validIntent, contribution: '' },
    { ...validIntent, contribution: ' ' }, { ...validIntent, contribution: 'a'.repeat(241) },
    { ...validIntent, approved: true },
    Object.fromEntries(Object.entries(validIntent).filter(([key]) => key !== 'target')),
  ];
  for (const intent of invalid) {
    const h = harness();
    const editorial = validPlan();
    editorial.intent = intent;
    h.context.mostrarTranscricao(session());
    await h.import([cut({ editorial })]);
    assert.deepEqual(plain(h.context.lerCortesEditor()[0].editorial.intent), intent);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(starts(h).length, 0, JSON.stringify(intent));
    assert.equal(h.alerts.length, 1, JSON.stringify(intent));
    assert.match(h.alerts[0], /Corte 1:/);
  }
});

test('todos os perfis contextuais compartilhados passam pelo gate e seguem intactos ao motor', async () => {
  const profiles = JSON.parse(fs.readFileSync(new URL('./fixtures/editorial-contextual-profiles.json', import.meta.url), 'utf8'));
  assert.equal(new Set(profiles.map(profile => profile.tone)).size, 6);
  for (const profile of profiles) {
    const h = harness();
    const editorial = validPlan();
    editorial.profile = profile;
    editorial.scenes[0].tts.tone = profile.tone;
    editorial.scenes[0].tts.intensity = profile.intensity;
    h.context.mostrarTranscricao(session());
    await h.import([cut({ editorial })]);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(h.alerts.length, 0, JSON.stringify(profile));
    assert.deepEqual(starts(h)[0].body.cuts[0].editorial, editorial);
  }
});

test('pacote autoral anterior mantém direção padrão e não ganha metadados ao enviar', async () => {
  const h = harness();
  const editorial = validPlan();
  h.context.mostrarTranscricao(session());
  await h.import([cut({ editorial })]);
  assert.match(h.cards()[0].textContent, /Comentarista de direita.*Geral.*Conversado.*Média/);
  assert.match(h.cards()[0].textContent, /Pacote anterior/);
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  assert.deepEqual(starts(h)[0].body.cuts[0].editorial, editorial);
  assert.equal(Object.hasOwn(starts(h)[0].body.cuts[0].editorial, 'profile'), false);
});

test('direção desconhecida, inválida ou incompleta bloqueia geração antes da rede sem descartar campos', async () => {
  const invalidProfiles = [null, [], 'right', {},
    contextualProfile({ perspective: 'neutral' }), contextualProfile({ topic: 'sports' }),
    contextualProfile({ tone: 'angry' }), contextualProfile({ intensity: 'maximum' }),
    contextualProfile({ angle: ' ' }), contextualProfile({ angle: 'x'.repeat(241) }),
    contextualProfile({ audience_question: null }), contextualProfile({ audience_question: 'x'.repeat(241) }),
    contextualProfile({ unknown: true }), contextualProfile({ topic: 'toString' }),
  ];
  for (const profile of invalidProfiles) {
    const h = harness();
    const editorial = validPlan();
    editorial.profile = profile;
    h.context.mostrarTranscricao(session());
    await h.import([cut({ editorial })]);
    assert.deepEqual(plain(h.context.lerCortesEditor()[0].editorial.profile), profile);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(starts(h).length, 0, JSON.stringify(profile));
    assert.equal(h.alerts.length, 1, JSON.stringify(profile));
    assert.match(h.alerts[0], /Corte 1:/);
  }
  for (const tts of [{ tone: 'angry' }, { tone: null }, { intensity: 'loud' }, { intensity: null }, null]) {
    const h = harness();
    const editorial = validPlan();
    editorial.profile = contextualProfile();
    editorial.scenes[0].tts = tts;
    h.context.mostrarTranscricao(session());
    await h.import([cut({ editorial })]);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(starts(h).length, 0, JSON.stringify(tts));
    assert.match(h.alerts[0], /cena “abertura”/);
  }
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

test('timestamps conservam milissegundos em strings, vírgulas e segundos numéricos', () => {
  const h = harness();
  for (const [value, expected] of [
    ['00:01:41.7', '00:01:41.7'], ['00:06:02.2', '00:06:02.2'],
    ['01:41,700', '00:01:41.7'], [101.7, '00:01:41.7'],
    ['00:59.999', '00:00:59.999'], ['59:59.999', '00:59:59.999'],
    ['60', '00:01:00'], ['3600', '01:00:00'], ['59.9996', '00:01:00'],
  ]) {
    assert.equal(h.context.normalizarTimestamp(value), expected);
  }
});

test('importar, editar, excluir, restaurar e enviar conserva limites fracionários e cenas intactas', async () => {
  const h = harness();
  const editorial = validPlan();
  editorial.scenes[0].background = { start: 101.7, end: 110.2 };
  editorial.scenes[0].evidence = [{ start: 101.7, end: 294.7 }];
  editorial.scenes[1].start = 265.2;
  editorial.scenes[1].end = 294.7;
  await h.import([cut({ titulo: 'Excluir' }), cut({ inicio: '00:01:41.7', fim: '00:04:54.7', editorial })]);
  h.cards()[1].querySelector('[data-field="titulo"]').value = 'Título revisado';
  await h.cards()[0].querySelector('.btn-delete-cut').fire('click');
  const saved = JSON.parse(h.storage.get(packageKey));
  assert.equal(saved[0].inicio, '00:01:41.7');
  assert.equal(saved[0].fim, '00:04:54.7');
  assert.deepEqual(saved[0].editorial, editorial);
  const restored = harness({ [packageKey]: JSON.stringify(saved), [sessionKey]: JSON.stringify(session()) });
  restored.context.restaurarSessao();
  await restored.get('#btnImportar').fire('click');
  await restored.get('#btnGerarCortes').fire('click');
  assert.equal(restored.alerts.length, 0);
  const sent = starts(restored)[0].body.cuts[0];
  assert.equal(sent.titulo, 'Título revisado');
  assert.equal(sent.inicio, '00:01:41.7');
  assert.equal(sent.fim, '00:04:54.7');
  assert.deepEqual(sent.editorial, editorial);
});

test('fim fracionário menor que meio segundo não é encurtado ao importar e enviar', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session());
  const editorial = validPlan();
  editorial.scenes[0].background = { start: 301.4, end: 308.6 };
  editorial.scenes[0].evidence = [{ start: 301.4, end: 338.8 }];
  editorial.scenes[1].start = 352.1;
  editorial.scenes[1].end = 362.2;
  await h.import([cut({ inicio: 301.4, fim: 362.2, editorial })]);
  await h.get('#btnGerarCortes').fire('click');
  assert.equal(h.alerts.length, 0);
  assert.equal(starts(h)[0].body.cuts[0].fim, '00:06:02.2');
});

test('limite editado que exclui clip, fundo ou evidência informa a cena antes de iniciar processamento', async () => {
  for (const field of ['clip', 'background', 'evidence']) {
    const h = harness();
    h.context.mostrarTranscricao(session());
    const editorial = validPlan();
    if (field === 'clip') editorial.scenes[1].start = 9.7;
    if (field === 'background') editorial.scenes[0].background.start = 9.7;
    if (field === 'evidence') editorial.scenes[0].evidence[0].end = 20.2;
    await h.import([cut({ editorial })]);
    await h.get('#btnGerarCortes').fire('click');
    assert.equal(starts(h).length, 0);
    assert.match(h.alerts[0], /Corte 1: a cena/);
    assert.match(h.alerts[0], new RegExp(`campo ${field}`));
    assert.match(h.alerts[0], /fora de Início\/Fim/);
    assert.doesNotMatch(h.alerts[0], /precisa de um plano editorial/);
  }
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

test('pausa mostra erro como texto, contadores e decisão; continuar preserva histórico e arquivos salvos',async()=>{
 const h=harness({'os4_current_job':JSON.stringify({id:'request',kind:'render',timestamp:Date.now()})});
 const title=resultHeading(h);
 const error={index:1,titulo:'<img src=x>',error:'Texto muito grande <script>alert(1)</script>'};
 const result={folderId:'folder',requestedCount:4,completedCount:1,cuts:[readyCut()],errors:[error]};
 const paused={status:'paused',stage:'aguardando_decisao',percent:31,totalCuts:4,completedCount:1,failedCount:1,consecutiveFailures:1,
  pendingDecision:{id:'decision-ui',cutError:error},failureHistory:[error],result,detail:'Escolha parar ou continuar'};
 h.context.atualizarTelaJob(paused,'render');
 assert.match(h.get('#cutsLiveSummary').textContent,/1\/4 salvos no Google Drive.*1 com falha.*1 falha/);
 assert.equal(h.get('#btnGerarCortes').textContent,'Aguardando sua decisão');
 assert.equal(h.get('#cutsFailureHistory').children.length,1);
 assert.match(h.get('#cutsFailureHistory').children[0].textContent,/<script>alert\(1\)<\/script>/);
 assert.equal(h.get('#cutsFailureHistory').children[0].children.length,0,'Error markup is displayed as text');
 assert.equal(h.get('#cutsFailureActions').className.includes('hidden'),false);
 assert.equal(h.get('#cutsLiveProgress').className.includes('hidden'),false);
 assert.match(title.textContent,/1\/4 cortes prontos; 1 com falha/);
 h.state.job={...paused,status:'running',stage:'tracking',pendingDecision:null,detail:'Montando o próximo corte'};
 await h.get('#btnContinuarCortes').fire('click');
 const action=h.requests.find(item=>item.path.includes('workflow-control'));
 assert.deepEqual(action.body,{requestId:'request',action:'continue',decisionId:'decision-ui'});
 assert.equal(h.get('#cutsFailurePanel').className.includes('hidden'),false);
 assert.equal(h.get('#cutsFailureHistory').children.length,1);
 assert.equal(h.get('#cutsFailureActions').className.includes('hidden'),true);
 assert.match(h.get('#cutsControlMessage').textContent,/Continuação confirmada/);
 assert.equal(h.get('#btnGerarCortes').textContent,'Gerando cortes…');
 assert.match(h.get('#cutsLiveSummary').textContent,/1 falha\(s\) seguida/);
 assert.equal(JSON.parse(h.storage.get('os4_last_results_view')).cuts.length,1);
});

test('parar geração chama backend e mantém acompanhamento até confirmação do processador',async()=>{
 const h=harness({'os4_current_job':JSON.stringify({id:'request',kind:'render',timestamp:Date.now()})});
 h.context.atualizarTelaJob({status:'running',stage:'tracking',totalCuts:4},'render');
 h.state.job={status:'stopping',stage:'interrompendo',totalCuts:4,stopRequested:true};
 await h.get('#btnCancelarJob').fire('click');
 assert.deepEqual(h.requests.find(item=>item.path.includes('workflow-control')).body,{requestId:'request',action:'stop',decisionId:null});
 assert.equal(JSON.parse(h.storage.get('os4_current_job')).id,'request');
 assert.equal(h.get('#btnGerarCortes').textContent,'Encerrando…');
 assert.match(h.get('#cutsControlMessage').textContent,/Aguarde a confirmação do processador/);
 assert.equal(h.get('#btnCancelarJob').disabled,false);
});

test('jobs longos mantêm recuperação após reload e três falhas aparecem como interrupção',async()=>{
 const h=harness({'os4_current_job':JSON.stringify({id:'old-job',kind:'render',timestamp:Date.now()-60*60*1000})});
 h.state.job={status:'paused',stage:'aguardando_decisao',totalCuts:4,pendingDecision:{id:'old-decision'},
  failureHistory:[{index:1,titulo:'Primeiro',error:'Falhou'}],failedCount:1,consecutiveFailures:1};
 h.context.retomarJob();
 await new Promise(setImmediate);
 assert.ok(h.requests.some(item=>item.path.includes('workflow-status?id=old-job')));
 assert.equal(JSON.parse(h.storage.get('os4_current_job')).id,'old-job');
 h.context.atualizarTelaJob({...h.state.job,status:'error',pendingDecision:null,failedCount:3,consecutiveFailures:3,
  error:'Interrompido após 3 falhas consecutivas'},'render');
 assert.match(h.get('#cutsFailureTitle').textContent,/3 falhas consecutivas/);
 assert.match(h.get('#cutsFailureNotice').textContent,/Interrompido após 3 falhas/);
 assert.equal(h.get('#cutsFailureActions').className.includes('hidden'),true);
});

test('falha exclusiva de capa mantém vídeo, SRT e postagem acessíveis sem anunciar corte pronto',()=>{
 const h=harness();
 const title=resultHeading(h);
 const sent=[];h.context.enviarParaPublicadorLocal=result=>sent.push(result);
 const draft={...readyCut(),index:1,pendingReason:'cover',error:'Capa não coube <b>no espaço</b>'};
 const error={index:1,titulo:draft.titulo,error:draft.error};
 const result={folderId:'folder',requestedCount:4,completedCount:0,cuts:[],pendingCuts:[draft],errors:[error]};
 h.context.atualizarTelaJob({status:'paused',stage:'aguardando_decisao',totalCuts:4,completedCount:0,failedCount:1,pendingCount:1,
  consecutiveFailures:1,pendingDecision:{id:'cover-ui'},failureHistory:[error],result},'render');
 assert.match(title.textContent,/0\/4 cortes prontos.*1 vídeo\(s\) com capa pendente/);
 const card=h.get('#resultsList').querySelector('.result-pending');
 assert.ok(card);assert.match(card.textContent,/Vídeo salvo; capa pendente/);
 assert.match(card.textContent,/Capa não coube <b>no espaço<\/b>/);
 assert.equal(card.querySelectorAll('a').length,4);
 assert.match(card.querySelector('a').href,/draft|file-videoLegenda/);
 assert.equal(h.get('#resultsList').querySelectorAll('.result-error').length,0);
 assert.match(h.get('#cutsLiveSummary').textContent,/1 vídeo\(s\) salvo\(s\); capa pendente/);
 assert.equal(sent.length,0);
 assert.equal(h.get('#cutsFailureActions').className.includes('hidden'),false);
});

test('erro antes de salvar um corte conserva progresso zero sem sugerir conclusão',async()=>{
 const h=harness();
 h.state.job={status:'error',stage:'erro',percent:0,error:'Não foi possível iniciar a montagem.'};
 h.context.acompanharJob('request','render');
 await new Promise(setImmediate);
 assert.equal(h.get('#progressPercent').textContent,'0%');
 assert.match(h.get('#cutsLiveDetail').textContent,/Não foi possível iniciar/);
 assert.equal(h.get('#btnGerarCortes').disabled,false);
});

test('parada voluntária sem falhas preserva estado interrompido e resultados de zero ou alguns cortes',async()=>{
 for(const saved of [0,1]) {
  const h=harness({'os4_current_job':JSON.stringify({id:'request',kind:'render',timestamp:Date.now()})});
  const title=resultHeading(h);
  const result={folderId:'folder',requestedCount:33,completedCount:saved,cuts:saved?[readyCut()]:[],errors:[],
   stoppedReason:'Processamento interrompido pelo usuário; os cortes já salvos foram preservados.'};
  h.state.job={status:'cancelled',stage:'cancelado',percent:10+85*saved/33,totalCuts:33,completedCount:saved,
   result,error:result.stoppedReason};
  h.context.acompanharJob('request','render');
  await new Promise(setImmediate);
  assert.equal(h.get('#cortesStatus').textContent,'Interrompido');
  assert.equal(h.get('#cortesDot').className,'status-dot error');
  assert.equal(h.get('#progressTitle').textContent,'Processamento interrompido');
  assert.equal(h.get('#cutsLiveStage').textContent,'Processamento interrompido');
  assert.match(h.get('#cutsLiveDetail').textContent,/interrompido pelo usuário/);
  assert.match(title.textContent,new RegExp(`${saved}/33 cortes prontos; 0 com falha`));
  assert.equal(h.get('#cutsLiveProgress').className.includes('hidden'),false);
  assert.equal(h.get('#resultsList').querySelectorAll('.result-card').length,saved);
  assert.equal(h.get('#btnGerarCortes').disabled,false);
  assert.equal(h.storage.has('os4_current_job'),false);
  // Restoring the saved result after a reload preserves the terminal state.
  h.context.mostrarResultados(result,false);
  assert.equal(h.get('#cortesStatus').textContent,'Interrompido');
  assert.equal(h.get('#progressTitle').textContent,'Processamento interrompido');
 }
});


test('Motion Dark acrescenta direção visual no prompt somente quando selecionado', async () => {
  for (const editorialStyle of ['classic', 'paper', 'motion_dark']) {
    const h = harness();
    h.context.mostrarTranscricao(session({ simpleCuts: false, editorialStyle }));
    assert.equal(h.get('#editorialStyle').value, editorialStyle);
    await h.get('#btnCopiarPromptIA').fire('click');
    const prompt = h.copied[0];
    const [example] = promptExample(prompt);
    const narrated = example.editorial.scenes.filter(scene => scene.kind === 'narration');
    if (editorialStyle === 'motion_dark') {
      assert.match(prompt, /DIREÇÃO VISUAL MOTION DARK/);
      assert.match(prompt, /line-md:alert-circle/);
      assert.match(prompt, /direção visual executável/);
      assert.ok(narrated.every(scene => scene.visual.motion?.layout === 'statement'));
      assert.ok(narrated.every(scene => scene.visual.motion?.icon === 'line-md:chat'));
      await h.import([example]);
      assert.equal(h.cards().length, 1);
      assert.deepEqual(h.alerts, []);
      assert.deepEqual(JSON.parse(h.storage.get(packageKey))[0].editorial.scenes, example.editorial.scenes);
    } else {
      assert.doesNotMatch(prompt, /DIREÇÃO VISUAL MOTION DARK/);
      assert.ok(narrated.every(scene => !Object.hasOwn(scene.visual, 'motion')));
    }
  }
});

test('Motion Dark não altera modo simples nem a escolha editorial mantida na sessão', async () => {
  const h = harness();
  h.context.mostrarTranscricao(session({ simpleCuts: false, editorialStyle: 'motion_dark' }));
  assert.equal(h.get('#editorialStyle').disabled, false);
  assert.equal(h.get('#editorialStyle').value, 'motion_dark');
  h.get('#simpleCuts').checked = true;
  await h.get('#simpleCuts').fire('change');
  assert.equal(h.get('#editorialStyle').disabled, true);
  await h.get('#btnCopiarPromptIA').fire('click');
  assert.doesNotMatch(h.copied[0], /DIREÇÃO VISUAL MOTION DARK/);
  assert.equal(JSON.parse(h.storage.get(sessionKey)).editorialStyle,'motion_dark');
});
