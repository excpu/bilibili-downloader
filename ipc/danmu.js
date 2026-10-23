const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const Setting = require('../modules/config_setting');

const downloadFile = require('../modules/download_without_progress'); // 引入下载函数

const { constructXMLDanmaku } = require('../modules/danmu_protobuf'); // 引入 protobuf 弹幕构建函数
const { convertXmlToAss } = require('../modules/xml2ass'); // XML 弹幕转 ASS

const setting = new Setting();
setting.load();

function ensureDownloadDir(downloadDir) {
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
}

// 按设置把 xml 弹幕转换为同名 ass 文件，并按需保留/删除原始 xml
// enabled 由调用方根据下载来源（任务下载 / 直接下载）对应的开关决定
function applyDanmakuAssConversion(xmlPath, enabled) {
    if (!enabled) {
        return;
    }

    const { keepXml, assOptions } = setting.getDanmakuSettings();
    const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
    const options = { ...assOptions };
    // 配置中以字符串保存正则，转换前还原为 RegExp
    options.blockRegex = options.blockRegex ? new RegExp(options.blockRegex, 'i') : null;

    const { assContent } = convertXmlToAss(xmlContent, options);
    const assPath = xmlPath.replace(/\.xml$/i, '.ass');
    fs.writeFileSync(assPath, assContent, 'utf-8');

    if (!keepXml) {
        fs.unlinkSync(xmlPath);
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
        const { cid, title, duration, standalone } = payload;
        const downloadDir = setting.resolveDownloadDir(payload.folderNames);
        const danmuDownloadMethod = setting.getDanmuDownloadMethod();
        const danmakuSettings = setting.getDanmakuSettings();
        // 直接下载弹幕走独立开关 convertStandalone，任务下载走 convertToAss
        const convertEnabled = standalone
            ? danmakuSettings.convertStandalone
            : danmakuSettings.convertToAss;

        try {
            ensureDownloadDir(downloadDir);

            const xmlPath = path.join(downloadDir, `${sanitizePath(title)}.xml`);

            if (danmuDownloadMethod === 'protobuf') {
                mainWindow.webContents.send('downloadDanmuProgress', {
                    status: 'info',
                    message: '开始获取弹幕，请稍候...'
                });
                await downloadProtobufDanmu(cid, title, duration, downloadDir);
            } else {
                await downloadTraditionalDanmu(cid, title, downloadDir);
            }

            applyDanmakuAssConversion(xmlPath, convertEnabled);

            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });

    ipcMain.handle('downloadDanmuProtobuf', async (event, payload) => {
        const { cid, title, duration } = payload;
        const downloadDir = setting.resolveDownloadDir(payload.folderNames);
        const convertEnabled = setting.getDanmakuSettings().convertToAss;

        try {
            ensureDownloadDir(downloadDir);
            await downloadProtobufDanmu(cid, title, duration, downloadDir);
            applyDanmakuAssConversion(path.join(downloadDir, `${sanitizePath(title)}.xml`), convertEnabled);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'success', message: '弹幕下载完成' });
        } catch (error) {
            console.error('❌ 获取弹幕失败：', error);
            mainWindow.webContents.send('downloadDanmuProgress', { status: 'error', message: '弹幕下载失败' });
        }
    });
};