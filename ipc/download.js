const { ipcMain, app } = require('electron');
const path = require('path');
const axios = require('axios'); // 替换 axios 进行稳定下载

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

// 辅助函数：使用 axios 流式下载文件并计算进度
async function downloadFileWithAxios(url, destPath, headers, onProgress, maxRetries = 5) {
    let retries = maxRetries;
    let totalLength = 0;

    while (retries >= 0) {
        try {
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

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: reqHeaders,
                timeout: 30000,
                maxRedirects: 5
            });

            // 3. 解析服务器支持情况
            if (response.status === 200) {
                // 状态码 200 表示服务器忽略了 Range，或者这是第一次下载。需要从头开始。
                downloadedLength = 0;
                totalLength = parseInt(response.headers['content-length'], 10) || 0;
            } else if (response.status === 206) {
                // 状态码 206 表示服务器接受了断点续传。解析总体积。
                const contentRange = response.headers['content-range']; // 格式如: "bytes 100-199/200"
                if (contentRange) {
                    totalLength = parseInt(contentRange.split('/')[1], 10);
                } else {
                    totalLength = downloadedLength + parseInt(response.headers['content-length'], 10);
                }
            }

            // 4. 如果文件已经下载完整，直接返回成功
            if (totalLength > 0 && downloadedLength >= totalLength) {
                if (onProgress) onProgress(100, "0.00");
                return;
            }

            let lastDownloadedLength = downloadedLength;
            let lastTime = Date.now();

            // 5. 如果有残留文件且支持续传，使用 'a' (追加) 模式；否则用 'w' (覆盖) 模式
            const writer = fs.createWriteStream(destPath, { flags: downloadedLength > 0 ? 'a' : 'w' });

            await new Promise((resolve, reject) => {
                response.data.on('data', (chunk) => {
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

                response.data.pipe(writer);

                writer.on('finish', () => {
                    // 检查是否因为流意外断开导致提前触发 finish
                    if (totalLength && downloadedLength < totalLength) {
                        reject(new Error("网络流意外关闭，文件未下载完整"));
                    } else {
                        if (onProgress) onProgress(100, "0.00");
                        resolve();
                    }
                });

                writer.on('error', reject);
                response.data.on('error', reject);
            });

            // 如果执行到这里，说明这段 Promise 跑完了且未抛出异常，直接跳出 while 循环
            return;

        } catch (err) {
            // 如果报错 416 (Range Not Satisfiable)，通常代表你请求的起始字节超出了文件总大小
            // 这意味着文件其实已经全部下完了，可以直接当做成功处理
            if (err.response && err.response.status === 416) {
                if (onProgress) onProgress(100, "0.00");
                return;
            }

            // 如果报错且还有重试次数，则等待 2 秒后继续下一个 while 循环
            retries--;
            if (retries < 0) {
                // 重试次数彻底耗尽，把错误抛给上层的主逻辑（触发 finally 清理文件）
                throw new Error(`下载失败，已重试耗尽: ${err.message}`);
            }

            console.warn(`⚠️ 下载遇到网络波动，2秒后尝试断点续传... (剩余重试次数: ${retries}) - 错误: ${err.message}`);

            // 等待 2 秒
            await new Promise(res => setTimeout(res, 2000));
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

            // try {
            //     await execFileAsync(ffmpeg, ffmpegArgs);
            //     console.log(`✅ [${title}] 转换完成`);
            // } catch (err) {
            //     console.error(`❌ [${title}] 合并出错：`, err);
            //     return { success: false, message: '音视频合并失败' };
            // }
            try {
                const { stdout, stderr } = await execFileAsync(ffmpeg, ffmpegArgs);
                // console.log(`✅ [${title}] ffmpeg stdout:`, stdout);
                // console.log(`✅ [${title}] ffmpeg stderr:`, stderr);
                console.log(`✅ [${title}] 转换完成`);
            } catch (err) {
                console.error(`❌ [${title}] 合并出错`);
                console.error('platform:', process.platform);
                console.error('arch:', process.arch);
                console.error('ffmpeg path:', ffmpeg);
                console.error('ffmpeg exists:', fs.existsSync(ffmpeg));
                console.error('ffmpeg args:', ffmpegArgs);
                console.error('err.code:', err.code);
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