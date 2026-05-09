const { ipcMain, dialog, BrowserWindow } = require('electron');

module.exports = function registerMergeIpc() {
    // 先移除旧的监听，防止重复注册报错（或者只在 app 启动时调用一次）
    // ipcMain.removeHandler('open-dir-dialog');

    ipcMain.handle('open-dir-dialog', async (event) => {
        // event.sender 就是发送指令的 mergeWindow 的 webContents
        const senderWindow = BrowserWindow.fromWebContents(event.sender);

        const result = await dialog.showOpenDialog(senderWindow, {
            properties: ['openDirectory'],
            title: '请选择缓存目录'
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });
};