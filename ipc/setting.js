const { ipcMain } = require('electron');
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

    
}