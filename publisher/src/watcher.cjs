const EventEmitter=require('node:events');
const ENDPOINT='https://os4cortes.netlify.app/.netlify/functions/publisher-folder';
const terminal=s=>['completed','error','cancelled'].includes(s);
class FolderWatcher extends EventEmitter {
  constructor({queue,executor,protect,unprotect,scan,readText,download,fetcher=fetch,now=Date.now,interval=120000,onLog=()=>{}}){
    super();Object.assign(this,{q:queue,executor,protect,unprotect,scan,readText,download,fetcher,now,interval,onLog});
    this.items=queue.get('folder_watchers',[]);this.busy=new Set();this.downloading=new Set();
  }
  save(){this.q.set('folder_watchers',this.items);this.emit('updated',this.status());}
  status(){return this.items.map(w=>({folderId:w.folderId,enabled:w.enabled,phase:w.phase,detail:w.detail,readyCount:w.readyCount||0,totalCuts:w.totalCuts||0,downloadedCount:(w.ready||[]).filter(c=>w.done?.[this.key(c)]).length,nextCheck:w.nextCheck,lastCheck:w.lastCheck,remoteStatus:w.remoteStatus}));}
  start(folderUrl){
    const folderId=String(folderUrl).match(/\/folders\/([\w-]+)/)?.[1]||String(folderUrl).trim();
    if(!/^[\w-]{20,200}$/.test(folderId))throw new Error('Link da pasta do Drive inválido.');
    let w=this.items.find(w=>w.folderId===folderId);
    if(!w){w={folderId,enabled:true,phase:'waiting',detail:'Aguardando geração dos cortes',done:{},failures:{},ready:[]};this.items.push(w);}
    else{w.enabled=true;w.phase='waiting';}
    w.nextCheck=0;this.save();this.ensureRunning();this.tick().catch(e=>this.onLog(e.message));return {ok:true,folderId};
  }
  stop(folderId){const w=this.items.find(w=>w.folderId===folderId);if(w){w.enabled=false;w.phase='stopped';w.detail='Acompanhamento interrompido pelo usuário';this.save();}}
  ensureRunning(){if(this.timer)return;this.timer=setInterval(()=>this.tick().catch(e=>this.onLog(e.message)),2000);this.timer.unref?.();this.tick().catch(e=>this.onLog(e.message));}
  shutdown(){clearInterval(this.timer);this.timer=null;}
  async tick(){
    for(const w of this.items.filter(w=>w.enabled)){
      if(!this.busy.has(w.folderId)&&(w.nextCheck||0)<=this.now()){
        this.busy.add(w.folderId);
        this.poll(w).catch(e=>{w.phase='waiting';w.detail=`Nova tentativa automática: ${e.message}`;this.onLog(`[Pasta] ${w.detail}`);})
          .finally(()=>{this.busy.delete(w.folderId);w.nextCheck=this.now()+this.interval;this.save();this.drain(w);});
      }
      this.drain(w);
    }
  }
  async poll(w){
    w.lastCheck=this.now();
    if(!w.capability){
      w.phase='connecting';w.detail='Localizando acompanhamento da pasta';this.save();
      const found=await this.scan(w.folderId,this.onLog);
      if(!found.monitorFileId){w.phase='waiting';w.detail='Aguardando início da geração. A pasta continua sendo acompanhada.';return;}
      const manifest=JSON.parse(await this.readText(found.monitorFileId));
      if(manifest.version!==1||manifest.folderId!==w.folderId||manifest.apiUrl!==ENDPOINT||!/^[a-f0-9]{64}$/.test(manifest.token||''))throw new Error('Arquivo de acompanhamento inválido.');
      w.capability=this.protect(manifest.token);this.save();
    }
    let token;try{token=this.unprotect(w.capability);}catch{delete w.capability;throw new Error('Reconectando autorização local da pasta.');}
    const response=await this.fetcher(`${ENDPOINT}?folderId=${encodeURIComponent(w.folderId)}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    if(response.status===401){delete w.capability;throw new Error('Reconectando acompanhamento da pasta.');}
    const feed=await response.json();if(!response.ok||!feed.ok)throw new Error(feed.error||'Servidor temporariamente indisponível.');
    if(feed.folderId!==w.folderId||!Array.isArray(feed.cuts))throw new Error('Resposta da pasta inválida.');
    w.requestId=feed.requestId;w.totalCuts=feed.totalCuts;w.readyCount=feed.readyCount;w.remoteStatus=feed.status;
    w.ready=feed.cuts.filter(c=>c.ready&&c.files?.post?.id&&(c.formato==='16:9'?c.files?.video?.id||c.files?.videoLegenda?.id:c.files?.videoLegenda?.id));
    w.phase=terminal(feed.status)?'finishing':'watching';
    w.detail=feed.error|| (feed.stale?'Processamento sem atualização recente; acompanhamento continua.':`${feed.readyCount}/${feed.totalCuts} cortes prontos. ${feed.detail||'Aguardando novos cortes.'}`);
    this.finishIfDone(w);this.save();
  }
  finishIfDone(w){
    if(!terminal(w.remoteStatus)||w.ready.some(c=>!w.done[this.key(c)]))return;
    const pending=this.q.list().filter(j=>j.payload.folderId===w.folderId&&j.state!=='completed'&&j.state!=='cancelled');
    if(pending.length){w.detail=`Geração ${w.remoteStatus==='completed'?'concluída':'interrompida'}; ${pending.length} publicação(ões) pendente(s).`;return;}
    if(w.remoteStatus==='completed'&&w.readyCount<w.totalCuts){w.detail='Geração terminou com arquivos pendentes. Aguardando confirmação do servidor.';return;}
    w.enabled=false;w.phase=w.remoteStatus==='completed'?'completed':'error';w.detail=w.remoteStatus==='completed'?'Todos os cortes publicados e confirmados.':w.detail;
  }
  key(c){return `${c.formato}:${c.formato==='16:9'?c.files.video?.id||c.files.videoLegenda?.id:c.files.videoLegenda?.id}`;}
  drain(w){
    if(!w.enabled)return;this.finishIfDone(w);if(!w.enabled){this.save();return;}
    for(const c of w.ready||[]){
      const key=this.key(c);if(this.downloading.size>=2)break;
      if(w.done[key]||this.downloading.has(key)||(w.failures[key]?.next||0)>this.now())continue;
      const videoFileId=key.split(':').slice(2).join(':'); // formato contains one colon
      const nets=c.formato==='16:9'?['youtube']:['tiktok','instagram'];
      const existing=this.q.list().filter(j=>j.payload.driveFileId===videoFileId&&j.payload.formato===c.formato&&['queued','publishing','completed','verify'].includes(j.state));
      if(nets.every(n=>existing.some(j=>j.payload.network===n&&j.payload.account===(this.q.get('accounts',{})[n]?.account||'@os4.cortes')))){
        w.done[key]=true;this.save();continue;
      }
      this.downloading.add(key);
      this.download({cutIndex:c.index,titulo:c.titulo,videoFileId,postFileId:c.files.post.id,capaFileId:c.files.capa?.id,formato:c.formato,requestId:w.requestId,
        onProgress:p=>this.onLog(`[Download] Corte ${c.index}: ${p.status}`)})
        .then(result=>{
          if(!w.enabled)return;
          this.executor.enqueueCorte({...result,cutIndex:c.index,requestId:w.requestId,folderId:w.folderId,driveFileId:videoFileId});
          w.done[key]=true;delete w.failures[key];this.onLog(`[Pasta] Corte ${c.index} pronto e enfileirado.`);
        }).catch(e=>{const n=(w.failures[key]?.count||0)+1;w.failures[key]={count:n,next:this.now()+Math.min(600000,30000*2**Math.min(n,4))};w.detail=`Corte ${c.index}: ${e.message}. Download será retomado.`;this.onLog(`[Pasta] ${w.detail}`);})
        .finally(()=>{this.downloading.delete(key);this.save();this.drain(w);});
    }
  }
}
module.exports={FolderWatcher,ENDPOINT};
