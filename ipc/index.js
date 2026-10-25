// ./ipc/index.js
const { ipcMain, BrowserWindow } = require('electron');
const registerInformationIpc = require('./information');
const registerDownloadIpc = require('./download');
const registerDanmuIpc = require('./danmu');
const registerCoverIpc = require('./cover');
const registerNewWindowIpc = require('./new_window');
const registerSettingIpc = require('./setting');
const registerPreviewIpc = require('./preview');
const registerLibraryIpc = require('./bilibili_library');
const theme = require('../modules/theme');
// 为 merge 窗口注册 IPC
const registerMergeIpc = require('./merge/merge');

module.exports = function registerIpc(mainWindow) {
    registerInformationIpc(mainWindow);
    registerDownloadIpc(mainWindow);
    registerDanmuIpc(mainWindow);
    registerCoverIpc(mainWindow);
    registerNewWindowIpc(mainWindow);
    registerSettingIpc(mainWindow);
    registerPreviewIpc(mainWindow);
    registerLibraryIpc();

    // 监听模态框打开/关闭状态以动态同步原生控制按钮遮罩颜色
    // 跟随主题的窗口由 theme 模块统一决定符号色，其余窗口沿用传入的颜色
    ipcMain.handle('setTitleBarOverlay', (event, options) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        if (!win || win.isDestroyed()) return;
        if (theme.setModalState(win, !!options?.modal)) return;
        // 未跟随主题的窗口必须自带颜色，否则不做处理
        if (!options?.symbolColor || typeof win.setTitleBarOverlay !== 'function') return;
        try {
            win.setTitleBarOverlay(options);
        } catch (err) {
            console.error('setTitleBarOverlay 失败:', err);
        }
    });

    // merge 页面 IPC
    registerMergeIpc();
}
