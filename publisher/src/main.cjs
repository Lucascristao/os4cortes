const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, powerMonitor, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const { Queue } = require('./queue.cjs');
const { QueueExecutor } = require('./executor.cjs');
const { LocalBridgeServer } = require('./bridge.cjs');
const { scanDriveFolder, downloadTextFileDirect, downloadCorte } = require('./downloader.cjs');
const { FolderWatcher } = require('./watcher.cjs');
const { sanitizeDiagnostic } = require('./diagnostics.cjs');

const smoke = process.argv.includes('--smoke-test');
const dataDir = smoke ? (process.env.OS4_SMOKE_DIR || path.join(app.getPath('temp'), `OS4Publicador-smoke-${process.pid}`)) : path.join(process.env.LOCALAPPDATA, 'OS4Publicador');
app.setPath('userData', path.join(dataDir, 'interface'));

const platforms = {
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  instagram: 'https://www.instagram.com/',
  youtube: 'https://studio.youtube.com/'
};

let win, tray, q, executor, bridge, watcher, quitting = false;
const contexts = new Map();
const loginProcesses = new Map();
const logPath = path.join(dataDir, 'activity.ndjson');
function logToUi(msg) {
  const clean = sanitizeDiagnostic(msg);
  const entry = {msg:clean,time:new Date().toISOString()};
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5*1024*1024) fs.renameSync(logPath, logPath+'.previous');
    fs.appendFileSync(logPath,JSON.stringify(entry)+'\n');
  } catch (_) {}
  win?.webContents.send('app-log',entry);
}
function queueStatus() {return executor ? {...executor.getStatus(),watchers:watcher?.status()||[]} : null;}

function getNativeBrowserPath() {
  const candidates = [
    // 1. Google Chrome (padrão para YouTube/Google, Instagram e TikTok)
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    // 2. Brave Browser
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    // 3. Microsoft Edge (nativo em todo Windows 10/11)
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const method of ['log','warn','error']) {
      const original=console[method].bind(console);
      console[method]=(...args)=>{const clean=sanitizeDiagnostic(args.map(a=>a instanceof Error?a.message:typeof a==='string'?a:JSON.stringify(a)).join(' '));original(clean);logToUi(clean);};
    }
    q = new Queue(path.join(dataDir, 'queue.sqlite'));
    executor = new QueueExecutor(q);
    watcher = new FolderWatcher({queue:q,executor,scan:scanDriveFolder,readText:downloadTextFileDirect,download:downloadCorte,onLog:logToUi,
      protect:token => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Proteção de credenciais do Windows indisponível.');
        return safeStorage.encryptString(token).toString('base64');
      },
      unprotect:value => safeStorage.decryptString(Buffer.from(value,'base64'))
    });
    watcher.on('updated',()=>win?.webContents.send('queue-status',queueStatus()));

    bridge = new LocalBridgeServer({
      executor,
      watcher,
      onLog: (msg) => {
        logToUi(msg);
      }
    });
    if (!smoke) bridge.start();

    // Eventos do executor para a UI
    executor.on('queue-updated', () => win?.webContents.send('queue-status', queueStatus()));
    executor.on('job-started', (data) => win?.webContents.send('queue-status', data.status));
    executor.on('job-completed', (data) => win?.webContents.send('queue-status', data.status));
    executor.on('job-failed', (data) => win?.webContents.send('queue-status', data.status));
    executor.on('cooldown', (data) => win?.webContents.send('cooldown', data));
    executor.on('worker-error',e=>logToUi(`[Fila] ${e.message}`));
    executor.on('job-started',data=>logToUi(`[Fila] Corte ${data.job.payload.cutIndex}: envio no ${data.job.payload.network}.`));
    executor.on('job-completed',data=>logToUi(`[Fila] Corte ${data.job.payload.cutIndex}: confirmação no ${data.job.payload.network}.`));
    executor.on('job-failed',data=>logToUi(`[Fila] Corte ${data.job.payload.cutIndex}: ${data.error}`));
    if (!smoke) {executor.ensureWorkerRunning();watcher.ensureRunning();}

    const browserDir = app.isPackaged
      ? path.join(process.resourcesPath, 'browser')
      : path.join(__dirname, '..', 'browser');
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserDir;

    win = new BrowserWindow({
      width: 1040,
      height: 820,
      minWidth: 780,
      minHeight: 640,
      title: 'OS4 Publicador',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    await win.loadFile(path.join(__dirname, 'index.html'));

    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        win.hide();
      }
    });

    const pixels = Buffer.alloc(32 * 32 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 30;
      pixels[i + 1] = 190;
      pixels[i + 2] = 245;
      pixels[i + 3] = 255;
    }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
    tray.setToolTip('OS4 Publicador — Fila Ativa');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir OS4 Publicador', click: () => win.show() },
      { label: 'Abrir site OS4', click: () => shell.openExternal('https://os4cortes.netlify.app/') },
      {
        label: 'Encerrar',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ]));
    tray.on('double-click', () => win.show());

    powerMonitor.on('resume', () => q.set('lastResume', Date.now()));

    if (app.isPackaged && !process.argv.includes('--smoke-test')) {
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] });
    }
    if (process.argv.includes('--background')) win.hide();
  });

  app.on('before-quit', () => {
    quitting = true;
    try { bridge?.stop(); } catch (_) {}
    try { executor?.stop(); } catch (_) {}
    watcher?.shutdown();
    for (const proc of loginProcesses.values()) {
      try { proc.kill(); } catch (_) {}
    }
    loginProcesses.clear();
    for (const context of contexts.values()) {
      context.close().catch(() => {});
    }
    contexts.clear();
  });

  app.on('window-all-closed', () => {});
}

