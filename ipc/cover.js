const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const Setting = require('../modules/config_setting');

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

const setting = new Setting();
setting.load();

module.exports = function registerCoverIpc(mainWindow) {
    ipcMain.handle('downloadCover', async (event, payload) => {
        const { url, title } = payload;
        const downloadDir = setting.getDownloadPath();

        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }

        try {
            await downloadFile(url, path.join(downloadDir, `${sanitizePath(title)}${path.extname(url)}`), false);
            mainWindow.webContents.send('downloadCoverProgress', { status: 'success', message: '封面下载完成' });
        } catch (error) {
            console.error('❌ 获取封面失败：', error);
            mainWindow.webContents.send('downloadCoverProgress', { status: 'error', message: '封面下载失败' });
        }
    });
};