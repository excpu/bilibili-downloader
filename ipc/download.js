const { ipcMain, app } = require('electron');
const path = require('path');

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');
const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const { downloadFileWithGot } = require('../modules/stream_download');

const auth = new Auth();

const fs = require('fs');
const util = require('util');
// ffmpeg 用于合并Dash 音视频
let ffmpeg = require('ffmpeg-static');
const { execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);

// asar 修正
if (app.isPackaged && ffmpeg.includes('app.asar')) {
    ffmpeg = ffmpeg.replace('app.asar', 'app.asar.unpacked');
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

        // 新任务开始前清理上次异常退出残留的临时文件，避免一开始就命中 416
        for (const tempPath of [videoPath, audioPath]) {
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch (cleanupErr) {
                    console.warn(`⚠️ 清理残留临时文件失败: ${tempPath}`, cleanupErr.message);
                }
            }
        }

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
        };

        try {
            // 串行下载：等待音频下载完成后，再开始视频下载
            console.log(`⏳ [${title}] 开始下载音频...`);
            await downloadFileWithGot(
                videoStream.audioUrl,
                audioPath,
                downloadHeaders,
                (percent, speed) => notifyProgress(percent, speed, 'audio')
            );

            console.log(`⏳ [${title}] 音频下载完成，开始下载视频...`);
            await downloadFileWithGot(
                videoStream.videoUrl,
                videoPath,
                downloadHeaders,
                (percent, speed) => notifyProgress(percent, speed, 'video')
            );

            // 合并音视频
            console.log(`⏳ [${title}] 正在合并...`);
            // 1. 修复 macOS/Linux 下的执行权限问题
            if (process.platform === 'darwin' || process.platform === 'linux') {
                try {
                    fs.chmodSync(ffmpeg, 0o755);
                } catch (chmodErr) {
                    console.warn('⚠️ 尝试赋予 ffmpeg 执行权限失败，可能会影响合并:', chmodErr);
                }
            }

            // 2. 使用 execFile 代替 exec，将参数写成数组，彻底避免路径转义问题
            const ffmpegArgs = [
                '-y',
                '-i', videoPath,
                '-i', audioPath,
                '-c:v', 'copy',
                '-c:a', 'copy',
                outputPath
            ];


            // 合并音视频
            try {
                await execFileAsync(ffmpeg, ffmpegArgs);
                console.log(`✅ [${title}] 转换完成`);
            } catch (err) {
                console.error(`❌ [${title}] 合并出错`);
                console.error('err.message:', err.message);
                console.error('err.stderr:', err.stderr);
                console.error('err.stdout:', err.stdout);
                console.error('full err:', err);

                return {
                    success: false,
                    message: err.stderr || err.message || '音视频合并失败'
                };
            }

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
}