const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const Setting = require('../modules/config_setting');

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

const { constructXMLDanmaku } = require('../modules/danmu_protobuf'); // 引入 protobuf 弹幕构建函数

const setting = new Setting();
setting.load();

function ensureDownloadDir(downloadDir) {
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
}
// 传统弹幕下载接口
async function downloadTraditionalDanmu(cid, title, downloadDir) {
    const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
    await downloadFile(url, path.join(downloadDir, `${sanitizePath(title)}.xml`));
}

// Protobuf 弹幕下载接口
async function downloadProtobufDanmu(cid, title, duration, downloadDir) {
    if (!duration) {
        throw new Error('protobuf 弹幕下载需要视频时长');
    }

    const xmlContent = await constructXMLDanmaku(cid, duration);
    const outputPath = path.join(downloadDir, `${sanitizePath(title)}.xml`);
    fs.writeFileSync(outputPath, xmlContent, 'utf-8');
}

module.exports = function registerDanmuIpc(mainWindow) {
    ipcMain.handle('downloadDanmu', async (event, payload) => {
        const { cid, title, duration } = payload;
        const downloadDir = setting.getDownloadPath();
        const danmuDownloadMethod = setting.getDanmuDownloadMethod();

        try {
            ensureDownloadDir(downloadDir);

            if (danmuDownloadMethod === 'protobuf') {
                mainWindow.webContents.send('downloadDanmuProgress', {
                    status: 'info',
                    message: '开始获取弹幕，请稍候...'
                });
                await downloadProtobufDanmu(cid, title, duration, downloadDir);
            } else {
                await downloadTraditionalDanmu(cid, title, downloadDir);
            }

            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });

    ipcMain.handle('downloadDanmuProtobuf', async (event, payload) => {
        const { cid, title, duration } = payload;
        const downloadDir = setting.getDownloadPath();

        try {
            ensureDownloadDir(downloadDir);
            await downloadProtobufDanmu(cid, title, duration, downloadDir);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });
};