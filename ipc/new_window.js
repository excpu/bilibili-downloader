const { ipcMain, app, BrowserWindow } = require('electron');

let playerWindow = null; // 持有引用，防止重复打开

module.exports = function registerNewWindowIpc(mainWindow) {
    ipcMain.handle('openPlayer', (event, payload) => {
        // electron 新窗口打开html
        if (playerWindow) {
            if (playerWindow.isMinimized()) playerWindow.restore();
            playerWindow.focus();
            return;
        }

        playerWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        playerWindow.loadFile('../web/player/index.html');

        playerWindow.on('closed', () => {
            playerWindow = null;
        });

    });
}