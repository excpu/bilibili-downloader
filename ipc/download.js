const { ipcMain } = require('electron');
const path = require('path');

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');
const { sanitizePath } = require('../modules/sanitize_path'); // 引入路径安全函数
const { applyCdnHost: applyDownloadCdnHost } = require('../modules/cdn_source');
const { downloadFileWithGot } = require('../modules/stream_download');
const { downloadFileWithGotMulti } = require('../modules/multi_thread_stream_download');
const { createCancelError, isCancelError } = require('../modules/download_cancel');
const { isUrlRefreshableError } = require('../modules/download_errors');
const Setting = require("../modules/config_setting");
const subtitleJsonConverter = require('../modules/sub_json_converter');
const setting = new Setting();
setting.load(); // 加载设置数据

let activeDownloadCount = 0;
const downloadControllers = new Map(); // uid -> AbortController
const MAX_URL_REFRESHES = 2;

function getTaskPaths(payload) {
    if (typeof payload?.uid !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(payload.uid)) {
        throw new Error('下载任务 UID 无效');
    }
    const title = sanitizePath(String(payload.title || ''));
    if (!title) throw new Error('下载任务标题为空');
    const dir = setting.resolveDownloadDir(payload.folderNames);
    const suffix = payload.uid;
    return {
        dir, title,
        audio: path.join(dir, `${title}_audio_${suffix}.m4s`),
        video: path.join(dir, `${title}_video_${suffix}.m4s`),
        state: path.join(dir, `${title}_download_${suffix}.json`),
        output: ext => path.join(dir, `${title}_output_${suffix}.${ext}`),
    };
}

function saveCheckpoint(filePath, checkpoint) {
    fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(checkpoint), 'utf8');
    fs.renameSync(`${filePath}.tmp`, filePath);
}

function loadCheckpoint(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (checkpoint.version !== 1 || !['node', 'node-multi'].includes(checkpoint.engine)) {
        throw new Error('下载断点元数据格式无效，请删除任务后重新添加');
    }
    return checkpoint;
}

function getAvailableOutputPath(dir, title, ext) {
    let outputPath = path.join(dir, `${title}.${ext}`);
    for (let index = 2; fs.existsSync(outputPath); index++) {
        outputPath = path.join(dir, `${title} (${index}).${ext}`);
    }
    return outputPath;
}

// 取消后删除下载残留文件，文件可能被释放得稍慢，失败时短暂重试
async function removeFilesWithRetry(filePaths) {
    for (const filePath of filePaths) {
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                break;
            } catch (err) {
                if (attempt === 9) {
                    console.warn(`⚠️ 清理文件失败: ${filePath}`, err.message);
                    throw err;
                }
                else await new Promise(res => setTimeout(res, 300));
            }
        }
    }
}

// 每次需要下载函数时读取最新设置，避免在模块加载时缓存导致切换无效
const getDownloadFunction = (engine = setting.getDownloadEngine() || 'node-multi') => {
    if (engine === 'node') {
        return downloadFileWithGot;
    }
    return downloadFileWithGotMulti;
};

const auth = new Auth();

// 将下载链接的域名替换为用户选择的下载 CDN，仅替换主机名，其余参数保持不变
function applyCdnHost(url) {
    return applyDownloadCdnHost(url, setting.getCdnHost());
}

const fs = require('fs');
// js-media 统一门面：合并与纯音频转封装都只从这里进，全程纯 JS，不依赖 ffmpeg
const { mergeBiliM4sToFile, convertBiliM4sAudio, checkAudioConversion } = require('../modules/js-media/media');

