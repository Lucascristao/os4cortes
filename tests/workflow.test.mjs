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
import control from '../netlify/functions/workflow-control.mts';
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

test('burn-captions flag accepts only booleans and invalid values never dispatch or create jobs',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 for(const burnCaptions of ['true','false','sim','',1,0,null,{},[]]) {
  const response=await start(req('workflow-start','POST',{...renderBody(),burnCaptions}),context);
  assert.equal(response.status,400,JSON.stringify(burnCaptions));
  assert.match((await response.json()).error,/queimar legendas/);
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

test('burn-captions defaults to true and reaches workflow dispatch when disabled or enabled',async()=>{
 for(const [enabled,expected] of [[false,'false'],[true,'true'],[undefined,'true']]) {
  const body=renderBody();
  if(enabled!==undefined) body.burnCaptions=enabled;
  const response=await start(req('workflow-start','POST',body),context);
  assert.equal(response.status,202);
  const {requestId}=await response.json();
  const {inputs}=dispatches.at(-1);
  assert.equal(inputs.burn_captions,expected);
  const job=await blobStore('os4-jobs',context).get(requestId,{type:'json'});
  assert.equal(job.burnCaptions,expected==='true');
 }
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
  [cut=>{cut.editorial=null;},/precisa de um plano editorial.*Importe o pacote/],
  [cut=>{cut.editorial.version='1';},/plano editorial inválido: o campo version/],
  [cut=>{cut.editorial.scenes.push(null);},/cena 3: o campo id/],
  [cut=>{cut.editorial.scenes.push({id:'unknown',kind:'command'});},/cena 3 \(unknown\): o campo kind/],
  [cut=>{cut.editorial.scenes[1].id='opening';},/cena 2 \(opening\): o campo id está repetido/],
  [cut=>{cut.editorial.scenes[1].end=31;},/cena 2 \(answer\): o campo start\/end \(15s a 31s\).*início 10s; fim 30s/],
  [cut=>{cut.editorial.scenes[0].background.start=9;},/cena 1 \(opening\): o campo background \(9s a 15s\).*início 10s; fim 30s/],
  [cut=>{cut.editorial.scenes[0].evidence=[];},/cena 1 \(opening\): o campo evidence precisa ter entre 1 e 8/],
  [cut=>{cut.editorial.scenes[0].evidence[0].end=31;},/cena 1 \(opening\): o campo evidence\[0\] \(15s a 31s\).*início 10s; fim 30s/],
  [cut=>{cut.editorial.scenes[0].visual.title='';},/cena 1 \(opening\): o campo visual\.title/],
 ];
 for(const [change,diagnostic] of changes) {
  const cut=narratedCut();change(cut);
  const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:false})),context);
  assert.equal(response.status,400);
  const {error}=await response.json();
  assert.match(error,/Corte 1:.*plano editorial/);
  assert.match(error,diagnostic);
  if(cut.editorial!==null) assert.doesNotMatch(error,/Importe o pacote|marque corte simples/);
 }
 assert.equal(dispatches.length,before);
 assert.equal(records.size,recordsBefore);
});

function fractionalEditorialCut() {
 const cut=narratedCut();
 cut.inicio='01:41.7';cut.fim='04:54.7';
 cut.editorial.scenes[0].background={start:101.7,end:120.45};
 cut.editorial.scenes[0].evidence=[{start:250.25,end:294.7}];
 Object.assign(cut.editorial.scenes[1],{start:250.25,end:294.7});
 return cut;
}

const contextualProfiles = JSON.parse(fs.readFileSync(new URL('./fixtures/editorial-contextual-profiles.json', import.meta.url), 'utf8'));
const commentaryIntents = JSON.parse(fs.readFileSync(new URL('./fixtures/editorial-commentary-intents.json', import.meta.url), 'utf8'));

