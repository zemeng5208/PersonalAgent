const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('localDesktop', Object.freeze({call: (name, payload) => ipcRenderer.invoke('desktop-local', name, payload)}));
