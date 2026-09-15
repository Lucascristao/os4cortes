const message=document.querySelector('#message');
async function action(button,fn){button.disabled=true;message.textContent='Aguarde…';try{await fn();message.textContent='Concluído.';}catch(e){message.textContent=e.message;}finally{button.disabled=false;await refresh();}}
for(const [network,label]of Object.entries({tiktok:'TikTok',instagram:'Instagram',youtube:'YouTube'})){
 const row=document.createElement('div');row.className='account';const name=document.createElement('strong');name.textContent=label;
 const input=document.createElement('input');input.id=network;input.placeholder='@usuário ou nome do canal';input.setAttribute('aria-label',`Conta ${label}`);
 const login=document.createElement('button');login.textContent='Conectar';login.onclick=()=>action(login,()=>window.os4.login(network));
 const save=document.createElement('button');save.textContent='Salvar identificação';save.className='secondary';save.onclick=()=>action(save,()=>window.os4.saveAccount(network,input.value));
 const close=document.createElement('button');close.textContent='Fechar navegador';close.className='secondary';close.onclick=()=>action(close,()=>window.os4.closeLogin(network));
 const status=document.createElement('div');status.className='status';status.id=`status-${network}`;
 row.append(name,input,login,save,close,status);document.querySelector('#accounts').append(row);
}
async function refresh(){try{const s=await window.os4.state();document.querySelector('#phase').textContent=s.phase;document.querySelector('#version').textContent=`Versão ${s.version} · ${s.dataDir}`;document.querySelector('#startup').textContent=s.autoStart?'Inicialização automática ativada no login do Windows. Fechar a janela mantém o aplicativo na bandeja.':'Inicialização automática será ativada após a instalação.';for(const n of ['tiktok','instagram','youtube']){const input=document.getElementById(n);if(document.activeElement!==input)input.value=s.accounts[n]?.account||'';document.getElementById(`status-${n}`).textContent=`${s.accounts[n]?.status||'Conta ainda não informada'}${s.open.includes(n)?' · navegador aberto':''}`;}}catch(e){message.textContent=e.message;}}
document.querySelector('#site').onclick=()=>window.os4.openSite();refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);
