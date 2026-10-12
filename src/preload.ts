import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('hostframe', {
  command: (command: string, params: unknown = {}) => ipcRenderer.invoke('command',command,params),
  desktop: (action: string, payload: unknown) => ipcRenderer.invoke('desktop',action,payload),
  bounds: (value: unknown) => ipcRenderer.send('bounds',value),
  frames: (listener: (frames: Record<string, string>) => void) => { ipcRenderer.on('frames', (_event: unknown, frames: Record<string, string>) => listener(frames)); },
  subscribe: (listener: (state: unknown) => void) => { const handler=(_event:unknown,state:unknown)=>listener(state);ipcRenderer.on('state',handler);return()=>ipcRenderer.removeListener('state',handler); }
});
