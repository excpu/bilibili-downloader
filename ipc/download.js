const { ipcMain, app } = require('electron');
const path = require('path');

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');
const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const { downloadFileWithGot } = require('../modules/stream_download');
const Aria2Client = require('../modules/aria2-client'); // 引入 Aria2Client 类
const { downloadWithAria2 } = require('../modules/aria2-client');
const Setting = require("../modules/config_setting");
const setting = new Setting();
setting.load(); // 加载设置数据

// 每次需要下载函数时读取最新设置，避免在模块加载时缓存导致切换无效
const getDownloadFunction = () => {
    const engine = setting.getDownloadEngine() || 'node';
    return engine === 'aria2' ? downloadWithAria2 : downloadFileWithGot;
};

const aria2 = new Aria2Client();
const client = new Aria2Client({
    host: 'ws://localhost:6818/jsonrpc',
    secret: '' // 如果有密码请填写
});

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
        let {
            uid,
            bvid,
            cid,
            title,
            audioIndex,
            videoIndex,
            audioQualityId,
            audioCodec,
            videoQualityId,
            videoCodec
        } = payload;
        title = sanitizePath(title);
        const downloadDir = setting.getDownloadPath();

        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }

        const videoStream = await getUpToDateUrl(bvid, cid, {
            audioIndex,
            videoIndex,
            audioQualityId,
            audioCodec,
            videoQualityId,
            videoCodec
        });
        if (!videoStream.success) {
            console.error(`❌ [${title}] 获取视频流失败: ${videoStream.message}`);
            return { success: false, message: videoStream.message };
        }

        const videoPath = path.join(downloadDir, `${title}_video.m4s`);
        const audioPath = path.join(downloadDir, `${title}_audio.m4s`);
        const outputPath = path.join(downloadDir, `${title}.mp4`);
        let m4aOutputPath = path.join(downloadDir, `${title}.m4a`);

        if (videoStream.selectedAudioId == 30251) {
            m4aOutputPath = path.join(downloadDir, `${title}.flac`);
        }

        if (videoStream.selectedAudioId == 30250) {
            m4aOutputPath = path.join(downloadDir, `${title}.mkv`);
        }


        // 检查是否仅下载音频
        const audioOnly = parseInt(videoIndex) === -1;

        // 新任务开始前清理上次异常退出残留的临时文件，避免一开始就命中 416
        const tempPathsToClean = [audioPath];
        if (!audioOnly) tempPathsToClean.push(videoPath);
        if (audioOnly && fs.existsSync(m4aOutputPath)) tempPathsToClean.push(m4aOutputPath);

        for (const tempPath of tempPathsToClean) {
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
            const downloadFunc = getDownloadFunction();
            await downloadFunc(
                videoStream.audioUrl,
                audioPath,
                downloadHeaders,
                (percent, speed) => notifyProgress(percent, speed, 'audio')
            );

            if (audioOnly) {
                // 仅音频模式：直接转换音频为 m4a
                console.log(`⏳ [${title}] 正在转换为 m4a 格式...`);

                // 修复 macOS/Linux 下的执行权限问题
                if (process.platform === 'darwin' || process.platform === 'linux') {
                    try {
                        fs.chmodSync(ffmpeg, 0o755);
                    } catch (chmodErr) {
                        console.warn('⚠️ 尝试赋予 ffmpeg 执行权限失败，可能会影响转换:', chmodErr);
                    }
                }

                // 使用 ffmpeg 将 m4s 转换为 m4a
                const ffmpegArgs = [
                    '-y',
                    '-i', audioPath,
                    '-c:a', 'copy',
                    m4aOutputPath
                ];

                try {
                    await execFileAsync(ffmpeg, ffmpegArgs);
                    console.log(`✅ [${title}] 转换为 m4a 完成`);
                } catch (err) {
                    console.error(`❌ [${title}] 转换为 m4a 出错`);
                    console.error('err.message:', err.message);
                    console.error('err.stderr:', err.stderr);
                    console.error('err.stdout:', err.stdout);
                    console.error('full err:', err);

                    return {
                        success: false,
                        message: err.stderr || err.message || '音频转换失败'
                    };
                }
            } else {
                // 音视频模式：下载视频并合并
                console.log(`⏳ [${title}] 音频下载完成，开始下载视频...`);
                const downloadFunc = getDownloadFunction();
                await downloadFunc(
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
            }

        } catch (err) {
            console.error(`❌ [${title}] 出错：`, err);
            return {
                success: false,
                message: err?.message ? `下载或合并出错: ${err.message}` : '下载或合并出错'
            };
        } finally {
            // 清理临时 m4s 文件
            if (!audioOnly && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }

        // 通知该视频已经下载完成
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', uid);
        }

        return { success: true };
    });

    function getCodecPrefix(codecs) {
        return String(codecs || '').split('.')[0].toLowerCase();
    }

    // 视频选择策略：优先同清晰度同编码；其次同清晰度其他编码；最后按清晰度降档兜底。
    function pickVideoStream(videoList, preferredQualityId, preferredCodec) {
        const normalizedCodec = String(preferredCodec || '').toLowerCase();
        const targetQuality = parseInt(preferredQualityId);

        if (!Array.isArray(videoList) || videoList.length === 0) return null;

        if (Number.isFinite(targetQuality)) {
            if (normalizedCodec) {
                const exactMatch = videoList.find(item =>
                    parseInt(item.id) === targetQuality && getCodecPrefix(item.codecs) === normalizedCodec
                );
                if (exactMatch) return exactMatch;
            }

            const sameQualityAnyCodec = videoList.find(item => parseInt(item.id) === targetQuality);
            if (sameQualityAnyCodec) return sameQualityAnyCodec;

            const lowerQualityList = videoList
                .filter(item => parseInt(item.id) < targetQuality)
                .sort((a, b) => parseInt(b.id) - parseInt(a.id));

            if (normalizedCodec) {
                const lowerQualityCodecMatch = lowerQualityList.find(item => getCodecPrefix(item.codecs) === normalizedCodec);
                if (lowerQualityCodecMatch) return lowerQualityCodecMatch;
            }

            if (lowerQualityList.length > 0) return lowerQualityList[0];
        }

        return videoList.slice().sort((a, b) => parseInt(b.id) - parseInt(a.id))[0] || null;
    }

    function getAudioQualityScore(audioId) {
        const scoreMap = {
            30251: 5100, // FLAC
            30250: 5000, // Dolby
            30280: 2800,
            30232: 2320,
            30216: 2160,
        };
        const id = parseInt(audioId);
        return scoreMap[id] || id;
    }

    // 音频选择策略与视频一致，但使用质量分值做“降档”排序以兼容 FLAC / Dolby。
    function pickAudioStream(audioList, preferredQualityId, preferredCodec) {
        const normalizedCodec = String(preferredCodec || '').toLowerCase();
        const targetQuality = parseInt(preferredQualityId);

        if (!Array.isArray(audioList) || audioList.length === 0) return null;

        if (Number.isFinite(targetQuality)) {
            if (normalizedCodec) {
                const exactMatch = audioList.find(item =>
                    parseInt(item.id) === targetQuality && getCodecPrefix(item.codecs) === normalizedCodec
                );
                if (exactMatch) return exactMatch;
            }

            const sameQualityAnyCodec = audioList.find(item => parseInt(item.id) === targetQuality);
            if (sameQualityAnyCodec) return sameQualityAnyCodec;

            const targetScore = getAudioQualityScore(targetQuality);
            const lowerQualityList = audioList
                .filter(item => getAudioQualityScore(item.id) < targetScore)
                .sort((a, b) => getAudioQualityScore(b.id) - getAudioQualityScore(a.id));

            if (normalizedCodec) {
                const lowerQualityCodecMatch = lowerQualityList.find(item => getCodecPrefix(item.codecs) === normalizedCodec);
                if (lowerQualityCodecMatch) return lowerQualityCodecMatch;
            }

            if (lowerQualityList.length > 0) return lowerQualityList[0];
        }

        return audioList.slice().sort((a, b) => getAudioQualityScore(b.id) - getAudioQualityScore(a.id))[0] || null;
    }

    async function getUpToDateUrl(bvid, cid, options = {}) {
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

            const dash = json?.data?.dash;
            if (!dash || !Array.isArray(dash.video) || !Array.isArray(dash.audio)) {
                return { success: false, message: '未找到可下载的 DASH 资源' };
            }

            const parsedVideoIndex = parseInt(options.videoIndex);
            const parsedAudioIndex = parseInt(options.audioIndex);

            let preferredVideoQualityId = parseInt(options.videoQualityId);
            let preferredVideoCodec = String(options.videoCodec || '').toLowerCase();

            if (!Number.isFinite(preferredVideoQualityId) && Number.isInteger(parsedVideoIndex) && parsedVideoIndex >= 0 && parsedVideoIndex < dash.video.length) {
                preferredVideoQualityId = parseInt(dash.video[parsedVideoIndex].id);
                if (!preferredVideoCodec) {
                    preferredVideoCodec = getCodecPrefix(dash.video[parsedVideoIndex].codecs);
                }
            }

            let selectedVideo = null;
            if (parsedVideoIndex !== -1) {
                selectedVideo = pickVideoStream(dash.video, preferredVideoQualityId, preferredVideoCodec);
                if (!selectedVideo || !selectedVideo.baseUrl) {
                    return { success: false, message: '未找到可用视频流（已尝试同清晰度与降档）' };
                }
            }

            // 音频候选合并有损/无损/杜比，后续统一按同档与降档规则选择。
            const audioCandidates = Array.isArray(dash.audio) ? [...dash.audio] : [];
            if (dash.flac && dash.flac.audio) {
                audioCandidates.push(dash.flac.audio);
            }
            if (dash.dolby && Array.isArray(dash.dolby.audio) && dash.dolby.audio.length > 0) {
                audioCandidates.push(dash.dolby.audio[0]);
            }

            let preferredAudioQualityId = parseInt(options.audioQualityId);
            let preferredAudioCodec = String(options.audioCodec || '').toLowerCase();

            if (!Number.isFinite(preferredAudioQualityId)) {
                preferredAudioQualityId = parsedAudioIndex;
            }
            if (!preferredAudioCodec) {
                const oldMatched = audioCandidates.find(item => parseInt(item.id) === parsedAudioIndex);
                if (oldMatched) {
                    preferredAudioCodec = getCodecPrefix(oldMatched.codecs);
                }
            }

            const selectedAudio = pickAudioStream(audioCandidates, preferredAudioQualityId, preferredAudioCodec);
            if (!selectedAudio || !selectedAudio.baseUrl) {
                return { success: false, message: '未找到可用音频流（已尝试同音质与降档）' };
            }

            return {
                success: true,
                videoUrl: parsedVideoIndex === -1 ? null : selectedVideo.baseUrl,
                audioUrl: selectedAudio.baseUrl,
                selectedVideoId: selectedVideo ? parseInt(selectedVideo.id) : -1,
                selectedAudioId: parseInt(selectedAudio.id),
                selectedVideoCodec: selectedVideo ? getCodecPrefix(selectedVideo.codecs) : '',
                selectedAudioCodec: getCodecPrefix(selectedAudio.codecs)
            };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    }
}