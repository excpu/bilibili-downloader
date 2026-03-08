const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require("axios");

const Auth = require('../modules/auth');
const auth = new Auth();

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数

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

    async function downloadFile(url, outputPath) {
        const credentialCookie = auth.getConstructedCookie();
        let response; 

        try {
            response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Cookie': credentialCookie
                }
            });
        } catch (error) {
            console.error('❌ 网络请求弹幕失败：', error);
            throw error;
        }

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', (err) => {
                writer.close(); // 写入出错时安全关闭流
                reject(err);
            });
        });
    }
};