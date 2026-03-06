const { ipcMain, app } = require('electron');
const path = require('path');
const axios = require('axios'); // 替换 axios 进行稳定下载

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');

const auth = new Auth();

const fs = require('fs');
const util = require('util');
// ffmpeg 用于合并Dash 音视频
let ffmpeg = require('ffmpeg-static');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

// asar 修正
if (app.isPackaged && ffmpeg.includes('app.asar')) {
    ffmpeg = ffmpeg.replace('app.asar', 'app.asar.unpacked');
}

// 辅助函数：使用 axios 流式下载文件并计算进度
async function downloadFileWithAxios(url, destPath, headers, onProgress) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: headers,
        timeout: 30000,
        maxRedirects: 5
    });

    const totalLength = parseInt(response.headers['content-length'], 10);
    let downloadedLength = 0;

    let lastDownloadedLength = 0;
    let lastTime = Date.now();

    const writer = fs.createWriteStream(destPath);

    return new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
            downloadedLength += chunk.length;

            const now = Date.now();
            const timeDiff = now - lastTime;

            // 每 400ms 汇报一次进度
            if (timeDiff >= 400) {
                const percentage = totalLength ? Math.round((downloadedLength / totalLength) * 100) : 0;
                const bytesDiff = downloadedLength - lastDownloadedLength;
                const speed = (bytesDiff / (1024 * 1024)) / (timeDiff / 1000);

                if (onProgress) {
                    onProgress(percentage, speed.toFixed(2));
                }

                lastTime = now;
                lastDownloadedLength = downloadedLength;
            }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
            if (onProgress) onProgress(100, "0.00");
            resolve();
        });

        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

module.exports = function registerDownloadIpc(mainWindow) {
    // 添加下载任务 (新增支持多视频并发)
    ipcMain.handle('downloadTarget', async (event, payload) => {
        let { uid, bvid, cid, title, audioIndex, videoIndex } = payload;
        title = sanitizePath(title);

        const videoStream = await getUpToDateUrl(bvid, cid, audioIndex, videoIndex);
        if (!videoStream.success) {
            console.error(`❌ [${title}] 获取视频流失败: ${videoStream.message}`);
            return { success: false, message: videoStream.message };
        }

        const videoPath = path.join(app.getPath('downloads'), `${title}_video.m4s`);
        const audioPath = path.join(app.getPath('downloads'), `${title}_audio.m4s`);
        const outputPath = path.join(app.getPath('downloads'), `${title}.mp4`);

        // 局部通知函数，绑定当前任务的 uid
        const notifyProgress = (progress, speed, avId) => {
            if (speed === 'NaN' || isNaN(Number(speed))) return;
            const progressInfo = { progress, speed, currentUid: uid, avId };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', progressInfo);
            }
        };

        const downloadHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
            'Referer': 'https://www.bilibili.com/',
            'Origin': 'https://www.bilibili.com',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive'
        };

        try {
            // 串行下载：等待音频下载完成后，再开始视频下载
            console.log(`⏳ [${title}] 开始下载音频...`);
            await downloadFileWithAxios(
                videoStream.audioUrl,
                audioPath,
                downloadHeaders,
                (percent, speed) => notifyProgress(percent, speed, 'audio')
            );

            console.log(`⏳ [${title}] 音频下载完成，开始下载视频...`);
            await downloadFileWithAxios(
                videoStream.videoUrl,
                videoPath,
                downloadHeaders,
                (percent, speed) => notifyProgress(percent, speed, 'video')
            );

            // 合并音视频
            console.log(`⏳ [${title}] 正在合并...`);
            let ffmpegCmd = `"${ffmpeg}" -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a copy "${outputPath}"`;
            await execAsync(ffmpegCmd);
            console.log(`✅ [${title}] 转换完成`);

        } catch (err) {
            console.error(`❌ [${title}] 出错：`, err);
            return { success: false, message: '下载或合并出错' };
        } finally {
            // 清理临时 m4s 文件
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }

        // 通知该视频已经下载完成
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', uid);
        }

        return { success: true };
    });

    async function getUpToDateUrl(bvid, cid, audioIndex, videoIndex) {
        try {
            const wbiKeys = await getWbiKeys();
            const params = {
                bvid: bvid,
                cid: cid,
                fnval: 4048,
                fourk: 1,
                gaia_source: 'view-card'
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            const url = `https://api.bilibili.com/x/player/wbi/playurl?${wbiQuery}`;
            const credentialCookie = auth.getConstructedCookie();

            const response = await fetch(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Accept': 'application/json',
                    "Connection": "keep-alive",
                    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
                    'Cache-Control': 'no-cache',
                    'Origin': 'https://www.bilibili.com',
                    'Cookie': credentialCookie
                }
            });

            if (!response.ok) {
                return { success: false, message: '网络请求失败' };
            }

            const json = await response.json();

            if (json.code !== 0) {
                return { success: false, message: json.message || '获取视频流信息失败' };
            }

            let audioUrl = "";
            if (parseInt(audioIndex) === 30251) {
                // flac 无损音频
                audioUrl = json.data.dash.flac.audio.baseUrl;
            } else if (parseInt(audioIndex) === 30250) {
                // dolby 杜比全景声
                audioUrl = json.data.dash.dolby.audio[0].baseUrl;
            } else {
                const audioObj = json.data.dash.audio.find(i => parseInt(i.id) === parseInt(audioIndex));
                audioUrl = audioObj ? audioObj.baseUrl : json.data.dash.audio[0].baseUrl;
            }

            return {
                success: true,
                videoUrl: json.data.dash.video[parseInt(videoIndex)].baseUrl,
                audioUrl
            };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    }

    function sanitizePath(input, replacement = '_') {
        // Windows 禁止: <>:"/\|?* 及控制字符 \x00-\x1F
        // POSIX 禁止: /
        // macOS HFS+ 禁止: :
        const illegalRegex = /[<>:"/\\|?*\x00-\x1F]/g;

        // 先替换所有非法字符
        let output = input.replace(illegalRegex, replacement);

        // macOS HFS+ 特殊：禁止 ":" 
        output = output.replace(/:/g, replacement);

        // 移除多余重复替代符号
        output = output.replace(new RegExp(`${replacement}+`, 'g'), replacement);

        // 去掉开头或结尾的替换符号
        output = output.replace(new RegExp(`^${replacement}+|${replacement}+$`, 'g'), '');

        return output;
    }
}