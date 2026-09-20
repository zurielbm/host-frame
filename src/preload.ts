import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('hostframe', {
  command: (command: string, params: unknown = {}) => ipcRenderer.invoke('command',command,params),
  desktop: (action: string, payload: unknown) => ipcRenderer.invoke('desktop',action,payload),
  bounds: (value: unknown) => ipcRenderer.send('bounds',value),
  subscribe: (listener: (state: unknown) => void) => { const handler=(_event:unknown,state:unknown)=>listener(state);ipcRenderer.on('state',handler);return()=>ipcRenderer.removeListener('state',handler); }
});