function validateEvent(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('Origem inválida');
  }
}

ipcMain.handle('state', (event) => {
  validateEvent(event);
  const openNetworks = [...new Set([...contexts.keys(), ...loginProcesses.keys()])];
  return {
    version: app.getVersion(),
    phase: smoke ? 'Teste de interface; envios desativados' : 'Publicação contínua e acompanhamento de pastas ativos',
    dataDir,
    accounts: q.get('accounts', {}),
    open: openNetworks,
    jobs: q.list().map((j) => ({ id: j.id, state: j.state, network: j.payload.network })),
    autoStart: app.getLoginItemSettings().openAtLogin
  };
});

ipcMain.handle('login', async (event, network) => {
  validateEvent(event);
  if (!Object.hasOwn(platforms, network)) throw new Error('Rede inválida');
  if (executor.activeJobs.has(network)) throw new Error('Esta rede está publicando. Aguarde o envio terminar antes de abrir o login.');

  if (loginProcesses.has(network)) {
    return;
  }
  if (contexts.has(network)) {
    const pages = contexts.get(network).pages();
    await pages[0]?.bringToFront();
    return;
  }

  const profileDir = path.join(dataDir, 'profiles', network);
  fs.mkdirSync(profileDir, { recursive: true });

  const nativeBrowser = getNativeBrowserPath();
  if (nativeBrowser) {
    // Abre navegador nativo desacoplado de automação e de flags de depuração
    const child = cp.spawn(nativeBrowser, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      platforms[network]
    ], { detached: false, stdio: 'ignore' });

    loginProcesses.set(network, child);
    child.on('exit', () => {
      loginProcesses.delete(network);
    });
    child.on('error', (err) => {
      console.error(`Falha ao abrir navegador para ${network}:`, err);
      loginProcesses.delete(network);
    });
    return;
  }

  // Fallback para Playwright caso nenhum navegador nativo seja encontrado
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: 'pt-BR',
    timezoneId: 'America/Fortaleza',
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage'
    ]
  });
  contexts.set(network, ctx);
  ctx.on('close', () => contexts.delete(network));
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(platforms[network], { waitUntil: 'domcontentloaded', timeout: 60000 });
});

ipcMain.handle('save-account', async (event, { network, account }) => {
  validateEvent(event);
  if (!Object.hasOwn(platforms, network) || typeof account !== 'string' || !account.trim() || account.length > 150) {
    throw new Error('Informe a identificação da conta');
  }
  const accounts = q.get('accounts', {});
  accounts[network] = { account: account.trim(), status: 'Informada; confirmação visual pendente' };
  q.set('accounts', accounts);
  return true;
});

ipcMain.handle('close-login', async (event, network) => {
  validateEvent(event);
  if (loginProcesses.has(network)) {
    try {
      loginProcesses.get(network).kill();
    } catch (_) {}
    loginProcesses.delete(network);
  }
  if (contexts.has(network)) {
    await contexts.get(network)?.close().catch(() => {});
    contexts.delete(network);
  }
});

ipcMain.handle('open-site', (event) => {
  validateEvent(event);
  return shell.openExternal('https://os4cortes.netlify.app/');
});

ipcMain.handle('get-queue', (event) => {
  validateEvent(event);
  return queueStatus();
});

ipcMain.handle('enqueue-manual', (event, payload) => {
  validateEvent(event);
  if (smoke) throw new Error('Envios desativados neste teste.');
  if (!executor) throw new Error('Executor não iniciado');
  return executor.enqueueCorte(payload);
});

ipcMain.handle('import-drive-folder', async (event, folderUrl) => {
  validateEvent(event);
  if (smoke) throw new Error('Envios desativados neste teste.');
  return watcher.start(folderUrl);
});
ipcMain.handle('watch:stop',(event,id)=>{validateEvent(event);watcher.stop(id);return true;});
ipcMain.handle('queue:verify',(event,{id,published})=>{validateEvent(event);if(typeof published!=='boolean')throw new Error('Verificação inválida');return executor.verifyJob(id,published);});
ipcMain.handle('history',(event)=>{validateEvent(event);return q.history();});

ipcMain.handle('queue:pause', (event) => {
  validateEvent(event);
  if (!executor) throw new Error('Executor não iniciado');
  return executor.pause();
});

ipcMain.handle('queue:resume', (event) => {
  validateEvent(event);
  if (!executor) throw new Error('Executor não iniciado');
  return executor.resume();
});

ipcMain.handle('queue:retry', (event, id) => {
  validateEvent(event);
  if (!executor) throw new Error('Executor não iniciado');
  return executor.retryJob(id);
});

ipcMain.handle('queue:retry-all', (event) => {
  validateEvent(event);
  if (!executor) throw new Error('Executor não iniciado');
  return executor.retryAllFailed();
});

ipcMain.handle('queue:delete', (event, id) => {
  validateEvent(event);
  if (!executor) throw new Error('Executor não iniciado');
  return executor.deleteJob(id);
});


