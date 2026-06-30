const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    send: (ch, ...args) => ipcRenderer.send(ch, ...args),
    on: (ch, cb) => ipcRenderer.on(ch, (e, ...args) => cb(...args)),
    invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
});