const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    send: (ch, data) => ipcRenderer.send(ch, data),
    on: (ch, cb) => ipcRenderer.on(ch, (e, a) => cb(a)),
    invoke: (ch, data) => ipcRenderer.invoke(ch, data),
});