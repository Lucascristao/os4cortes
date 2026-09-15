const {_electron}=require('playwright');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
(async()=>{const temp=fs.mkdtempSync(path.join(os.tmpdir(),'os4-smoke-'));let app;try{
const env={...process.env,LOCALAPPDATA:temp};delete env.ELECTRON_RUN_AS_NODE;
app=await _electron.launch({executablePath:path.resolve('dist/portable-0.1.0/OS4 Publicador.exe'),args:['--smoke-test'],env,timeout:60000});
const page=await app.firstWindow();await page.waitForSelector('#phase');await page.waitForFunction(()=>document.querySelector('#phase').textContent.includes('Validação'));
assert.equal(await page.locator('.account').count(),3);const s=await page.evaluate(()=>window.os4.state());assert.equal(s.jobs.length,0);assert.equal(Object.keys(s.accounts).length,0);
await page.locator('#youtube').fill('canal-teste');await page.locator('.account').nth(2).getByText('Salvar identificação').click();await page.waitForFunction(()=>document.querySelector('#status-youtube').textContent.includes('Informada'));
await page.screenshot({path:path.resolve('dist/smoke.png'),fullPage:true});console.log('Electron: janela, IPC, SQLite e renderização aprovados. Nenhuma rede acessada.');
}finally{if(app)await app.close();fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
