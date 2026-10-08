class PublicationAttempt {
  constructor(callbacks={}){this.callbacks=callbacks;this.controller=new AbortController();this.signal=this.controller.signal;this.contexts=new Set();this.submitted=false;this.receipt=null;}
  check(){this.signal.throwIfAborted();}
  async attach(context){this.contexts.add(context);context.on?.('close',()=>this.contexts.delete(context));if(this.signal.aborted){await context.close().catch(()=>{});this.check();}}
  stage(detail){this.check();this.callbacks.stage?.(detail);}
  beforePublish(){this.check();if(!this.submitted){this.callbacks.intent?.();this.submitted=true;}}
  confirm(result){if(!result?.confirmed||this.receipt)return;this.receipt=result;this.callbacks.confirmed?.(result);}
  isClosed(){return this.contexts.size===0;}
  async abort(){
    this.controller.abort(new Error('Tentativa encerrada.'));let timer;
    const closing=Promise.allSettled([...this.contexts].map(ctx=>ctx.close()));
    try{const results=await Promise.race([closing,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),30000);})]);return this.isClosed()||!!results&&results.every(r=>r.status==='fulfilled');}
    finally{clearTimeout(timer);}
  }
}
module.exports={PublicationAttempt};