test('commentary role and declared contribution are transported without adding per-video approval', async () => {
 const cuts = commentaryIntents.map((intent, index) => {
  const cut = narratedCut();
  cut.editorial.profile = structuredClone(contextualProfiles[index]);
  cut.editorial.intent = structuredClone(intent);
  return cut;
 });
 const response = await start(req('workflow-start', 'POST', renderBody({ cuts, simpleCuts: false })), context);
 assert.equal(response.status, 202);
 const sent = JSON.parse(dispatches.at(-1).inputs.cuts_json);
 assert.deepEqual(sent, cuts);
 assert.equal(sent[0].editorial.intent.mode, 'support_source');
 assert.equal(Object.hasOwn(sent[0], 'approved'), false);
});

test('invalid commentary intent fails before starting a runner while legacy intent remains optional', async () => {
 const before = dispatches.length;
 const recordsBefore = records.size;
 const changes = [
  [cut => { cut.editorial.intent = null; }, /intent precisa ser um objeto/],
  [cut => { cut.editorial.intent.mode = 'always_agree'; }, /intent\.mode/],
  [cut => { cut.editorial.intent.source_point = ' '; }, /intent\.source_point/],
  [cut => { cut.editorial.intent.contribution = 'a'.repeat(241); }, /intent\.contribution/],
  [cut => { delete cut.editorial.intent.target; }, /intent\.target/],
  [cut => { cut.editorial.intent.target = false; }, /intent\.target/],
  [cut => { cut.editorial.intent.require_approval = true; }, /intent contém uma propriedade não suportada/],
 ];
 for (const [change, diagnostic] of changes) {
  const cut = narratedCut();
  cut.editorial.intent = structuredClone(commentaryIntents[0]);
  change(cut);
  const response = await start(req('workflow-start', 'POST', renderBody({ cuts: [cut], simpleCuts: false })), context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, diagnostic);
 }
 assert.equal(dispatches.length, before);
 assert.equal(records.size, recordsBefore);
 const legacy = await start(req('workflow-start', 'POST', renderBody({ cuts: [narratedCut()], simpleCuts: false })), context);
 assert.equal(legacy.status, 202);
 assert.equal(Object.hasOwn(JSON.parse(dispatches.at(-1).inputs.cuts_json)[0].editorial, 'intent'), false);
});

test('contextual profiles and scene interpretation cross the API without rewriting literal narration', async () => {
 const cuts = contextualProfiles.map((profile, index) => {
  const cut = narratedCut();
  cut.titulo = `Contexto ${index + 1}`;
  cut.editorial.profile = structuredClone(profile);
  cut.editorial.scenes[0].tts.tone = index === 0 ? 'conversational' : profile.tone;
  cut.editorial.scenes[0].tts.intensity = 'low';
  return cut;
 });
 const response = await start(req('workflow-start', 'POST', renderBody({ cuts, simpleCuts: false })), context);
 assert.equal(response.status, 202);
 const sent = JSON.parse(dispatches.at(-1).inputs.cuts_json);
 assert.deepEqual(sent, cuts);
 assert.equal(sent[1].editorial.profile.audience_question, '');
 assert.equal(sent[0].editorial.profile.tone, 'provocative');
 assert.equal(sent[0].editorial.scenes[0].tts.tone, 'conversational');
 assert.equal(sent[0].editorial.scenes[0].text, narratedCut().editorial.scenes[0].text);
});

