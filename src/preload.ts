import { contextBridge,ipcRenderer } from 'electron';
const allowed=new Set(['state','save-settings','set-widget-settings','connect','manual-login','test-mail','clear-secrets','choose-directory','mcp-config','open-link','tool']);
contextBridge.exposeInMainWorld('xipu',{
  invoke:(command:string,payload?:unknown)=>{if(!allowed.has(command))throw new Error('Unsupported command');return ipcRenderer.invoke('app-command',command,payload);},
  onChange:(callback:()=>void)=>{const handler=()=>callback();ipcRenderer.on('state-changed',handler);return()=>ipcRenderer.removeListener('state-changed',handler);},
});
