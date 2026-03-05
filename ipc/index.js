// ./ipc/index.js
const registerInformationIpc = require('./information');
const registerDownloadIpc = require('./download');
const registerDanmuIpc = require('./danmu');

module.exports = function registerIpc(mainWindow) {
    registerInformationIpc(mainWindow);
    registerDownloadIpc(mainWindow);
    registerDanmuIpc(mainWindow);
}
