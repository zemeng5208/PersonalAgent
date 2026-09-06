const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  invoke: (action, payload) => ipcRenderer.invoke('desktop:action', action, payload),
  subscribe: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('desktop:update', receive);
    return () => ipcRenderer.removeListener('desktop:update', receive);
  }
}));
