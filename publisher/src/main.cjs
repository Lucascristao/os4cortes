const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,shell,powerMonitor}=require('electron');
const path=require('node:path');const fs=require('node:fs');
const {Queue}=require('./queue.cjs');
const dataDir=path.join(process.env.LOCALAPPDATA,'OS4Publicador');
app.setPath('userData',path.join(dataDir,'interface'));
const platforms={tiktok:'https://www.tiktok.com/tiktokstudio/upload',instagram:'https://www.instagram.com/',youtube:'https://studio.youtube.com/'};
let win,tray,q,quitting=false;const contexts=new Map();
if(!app.requestSingleInstanceLock()) app.quit();
else {
app.on('second-instance',()=>{win?.show();win?.focus();});
app.whenReady().then(async()=>{
  fs.mkdirSync(dataDir,{recursive:true});q=new Queue(path.join(dataDir,'queue.sqlite'));
  const browserDir=app.isPackaged?path.join(process.resourcesPath,'browser'):path.join(__dirname,'..','browser');
  process.env.PLAYWRIGHT_BROWSERS_PATH=browserDir;
  win=new BrowserWindow({width:980,height:780,minWidth:720,minHeight:620,title:'OS4 Publicador',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
  await win.loadFile(path.join(__dirname,'index.html'));
  win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});
  const pixels=Buffer.alloc(32*32*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=30;pixels[i+1]=190;pixels[i+2]=245;pixels[i+3]=255;}
  tray=new Tray(nativeImage.createFromBitmap(pixels,{width:32,height:32}));tray.setToolTip('OS4 Publicador — configuração');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Abrir OS4 Publicador',click:()=>win.show()},{label:'Abrir site OS4',click:()=>shell.openExternal('https://os4cortes.netlify.app/')},{label:'Encerrar',click:()=>{quitting=true;app.quit();}}]));
  tray.on('double-click',()=>win.show());
  powerMonitor.on('resume',()=>q.set('lastResume',Date.now()));
  if(app.isPackaged && !process.argv.includes('--smoke-test')) app.setLoginItemSettings({openAtLogin:true,path:process.execPath,args:['--background']});
  if(process.argv.includes('--background'))win.hide();
});
app.on('before-quit',()=>{quitting=true;for(const context of contexts.values())context.close().catch(()=>{});});
app.on('window-all-closed',()=>{});
}
function validateEvent(event){if(!win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Origem inválida');}
ipcMain.handle('state',(event)=>{validateEvent(event);return {version:app.getVersion(),phase:'Validação inicial — publicação automática ainda desabilitada',dataDir,accounts:q.get('accounts',{}),open:[...contexts.keys()],jobs:q.list().map(j=>({id:j.id,state:j.state,network:j.payload.network})),autoStart:app.getLoginItemSettings().openAtLogin};});
ipcMain.handle('login',async(event,network)=>{
  validateEvent(event);if(!Object.hasOwn(platforms,network))throw new Error('Rede inválida');
  if(contexts.has(network)){const pages=contexts.get(network).pages();await pages[0]?.bringToFront();return;}
  const {chromium}=require('playwright');
  const ctx=await chromium.launchPersistentContext(path.join(dataDir,'profiles',network),{headless:false,locale:'pt-BR',timezoneId:'America/Fortaleza',viewport:{width:1280,height:900}});
  contexts.set(network,ctx);ctx.on('close',()=>contexts.delete(network));
  const page=ctx.pages()[0]||await ctx.newPage();await page.goto(platforms[network],{waitUntil:'domcontentloaded',timeout:60000});
});
ipcMain.handle('save-account',async(event,{network,account})=>{
  validateEvent(event);if(!Object.hasOwn(platforms,network)||typeof account!=='string'||!account.trim()||account.length>150)throw new Error('Informe a identificação da conta');
  const accounts=q.get('accounts',{});accounts[network]={account:account.trim(),status:'Informada; confirmação visual pendente'};q.set('accounts',accounts);return true;
});
ipcMain.handle('close-login',async(event,network)=>{validateEvent(event);await contexts.get(network)?.close();});
ipcMain.handle('open-site',(event)=>{validateEvent(event);return shell.openExternal('https://os4cortes.netlify.app/');});
