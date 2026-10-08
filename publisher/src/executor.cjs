const fs = require('node:fs');
const crypto = require('node:crypto');
const { videoDuration } = require('./media-probe.cjs');
const { sanitizeDiagnostic } = require('./diagnostics.cjs');
const EventEmitter = require('node:events');
const { buildYouTubeTitle } = require('./titles.cjs');
const { PublicationAttempt } = require('./attempt.cjs');

class QueueExecutor extends EventEmitter {
  constructor(q, options = {}) {
    super(); this.q=q; this.options=options; this.now=options.now||Date.now;
    this.isPaused=Boolean(q.get('queue_paused',false)); this.isRunning=false;
    this.activeJobs=new Map(); this.phases={}; this.nextAvailable=q.get('network_next',{}); this.blocked=new Set();this.closing=new Map();
    for(const job of q.list().filter(j=>j.state==='verify')) {
      if(q.confirmation(job.id)?.confirmed) q.status(job.id,'completed','Confirmação recuperada após reinício.');
    }
  }
  enqueueCorte(p) {
    const formato=p.formato==='16:9'||/_16x9/i.test(p.videoPath)?'16:9':'9:16';
    const nets=formato==='16:9'?['youtube']:['tiktok','instagram'];
    const fileId=p.driveFileId||`${p.requestId||'local'}:${p.videoPath}`;
    const jobs=this.q.list(),ids=[];
    for(const network of nets) {
      const account=this.q.get('accounts',{})[network]?.account||'@os4.cortes';
      if(jobs.some(j=>j.payload.network===network && j.payload.account===account &&
        (j.payload.driveFileId===fileId || (j.payload.folderId && j.payload.folderId===p.folderId &&
         j.payload.cutIndex===p.cutIndex && (j.payload.formato||'9:16')===formato)))) continue;
      const id=crypto.createHash('sha256').update(JSON.stringify([fileId,formato,network,account])).digest('hex');
      if(this.q.add({...p,id,network,account,formato,driveFileId:p.driveFileId||null,videoFileId:`${fileId}:${formato}`,
        titulo:p.titulo||`Corte ${p.cutIndex}`,enqueuedAt:this.now()})) ids.push(id);
    }
    this.update();this.ensureWorkerRunning();return ids;
  }
  update(){this.emit('queue-updated',this.getStatus());}
  ensureWorkerRunning(){
    if(this.isRunning)return;this.isRunning=true;
    this.timer=setInterval(()=>this.tick().catch(e=>this.emit('worker-error',e)),1000);
    this.timer.unref?.();this.tick().catch(e=>this.emit('worker-error',e));
  }
  async tick(){
    if(this.isPaused||!this.isRunning)return;
    for(const [net,attempt] of this.closing){if(attempt.isClosed()){this.closing.delete(net);this.blocked.delete(net);}}
    for(const job of this.q.list().filter(j=>j.state==='queued')) {
      const net=job.payload.network;
      if(this.activeJobs.size>=2)break;
      if(this.activeJobs.has(net)||this.blocked.has(net)||!this.q.eligibility(net,this.now()).eligible)continue;
      if((this.nextAvailable[net]||0)>this.now())continue;
      // Register before awaiting: overlapping ticks cannot start a duplicate.
      this.activeJobs.set(net,job);
      job.promise=this.processJob(job).catch(e=>this.emit('worker-error',e)).finally(()=>{
        this.activeJobs.delete(net);delete this.phases[net];this.update();
      });
    }
    this.update();
  }
  async validateVideo(file){
    if(this.options.validateVideo)return this.options.validateVideo(file);
    if(!file||!fs.existsSync(file))throw new Error('Arquivo de vídeo ausente. Baixe novamente o corte.');
    if(!(await videoDuration(file)>5))throw new Error('Vídeo incompleto ou duração inválida.');
  }
  async processJob(job){
    const p=job.payload,net=p.network,started=this.now();let begun=false,attempt;
    try{
      await this.validateVideo(p.videoPath);
      const text=p.postPath&&fs.existsSync(p.postPath)?fs.readFileSync(p.postPath,'utf8').trim():(p.postText||'').trim();
      if(!text)throw new Error('Texto da postagem ausente. O corte não será publicado sem legenda.');
      this.q.begin(job.id,started);begun=true;
      this.nextAvailable[net]=this.q.eligibility(net,started).next;this.q.set('network_next',this.nextAvailable);
      this.emit('job-started',{job,status:this.getStatus()});
      attempt=new PublicationAttempt({
        stage:detail=>{this.phases[net]=detail;this.q.stage(job.id,'stage',detail,this.now());this.update();},
        intent:()=>this.q.stage(job.id,'publish_intent','Clique final autorizado e registrado.',this.now()),
        confirmed:result=>this.q.stage(job.id,'publication_confirmed',result,this.now())
      });job.attempt=attempt;
      const publishers=this.options.publishers||{
        youtube:args=>require('./adapters/youtube.cjs').publishYouTubeVideo(args),
        tiktok:args=>require('./adapters/tiktok.cjs').publishTikTok(args),
        instagram:args=>require('./adapters/instagram.cjs').publishInstagramReels(args)
      };
      const firstLine=text.split('\n').find(l=>l.trim()&&!l.startsWith('#'))||p.titulo;
      const task=Promise.resolve().then(()=>publishers[net]({videoPath:p.videoPath,caption:text,title:buildYouTubeTitle(firstLine,text),description:text,thumbnailPath:p.capaPath,attempt}));
      let timer;
      const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Tempo de envio excedido. Navegador encerrado para liberar a fila.')),this.options.timeoutMs||600000);});
      let result;try{result=await Promise.race([task,expiry]);}finally{clearTimeout(timer);}
      if(!result?.ok||result.confirmed!==true)throw new Error('A rede não confirmou a publicação.');
      attempt.confirm(result);
      this.q.status(job.id,'completed',`Publicação confirmada em ${Math.round((this.now()-started)/1000)}s.`,this.now());
      this.emit('job-completed',{job,result,status:this.getStatus()});this.scheduleCleanup(p.videoPath);
    }catch(e){
      e.message=sanitizeDiagnostic(e.message);
      if(attempt&&!(await attempt.abort())){this.blocked.add(net);this.closing.set(net,attempt);}
      if(this.q.confirmation(job.id)?.confirmed){
        this.q.status(job.id,'completed','Publicação confirmada; encerramento do navegador recuperado.',this.now());this.scheduleCleanup(p.videoPath);
      }else if(attempt?.submitted){
        this.q.status(job.id,'verify',`Envio iniciado, confirmação pendente. Confira na rede antes de reenviar. ${e.message}`,this.now());
      }else{
        const count=this.q.db.prepare('SELECT count(*) n FROM attempts WHERE job=?').get(job.id).n;
        const retry=begun&&count<3;
        this.q.status(job.id,retry?'queued':'failed',`${e.message}${retry?' Nova tentativa após o intervalo da rede.':''}`,this.now());
      }
      this.emit('job-failed',{job,error:e.message,status:this.getStatus()});
    }finally{
      if(begun){this.nextAvailable[net]=Math.max(this.nextAvailable[net]||0,this.now()+30000);this.q.set('network_next',this.nextAvailable);}
    }
  }
  scheduleCleanup(file){
    if(!file||this.options.cleanup===false)return;
    const current=this.q.list().filter(j=>j.payload.videoPath===file);
    if(!current.length||!current.every(j=>j.state==='completed'))return;
    const timer=setTimeout(()=>{
      const related=this.q.list().filter(j=>j.payload.videoPath===file);
      if(!related.length||!related.every(j=>j.state==='completed'))return;
      const candidates=new Set(related.flatMap(j=>[j.payload.videoPath,j.payload.postPath,j.payload.capaPath]).filter(Boolean));
      for(const candidate of candidates){
        if(this.q.list().some(j=>j.state!=='completed'&&[j.payload.videoPath,j.payload.postPath,j.payload.capaPath].includes(candidate)))continue;
        try{fs.unlinkSync(candidate);}catch(_){}
      }
    },120000);timer.unref?.();
  }
  pause(){this.isPaused=true;this.q.set('queue_paused',true);this.update();return true;}
  resume(){this.isPaused=false;this.q.set('queue_paused',false);this.ensureWorkerRunning();this.update();return true;}
  retryJob(id){this.q.retry(id);this.update();this.ensureWorkerRunning();return true;}
  retryAllFailed(){const count=this.q.retryAllFailed();this.update();this.ensureWorkerRunning();return count;}
  verifyJob(id,published){
    const job=this.q.list().find(j=>j.id===id);if(job?.state!=='verify')throw new Error('Corte não está aguardando verificação.');
    if(published){this.q.markVerified(id);this.scheduleCleanup(job.payload.videoPath);}
    else{this.q.status(id,'failed','Usuário confirmou que não houve publicação.');this.q.retry(id);}
    this.update();this.ensureWorkerRunning();
  }
  deleteJob(id){
    if([...this.activeJobs.values()].some(j=>j.id===id))throw new Error('Aguarde o término deste envio para descartar.');
    this.q.delete(id);this.update();return true;
  }
  getStatus(){
    const list=this.q.list(),now=this.now(),today=this.q.completedTodayJobIds(now);
    const activeJobs=[...this.activeJobs.values()].map(j=>({id:j.id,network:j.payload.network,cutIndex:j.payload.cutIndex,titulo:j.payload.titulo,phase:this.phases[j.payload.network]||'Preparando envio'}));
    const nextAvailable=Object.fromEntries(['youtube','tiktok','instagram'].map(n=>[n,Math.max(this.nextAvailable[n]||0,this.q.eligibility(n,now).next)]));
    return{isPaused:this.isPaused,activeJobs,activeJob:activeJobs[0]||null,blockedNetworks:[...this.blocked],nextAvailable,
      limits:Object.fromEntries(['youtube','tiktok','instagram'].map(n=>[n,this.q.eligibility(n,now).count])),
      cooldowns:Object.fromEntries(Object.entries(nextAvailable).map(([n,t])=>[n,Math.max(0,Math.ceil((t-now)/1000))])),
      counts:{total:list.length,completedToday:today.size,...Object.fromEntries(['queued','publishing','completed','failed','verify'].map(s=>[s,list.filter(j=>j.state===s).length]))},
      jobs:list.map(j=>({id:j.id,state:j.state,network:j.payload.network,cutIndex:j.payload.cutIndex,titulo:j.payload.titulo,evidence:j.state==='publishing'?this.phases[j.payload.network]||j.evidence:j.evidence,created:j.created,completedToday:today.has(j.id)}))};
  }
  stop(){this.isRunning=false;clearInterval(this.timer);for(const job of this.activeJobs.values())job.attempt?.abort().catch(()=>{});}
}
module.exports={QueueExecutor};
