const { ipcMain, app } = require('electron');
const path = require('path');
const got = require('got'); // 使用 got 进行稳定下载

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');
const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数

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

// 辅助函数：使用 got 流式下载文件并计算进度（支持断点续传）
async function downloadFileWithGot(url, destPath, headers, onProgress, maxRetries = 5) {
    const MAX_DOWNLOAD_DURATION_MS = 110 * 60 * 1000; // 1小时50分钟
    const deadline = Date.now() + MAX_DOWNLOAD_DURATION_MS;
    let retries = maxRetries;
    let totalLength = 0;

    while (retries >= 0) {
        try {
            if (Date.now() >= deadline) {
                throw new Error('下载链接已超过 1 小时 50 分钟有效期，停止重试并退出');
            }

            // 1. 检查本地是否已有下载过一半的文件，获取大小
            let downloadedLength = 0;
            if (fs.existsSync(destPath)) {
                downloadedLength = fs.statSync(destPath).size;
            }

            // 2. 构造支持断点续传的请求头
            const reqHeaders = { ...headers };
            if (downloadedLength > 0) {
                reqHeaders['Range'] = `bytes=${downloadedLength}-`;
            }

            // 3. 如果文件已经下载完整，直接返回成功
            if (totalLength > 0 && downloadedLength >= totalLength) {
                if (onProgress) onProgress(100, "0.00");
                return;
            }

            let lastDownloadedLength = downloadedLength;
            let lastTime = Date.now();

            await new Promise((resolve, reject) => {
                let writer = null;
                let settled = false;

                const finish = (error) => {
                    if (settled) return;
                    settled = true;
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                const remainingTime = Math.max(1, deadline - Date.now());

                const downloadStream = got.stream(url, {
                    method: 'GET',
                    headers: reqHeaders,
                    timeout: {
                        request: remainingTime
                    },
                    followRedirect: true,
                    maxRedirects: 5,
                    http2: true,
                    retry: {
                        limit: Math.min(2, maxRetries),
                        methods: ['GET'],
                        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
                        errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']
                    }
                });

                downloadStream.on('retry', (retryCount, error) => {
                    console.warn(`⚠️ 下载遇到网络波动，got 正在重试... (第 ${retryCount} 次) - 错误: ${error.message}`);
                });

                downloadStream.on('response', (response) => {
                    // 4. 解析服务器是否接受断点续传
                    if (response.statusCode === 200) {
                        // 服务器忽略了 Range，需要从头开始覆盖写入
                        downloadedLength = 0;
                        lastDownloadedLength = 0;
                        totalLength = parseInt(response.headers['content-length'], 10) || 0;
                    } else if (response.statusCode === 206) {
                        // 服务器接受了断点续传，解析总大小
                        const contentRange = response.headers['content-range'];
                        if (contentRange) {
                            totalLength = parseInt(contentRange.split('/')[1], 10);
                        } else {
                            totalLength = downloadedLength + (parseInt(response.headers['content-length'], 10) || 0);
                        }
                    }

                    if (totalLength > 0 && downloadedLength >= totalLength) {
                        if (onProgress) onProgress(100, "0.00");
                        downloadStream.destroy();
                        finish();
                        return;
                    }

                    const shouldAppend = response.statusCode === 206 && downloadedLength > 0;
                    writer = fs.createWriteStream(destPath, { flags: shouldAppend ? 'a' : 'w' });

                    writer.on('error', (err) => {
                        downloadStream.destroy();
                        finish(err);
                    });

                    writer.on('finish', () => {
                        if (totalLength && downloadedLength < totalLength) {
                            finish(new Error('网络流意外关闭，文件未下载完整'));
                        } else {
                            if (onProgress) onProgress(100, "0.00");
                            finish();
                        }
                    });

                    downloadStream.pipe(writer);
                });

                downloadStream.on('data', (chunk) => {
                    downloadedLength += chunk.length;

                    const now = Date.now();
                    const timeDiff = now - lastTime;

                    // 每 400ms 更新一次进度
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

                downloadStream.on('error', (err) => {
                    if (writer && !writer.destroyed) {
                        writer.destroy();
                    }

                    if (err.response && err.response.statusCode === 416) {
                        if (onProgress) onProgress(100, "0.00");
                        finish();
                        return;
                    }

                    finish(err);
                });
            });

            return;
        } catch (err) {
            // 416 通常表示本地文件已完整
            if (err.response && err.response.statusCode === 416) {
                if (onProgress) onProgress(100, "0.00");
                return;
            }

            if (Date.now() >= deadline) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }

            retries--;
            if (retries < 0) {
                throw new Error(`下载失败，已重试耗尽: ${err.message}`);
            }

            console.warn(`⚠️ 下载中断，正在尝试断点续传... (剩余重试次数: ${retries}) - 错误: ${err.message}`);

            // 超时退出，迎合下载链接有效期限制
            const waitTime = Math.min(2000, Math.max(0, deadline - Date.now()));
            if (waitTime <= 0) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
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