const {test}=require('node:test');const assert=require('node:assert/strict');
const {Queue}=require('../src/queue.cjs');const {FolderWatcher,ENDPOINT}=require('../src/watcher.cjs');
const folderId='folder01234567890123456789',token='a'.repeat(64);
const cut=i=>({index:i,formato:'9:16',ready:true,titulo:`Corte ${i}`,files:{videoLegenda:{id:`video${i}`},post:{id:`post${i}`}}});
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(more={}){const q=new Queue(':memory:');const enqueued=[];let feed={ok:true,folderId,requestId:'render',status:'running',totalCuts:5,readyCount:0,cuts:[]};let scans=0,polls=0;
  const opts={queue:q,executor:{enqueueCorte:p=>enqueued.push(p)},protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString(),
    scan:async()=>{scans++;return {monitorFileId:'manifest'};},readText:async()=>JSON.stringify({version:1,folderId,apiUrl:ENDPOINT,token}),
    fetcher:async(url,opt)=>{polls++;assert.equal(opt.headers.Authorization,`Bearer ${token}`);return Response.json(feed);},download:async p=>({...p,videoPath:'/fixture.mp4',postText:'Texto'}),...more};
  const w=new FolderWatcher(opts);return{q,w,enqueued,opts,feed:f=>feed=f,scans:()=>scans,polls:()=>polls};}
test('recebe 3 cortes e depois mais 2 sem repetir; continua esperando durante geração',async()=>{
  const f=fixture();try{f.w.start(folderId);await settle();await settle();const w=f.w.items[0];assert.equal(w.enabled,true);assert.equal(f.enqueued.length,0);
    f.feed({ok:true,folderId,requestId:'render',status:'running',totalCuts:5,readyCount:3,cuts:[1,2,3].map(cut)});
    await f.w.poll(w);f.w.drain(w);await settle();await settle();assert.equal(f.enqueued.length,3);assert.equal(w.enabled,true);
    f.feed({ok:true,folderId,requestId:'render',status:'completed',totalCuts:5,readyCount:5,cuts:[1,2,3,4,5].map(cut)});
    await f.w.poll(w);f.w.drain(w);await settle();await settle();assert.equal(f.enqueued.length,5);assert.equal(w.phase,'completed');assert.equal(f.scans(),1);
    assert.deepEqual(f.enqueued.map(p=>p.driveFileId).sort(),['video1','video2','video3','video4','video5']);assert.ok(!JSON.stringify(f.w.status()).includes(token));
  }finally{f.w.shutdown();f.q.close();}
});
test('retoma autorização salva sem nova varredura e falha de um download não segura os outros',async()=>{
  let failed=true;const f=fixture({download:async p=>{if(p.cutIndex===1&&failed)throw new Error('rede');return {...p,postText:'Texto',videoPath:'/fixture.mp4'};}});
  try{f.w.start(folderId);await settle();await settle();f.w.shutdown();
    const resumed=new FolderWatcher({...f.opts});f.feed({ok:true,folderId,requestId:'render',status:'running',totalCuts:3,readyCount:3,cuts:[1,2,3].map(cut)});
    await resumed.poll(resumed.items[0]);resumed.drain(resumed.items[0]);await settle();await settle();assert.equal(f.enqueued.length,2);assert.equal(f.scans(),1);
    failed=false;resumed.items[0].failures['9:16:video1'].next=0;resumed.drain(resumed.items[0]);await settle();assert.equal(f.enqueued.length,3);resumed.shutdown();
  }finally{f.w.shutdown();f.q.close();}
});
test('manifesto não pode enviar autorização para outro servidor',async()=>{
  const f=fixture({readText:async()=>JSON.stringify({version:1,folderId,apiUrl:'https://evil.example/publisher',token})});
  try{const w={folderId,enabled:true,done:{},failures:{},ready:[]};await assert.rejects(()=>f.w.poll(w),/inválido/);assert.equal(w.capability,undefined);}
  finally{f.w.shutdown();f.q.close();}
});

test('cortes já recebidos pela ponte não são baixados novamente pelo acompanhamento',async()=>{
  const f=fixture({download:async()=>{throw new Error('Download duplicado não permitido');}});
  try{
    for(const network of ['tiktok','instagram']) f.q.add({id:network,network,account:'@os4.cortes',videoFileId:network,driveFileId:'video1',formato:'9:16'});
    f.w.start(folderId);await settle();await settle();const w=f.w.items[0];
    f.feed({ok:true,folderId,requestId:'render',status:'running',totalCuts:1,readyCount:1,cuts:[cut(1)]});
    await f.w.poll(w);f.w.drain(w);await settle();
    assert.equal(w.done['9:16:video1'],true);assert.equal(f.enqueued.length,0);assert.equal(Object.keys(w.failures).length,0);
  }finally{f.w.shutdown();f.q.close();}
});

test('lote com um pronto e uma falha encerra após confirmar só as publicações do corte pronto',async()=>{
  const f=fixture();
  f.opts.executor.enqueueCorte=p=>{
    f.enqueued.push(p);
    for(const network of ['tiktok','instagram'])f.q.add({id:network,network,account:'@os4.cortes',
      videoFileId:`${p.driveFileId}:${network}`,driveFileId:p.driveFileId,folderId,formato:'9:16'});
  };
  try{
    f.w.start(folderId);await settle();await settle();const w=f.w.items[0];
    f.feed({ok:true,folderId,requestId:'render',status:'completed',totalCuts:2,readyCount:1,
      requestedCount:2,completedCount:1,failedCount:1,cuts:[cut(1)]});
    await f.w.poll(w);f.w.drain(w);await settle();await settle();
    assert.equal(f.enqueued.length,1);
    assert.equal(f.enqueued[0].driveFileId,'video1');
    assert.equal(f.q.list().length,2,'Existing per-network confirmation policy must stay intact');
    assert.equal(w.enabled,true);
    assert.match(w.detail,/2 publicação\(ões\) pendente/);
    f.q.status('tiktok','completed','Confirmado');f.q.status('instagram','completed','Confirmado');
    f.w.drain(w);
    assert.equal(w.enabled,false);
    assert.equal(w.phase,'completed');
    assert.match(w.detail,/1\/2 cortes publicados e confirmados; 1 com falha na geração/);
    assert.equal(f.w.status()[0].failedCount,1);
    const polls=f.polls();await f.w.tick();await settle();
    assert.equal(f.polls(),polls,'A fully accounted terminal batch must stop polling');
    assert.equal(f.enqueued.length,1,'No retry may publish the failed cut or enqueue the ready cut again');
  }finally{f.w.shutdown();f.q.close();}
});

test('resultado terminal antigo sem contadores explícitos continua aguardando arquivos ausentes',async()=>{
  const f=fixture();
  try{
    const w={folderId,enabled:true,done:{'9:16:video1':true},failures:{},ready:[]};
    f.feed({ok:true,folderId,requestId:'render',status:'completed',totalCuts:2,readyCount:1,cuts:[cut(1)]});
    await f.w.poll(w);
    assert.equal(w.enabled,true);
    assert.equal(w.generationComplete,false);
    assert.match(w.detail,/Aguardando confirmação do servidor/);
  }finally{f.w.shutdown();f.q.close();}
});
