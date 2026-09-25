const {contextBridge, ipcRenderer} = require('electron');
for (const type of ['error', 'unhandledrejection']) window.addEventListener(type, () => {
  ipcRenderer.invoke('desktop-local', 'renderer-error', type).catch(() => {});
});
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  openSettings: () => ipcRenderer.invoke('desktop-local', 'open'),
  preferences: () => ipcRenderer.invoke('desktop-local', 'preferences'),
  subscribePreferences: listener => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('desktop:preferences', receive);
    return () => ipcRenderer.removeListener('desktop:preferences', receive);
  },
  invoke: (action, payload) => ipcRenderer.invoke('desktop:action', action, payload),
  subscribe: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('desktop:update', receive);
    return () => ipcRenderer.removeListener('desktop:update', receive);
  },
  microphone: Object.freeze({
    onCommand: listener => {
      const receive = (_event, command) => listener(command);
      ipcRenderer.on('desktop:microphone-command', receive);
      return () => ipcRenderer.removeListener('desktop:microphone-command', receive);
    },
    report: message => ipcRenderer.send('desktop:microphone-event', message),
  }),
}));
