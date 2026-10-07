const {test}=require('node:test');const assert=require('node:assert/strict');
const {Queue}=require('../src/queue.cjs');const {QueueExecutor}=require('../src/executor.cjs');
const settle=()=>new Promise(r=>setImmediate(r));
const job=(id,network)=>({id,network,account:'conta',videoFileId:id,videoPath:'/fixture/video.mp4',cutIndex:1,postText:'Título com acentos\n#cortes'});
function fixture(publishers,more={}){const q=new Queue(':memory:');const x=new QueueExecutor(q,{publishers,validateVideo:()=>{},cleanup:false,...more});x.ensureWorkerRunning=()=>{};x.isRunning=true;return {q,x};}
test('Instagram segue com outros cortes enquanto TikTok demora; mesma rede não sobrepõe',async()=>{
  let now=Date.now(),release;const calls=[];
  const {q,x}=fixture({tiktok:async()=>{calls.push('tt');return new Promise(r=>release=()=>r({ok:true,confirmed:true}));},instagram:async()=>{calls.push('ig');return {ok:true,confirmed:true};}},{now:()=>now});
  try{q.add(job('tt1','tiktok'));q.add(job('ig1','instagram'));q.add(job('tt2','tiktok'));q.add(job('ig2','instagram'));
    await x.tick();await settle();await settle();assert.deepEqual(calls,['tt','ig']);
    now+=301000;await x.tick();await settle();await settle();assert.deepEqual(calls,['tt','ig','ig']);assert.equal(x.activeJobs.size,1);
    release();await Promise.all([...x.activeJobs.values()].map(j=>j.promise));assert.equal(q.list().find(j=>j.id==='tt2').state,'queued');
    assert.ok(q.eligibility('tiktok',now).next>=now+30000);
  }finally{x.stop();q.close();}
});
test('timeout fecha contexto e impede clique tardio; não reenvia uma tentativa já submetida',async()=>{
  let closed=0,lateClick=false;const {q,x}=fixture({instagram:async({attempt})=>{
    await attempt.attach({close:async()=>{closed++;}});attempt.beforePublish();
    await new Promise(r=>setTimeout(r,50));attempt.check();lateClick=true;return {ok:true,confirmed:true};
  }},{timeoutMs:10});
  try{q.add(job('ig','instagram'));await x.processJob(q.list()[0]);await new Promise(r=>setTimeout(r,60));
    assert.equal(closed,1);assert.equal(lateClick,false);assert.equal(q.list()[0].state,'verify');assert.throws(()=>x.retryJob('ig'),/Verifique/);
  }finally{x.stop();q.close();}
});
test('ok sem confirmação permanece em conferência e confirmação persistida resiste a erro no fechamento',async()=>{
  const {q,x}=fixture({instagram:async({attempt})=>{attempt.beforePublish();return {ok:true,confirmed:false};},tiktok:async({attempt})=>{attempt.beforePublish();attempt.confirm({ok:true,confirmed:true});throw new Error('Falha no fechamento');}});
  try{q.add(job('ig','instagram'));q.add(job('tt','tiktok'));for(const j of q.list())await x.processJob(j);
    assert.equal(q.list().find(j=>j.id==='ig').state,'verify');assert.equal(q.list().find(j=>j.id==='tt').state,'completed');
    x.verifyJob('ig',true);assert.equal(q.list().find(j=>j.id==='ig').state,'completed');
  }finally{x.stop();q.close();}
});
test('fila deduplica web e monitor por arquivo; formatos distintos do mesmo índice permanecem separados',()=>{
  const {q,x}=fixture({});try{
    const p={cutIndex:1,titulo:'Título',videoPath:'/a.mp4',postText:'Legenda',folderId:'folder',driveFileId:'vertical',requestId:'request',formato:'9:16'};
    assert.equal(x.enqueueCorte(p).length,2);assert.equal(x.enqueueCorte({...p,requestId:'outra-entrada',videoPath:'/b.mp4'}).length,0);
    assert.equal(x.enqueueCorte({...p,driveFileId:'horizontal',formato:'16:9'}).length,1);assert.equal(q.list().length,3);
  }finally{x.stop();q.close();}
});
test('falha anterior ao clique é repetida no máximo três vezes; intervalo sobrevive a retry',async()=>{
  let now=Date.now();const {q,x}=fixture({tiktok:async()=>{throw new Error('Falha transitória antes do envio');}},{now:()=>now});
  try{q.add(job('tt','tiktok'));for(let i=0;i<3;i++){await x.processJob(q.list()[0]);now+=301000;}
    assert.equal(q.list()[0].state,'failed');x.retryJob('tt');assert.ok(q.get('network_next').tiktok>0);assert.equal(q.db.prepare('SELECT count(*) n FROM attempts').get().n,3);
  }finally{x.stop();q.close();}
});
