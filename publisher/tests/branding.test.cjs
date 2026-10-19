const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Queue} = require('../src/queue.cjs');
const {QueueExecutor} = require('../src/executor.cjs');
const {BRAND_ACCOUNT,canonicalAccount,rebrandText,migrateQueueBranding} = require('../src/branding.cjs');

function legacy(q,id,state='queued',account='@os4.cortes') {
  const payload={id,account,network:'youtube',videoFileId:'video-'+id,videoPath:'C:/OS4CORTES/video.mp4',
    postPath:'C:/OS4CORTES/post.txt',titulo:'OS4 Cortes',postText:'Siga @os4.cortes #os4cortes — OS4 Cortes'};
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([payload.videoFileId,payload.network,account])).digest('hex');
  q.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(id,fingerprint,JSON.stringify(payload),state,123,'evidência original');
  return payload;
}

test('migração preserva contas personalizadas, estados, caminhos, evidências e histórico',()=>{
  const q=new Queue(':memory:');
  try {
    q.set('accounts',{tiktok:{account:'@os4cortes',status:'Conectada',extra:'preservado'},instagram:{account:'@outro.canal',status:'Personalizada'},youtube:{account:'@OS4.CORTES'}});
    q.set('folder_watchers',[{folderId:'folder',capability:'fixture-protected'}]);
    for(const state of ['queued','preparing','failed','cancelled','publishing','verify','completed'])legacy(q,state,state);
    q.stage('completed','publication_confirmed',{confirmed:true},321);
    const beforeEvents=q.db.prepare('SELECT * FROM events').all();
    assert.deepEqual(migrateQueueBranding(q.db),{accountsChanged:true,jobsChanged:7});
    assert.equal(q.get('accounts').tiktok.account,BRAND_ACCOUNT);
    assert.equal(q.get('accounts').tiktok.status,'Conectada');
    assert.equal(q.get('accounts').tiktok.extra,'preservado');
    assert.equal(q.get('accounts').instagram.account,'@outro.canal');
    assert.equal(q.get('accounts').youtube.account,BRAND_ACCOUNT);
    assert.deepEqual(q.get('folder_watchers'),[{folderId:'folder',capability:'fixture-protected'}]);
    for(const job of q.list()) {
      assert.equal(job.state,job.id);assert.equal(job.created,123);assert.equal(job.evidence,'evidência original');
      assert.equal(job.payload.account,BRAND_ACCOUNT);
      assert.equal(job.payload.videoPath,'C:/OS4CORTES/video.mp4');assert.equal(job.payload.postPath,'C:/OS4CORTES/post.txt');
      assert.equal(job.payload.titulo,['publishing','verify','completed'].includes(job.state)?'OS4 Cortes':'OS4 de Direita');
    }
    assert.deepEqual(q.db.prepare('SELECT * FROM events').all(),beforeEvents);
    assert.deepEqual(migrateQueueBranding(q.db),{accountsChanged:false,jobsChanged:0});
  } finally {q.close();}
});

test('migração mantém registros em colisão e impede reenvio sob o novo nome',()=>{
  const q=new Queue(':memory:');
  try {
    const old=legacy(q,'old','completed');
    q.add({...old,id:'new',account:BRAND_ACCOUNT});
    const ids=q.list().map(j=>j.id);
    migrateQueueBranding(q.db);
    assert.deepEqual(q.list().map(j=>j.id),ids);assert.equal(q.list().length,2);
    assert.equal(q.add({...old,id:'third',account:'@os4cortes'}),false);
  } finally {q.close();}
});

test('novos pedidos usam a nova conta e reconhecem histórico com handle legado',()=>{
  const q=new Queue(':memory:');const x=new QueueExecutor(q);x.ensureWorkerRunning=()=>{};
  try {
    assert.ok(['youtube','instagram','tiktok'].every(n=>q.get('accounts')[n].account===BRAND_ACCOUNT));
    const existing=legacy(q,'previous','completed');
    q.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify({...existing,driveFileId:'drive-file',formato:'16:9'}),'previous');
    assert.deepEqual(x.enqueueCorte({driveFileId:'drive-file',videoPath:'/copy.mp4',formato:'16:9'}),[]);
    const ids=x.enqueueCorte({driveFileId:'fresh-file',videoPath:'/fresh.mp4',formato:'16:9',postText:'Siga @os4cortes'});
    const job=q.list().find(j=>j.id===ids[0]);assert.equal(job.payload.account,BRAND_ACCOUNT);assert.equal(job.payload.postText,'Siga @os4dedireita');
  } finally {x.stop();q.close();}
});

