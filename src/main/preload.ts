// Ponte segura entre a interface e o processo principal.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const on = (channel: string) => (cb: (...args: any[]) => void) => {
  const fn = (_e: IpcRendererEvent, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
    pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  },
  pty: {
    start: (cols: number, rows: number) => ipcRenderer.send('pty:start', cols, rows),
    restart: (cols: number, rows: number) => ipcRenderer.send('pty:restart', cols, rows),
    input: (data: string) => ipcRenderer.send('pty:input', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', cols, rows),
    onData: on('pty:data'),
    onExit: on('pty:exit'),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    spawn: (name: string, task: string) => ipcRenderer.invoke('agents:spawn', name, task),
    stop: (id: string) => ipcRenderer.invoke('agents:stop', id),
    continue: (id: string, msg: string) => ipcRenderer.invoke('agents:continue', id, msg),
    dismiss: (id: string) => ipcRenderer.invoke('agents:dismiss', id),
    openFolder: (path: string) => ipcRenderer.invoke('agents:open-folder', path),
    onEvent: on('agents:event'),
  },
};

contextBridge.exposeInMainWorld('zagent', api);
export type ZagentApi = typeof api;
