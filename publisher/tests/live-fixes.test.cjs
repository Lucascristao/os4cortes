const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {downloadDriveStream, cookieHeader} = require('../src/drive-stream.cjs');
const {videoDuration} = require('../src/media-probe.cjs');
const {sanitizeDiagnostic} = require('../src/diagnostics.cjs');
const {PublicationAttempt} = require('../src/attempt.cjs');
const {waitForUploadReady} = require('../src/upload-ready.cjs');
test('stream segue confirmação e redirect, sem baixar um segundo buffer', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'os4-stream-'));let count=0;
  const server=http.createServer((req,res)=>{
    if(req.url==='/start'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<form action="/confirm"><input value="yes" name="confirm"></form>');}
    else if(req.url==='/confirm?confirm=yes'){res.writeHead(302,{Location:'/file'});res.end();}
    else {count++;res.writeHead(200,{'Content-Length':6});res.end('abcdef');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const address=`http://127.0.0.1:${server.address().port}`;
  try{const dest=path.join(dir,'video.mp4');await downloadDriveStream(address+'/start',dest,{allowedUrl:u=>u.origin===address});assert.equal(fs.readFileSync(dest,'utf8'),'abcdef');assert.equal(count,1);}
  finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('retoma truncamento e recomeça quando o servidor ignora Range',async()=>{
  for(const respectRange of [true,false]){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'os4-resume-'));let requests=0;let receivedRange;
    const server=http.createServer((req,res)=>{
      requests++;if(requests===1){res.writeHead(200,{'Content-Length':6});res.write('abc');setTimeout(()=>res.destroy(),10);return;}
      receivedRange=req.headers.range;
      if(respectRange){res.writeHead(206,{'Content-Length':3,'Content-Range':'bytes 3-5/6'});res.end('def');}
      else{res.writeHead(200,{'Content-Length':6});res.end('abcdef');}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const address=`http://127.0.0.1:${server.address().port}`;
    try{const dest=path.join(dir,'video');await downloadDriveStream(address,dest,{allowedUrl:u=>u.origin===address,retryDelay:0});assert.equal(receivedRange,'bytes=3-');assert.equal(fs.readFileSync(dest,'utf8'),'abcdef');}
    finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
  }
});
test('cookies acompanham apenas seu domínio; logs removem cabeçalhos privados',()=>{
  const cookies=[{name:'session',value:'fixture-secret',domain:'.google.com',path:'/',secure:true}];
  assert.equal(cookieHeader(cookies,new URL('https://drive.google.com/uc')),'session=fixture-secret');
  assert.equal(cookieHeader(cookies,new URL('https://example.com')),'');
  const diagnostic=sanitizeDiagnostic('Timeout.\nCall log:\n - Cookie: fixture-secret\n - Set-Cookie: fixture-secret');
  assert.ok(!diagnostic.includes('fixture-secret'));
  assert.ok(!sanitizeDiagnostic('Cookie: fixture-secret\nhttps://test/?token=fixture-secret').includes('fixture-secret'));
});
test('verificação de mídia aguarda processo assíncrono e recupera timeout transitório',async()=>{
  let calls=0;const file=__filename;
  const duration=await videoDuration(file,async()=>{calls++;await new Promise(r=>setImmediate(r));if(calls===1)throw Object.assign(new Error('Timeout'),{code:'ETIMEDOUT'});return {stdout:'120.5'};});
  assert.equal(duration,120.5);assert.equal(calls,2);
});
test('botão desabilitado espera processamento; cancelamento impede continuar',async()=>{
  let now=0,enabled=false,clicks=0;const button={isEnabled:async()=>enabled,getAttribute:async()=>null};
  const page={waitForTimeout:async()=>{now+=1000;if(now>=3000)enabled=true;}};
  const attempt=new PublicationAttempt();await waitForUploadReady(button,page,attempt,5000,()=>now);
  assert.equal(now,3000);assert.equal(clicks,0);
  await attempt.abort();await assert.rejects(waitForUploadReady(button,page,attempt,5000,()=>now),/encerrada/);
});
test('evento close comprova encerramento mesmo se close rejeitar depois',async()=>{
  let listener;const attempt=new PublicationAttempt();
  await attempt.attach({on:(event,fn)=>listener=fn,close:async()=>{listener();throw new Error('Target closed');}});
  assert.equal(await attempt.abort(),true);assert.equal(attempt.isClosed(),true);
});