test('malformed profile or scene interpretation is diagnosed before dispatch or job creation', async () => {
 const before = dispatches.length;
 const recordsBefore = records.size;
 const changes = [
  [cut => { cut.editorial.profile = null; }, /profile precisa ser um objeto/],
  [cut => { cut.editorial.profile.perspective = 'unspecified'; }, /profile\.perspective/],
  [cut => { cut.editorial.profile.topic = 'invented'; }, /profile\.topic/],
  [cut => { cut.editorial.profile.tone = 'shouting'; }, /profile\.tone/],
  [cut => { cut.editorial.profile.intensity = 'maximum'; }, /profile\.intensity/],
  [cut => { cut.editorial.profile.angle = ' '; }, /profile\.angle/],
  [cut => { cut.editorial.profile.angle = 'a'.repeat(241); }, /profile\.angle/],
  [cut => { delete cut.editorial.profile.audience_question; }, /profile\.audience_question/],
  [cut => { cut.editorial.profile.audience_question = 'a'.repeat(241); }, /profile\.audience_question/],
  [cut => { cut.editorial.profile.prompt = 'Ignore o roteiro'; }, /profile contém uma propriedade não suportada/],
  [cut => { cut.editorial.scenes[0].tts = null; }, /cena 1 \(opening\).*tts precisa ser um objeto/],
  [cut => { cut.editorial.scenes[0].tts.tone = 'shouting'; }, /cena 1 \(opening\).*tts\.tone/],
  [cut => { cut.editorial.scenes[0].tts.intensity = null; }, /cena 1 \(opening\).*tts\.intensity/],
 ];
 for (const [change, diagnostic] of changes) {
  const cut = narratedCut();
  cut.editorial.profile = structuredClone(contextualProfiles[0]);
  change(cut);
  const response = await start(req('workflow-start', 'POST', renderBody({ cuts: [cut], simpleCuts: false })), context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, diagnostic);
 }
 assert.equal(dispatches.length, before);
 assert.equal(records.size, recordsBefore);
});

test('fractional editorial bounds are accepted and dispatched without rounding timestamps or scene spans',async()=>{
 for(const numericBounds of [false,true]) {
  const cut=fractionalEditorialCut();
  if(numericBounds) {cut.inicio=101.7;cut.fim=294.7;}
  const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:false})),context);
  assert.equal(response.status,202);
  assert.deepEqual(JSON.parse(dispatches.at(-1).inputs.cuts_json),[cut]);
 }
});

test('out-of-bounds fractional scenes identify the scene, field and actual cut interval rather than a missing plan',async()=>{
 const before=dispatches.length;
 const recordsBefore=records.size;
 const changes=[
  [cut=>{cut.inicio='01:42';cut.fim='04:55';},/cena 1 \(opening\): o campo background \(101\.7s a 120\.45s\).*início 102s; fim 295s/],
  [cut=>{cut.editorial.scenes[0].background.start=101.698;},/cena 1 \(opening\): o campo background \(101\.698s a 120\.45s\).*início 101\.7s; fim 294\.7s/],
  [cut=>{cut.editorial.scenes[0].evidence[0].end=294.702;},/cena 1 \(opening\): o campo evidence\[0\] \(250\.25s a 294\.702s\).*início 101\.7s; fim 294\.7s/],
  [cut=>{cut.editorial.scenes[1].end=294.702;},/cena 2 \(answer\): o campo start\/end \(250\.25s a 294\.702s\).*início 101\.7s; fim 294\.7s/],
 ];
 for(const [change,diagnostic] of changes) {
  const cut=fractionalEditorialCut();change(cut);
  const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:false})),context);
  assert.equal(response.status,400);
  const {error}=await response.json();
  assert.match(error,diagnostic);
  assert.doesNotMatch(error,/precisa de um plano editorial|Importe o pacote|marque corte simples/);
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

test('cover crosses simple, editorial and gzip dispatch without changing its cut association',async()=>{
 const models=['01_central','02_lateral','03_close'];
 const covers=models.map((template_id,index)=>({version:1,template_id,title:`A DECISÃO ${index+1} MUDOU?`}));
 for(const simpleCuts of [true,false]) {
  const cuts=covers.map(cover=>({...narratedCut(),cover}));
  const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts})),context);
  assert.equal(response.status,202);
  const sent=JSON.parse(dispatches.at(-1).inputs.cuts_json);
  assert.deepEqual(sent.map(cut=>cut.cover),covers);
 }
 const cuts=fortyEditorialCuts().map((cut,index)=>({...cut,cover:covers[index%3]}));
 const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:false})),context);
 assert.equal(response.status,202);
 const transport=dispatches.at(-1).inputs.cuts_json;
 assert.ok(transport.startsWith('gzip-base64:'));
 const sent=JSON.parse(gunzipSync(Buffer.from(transport.slice('gzip-base64:'.length),'base64')).toString('utf8'));
 assert.deepEqual(sent,cuts);
});

