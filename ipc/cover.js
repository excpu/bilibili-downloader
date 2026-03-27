const { ipcMain, app } = require('electron');
const path = require('path');

const Auth = require('../modules/auth');
const auth = new Auth();

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

module.exports = function registerCoverIpc(mainWindow) {
    ipcMain.handle('downloadCover', async (event, payload) => {
        const { url, title } = payload;

        try {
            await downloadFile(url, path.join(app.getPath('downloads'), `${sanitizePath(title)}${path.extname(url)}`), false);
            mainWindow.webContents.send('downloadCoverProgress', { status: 'success', message: '封面下载完成' });
        } catch (error) {
            console.error('❌ 获取封面失败：', error);
            mainWindow.webContents.send('downloadCoverProgress', { status: 'error', message: '封面下载失败' });
        }
    });
};