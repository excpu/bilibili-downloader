const { ipcMain, app } = require('electron');
const path = require('path');

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

module.exports = function registerDanmuIpc(mainWindow) {
    ipcMain.handle('downloadDanmu', async (event, payload) => {
        const { cid, title } = payload;
        // 旧版弹幕接口
        const url = `https://comment.bilibili.com/${cid}.xml`;

        try {
            await downloadFile(url, path.join(app.getPath('downloads'), `${sanitizePath(title)}.xml`));
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });
};