module.exports = function registerDownloadIpc(mainWindow) {
    const cleanupDownload = async (event, payload) => {
        const paths = getTaskPaths(payload);
        const targets = [paths.video, paths.audio].flatMap(p => [
            p, `${p}.tmp`, `${p}.dstate.json`
        ]);
        targets.push(paths.state, `${paths.state}.tmp`, ...['mp4', 'mkv', 'm4a', 'flac'].map(paths.output));
        await removeFilesWithRetry(targets);
        return { success: true };
    };
    ipcMain.handle('cleanupFailedDownload', cleanupDownload);
    ipcMain.handle('completeDownload', cleanupDownload);
    ipcMain.handle('cancelDownload', (event, uid) => {
        const controller = downloadControllers.get(uid);
        if (!controller) return { success: false };
        controller.abort();
        return { success: true };
    });
    ipcMain.handle('pauseDownload', (event, uid) => {
        const controller = downloadControllers.get(uid);
        if (!controller) return { success: false, message: '任务已经结束，无法暂停' };
        controller.abort('pause');
        return { success: true };
    });
    ipcMain.handle('downloadSubtitle', async (event, payload) => {
        try {
            const subtitleUrl = String(payload?.subtitleUrl || '');
            if (!subtitleUrl) {
                return { success: false, message: '字幕下载地址为空' };
            }

            const normalizedUrl = subtitleUrl.startsWith('//')
                ? `https:${subtitleUrl}`
                : subtitleUrl;
            const parsedUrl = new URL(normalizedUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return { success: false, message: '字幕下载地址协议无效' };
            }

            const response = await fetch(parsedUrl);
            if (!response.ok) {
                return { success: false, message: `字幕请求失败：HTTP ${response.status}` };
            }

            const subtitleData = await response.json();
            const subtitleSettings = setting.getSubtitleSettings();
            const isAss = subtitleSettings.format === 'ass';
            const subtitleContent = isAss
                ? subtitleJsonConverter.jsonToAss(subtitleData, subtitleSettings.assOptions)
                : subtitleJsonConverter.jsonToSrt(subtitleData);
            if (!subtitleContent) {
                return { success: false, message: '字幕内容为空或格式无效' };
            }

            const title = sanitizePath(String(payload.title || 'subtitle'));
            const language = sanitizePath(String(payload.language || 'subtitle'));
            const fileName = subtitleSettings.appendLanguage ? `${title}_${language}` : title;
            const saveSubtitle = isAss
                ? subtitleJsonConverter.saveAssToFile
                : subtitleJsonConverter.saveSrtToFile;
            const filePath = await saveSubtitle(
                subtitleContent,
                setting.resolveDownloadDir(payload.folderNames),
                `${fileName}.${isAss ? 'ass' : 'srt'}`
            );
            return { success: true, filePath };
        } catch (error) {
            console.error('下载字幕失败:', error.message);
            return { success: false, message: `下载字幕失败：${error.message}` };
        }
    });

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
        const paths = getTaskPaths(payload);
        title = paths.title;
        const downloadDir = paths.dir;
        const controller = new AbortController();
        const signal = controller.signal;
        downloadControllers.set(uid, controller);
        const videoPath = paths.video;
        const audioPath = paths.audio;
        let outputPath;
        let m4aOutputPath;
        let outputFormat;
        let finalOutputPath;
        const audioOnly = parseInt(videoIndex) === -1;
        let checkpoint;
        let resumeEnabled = false;
        let mergeStarted = false;
        let keepPartial = payload.resume === true;
        activeDownloadCount += 1;

        try {
            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true });
            }
            checkpoint = payload.resume ? loadCheckpoint(paths.state) : null;
            if (checkpoint?.completed && checkpoint.outputPath &&
                path.dirname(checkpoint.outputPath) === downloadDir && fs.existsSync(checkpoint.outputPath)) {
                finalOutputPath = checkpoint.outputPath;
                keepPartial = true;
                return { success: true, filePath: finalOutputPath };
            }
            const engine = checkpoint?.engine || setting.getDownloadEngine() || 'node-multi';
            const isMultiEngine = engine !== 'node';
            resumeEnabled = isMultiEngine && setting.getNodeResumeEnabled();
            const resuming = payload.resume === true && !!checkpoint;
            const tempPathsToClean = resuming ? [] : [audioPath, `${audioPath}.tmp`, `${audioPath}.dstate.json`];
            if (!audioOnly && !resuming) tempPathsToClean.push(videoPath, `${videoPath}.tmp`, `${videoPath}.dstate.json`);
            await removeFilesWithRetry(tempPathsToClean);
            checkpoint ||= { version: 1, engine };

            // 局部通知函数，绑定当前任务的 uid
            const notifyProgress = (progress, speed, avId, downloadedBytes = 0, totalBytes = 0) => {
                if (speed === 'NaN' || isNaN(Number(speed))) return;
                const progressInfo = {
                    progress,
                    speed,
                    currentUid: uid,
                    avId,
                    downloadedBytes: Number(downloadedBytes) || 0,
                    totalBytes: Number(totalBytes) || 0
                };
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

            const downloadFunc = getDownloadFunction(engine);
            let videoStream;
            const refreshStreams = async () => {
                const fresh = await getUpToDateUrl(bvid, cid, {
                    audioIndex, videoIndex, audioQualityId, audioCodec, videoQualityId, videoCodec
                }, signal);
                if (signal.aborted) throw createCancelError();
                if (!fresh.success) throw new Error(`获取视频流失败：${fresh.message}`);
                const audioResource = new URL(fresh.audioUrl).pathname;
                const videoResource = fresh.videoUrl ? new URL(fresh.videoUrl).pathname : null;
                if (checkpoint.audioResource && (checkpoint.audioResource !== audioResource ||
                    checkpoint.videoResource !== videoResource)) {
                    await removeFilesWithRetry([audioPath, videoPath].flatMap(p => [p, `${p}.tmp`, `${p}.dstate.json`]));
                    checkpoint.audioComplete = false;
                    checkpoint.videoComplete = false;
                }
                Object.assign(checkpoint, { audioResource, videoResource, completed: false });
                saveCheckpoint(paths.state, checkpoint);
                videoStream = fresh;
                outputFormat = setting.resolveOutputFormat({
                    audioId: fresh.selectedAudioId, audioCodec: fresh.selectedAudioCodec,
                });
                outputPath = paths.output(outputFormat);
                const audioExt = fresh.selectedAudioId === 30251 ? 'flac' : fresh.selectedAudioId === 30250 ? 'mkv' : 'm4a';
                m4aOutputPath = paths.output(audioExt);
            };
            await refreshStreams();
            keepPartial = false;
            let urlRefreshes = 0;
            for (;;) {
                try {
                    if (signal.aborted) throw createCancelError();
                    if (!checkpoint.audioComplete || !fs.existsSync(audioPath)) {
                        await downloadFunc(
                            applyCdnHost(videoStream.audioUrl), audioPath, downloadHeaders,
                            (percent, speed, downloaded, total) => notifyProgress(percent, speed, 'audio', downloaded, total),
                            undefined, setting.getConcurrency(), signal, { resume: isMultiEngine }
                        );
                        checkpoint.audioComplete = true;
                        saveCheckpoint(paths.state, checkpoint);
                    }
                    if (signal.aborted) throw createCancelError();
                    if (!audioOnly && (!checkpoint.videoComplete || !fs.existsSync(videoPath))) {
                        notifyProgress(0, '0.00', 'video');
                        await downloadFunc(
                            applyCdnHost(videoStream.videoUrl), videoPath, downloadHeaders,
                            (percent, speed, downloaded, total) => notifyProgress(percent, speed, 'video', downloaded, total),
                            undefined, setting.getConcurrency(), signal, { resume: isMultiEngine }
                        );
                        checkpoint.videoComplete = true;
                        saveCheckpoint(paths.state, checkpoint);
                    }
                    if (signal.aborted) throw createCancelError();
                    break;
                } catch (error) {
                    if (signal.aborted || !isUrlRefreshableError(error) || urlRefreshes >= MAX_URL_REFRESHES) throw error;
                    urlRefreshes += 1;
                    console.warn(`⚠️ [${title}] 下载链接失效，刷新地址 (${urlRefreshes}/${MAX_URL_REFRESHES})`);
                    notifyProgress(0, '0.00', 'refreshing');
                    await refreshStreams();
                }
            }

            if (audioOnly) {
                // 仅音频模式：把音频 .m4s 转封装成目标格式（.m4a / .flac / 纯音频 .mkv）
                const audioExt = path.extname(m4aOutputPath).replace('.', '').toUpperCase();
                console.log(`⏳ [${title}] 正在转换为 ${audioExt} 格式...`);
                notifyProgress(100, '0.00', 'converting');
                mergeStarted = true;

                // js-media 按实际"编码 + 目标容器"判定能否转封装：
                // AAC -> M4A、FLAC -> 原生 FLAC、杜比全景声等 -> 纯音频 MKV。
                // 纯 JS 版本没有 ffmpeg 兜底，覆盖不到的编码直接报错。
                const jsAudio = checkAudioConversion(audioPath, m4aOutputPath);
                if (!jsAudio.supported) {
                    console.error(`❌ [${title}] js-media 无法转换为 ${audioExt}：${jsAudio.reason}`);
                    return {
                        success: false,
                        message: `无法转换为 ${audioExt}：${jsAudio.reason}`
                    };
                }

                try {
                    await convertBiliM4sAudio(audioPath, m4aOutputPath, { signal });
                    if (signal.aborted) throw createCancelError();
                    console.log(`✅ [${title}] 转换为 ${audioExt} 完成 (js-media)`);
                } catch (err) {
                    if (signal.aborted) throw createCancelError();
                    console.error(`❌ [${title}] 转换为 ${audioExt} 出错 (js-media)`);
                    console.error('err.message:', err.message);
                    return {
                        success: false,
                        message: err.message || '音频转换失败'
                    };
                }
            } else {
                console.log(`⏳ [${title}] 正在合并...`);
                notifyProgress(100, '0.00', 'merging');
                mergeStarted = true;
                try {
                    // 传入 signal：js-media 在分片/Cluster 边界检查，取消可中途生效
                    await mergeBiliM4sToFile(videoPath, audioPath, outputPath, { title, signal });
                    if (signal.aborted) throw createCancelError();
                    console.log(`✅ [${title}] 转换完成`);
                } catch (err) {
                    if (signal.aborted) throw createCancelError();
                    console.error(`❌ [${title}] 合并出错`);
                    console.error('err.message:', err.message);
                    console.error('full err:', err);

                    return {
                        success: false,
                        message: err.message || '音视频合并失败'
                    };
                }
            }
            const tempOutputPath = audioOnly ? m4aOutputPath : outputPath;
            const ext = path.extname(tempOutputPath).slice(1);
            const destination = getAvailableOutputPath(downloadDir, title, ext);
            Object.assign(checkpoint, { completed: true, outputPath: destination });
            saveCheckpoint(paths.state, checkpoint);
            fs.renameSync(tempOutputPath, destination);
            finalOutputPath = destination;
            keepPartial = true;

        } catch (err) {
            if (isCancelError(err) || signal.aborted) {
                if (signal.reason === 'pause') {
                    keepPartial = true;
                    if (checkpoint) saveCheckpoint(paths.state, checkpoint);
                    if (mergeStarted) await removeFilesWithRetry([audioOnly ? m4aOutputPath : outputPath]);
                    console.log(`⏸ [${title}] 下载已暂停，保留断点`);
                    return { success: false, paused: true, message: '下载已暂停' };
                }
                console.log(`🛑 [${title}] 下载已取消，清理文件`);
                const partialPaths = [videoPath, audioPath, ...(mergeStarted ? [outputPath, m4aOutputPath] : [])].flatMap(p => [
                    p, `${p}.tmp`, `${p}.dstate.json`
                ]);
                await removeFilesWithRetry(partialPaths);
                return { success: false, cancelled: true, message: '下载已取消' };
            }
            console.error(`❌ [${title}] 出错：`, err);
            keepPartial = !!checkpoint && (resumeEnabled || payload.resume === true || isUrlRefreshableError(err));
            if (!keepPartial) {
                await removeFilesWithRetry([videoPath, audioPath].flatMap(p => [`${p}.tmp`, `${p}.dstate.json`]));
            }
            return {
                success: false,
                message: err?.message ? `下载或合并出错: ${err.message}` : '下载或合并出错'
            };
        } finally {
            downloadControllers.delete(uid);
            activeDownloadCount -= 1;
            if (!keepPartial) await removeFilesWithRetry([paths.state, `${paths.state}.tmp`]);
            if (!keepPartial && mergeStarted) {
                await removeFilesWithRetry([audioOnly ? m4aOutputPath : outputPath]);
            }
            // 清理临时 m4s 文件
            try {
                if (!keepPartial || finalOutputPath) {
                    if (!audioOnly && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                }
            } catch (cleanupErr) {
                console.warn('⚠️ 清理临时文件失败:', cleanupErr.message);
            }
        }

        // 通知该视频已经下载完成
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', uid);
        }

        return { success: true, filePath: finalOutputPath };
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

    async function getUpToDateUrl(bvid, cid, options = {}, signal) {
        try {
            const wbiKeys = await getWbiKeys(signal);
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
                signal,
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

module.exports.hasActiveDownloads = () => activeDownloadCount > 0;