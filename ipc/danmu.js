const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const Setting = require('../modules/config_setting');

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

const { constructXMLDanmaku } = require('../modules/danmu_protobuf'); // 引入 protobuf 弹幕构建函数

const setting = new Setting();
setting.load();

module.exports = function registerDanmuIpc(mainWindow) {
    // 旧版弹幕接口下载
    ipcMain.handle('downloadDanmu', async (event, payload) => {
        const { cid, title } = payload;
        const downloadDir = setting.getDownloadPath();

        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }

        // 旧版弹幕接口
        const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;

        try {
            await downloadFile(url, path.join(downloadDir, `${sanitizePath(title)}.xml`));
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });
    // 新版 protobuf 弹幕接口下载
    ipcMain.handle('downloadDanmuProtobuf', async (event, payload) => {
        const { cid, title, duration } = payload;
        const downloadDir = setting.getDownloadPath();

        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }

        try {
            const xmlContent = await constructXMLDanmaku(cid, duration);
            const outputPath = path.join(downloadDir, `${sanitizePath(title)}.xml`);
            fs.writeFileSync(outputPath, xmlContent, 'utf-8');
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });
};