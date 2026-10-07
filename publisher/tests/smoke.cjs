const {_electron}=require('playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const output=path.resolve(__dirname,'../../work');fs.mkdirSync(output,{recursive:true});
 const temp=fs.mkdtempSync(path.join(output,'publisher-smoke-'));let app;
 try{
  const env={...process.env,OS4_SMOKE_DIR:temp};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.OS4_TEST_EXE||path.resolve(__dirname,'../dist/portable-0.2.0/OS4 Publicador.exe');
  app=await _electron.launch({executablePath,args:['--smoke-test'],env,timeout:60000});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('#btn-import-drive');
  const state=await page.evaluate(()=>window.os4.state());assert.match(state.phase,/envios desativados/);assert.equal(state.version,'0.2.0');assert.equal(state.jobs.length,0);
  assert.equal(await page.locator('.account').count(),3);
  await page.locator('#youtube').fill('canal-teste');await page.locator('.account').nth(2).getByText('Salvar identificação').click();
  await page.waitForFunction(()=>document.querySelector('#status-youtube').textContent.includes('Informada'));
  await page.evaluate(()=>renderQueue({isPaused:false,counts:{total:1,verify:1},nextAvailable:{},jobs:[{id:'fixture',state:'verify',network:'instagram',cutIndex:1,titulo:'Título com acentos',evidence:'Confira a postagem',created:Date.now()}],watchers:[{folderId:'fixturefolder1234567890',enabled:true,readyCount:3,totalCuts:5,downloadedCount:3,detail:'Aguardando novos cortes',nextCheck:Date.now()+120000}]}));
  assert.equal(await page.getByText('Já publicado',{exact:true}).count(),1);assert.match(await page.locator('#watch-list').innerText(),/3\/5 prontos/);
  assert.equal(errors.length,0,errors.join('; '));
  await page.screenshot({path:path.join(output,'publisher-0.2.0-smoke.png'),fullPage:true});
  console.log('Electron 0.2.0: IPC, SQLite, contas, acompanhamento e conferência aprovados.');
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
