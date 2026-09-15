// ./ipc/index.js
const { ipcMain, BrowserWindow } = require('electron');
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

    // 监听模态框打开/关闭状态以动态同步原生控制按钮遮罩颜色
    ipcMain.handle('setTitleBarOverlay', (event, options) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
            try {
                win.setTitleBarOverlay(options);
            } catch (err) {
                console.error('setTitleBarOverlay 失败:', err);
            }
        }
    });

    // merge 页面 IPC
    registerMergeIpc();
}
