import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { setEnvironmentContext, connectLambda } from '@netlify/blobs';
import setup from '../netlify/functions/github-setup.mts';
import start from '../netlify/functions/workflow-start.mts';
import progress from '../netlify/functions/workflow-progress.mts';
import publisherFolder from '../netlify/functions/publisher-folder.mts';
import {publisherToken} from '../netlify/functions/_shared/publisher.mts';
import status from '../netlify/functions/workflow-status.mts';
import { blobStore } from '../netlify/functions/_shared/platform.mts';

const secret='local-test-session-secret';
const callbackSecret='local-test-callback-secret';
const token='local-test-github-token-never-real';
const context={deploy:{context:'production'},requestId:'test-request'};
const environment={siteID:'test-site',primaryRegion:'us-east-2',deployID:'0123456789abcdef01234567',token:'test-blobs',edgeURL:'https://cached.test',uncachedEdgeURL:'https://strong.test'};
const records=new Map();
let dispatches=[];
let rejectDispatch=false;
const env = new Map(Object.entries({OS4_SESSION_SECRET:secret,GOOGLE_CLIENT_SECRET:callbackSecret}));
globalThis.Netlify={env:{get:(name)=>env.get(name),set:(name,value)=>env.set(name,value)}};
function cookie(email='owner@example.test') {
 const encoded=Buffer.from(JSON.stringify({email,exp:Date.now()+60000})).toString('base64url');
 return 'os4_session='+encoded+'.'+crypto.createHmac('sha256',secret).update(encoded).digest('hex');
}
function req(path,method='GET',body,session=cookie()) {
 return new Request('https://os4.example.test/.netlify/functions/'+path,{method,headers:{cookie:session,'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}

function narratedCut() {
 return {
  titulo:'O que essa resposta esclarece?',inicio:'00:10',fim:'00:30',formato:'9:16',saida_suave:false,
  editorial:{
   version:1,source:{label:'Entrevista original',date:'2026-10-18'},
   scenes:[
    {id:'opening',kind:'narration',text:'O que essa resposta esclarece?',background:{start:10,end:15},
     visual:{title:'O que foi dito?',kicker:'SEGUNDO A FONTE',lines:['Veja a resposta']},
     tts:{delivery:'question',cues:[]},evidence:[{start:15,end:25}]},
    {id:'answer',kind:'clip',start:15,end:25},
   ],
   extension:{reviewed:true},
  },
 };
}
function renderBody(extra={}) {
 return {kind:'render',folderId:'editorial-mode-folder',videoFileId:'source',transcriptJsonFileId:'transcript',
  cuts:[{titulo:'Corte legado',inicio:'00:10',fim:'00:30',formato:'9:16'}],...extra};
}
const transportFixture=JSON.parse(fs.readFileSync(new URL('./fixtures/editorial-transport-40.json',import.meta.url),'utf8'));
function fortyEditorialCuts() {
 return Array.from({length:transportFixture.count},(_,index)=>({
  ...structuredClone(transportFixture.template),
  titulo:`Corte ${String(index+1).padStart(2,'0')}: ${transportFixture.template.titulo}`,
 }));
}
globalThis.fetch=async (input,options={})=>{
 const url=new URL(String(input));
 if(url.hostname==='api.github.com') {
  assert.equal(options.headers.Authorization,`Bearer ${token}`);
  if(url.pathname.endsWith('/dispatches')) {
   dispatches.push(JSON.parse(options.body));
   return rejectDispatch ? Response.json({message:'Forbidden'},{status:403}) : new Response(null,{status:204});
  }
  return Response.json({workflows:[]});
 }
 assert.equal(url.hostname,'strong.test','All Blob operations must use strong consistency');
 const method=(options.method||'GET').toUpperCase();
 if(method==='PUT') {records.set(url.pathname,options.body);return new Response(null,{status:200});}
 if(method==='DELETE') {records.delete(url.pathname);return new Response(null,{status:200});}
 return records.has(url.pathname)?new Response(records.get(url.pathname),{status:200,headers:{etag:'test'}}):new Response(null,{status:404});
};
setEnvironmentContext(environment);

test('legacy context reproduces production failure; modern context keeps strong reads',async()=>{
 connectLambda({blobs:Buffer.from(JSON.stringify({url:environment.edgeURL,token:'test'})).toString('base64'),headers:{'x-nf-site-id':'test-site','x-nf-deploy-id':'0123456789abcdef01234567'}});
 await assert.rejects(()=>blobStore('os4-config',context).get('missing'),/uncachedEdgeURL/);
 setEnvironmentContext(environment);
 assert.equal(await blobStore('os4-config',context).get('missing'),null);
});

test('unauthorized requests and invalid JSON are rejected',async()=>{
 assert.equal((await setup(req('github-setup','GET',undefined,''),context)).status,401);
 assert.equal((await start(req('workflow-start','POST',null),context)).status,400);
});

test('token remains encrypted at rest and connection survives repeated reads',async()=>{
 assert.equal((await setup(req('github-setup','POST',{token}),context)).status,200);
 assert.equal(JSON.stringify([...records.values()]).includes(token),false);
 for(let i=0;i<2;i++) assert.equal((await (await setup(req('github-setup'),context)).json()).connected,true);
 const other=await (await setup(req('github-setup','GET',undefined,cookie('other@example.test')),context)).json();
 assert.equal(other.connected,false);
});

test('dispatch, authenticated progress, polling and results work end to end',async()=>{
 const response=await start(req('workflow-start','POST',{kind:'transcribe',videoUrl:'https://www.youtube.com/watch?v=X3HOegrwb8U'}),context);
 assert.equal(response.status,202);
 const {requestId}=await response.json();
 assert.equal(dispatches[0].inputs.callback_url,'https://os4.example.test/.netlify/functions/workflow-progress');
 const callbackToken=crypto.createHmac('sha256',callbackSecret).update('os4-progress:'+requestId).digest('hex');
 const update={request_id:requestId,token:callbackToken,status:'running',stage:'transcricao',percent:45};
 assert.equal((await progress(req('workflow-progress','POST',{...update,token:'wrong'}),context)).status,403);
 assert.equal((await progress(req('workflow-progress','POST',update),context)).status,200);
 assert.equal((await status(req('workflow-status?id='+requestId,'GET',undefined,cookie('other@example.test')),context)).status,404);
 let job=(await (await status(req('workflow-status?id='+requestId),context)).json()).job;
 assert.equal(job.percent,45);assert.equal(job.callbackHash,undefined);
 const result={transcript:'Test transcript',folderId:'folder',videoFileId:'video',transcriptJsonFileId:'transcript'};
 await progress(req('workflow-progress','POST',{...update,status:'completed',percent:100,result}),context);
 await progress(req('workflow-progress','POST',update),context);
 job=(await (await status(req('workflow-status?id='+requestId),context)).json()).job;
 assert.equal(job.status,'completed');assert.deepEqual(job.result,result);
});

test('invalid inputs do not launch paid processing and dispatch failures are explicit',async()=>{
 const before=dispatches.length;
 assert.equal((await start(req('workflow-start','POST',{kind:'transcribe',videoUrl:'https://youtube.com/'}),context)).status,400);
 const render={kind:'render',folderId:'folder',videoFileId:'video',transcriptJsonFileId:'transcript',cuts:[{inicio:'01:00',fim:'00:30'}]};
 assert.equal((await start(req('workflow-start','POST',render),context)).status,400);
 assert.equal(dispatches.length,before);
 rejectDispatch=true;
 assert.equal((await start(req('workflow-start','POST',{...render,cuts:[{inicio:'00:00',fim:'00:15'}]}),context)).status,502);
 rejectDispatch=false;
});

test('preview writes are isolated from production stores',async()=>{
 await blobStore('os4-config',{deploy:{context:'deploy-preview'}}).setJSON('preview-only',{test:true});
 assert.ok([...records.keys()].some(key=>key.includes('deploy:0123456789abcdef01234567')&&key.endsWith('/preview-only')));
 assert.equal(await blobStore('os4-config',context).get('preview-only'),null);
});

test('stale queued jobs remain resumable while a runner is waiting',async()=>{
 const oldId='stale-queued-123';
 const oldJob={
  ownerHash:crypto.createHash('sha256').update('owner@example.test').digest('hex'),
  callbackHash:'abc',
  kind:'transcribe',
  status:'queued',
  stage:'fila',
  detail:'Enviado para o GitHub Actions',
  percent:0,
  createdAt:new Date(Date.now()-20*60*1000).toISOString(),
  updatedAt:new Date(Date.now()-20*60*1000).toISOString(),
 };
 await blobStore('os4-jobs',context).setJSON(oldId,oldJob);
 const res=await status(req('workflow-status?id='+oldId),context);
 assert.equal(res.status,200);
 const data=await res.json();
 assert.equal(data.job.status,'queued');
 assert.equal(data.job.hasLowerThird,false);
 assert.equal(data.job.stale,true);
 assert.equal(data.job.error,null);
});

test('more than 30 cuts flow through dispatch, partial readiness and scoped publication API',async()=>{
 const folderId='folder01234567890123456789';
 const cuts=Array.from({length:40},(_,i)=>({inicio:'00:00',fim:'00:15',titulo:`Título ${i+1}`}));
 const response=await start(req('workflow-start','POST',{kind:'render',folderId,videoFileId:'source',transcriptJsonFileId:'transcript',cuts}),context);
 assert.equal(response.status,202);const {requestId}=await response.json();
 const scope=publisherToken(callbackSecret,folderId);
 const read=(id=folderId,auth=scope)=>publisherFolder(new Request(`https://os4.example.test/.netlify/functions/publisher-folder?folderId=${id}`,{headers:{Authorization:`Bearer ${auth}`}}),context);
 assert.equal((await read(folderId,'wrong')).status,401);
 assert.equal((await read('otherfolder0123456789012345')).status,401);
 const update={request_id:requestId,token:crypto.createHmac('sha256',callbackSecret).update('os4-progress:'+requestId).digest('hex'),status:'running',stage:'cortes'};
 assert.equal((await progress(req('workflow-progress','POST',{...update,ready_cut:{index:1,files:{video:{id:'raw'},post:{id:'post'}}}}),context)).status,400);
 const ready={index:40,formato:'9:16',titulo:'Pronto',files:{videoLegenda:{id:'final40'},post:{id:'post40'}}};
 assert.equal((await progress(req('workflow-progress','POST',{...update,ready_cut:ready}),context)).status,200);
 await progress(req('workflow-progress','POST',{...update,percent:90}),context);
 let feed=await (await read()).json();assert.equal(feed.totalCuts,40);assert.equal(feed.readyCount,1);assert.equal(feed.cuts[0].index,40);
 assert.equal(feed.callbackHash,undefined);assert.equal(feed.token,undefined);assert.equal(feed.ownerHash,undefined);
 await progress(req('workflow-progress','POST',{...update,status:'completed',result:{cuts:[{...ready,index:39,files:{videoLegenda:{id:'final39'},post:{id:'post39'}}}]}}),context);
 feed=await (await read()).json();assert.equal(feed.status,'completed');assert.deepEqual(feed.cuts.map(c=>c.index),[39,40]);
});

test('video lower-third flag reaches all 40 mixed-format cuts and defaults to off',async()=>{
 const cuts=Array.from({length:40},(_,i)=>({
  inicio:'00:00',fim:i%2?'04:00':'00:30',titulo:`Corte misto ${i+1}`,
  formato:i%2?'16:9':'9:16',destino:i%2?'youtube':'reels_tiktok',
 }));
 for(const [flag,enabled] of [[{hasLowerThird:true},true],[{hasLowerThird:false},false],[{},false]]) {
  const response=await start(req('workflow-start','POST',{
   kind:'render',folderId:'mixed-lower-third',videoFileId:'source',transcriptJsonFileId:'transcript',cuts,...flag,
  }),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const {inputs}=dispatches.at(-1);
  assert.equal(inputs.lower_third_mode,enabled?'crop':'off');
  assert.equal(inputs.lower_third_height,enabled?'0.30':'0');
  assert.deepEqual(JSON.parse(inputs.cuts_json),cuts);
  const job=await blobStore('os4-jobs',context).get(requestId,{type:'json'});
  assert.equal(job.hasLowerThird,enabled);
  assert.equal(job.totalCuts,40);
  const polled=await (await status(req('workflow-status?id='+requestId),context)).json();
  assert.equal(polled.job.hasLowerThird,enabled);
 }
});

test('transcription persists the video flag without adding unsupported workflow inputs',async()=>{
 for(const [flag,enabled] of [[{hasLowerThird:true},true],[{hasLowerThird:false},false],[{},false]]) {
  const response=await start(req('workflow-start','POST',{
   kind:'transcribe',videoUrl:'https://youtu.be/PMGxFRAea_I',...flag,
  }),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const job=await blobStore('os4-jobs',context).get(requestId,{type:'json'});
  assert.equal(job.hasLowerThird,enabled);
  assert.deepEqual(Object.keys(dispatches.at(-1).inputs).sort(),['callback_url','request_id','video_url']);
  const update={
   request_id:requestId,token:crypto.createHmac('sha256',callbackSecret).update('os4-progress:'+requestId).digest('hex'),
   status:'completed',stage:'concluido',percent:100,
   result:{folderId:'folder',videoFileId:'video',transcriptJsonFileId:'transcript'},
  };
  assert.equal((await progress(req('workflow-progress','POST',update),context)).status,200);
  const polled=await (await status(req('workflow-status?id='+requestId),context)).json();
  assert.equal(polled.job.hasLowerThird,enabled);
 }
});

test('lower-third flag accepts only booleans and invalid values never dispatch processing',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const requests=[
  {kind:'transcribe',videoUrl:'https://youtu.be/PMGxFRAea_I'},
  {kind:'render',folderId:'folder',videoFileId:'source',transcriptJsonFileId:'transcript',cuts:[{inicio:0,fim:15}]},
 ];
 for(const body of requests) {
  for(const hasLowerThird of ['true','false','cover','',1,0,null,{},[]]) {
   const response=await start(req('workflow-start','POST',{...body,hasLowerThird}),context);
   assert.equal(response.status,400,`${body.kind}: ${JSON.stringify(hasLowerThird)}`);
  }
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('render lower-third mode and height are derived exclusively from the video checkbox',async()=>{
 const response=await start(req('workflow-start','POST',{
  kind:'render',folderId:'folder',videoFileId:'source',transcriptJsonFileId:'transcript',
  cuts:[{inicio:0,fim:15}],hasLowerThird:true,lower_third_mode:'cover',lower_third_height:'0.60',
 }),context);
 assert.equal(response.status,202);
 assert.equal(dispatches.at(-1).inputs.lower_third_mode,'crop');
 assert.equal(dispatches.at(-1).inputs.lower_third_height,'0.30');
});

test('simple-cut flag accepts only booleans and invalid values never dispatch or create jobs',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 for(const body of [renderBody(),{kind:'transcribe',videoUrl:'https://youtu.be/PMGxFRAea_I'}]) {
  for(const simpleCuts of ['true','false','editorial','',1,0,null,{},[]]) {
   const response=await start(req('workflow-start','POST',{...body,simpleCuts}),context);
   assert.equal(response.status,400,`${body.kind}: ${JSON.stringify(simpleCuts)}`);
   assert.match((await response.json()).error,/corte simples/);
  }
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('explicit editorial mode rejects a legacy package before dispatch',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const response=await start(req('workflow-start','POST',renderBody({simpleCuts:false})),context);
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/Corte 1:.*plano editorial/);
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('editorial mode preserves the full plan and sends its mode independently of source lower thirds',async()=>{
 const cuts=[narratedCut()];
 for(const hasLowerThird of [false,true]) {
  const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:false,hasLowerThird})),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const {inputs}=dispatches.at(-1);
  assert.equal(inputs.cut_mode,'editorial');
  assert.equal(inputs.lower_third_mode,hasLowerThird?'crop':'off');
  assert.equal(inputs.lower_third_height,hasLowerThird?'0.30':'0');
  assert.deepEqual(JSON.parse(inputs.cuts_json),cuts);
  const job=await blobStore('os4-jobs',context).get(requestId,{type:'json'});
  assert.equal(job.simpleCuts,false);
  assert.equal(job.hasLowerThird,hasLowerThird);
  assert.equal(job.totalCuts,1);
 }
});

test('simple mode accepts legacy cuts and removes supplied editorial data without changing other fields',async()=>{
 const legacy=renderBody().cuts[0];
 const original=narratedCut();
 const expected={...original};delete expected.editorial;
 for(const cuts of [[legacy],[original],[{...original,editorial:null}]]) {
  const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:true})),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const {inputs}=dispatches.at(-1);
  assert.equal(inputs.cut_mode,'simple');
  assert.deepEqual(JSON.parse(inputs.cuts_json),cuts[0]===legacy?[legacy]:[expected]);
  assert.equal(Object.hasOwn(JSON.parse(inputs.cuts_json)[0],'editorial'),false);
  assert.equal((await blobStore('os4-jobs',context).get(requestId,{type:'json'})).simpleCuts,true);
 }
 assert.equal(Object.hasOwn(original,'editorial'),true,'Request objects must not be mutated when stripping plans');
});

test('omitted mode remains compatible with old clients and never enables narration from the plan alone',async()=>{
 const narrated=narratedCut();
 const cuts=[renderBody().cuts[0],narrated];
 const response=await start(req('workflow-start','POST',renderBody({cuts})),context);
 assert.equal(response.status,202);
 const {requestId}=await response.json();
 const {inputs}=dispatches.at(-1);
 const expected=narratedCut();delete expected.editorial;
 assert.equal(inputs.cut_mode,'simple');
 assert.deepEqual(JSON.parse(inputs.cuts_json),[cuts[0],expected]);
 assert.equal((await blobStore('os4-jobs',context).get(requestId,{type:'json'})).simpleCuts,true);
});

test('malformed or out-of-bounds editorial scenes are rejected before starting a runner',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const changes=[
  cut=>{cut.editorial=null;},
  cut=>{cut.editorial.version='1';},
  cut=>{cut.editorial.scenes.push(null);},
  cut=>{cut.editorial.scenes.push({id:'unknown',kind:'command'});},
  cut=>{cut.editorial.scenes[1].id='opening';},
  cut=>{cut.editorial.scenes[1].end=31;},
  cut=>{cut.editorial.scenes[0].background.start=9;},
  cut=>{cut.editorial.scenes[0].evidence=[];},
  cut=>{cut.editorial.scenes[0].evidence[0].end=31;},
  cut=>{cut.editorial.scenes[0].visual.title='';},
 ];
 for(const change of changes) {
  const cut=narratedCut();change(cut);
  const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:false})),context);
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/Corte 1:.*plano editorial/);
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('transcription ignores render mode for workflow inputs while preserving the selected boolean in the job',async()=>{
 const response=await start(req('workflow-start','POST',{kind:'transcribe',videoUrl:'https://youtu.be/PMGxFRAea_I',simpleCuts:false}),context);
 assert.equal(response.status,202);
 const {requestId}=await response.json();
 assert.deepEqual(Object.keys(dispatches.at(-1).inputs).sort(),['callback_url','request_id','video_url']);
 assert.equal((await blobStore('os4-jobs',context).get(requestId,{type:'json'})).simpleCuts,false);
});

test('forty editorial plans cross dispatch losslessly through the shared Python gzip transport fixture',async()=>{
 const cuts=fortyEditorialCuts();
 const raw=JSON.stringify(cuts);
 assert.ok(raw.length>60000);
 assert.ok(Buffer.byteLength(raw,'utf8')<512000);
 const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:false})),context);
 assert.equal(response.status,202);
 const {requestId}=await response.json();
 const {inputs}=dispatches.at(-1);
 assert.equal(inputs.cut_mode,'editorial');
 assert.ok(inputs.cuts_json.startsWith('gzip-base64:'));
 assert.ok(inputs.cuts_json.length<=60000);
 const unpack=value=>gunzipSync(Buffer.from(value.slice('gzip-base64:'.length),'base64')).toString('utf8');
 assert.equal(unpack(inputs.cuts_json),raw);
 assert.equal(unpack(inputs.cuts_json),unpack(transportFixture.transport));
 assert.deepEqual(JSON.parse(unpack(inputs.cuts_json)),cuts);
 const job=await blobStore('os4-jobs',context).get(requestId,{type:'json'});
 assert.equal(job.totalCuts,40,'Counting cuts must not parse compressed workflow input as JSON');
});

