const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('os4',{state:()=>ipcRenderer.invoke('state'),login:n=>ipcRenderer.invoke('login',n),saveAccount:(network,account)=>ipcRenderer.invoke('save-account',{network,account}),closeLogin:n=>ipcRenderer.invoke('close-login',n),openSite:()=>ipcRenderer.invoke('open-site')});
