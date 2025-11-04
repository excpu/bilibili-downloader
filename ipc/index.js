// ./ipc/index.js
const registerInformationIpc = require('./information');
const registerDownloadIpc = require('./download');

module.exports = function registerIpc(mainWindow) {
    registerInformationIpc(mainWindow);
    registerDownloadIpc(mainWindow);
}
