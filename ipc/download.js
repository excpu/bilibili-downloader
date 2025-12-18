const { ipcMain, app } = require('electron');
const path = require('path');
const EasyDl = require('easydl');

const Auth = require('../modules/auth');

const { encWbi, getWbiKeys } = require('../modules/wbi');

const auth = new Auth();

const fs = require('fs');
const util = require('util');
//ffmpeg 用于合并Dash 音视频
let ffmpeg = require('ffmpeg-static');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

// asar 修正
if (app.isPackaged && ffmpeg.includes('app.asar')) {
    ffmpeg = ffmpeg.replace('app.asar', 'app.asar.unpacked');
}

let currentUid = '';

module.exports = function registerDownloadIpc(mainWindow) {
    // 添加下载任务
    ipcMain.handle('downloadTarget', async (event, payload) => {
        let { uid, bvid, cid, title, audioIndex, videoIndex } = payload;
        currentUid = uid;
        title = sanitizePath(title);
        const videoStream = await getUpToDateUrl(bvid, cid, audioIndex, videoIndex);
        for (let i = 0; i < 2; i++) {
            if (i === 0) {
                const downloadPath = path.join(app.getPath('downloads'), `${title}_audio.m4s`);
                const download = new EasyDl(videoStream.audioUrl, downloadPath, {
                    reportInterval: 400,
                    connections: 1,
                    existBehavior: 'overwrite',
                    httpOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                            'Referer': 'https://www.bilibili.com/',
                        }
                    },
                });
                await download.on("progress", ({ details, total }) => {
                    // console.log("[Percent]", Math.round(total.percentage));
                    // console.log(`[Speed] ${(total.speed / 1024 / 1024).toFixed(2)} MB/S`);
                    notifyRendererDownloadProgress(Math.round(total.percentage), (total.speed / 1024 / 1024).toFixed(2), 'audio');
                }).wait();
            } else {
                const downloadPath = path.join(app.getPath('downloads'), `${title}_video.m4s`);
                const download = new EasyDl(videoStream.videoUrl, downloadPath, {
                    reportInterval: 400,
                    connections: 1,
                    existBehavior: 'overwrite',
                    chunkSize: 16 * 1024 * 1024,
                    httpOptions: {
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                            'Referer': 'https://www.bilibili.com/',
                            'Origin': 'https://www.bilibili.com',
                            'Accept': '*/*',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            'Connection': 'keep-alive',
                        },
                        timeout: 30000,                        // 单段超时
                        maxRedirects: 5                        // B站直链常有 302
                    },
                });
                await download.on("progress", ({ details, total }) => {
                    // console.log("[Percent]", Math.round(total.percentage));
                    // console.log(`[Speed] ${(total.speed / 1024 / 1024).toFixed(2)} MB/S`);
                    notifyRendererDownloadProgress(Math.round(total.percentage), (total.speed / 1024 / 1024).toFixed(2), 'video');
                }).wait();
            }
        }
        // 合并音视频
        const videoPath = path.join(app.getPath('downloads'), `${title}_video.m4s`);
        const audioPath = path.join(app.getPath('downloads'), `${title}_audio.m4s`);
        const outputPath = path.join(app.getPath('downloads'), `${title}.mp4`);
        let ffmpegCmd = `"${ffmpeg}" -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a copy "${outputPath}"`;
        try {
            const { stdout, stderr } = await execAsync(ffmpegCmd);
            console.log('✅ 转换完成');
            // console.log(stdout);
            // console.error(stderr);
            fs.unlinkSync(videoPath);
            fs.unlinkSync(audioPath);
        } catch (err) {
            console.error('❌ 出错：', err);
        }

        // 通知已经下载完成
        notifyRendererDownloadFinished();
    });

    function notifyRendererDownloadProgress(progress, speed, avId) {
        if (speed === NaN) {
            return;
        }
        const progressInfo = { progress, speed, currentUid, avId };
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', progressInfo);
        }
    }

    function notifyRendererDownloadFinished() {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', currentUid);
        }
    }

    async function getUpToDateUrl(bvid, cid, audioIndex, videoIndex) {
        try {
            const wbiKeys = await getWbiKeys(); // 获取最新的 wbiKeys
            const params = {
                bvid: bvid,
                cid: cid,
                fnval: 4048,
                fourk: 1,
                gaia_source: 'view-card'
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            const url = `https://api.bilibili.com/x/player/wbi/playurl?${wbiQuery}`;
            const data = auth.load();
            const credentialCookie = `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct}; bili_ticket=${data.ticket}` || '';
            const response = await fetch(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Accept': 'application/json',
                    "Connection": "keep-alive",
                    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
                    'Cache-Control': 'no-cache',
                    'Origin': 'https://www.bilibili.com',
                    'Cookie': credentialCookie // 登录验证
                }
            });
            if (!response.ok) {
                return { success: false, message: '网络请求失败' };
            }
            const json = await response.json();
            let audioUrl = "";
            if (parseInt(audioIndex) === 30251) {
                // flac 无损
                audioUrl = json.data.dash.flac.audio.baseUrl;
            } else if (parseInt(audioIndex) === 30250) {
                // 杜比全景声
                audioUrl = json.data.dash.dolby.audio[0].baseUrl;
            } else {
                for (let i of json.data.dash.audio) {
                    if (parseInt(i.id) === parseInt(audioIndex)) {
                        audioUrl = i.baseUrl;
                        break;
                    }
                }
            }
            if (json.code === 0) {
                return {
                    success: true,
                    videoUrl: json.data.dash.video[parseInt(videoIndex)].baseUrl,
                    audioUrl
                };
            } else {
                return { success: false, message: json.message || '获取视频流信息失败' };
            }
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