test('retired two-person covers migrate by effective aspect in simple, editorial and gzip dispatch',async()=>{
 const legacy={version:1,template_id:'04_duas_pessoas',title:'A DECISÃO É ESSA?'};
 for(const simpleCuts of [true,false]) {
  const shortEnvelope=narratedCut();shortEnvelope.inicio=0;shortEnvelope.fim=181;
  const longOriginal=structuredClone(shortEnvelope);Object.assign(longOriginal.editorial.scenes[1],{start:0,end:181});
  const cuts=[narratedCut(),{...narratedCut(),formato:'16:9'},
   {...narratedCut(),destino:'youtube'},shortEnvelope,longOriginal]
   .map(cut=>({...cut,cover:structuredClone(legacy)}));
  const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts})),context);
  assert.equal(response.status,202);
  const sent=JSON.parse(dispatches.at(-1).inputs.cuts_json);
  assert.deepEqual(sent.map(cut=>cut.cover),['01_central','02_lateral','02_lateral',
   simpleCuts?'02_lateral':'01_central','02_lateral'].map(template_id=>({...legacy,template_id})));
  assert.ok(cuts.every(cut=>cut.cover.template_id==='04_duas_pessoas'),'input remains unchanged');
 }
 const cuts=fortyEditorialCuts().map((cut,index)=>({...cut,formato:index%2?'16:9':'9:16',cover:structuredClone(legacy)}));
 const response=await start(req('workflow-start','POST',renderBody({cuts,simpleCuts:false})),context);
 assert.equal(response.status,202);
 const transport=dispatches.at(-1).inputs.cuts_json;
 assert.ok(transport.startsWith('gzip-base64:'));
 const sent=JSON.parse(gunzipSync(Buffer.from(transport.slice('gzip-base64:'.length),'base64')).toString('utf8'));
 assert.deepEqual(sent.map(cut=>cut.cover),cuts.map((cut,index)=>({...legacy,template_id:index%2?'02_lateral':'01_central'})));
});

test('invalid cover fails before dispatch and job creation in both render modes',async()=>{
 const base={version:1,template_id:'03_close',title:'O QUE ELA CONFIRMA?'};
 const invalid=[null,[],{},'03_close',{...base,version:2},{...base,version:true},{...base,template_id:'novo'},
  {...base,title:''},{...base,title:42},{...base,title:'a'.repeat(61)},{...base,title:'duas\nlinhas'},
  {...base,title:'<b>Título</b>'},{...base,title:'**Título**'},{...base,title:'[Título](https://example.test)'},
  {...base,title:'Título\u200boculto'},{...base,title:'Duas\u2028linhas'},{...base,extra:true},
  {...base,title:' '.repeat(60)+'a'},{...base,title:'[](https://example.test)'}];
 for(const simpleCuts of [true,false]) for(const cover of invalid) {
  const beforeDispatch=dispatches.length;
  const beforeRecords=records.size;
  const response=await start(req('workflow-start','POST',renderBody({cuts:[{...narratedCut(),cover}],simpleCuts})),context);
  assert.equal(response.status,400,JSON.stringify({simpleCuts,cover}));
  assert.match((await response.json()).error,/Corte 1: cover/);
  assert.equal(dispatches.length,beforeDispatch);
  assert.equal(records.size,beforeRecords);
 }
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

test('editorial Unicode below the character limit is compressed when UTF-8 bytes exceed the safe argument size',async()=>{
 const cut=narratedCut();cut.legenda_post='漢'.repeat(50000);
 const raw=JSON.stringify([cut]);
 assert.ok(raw.length<60000);
 assert.ok(Buffer.byteLength(raw,'utf8')>128*1024);
 const response=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:false})),context);
 assert.equal(response.status,202);
 const transport=dispatches.at(-1).inputs.cuts_json;
 assert.ok(transport.startsWith('gzip-base64:'));
 assert.ok(transport.length<=60000);
 assert.equal(gunzipSync(Buffer.from(transport.slice('gzip-base64:'.length),'base64')).toString('utf8'),raw);
 // The legacy mode deliberately retains its original character-based limit.
 const simple=await start(req('workflow-start','POST',renderBody({cuts:[cut],simpleCuts:true})),context);
 assert.equal(simple.status,202);
 const expected={...cut};delete expected.editorial;
 assert.deepEqual(JSON.parse(dispatches.at(-1).inputs.cuts_json),[expected]);
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
  const folderId=renderBody().folderId;
  const feed=await (await publisherFolder(new Request(`https://os4.example.test/.netlify/functions/publisher-folder?folderId=${folderId}`,
   {headers:{Authorization:`Bearer ${publisherToken(callbackSecret,folderId)}`}}),context)).json();
  assert.equal(feed.requestedCount,2);
  assert.equal(feed.completedCount,completedCount);
  assert.equal(feed.failedCount,2-completedCount);
  assert.equal(feed.readyCount,completedCount);
  assert.deepEqual(feed.cuts.map(cut=>cut.index),completedCount?[1]:[]);
  assert.equal(feed.errors,undefined,'Folder capability exposes counts without narration diagnostics');
 }
});

