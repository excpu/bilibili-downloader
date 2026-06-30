const { ipcMain, dialog, BrowserWindow } = require('electron');
const Setting = require('../modules/config_setting');

const setting = new Setting();
setting.load(); // 加载设置数据

module.exports = function registerSettingIpc(mainWindow) {
    ipcMain.handle('getDownloadEngine', () => {
        return setting.getDownloadEngine();
    });

    ipcMain.handle('setDownloadEngine', (event, engine) => {
        setting.updateDownloadEngine(engine);
    });

    ipcMain.handle('getDownloadPath', () => {
        return setting.getDownloadPath();
    });

    ipcMain.handle('setDownloadPath', (event, downloadPath) => {
        setting.updateDownloadPath(downloadPath);
        return setting.getDownloadPath();
    });

    ipcMain.handle('selectDownloadPath', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showOpenDialog(senderWindow, {
            properties: ['openDirectory'],
            title: '请选择下载目录',
            defaultPath: setting.getDownloadPath(),
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        const selectedPath = result.filePaths[0];
        setting.updateDownloadPath(selectedPath);
        return selectedPath;
    });

    
}