test('editorial size limits count UTF-8 bytes and reject transport that stays too large after gzip',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const overRaw=narratedCut();overRaw.legenda_post='á'.repeat(260000);
 assert.ok(JSON.stringify([overRaw]).length<512000);
 assert.ok(Buffer.byteLength(JSON.stringify([overRaw]),'utf8')>512000);
 let response=await start(req('workflow-start','POST',renderBody({cuts:[overRaw],simpleCuts:false})),context);
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/512000 bytes/);
 const overTransport=narratedCut();
 overTransport.legenda_post=crypto.randomBytes(50000).toString('base64');
 response=await start(req('workflow-start','POST',renderBody({cuts:[overTransport],simpleCuts:false})),context);
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/60000 caracteres após compressão/);
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('simple cuts keep the original 60000-character limit without automatic compression',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const cut=renderBody().cuts[0];cut.legenda_post='texto '.repeat(11000);
 for(const flag of [{simpleCuts:true},{}]) {
  const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],...flag})),context);
  assert.equal(response.status,400);
  assert.equal((await response.json()).error,'O pacote de cortes ficou grande demais. Reduza os textos do pacote.');
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('terminal callbacks preserve editorial failure details and partial counters through authenticated polling',async()=>{
 for(const completedCount of [1,0]) {
  const cuts=[narratedCut(),narratedCut()];
  const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:false})),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const ready={index:1,titulo:cuts[0].titulo,formato:'9:16',files:{videoLegenda:{id:'final-editorial'},post:{id:'post-editorial'}}};
  const result={cuts:completedCount?[ready]:[],requestedCount:2,completedCount,
   errors:cuts.slice(completedCount).map((cut,index)=>({index:index+completedCount+1,titulo:cut.titulo,error:'Falha controlada no áudio deste corte'}))};
  const callback={request_id:requestId,token:crypto.createHmac('sha256',callbackSecret).update('os4-progress:'+requestId).digest('hex'),
   status:completedCount?'completed':'error',stage:completedCount?'concluido':'erro',percent:100,result};
  assert.equal((await progress(req('workflow-progress','POST',callback),context)).status,200);
  await progress(req('workflow-progress','POST',{...callback,status:'running',result:{cuts:[]}}),context);
  const job=(await (await status(req('workflow-status?id='+requestId),context)).json()).job;
  assert.equal(job.status,completedCount?'completed':'error');
  assert.equal(job.totalCuts,2);
  assert.deepEqual(job.result,result,'Terminal polling must retain the failure list and both original counters');
 }
});