test('legenda local antiga recebe branding novo ao preparar envio sem modificar o arquivo',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'os4-brand-'));
  const postPath=path.join(dir,'post.txt');const original='OS4 Cortes\nSiga @os4.cortes #os4cortes';fs.writeFileSync(postPath,original);
  const q=new Queue(':memory:');let captured;
  const x=new QueueExecutor(q,{validateVideo:()=>{},cleanup:false,publishers:{youtube:async args=>{captured=args;return {ok:true,confirmed:true};}}});
  try {
    q.add({id:'queued',network:'youtube',account:BRAND_ACCOUNT,videoFileId:'file',postPath,videoPath:'/video.mp4'});
    await x.processJob(q.list()[0]);
    assert.equal(captured.description,'OS4 de Direita\nSiga @os4dedireita #os4dedireita');assert.equal(captured.caption,captured.description);
    assert.equal(fs.readFileSync(postPath,'utf8'),original);
  } finally {x.stop();q.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('texto público troca a marca sem alterar endereço técnico do Netlify ou contas distintas',()=>{
  assert.equal(rebrandText('@os4cortes.extra #os4cortes_extra'),'@os4cortes.extra #os4cortes_extra');
  assert.equal(canonicalAccount('@outro.canal'),'@outro.canal');assert.equal(canonicalAccount('@os4cortes.extra'),'@os4cortes.extra');
  assert.equal(rebrandText('OS4 Cortes · @os4cortes · os4cortes · https://os4cortes.netlify.app/'),'OS4 de Direita · @os4dedireita · os4dedireita · https://os4cortes.netlify.app/');
});

test('falha na migração registra diagnóstico, reverte escrita e mantém leitura atualizada das contas',t=>{
  const {DatabaseSync}=require('node:sqlite');
  const originalPrepare=DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
    if(sql==='SELECT id,fingerprint,payload,state FROM jobs')throw new Error('database disk image is malformed');
    return originalPrepare.call(this,sql);
  });
  const warnings=[];t.mock.method(console,'warn',message=>warnings.push(message));
  const q=new Queue(':memory:');
  try {
    assert.equal(q.brandingMigrationError,'database disk image is malformed');
    assert.equal(warnings.length,1);assert.match(warnings[0],/Migração da identificação adiada/);assert.match(warnings[0],/malformed/);
    assert.equal(q.db.prepare("SELECT value FROM settings WHERE key='accounts'").get(),undefined);
    q.set('accounts',{tiktok:{account:'@os4_cortes',status:'Conectada'},instagram:{account:'@canal.personalizado',status:'Conectada'}});
    const read=q.get('accounts');
    assert.equal(read.tiktok.account,BRAND_ACCOUNT);assert.equal(read.tiktok.status,'Conectada');
    assert.equal(read.instagram.account,'@canal.personalizado');assert.equal(read.youtube.account,BRAND_ACCOUNT);
    const stored=JSON.parse(q.db.prepare("SELECT value FROM settings WHERE key='accounts'").get().value);
    assert.equal(stored.tiktok.account,'@os4_cortes');assert.equal(stored.youtube,undefined);
    assert.equal(q.add({id:'still-usable',network:'youtube',account:'@os4_cortes',videoFileId:'new-file'}),true);
    assert.equal(q.list()[0].payload.account,BRAND_ACCOUNT);
  } finally {q.close();}
});

test('assinatura de negócios vira assinatura de direita, aliases aceitam sublinhado e URLs permanecem literais',()=>{
  const {BRAND_SIGNATURE}=require('../src/branding.cjs');
  for(const account of ['@os4cortes','@os4.cortes','@os4_cortes','@os4dedireita']) {
    assert.equal(rebrandText(`Siga ${account} para mais insights diários sobre negócios e liderança.`),BRAND_SIGNATURE);
  }
  assert.equal(canonicalAccount('@os4_cortes'),BRAND_ACCOUNT);
  assert.equal(rebrandText('OS4 Cortes @os4_cortes #os4_cortes os4_cortes'),'OS4 de Direita @os4dedireita #os4dedireita os4dedireita');
  const source='https://www.youtube.com/@os4cortes https://github.com/owner/OS4CORTES https://example.org/os4_cortes?q=@os4.cortes https://os4cortes.netlify.app/ C:\\OS4CORTES\\video.mp4';
  assert.equal(rebrandText(source),source);
  assert.equal(rebrandText('@os4.cortes. #os4_cortes.'),'@os4dedireita. #os4dedireita.');
});
