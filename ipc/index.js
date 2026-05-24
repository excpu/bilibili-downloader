// ./ipc/index.js
const registerInformationIpc = require('./information');
const registerDownloadIpc = require('./download');
const registerDanmuIpc = require('./danmu');
const registerCoverIpc = require('./cover');
const registerNewWindowIpc = require('./new_window');
const registerSettingIpc = require('./setting');
// 为 merge 窗口注册 IPC
const registerMergeIpc = require('./merge/merge');

module.exports = function registerIpc(mainWindow) {
    registerInformationIpc(mainWindow);
    registerDownloadIpc(mainWindow);
    registerDanmuIpc(mainWindow);
    registerCoverIpc(mainWindow);
    registerNewWindowIpc(mainWindow);
    registerSettingIpc(mainWindow);

    // merge 页面 IPC
    registerMergeIpc();
}
