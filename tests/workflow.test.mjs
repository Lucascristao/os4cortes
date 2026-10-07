import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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