async function controlledBatch(count=4) {
 const response=await start(req('workflow-start','POST',renderBody({cuts:Array.from({length:count},()=>narratedCut()),simpleCuts:false})),context);
 assert.equal(response.status,202);
 const {requestId}=await response.json();
 const callback={request_id:requestId,token:crypto.createHmac('sha256',callbackSecret).update('os4-progress:'+requestId).digest('hex')};
 return {requestId,callback,
  update:body=>progress(req('workflow-progress','POST',{...callback,...body}),context),
  get:async()=>(await (await status(req('workflow-status?id='+requestId),context)).json()).job,
  decide:(action,decisionId,session=cookie())=>control(req('workflow-control','POST',{requestId,action,decisionId},session),context),
 };
}
const failedCut=index=>({index,titulo:`Corte ${index}`,error:`Erro de composição ${index}: <script>alert(1)</script>`});
const pausedCut=(index,decision_id,streak=index)=>({status:'paused',stage:'aguardando_decisao',cut:index,
 decision_id,cut_error:failedCut(index),failed_count:index,completed_count:0,consecutive_failures:streak,
 result:{cuts:[],errors:Array.from({length:index},(_,i)=>failedCut(i+1)),requestedCount:4,completedCount:0,failedCount:index,consecutiveFailures:streak}});

test('paused decisions require the authenticated owner and survive heartbeat and resolved decision replays',async()=>{
 const batch=await controlledBatch();
 const pause=pausedCut(1,'decision-one');
 assert.deepEqual((await (await batch.update(pause)).json()).control,{action:'wait',decisionId:'decision-one'});
 assert.equal((await batch.decide('continue','decision-one','')).status,401);
 assert.equal((await batch.decide('continue','decision-one',cookie('other@example.test'))).status,404);
 const crossSite=req('workflow-control','POST',{requestId:batch.requestId,action:'stop'});
 crossSite.headers.set('origin','https://untrusted.test');
 assert.equal((await control(crossSite,context)).status,403);
 assert.equal((await batch.decide('continue','outdated')).status,409);
 await batch.update({status:'running',stage:'tracking',error:'',failed_count:0,completed_count:0,consecutive_failures:0,result:{cuts:[],errors:[]}});
 let job=await batch.get();
 assert.equal(job.status,'paused');assert.equal(job.stage,'aguardando_decisao');
 assert.equal(job.pendingDecision.id,'decision-one');assert.equal(job.failedCount,1);assert.equal(job.consecutiveFailures,1);
 assert.equal(job.failureHistory[0].error,pause.cut_error.error);
 assert.equal((await batch.decide('continue','decision-one')).status,200);
 job=await batch.get();assert.equal(job.status,'running');assert.equal(job.pendingDecision,null);assert.equal(job.consecutiveFailures,1);
 assert.deepEqual((await (await batch.update(pause)).json()).control,{action:'continue',decisionId:'decision-one'});
 assert.equal((await batch.get()).status,'running');
 await batch.update({...pausedCut(2,'decision-two'),error:'Segundo erro'});
 await batch.update(pause);
 job=await batch.get();assert.equal(job.pendingDecision.id,'decision-two');assert.equal(job.failedCount,2);assert.equal(job.consecutiveFailures,2);
 assert.equal((await batch.decide('continue','decision-one')).status,200,'Duplicate acknowledgement is harmless');
 assert.equal((await batch.get()).pendingDecision.id,'decision-two');
 await batch.decide('continue','decision-two');
 const ready={index:3,titulo:'Salvo',formato:'9:16',files:{videoLegenda:{id:'saved-video'},post:{id:'saved-post'}}};
 await batch.update({status:'running',stage:'cortes',ready_cut:ready,completed_count:1,consecutive_failures:0,
  result:{cuts:[ready],errors:[failedCut(1),failedCut(2)],requestedCount:4,completedCount:1,consecutiveFailures:0}});
 job=await batch.get();assert.equal(job.completedCount,1);assert.equal(job.failedCount,2);assert.equal(job.consecutiveFailures,0);
 await batch.update({status:'running',stage:'tracking',completed_count:0,failed_count:0,consecutive_failures:2,result:{cuts:[],errors:[]}});
 job=await batch.get();assert.equal(job.completedCount,1);assert.equal(job.failedCount,2);assert.equal(job.consecutiveFailures,0);
 assert.equal(job.result.cuts.length,1);assert.equal(job.result.errors.length,2);
 assert.equal(job.callbackHash,undefined);
});

test('stop is sticky independently of continue acknowledgements and returns no old decision ID while running',async()=>{
 const batch=await controlledBatch();
 await batch.update(pausedCut(1,'stop-decision'));
 await batch.decide('continue','stop-decision');
 assert.equal((await batch.decide('stop')).status,200);
 let job=await batch.get();assert.equal(job.status,'stopping');assert.equal(job.stopRequested,true);assert.equal(job.pendingDecision,null);
 assert.equal((await batch.decide('continue','stop-decision')).status,409);
 const response=await batch.update({status:'running',stage:'tracking',result:{cuts:[],errors:[]}});
 assert.deepEqual((await response.json()).control,{action:'stop',decisionId:null});
 assert.equal((await batch.get()).status,'stopping');
 assert.deepEqual((await (await batch.update(pausedCut(1,'stop-decision'))).json()).control,{action:'stop',decisionId:'stop-decision'});
 await batch.update({status:'cancelled',stage:'cancelado',error:'Parada solicitada',result:{cuts:[],errors:[failedCut(1)],requestedCount:4,completedCount:0,stoppedReason:'Parada solicitada'}});
 await batch.update({status:'running',stage:'tracking',result:{cuts:[],errors:[]}});
 job=await batch.get();assert.equal(job.status,'cancelled');assert.equal(job.failedCount,1);assert.equal(job.result.stoppedReason,'Parada solicitada');
 const transcription=await start(req('workflow-start','POST',{kind:'transcribe',videoUrl:'https://youtu.be/PMGxFRAea_I'}),context);
 const {requestId}=await transcription.json();
 assert.equal((await control(req('workflow-control','POST',{requestId,action:'stop'}),context)).status,400);
});

test('three consecutive failures remain terminal with complete partial history and counters',async()=>{
 const batch=await controlledBatch();
 for(let index=1;index<=2;index++) {await batch.update(pausedCut(index,`third-${index}`));await batch.decide('continue',`third-${index}`);}
 await batch.update({...pausedCut(3,'unused'),status:'error',stage:'erro',decision_id:undefined,error:'Interrompido após 3 falhas consecutivas',
  result:{...pausedCut(3,'unused').result,stoppedReason:'Interrompido após 3 falhas consecutivas'}});
 await batch.update(pausedCut(2,'third-2'));
 const job=await batch.get();
 assert.equal(job.status,'error');assert.equal(job.failedCount,3);assert.equal(job.consecutiveFailures,3);assert.equal(job.pendingDecision,null);
 assert.equal(job.failureHistory.length,3);assert.equal(job.result.errors.length,3);assert.match(job.result.stoppedReason,/3 falhas/);
 assert.equal((await batch.decide('continue','unused')).status,409);
});

test('simultaneous continue and stop from separate browsers leave an irreversible stop latch',async()=>{
 for(const stopFirst of [false,true]) {
  const batch=await controlledBatch();
  await batch.update(pausedCut(1,'concurrent-decision'));
  const actions=stopFirst?['stop','continue']:['continue','stop'];
  const responses=await Promise.all(actions.map(action=>batch.decide(action,'concurrent-decision')));
  assert.equal(responses[actions.indexOf('stop')].status,200);
  assert.ok([200,409].includes(responses[actions.indexOf('continue')].status));
  assert.equal((await batch.get()).status,'stopping');
  const callback=await batch.update({status:'running',stage:'tracking'});
  assert.deepEqual((await callback.json()).control,{action:'stop',decisionId:null});
  assert.equal((await batch.decide('continue','concurrent-decision')).status,409);
 }
});

test('a saved video awaiting its cover remains visible but never enters the publication feed',async()=>{
 const batch=await controlledBatch();
 const draft={index:1,titulo:'Vídeo preservado',formato:'9:16',cover:{version:1,template_id:'03_close',title:'CAPA'},
  pendingReason:'cover',error:'Não foi possível montar a capa',files:{videoLegenda:{id:'draft-video'},srt:{id:'draft-srt'},post:{id:'draft-post'}}};
 const pause={...pausedCut(1,'cover-decision'),result:{...pausedCut(1,'cover-decision').result,pendingCuts:[draft]}};
 await batch.update(pause);
 let job=await batch.get();
 assert.equal(job.completedCount,0);assert.equal(job.pendingCount,1);assert.deepEqual(job.result.pendingCuts,[draft]);
 await batch.decide('continue','cover-decision');
 await batch.update({status:'running',stage:'tracking',result:{cuts:[],errors:[],pendingCuts:[]}});
 job=await batch.get();assert.equal(job.pendingCount,1);assert.deepEqual(job.result.pendingCuts,[draft]);
 const folderId=renderBody().folderId;
 const feed=await (await publisherFolder(new Request(`https://os4.example.test/.netlify/functions/publisher-folder?folderId=${folderId}`,
  {headers:{Authorization:`Bearer ${publisherToken(callbackSecret,folderId)}`}}),context)).json();
 assert.equal(feed.completedCount,0);assert.equal(feed.readyCount,0);assert.equal(feed.pendingCount,1);assert.equal(feed.cuts.length,0);
 assert.equal(feed.pendingCuts,undefined,'Folder capability does not expose drafts for publishing');
 const final={...draft,files:{...draft.files,capa:{id:'finished-cover'}}};delete final.pendingReason;delete final.error;
 await batch.update({status:'running',stage:'cortes',ready_cut:final,completed_count:1,consecutive_failures:0,
  result:{cuts:[final],errors:[],pendingCuts:[],requestedCount:4,completedCount:1}});
 job=await batch.get();assert.equal(job.completedCount,1);assert.equal(job.pendingCount,0);assert.deepEqual(job.result.pendingCuts,[]);assert.equal(job.consecutiveFailures,0);
});


