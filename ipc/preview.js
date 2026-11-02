// 用于「点击封面预览视频」功能：使用下载同款的 DASH 流播放视频与音频，通过传统接口获取弹幕
const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const http = require('http');
const got = require('got');
const zlib = require('zlib');
const { PassThrough } = require('stream');

const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');

const auth = new Auth();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

const COMMON_HEADERS = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const QUALITY_MAP = {
    127: '8K 超高清',
    126: '杜比视界',
    125: 'HDR 真彩色',
    120: '4K 超清',
    116: '1080P 60帧',
    112: '1080P 高码率',
    80: '1080P 高清',
    74: '720P 60帧',
    64: '720P 标清',
    32: '480P 清晰',
    16: '360P 流畅',
    6: '240P 极速',
};

const CODEC_NAME_MAP = {
    avc1: 'AVC',
    hev1: 'HEVC',
    hvc1: 'HEVC',
    av01: 'AV1',
};

let previewWindow = null; // 持有引用，防止重复打开
let proxyServer = null;
let proxyPort = 0;

// 多线程并发预取缓冲配置
const CHUNK_SIZE = 1024 * 1024; // 1MB 分块大小，平衡网络握手开销与秒开响应
const CONCURRENCY = 6; // 6 个并发连接同时向 CDN 拉取分块，突破单连接限速
const MAX_PREFETCH_AHEAD = 8; // 内存中滑动预取窗口大小（最多提前缓冲 8 个分块，约 8MB）

// 媒体元数据缓存 (URL -> { totalSize, contentType })
const mediaMetaCache = new Map();

// 快速探测媒体总大小与 MIME 类型
async function probeMediaMeta(targetUrl, headers) {
    if (mediaMetaCache.has(targetUrl)) {
        return mediaMetaCache.get(targetUrl);
    }

    try {
        const probeRes = await got(targetUrl, {
            headers: { ...headers, 'Range': 'bytes=0-0' },
            throwHttpErrors: false,
            decompress: false,
            retry: 2,
        });

        let totalSize = 0;
        const cr = probeRes.headers['content-range'];
        if (cr) {
            const m = cr.match(/\/(\d+)$/);
            if (m) totalSize = parseInt(m[1], 10);
        }
        if (!totalSize && probeRes.headers['content-length']) {
            totalSize = parseInt(probeRes.headers['content-length'], 10);
        }

        const meta = {
            totalSize,
            contentType: probeRes.headers['content-type'] || 'video/mp4',
        };

        if (totalSize > 0) {
            mediaMetaCache.set(targetUrl, meta);
        }
        return meta;
    } catch (err) {
        console.warn('探测媒体元信息失败:', err.message);
        return { totalSize: 0, contentType: 'video/mp4' };
    }
}

// 降级处理：单连接直通
function handleFallbackSingleStream(req, res, targetUrl, headers) {
    const streamHeaders = { ...headers };
    if (req.headers.range) {
        streamHeaders['Range'] = req.headers.range;
    }

    try {
        const stream = got.stream(targetUrl, {
            headers: streamHeaders,
            throwHttpErrors: false,
            decompress: false,
            retry: 1,
        });

        stream.on('response', (remoteRes) => {
            const responseHeaders = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Accept-Ranges': 'bytes',
                'Content-Type': remoteRes.headers['content-type'] || 'video/mp4',
            };
            if (remoteRes.headers['content-length']) {
                responseHeaders['Content-Length'] = remoteRes.headers['content-length'];
            }
            if (remoteRes.headers['content-range']) {
                responseHeaders['Content-Range'] = remoteRes.headers['content-range'];
            }
            res.writeHead(remoteRes.statusCode || 200, responseHeaders);
            stream.pipe(res);
        });

        stream.on('error', (err) => {
            console.error('单连接直通出错:', err.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });

        req.on('close', () => stream.destroy());
    } catch (err) {
        if (!res.headersSent) {
            res.writeHead(500);
            res.end(err.message);
        }
    }
}

// 核心：多线程分块并发拉取与有序泵入响应流
function handleConcurrentChunkStream(req, res, targetUrl, headers, totalSize, clientStart, clientEnd) {
    const startChunk = Math.floor(clientStart / CHUNK_SIZE);
    const endChunk = Math.floor(clientEnd / CHUNK_SIZE);

    const activeControllers = new Map(); // chunkIndex -> AbortController
    const chunkBuffers = new Map(); // chunkIndex -> Buffer
    let nextChunkToWrite = startChunk;
    let nextChunkToFetch = startChunk;
    let isAborted = false;
    let isWriting = false;

    function cleanup() {
        if (isAborted) return;
        isAborted = true;
        for (const controller of activeControllers.values()) {
            controller.abort();
        }
        activeControllers.clear();
        chunkBuffers.clear();
    }

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);

    function scheduleFetches() {
        if (isAborted) return;

        while (
            activeControllers.size < CONCURRENCY &&
            nextChunkToFetch <= endChunk &&
            nextChunkToFetch < nextChunkToWrite + MAX_PREFETCH_AHEAD
        ) {
            const chunkIndex = nextChunkToFetch++;
            fetchChunk(chunkIndex);
        }
    }

    function fetchChunk(chunkIndex) {
        if (isAborted) return;

        const chunkStart = chunkIndex * CHUNK_SIZE;
        const chunkEnd = Math.min(totalSize - 1, (chunkIndex + 1) * CHUNK_SIZE - 1);

        const controller = new AbortController();
        activeControllers.set(chunkIndex, controller);

        got(targetUrl, {
            headers: {
                ...headers,
                'Range': `bytes=${chunkStart}-${chunkEnd}`,
            },
            decompress: false,
            throwHttpErrors: false,
            retry: 2,
            signal: controller.signal,
            responseType: 'buffer',
        }).then((response) => {
            activeControllers.delete(chunkIndex);
            if (isAborted) return;

            if (response.statusCode >= 200 && response.statusCode < 300) {
                chunkBuffers.set(chunkIndex, response.body);
                tryPumpNext();
                scheduleFetches();
            } else {
                console.warn(`分块 ${chunkIndex} 响应状态码: ${response.statusCode}`);
            }
        }).catch((err) => {
            activeControllers.delete(chunkIndex);
            if (isAborted || err.name === 'AbortError') return;
            console.warn(`分块 ${chunkIndex} 下载异常:`, err.message);
        });
    }

    function tryPumpNext() {
        if (isAborted || isWriting) return;

        while (chunkBuffers.has(nextChunkToWrite)) {
            const chunkIndex = nextChunkToWrite;
            let buffer = chunkBuffers.get(chunkIndex);
            chunkBuffers.delete(chunkIndex); // 用完立即释放内存

            const chunkStart = chunkIndex * CHUNK_SIZE;
            const chunkEnd = chunkStart + buffer.length - 1;

            let sliceStart = 0;
            if (clientStart > chunkStart) {
                sliceStart = clientStart - chunkStart;
            }

            let sliceEnd = buffer.length;
            if (clientEnd < chunkEnd) {
                sliceEnd = buffer.length - (chunkEnd - clientEnd);
            }

            if (sliceStart > 0 || sliceEnd < buffer.length) {
                buffer = buffer.subarray(sliceStart, sliceEnd);
            }

            nextChunkToWrite++;

            const canContinue = res.write(buffer);

            if (nextChunkToWrite > endChunk) {
                res.end();
                cleanup();
                return;
            }

            if (!canContinue) {
                isWriting = true;
                res.once('drain', () => {
                    isWriting = false;
                    tryPumpNext();
                    scheduleFetches();
                });
                return;
            }
        }
    }

    // 启动初始并发批次
    scheduleFetches();
}

// 启动本地轻量多线程并发流代理服务
function ensureProxyServer() {
    if (proxyServer && proxyPort > 0) {
        return Promise.resolve(proxyPort);
    }

    return new Promise((resolve, reject) => {
        proxyServer = http.createServer(async (req, res) => {
            const reqUrl = new URL(req.url, `http://127.0.0.1:${proxyPort}`);
            if (reqUrl.pathname !== '/stream') {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const targetUrl = reqUrl.searchParams.get('url');
            const bvid = reqUrl.searchParams.get('bvid');
            if (!targetUrl) {
                res.writeHead(400);
                res.end('Missing url parameter');
                return;
            }

            const baseHeaders = {
                'Referer': bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
                'User-Agent': BROWSER_UA,
                'Origin': 'https://www.bilibili.com',
                'Cookie': auth.getConstructedCookie(),
            };

            try {
                const meta = await probeMediaMeta(targetUrl, baseHeaders);
                const totalSize = meta.totalSize;

                // 如果无法探测出总大小，降级为普通单流传输
                if (!totalSize) {
                    handleFallbackSingleStream(req, res, targetUrl, baseHeaders);
                    return;
                }

                let clientStart = 0;
                let clientEnd = totalSize - 1;
                const rangeHeader = req.headers.range;
                if (rangeHeader) {
                    const parts = rangeHeader.replace(/bytes=/, '').split('-');
                    if (parts[0]) {
                        clientStart = parseInt(parts[0], 10);
                    }
                    if (parts[1]) {
                        clientEnd = parseInt(parts[1], 10);
                    }
                }

                if (clientStart >= totalSize || clientStart > clientEnd) {
                    res.writeHead(416, {
                        'Content-Range': `bytes */${totalSize}`,
                        'Access-Control-Allow-Origin': '*',
                    });
                    res.end();
                    return;
                }

                if (clientEnd >= totalSize) {
                    clientEnd = totalSize - 1;
                }

                const contentLength = clientEnd - clientStart + 1;
                res.writeHead(rangeHeader ? 206 : 200, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Accept-Ranges': 'bytes',
                    'Content-Range': `bytes ${clientStart}-${clientEnd}/${totalSize}`,
                    'Content-Length': contentLength,
                    'Content-Type': meta.contentType,
                });

                handleConcurrentChunkStream(req, res, targetUrl, baseHeaders, totalSize, clientStart, clientEnd);
            } catch (err) {
                console.error('代理请求分发失败:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(err.message);
                }
            }
        });

        proxyServer.listen(0, '127.0.0.1', () => {
            proxyPort = proxyServer.address().port;
            console.log(`🚀 视频预览【多线程并发缓冲引擎】已启动: 127.0.0.1:${proxyPort} (分块并发数: ${CONCURRENCY})`);
            resolve(proxyPort);
        });

        proxyServer.on('error', (err) => {
            console.error('代理服务器启动错误:', err);
            reject(err);
        });
    });
}

function closeProxyServer() {
    if (proxyServer) {
        try {
            if (typeof proxyServer.closeAllConnections === 'function') {
                proxyServer.closeAllConnections();
            }
            proxyServer.close(() => {
                console.log('🛑 视频预览本地代理服务已关闭');
            });
        } catch (err) {
            console.warn('关闭本地代理服务异常:', err.message);
        }
        proxyServer = null;
        proxyPort = 0;
        mediaMetaCache.clear();
    }
}

if (app) {
    app.on('before-quit', () => {
        closeProxyServer();
    });
}

function toProxyUrl(originalUrl, bvid, port) {
    if (!originalUrl) return null;
    return `http://127.0.0.1:${port}/stream?url=${encodeURIComponent(originalUrl)}&bvid=${encodeURIComponent(bvid || '')}`;
}

// 获取下载同款的 DASH 视频流及音频流
async function fetchPreviewDashStreams(bvid, cid) {
    await auth.ensureBuvidCredentials();
    const wbiKeys = await getWbiKeys();
    const params = {
        bvid,
        cid,
        fnval: 4048,
        fnver: 0,
        fourk: 1,
        web_location: 1315873,
        gaia_source: 'view-card',
    };
    const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
    const url = `https://api.bilibili.com/x/player/wbi/playurl?${wbiQuery}`;
    const response = await got(url, {
        headers: {
            ...COMMON_HEADERS,
            'Referer': `https://www.bilibili.com/video/${bvid}/`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.1',
            'Accept': 'application/json',
            'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
            'Cache-Control': 'no-cache',
            'Origin': 'https://www.bilibili.com',
            'Cookie': auth.getConstructedCookie(),
        },
        responseType: 'json',
        http2: true,
    });

    const json = response.body;
    if (json.code !== 0) {
        throw new Error(json.message || '获取 DASH 视频流失败');
    }

    const dash = json.data?.dash;
    if (!dash || !Array.isArray(dash.video) || !Array.isArray(dash.audio)) {
        throw new Error('未获取到可播放的 DASH 流资源');
    }

    return dash;
}

// 格式化 DASH 流，匹配用户偏好画质并优先选择兼容性最好的 AVC 编码
function formatDashForPreview(dash, preferred = {}) {
    const rawVideos = dash.video || [];
    const rawAudios = dash.audio || [];

    const videoList = rawVideos.map((item, index) => {
        const codecPrefix = (item.codecs || '').split('.')[0].toLowerCase();
        const qualityName = QUALITY_MAP[item.id] || `${item.id}P`;
        const codecName = CODEC_NAME_MAP[codecPrefix] || codecPrefix.toUpperCase() || '未知编码';
        const url = item.baseUrl || item.base_url || item.backupUrl?.[0] || item.backup_url?.[0];
        return {
            index,
            id: Number(item.id),
            qualityName,
            codecPrefix,
            codecName,
            label: `${qualityName} (${codecName})`,
            width: item.width,
            height: item.height,
            frameRate: item.frameRate,
            bandwidth: item.bandwidth,
            url,
        };
    }).filter(v => !!v.url);

    // 按分辨率从高到低排序；同一分辨率下将 AVC(兼容性最好)排在前面
    videoList.sort((a, b) => {
        if (b.id !== a.id) return b.id - a.id;
        if (a.codecPrefix === 'avc1' && b.codecPrefix !== 'avc1') return -1;
        if (b.codecPrefix === 'avc1' && a.codecPrefix !== 'avc1') return 1;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
    });

    // 格式化音频流列表（优先标准 AAC 格式，按质量降序）
    const audioCandidates = [...rawAudios];
    const audioList = audioCandidates.map((item, index) => {
        const codecPrefix = (item.codecs || '').split('.')[0].toLowerCase();
        const url = item.baseUrl || item.base_url || item.backupUrl?.[0] || item.backup_url?.[0];
        return {
            index,
            id: Number(item.id),
            codecPrefix,
            bandwidth: item.bandwidth,
            url,
        };
    }).filter(a => !!a.url);

    // 最佳音频：优先 AAC 流按码率降序
    const defaultAudio = audioList.slice().sort((a, b) => {
        if (a.codecPrefix === 'mp4a' && b.codecPrefix !== 'mp4a') return -1;
        if (b.codecPrefix === 'mp4a' && a.codecPrefix !== 'mp4a') return 1;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
    })[0] || null;

    // 挑选默认播放的视频流：优先匹配主界面的选项，否则默认取最高画质的 AVC 编码
    const prefQualityId = preferred.videoQualityId ? Number(preferred.videoQualityId) : null;
    const prefCodec = preferred.videoCodec ? String(preferred.videoCodec).toLowerCase() : null;

    let defaultVideo = null;
    if (prefQualityId) {
        if (prefCodec) {
            defaultVideo = videoList.find(v => v.id === prefQualityId && v.codecPrefix === prefCodec);
        }
        if (!defaultVideo) {
            defaultVideo = videoList.find(v => v.id === prefQualityId && v.codecPrefix === 'avc1')
                || videoList.find(v => v.id === prefQualityId);
        }
    }
    if (!defaultVideo) {
        const avcList = videoList.filter(v => v.codecPrefix === 'avc1');
        defaultVideo = avcList[0] || videoList[0] || null;
    }

    return {
        videoList,
        defaultVideo,
        defaultAudioUrl: defaultAudio ? defaultAudio.url : null,
    };
}

// 传统弹幕接口响应可能经过 gzip/br/deflate 压缩且缺少标准标头，需手动解压（与下载弹幕逻辑保持一致）
async function fetchPreviewDanmuXml(cid) {
    const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
    const stream = got.stream(url, {
        headers: {
            ...COMMON_HEADERS,
            'Referer': 'https://www.bilibili.com/',
            'Origin': 'https://www.bilibili.com',
            'Accept': '*/*',
            'Cookie': auth.getConstructedCookie(),
        },
        http2: true,
        retry: 0,
        decompress: false, // 禁用自动解压，手动接管
        throwHttpErrors: true,
    });

    return new Promise((resolve, reject) => {
        stream.on('error', reject);
        stream.on('response', (res) => {
            const encoding = res.headers['content-encoding'];
            let decompressor;
            if (encoding === 'gzip') {
                decompressor = zlib.createGunzip();
            } else if (encoding === 'br') {
                decompressor = zlib.createBrotliDecompress();
            } else if (encoding === 'deflate') {
                decompressor = zlib.createInflateRaw(); // B站弹幕缺少标准标头，使用 createInflateRaw 处理
            } else {
                decompressor = new PassThrough();
            }

            const chunks = [];
            decompressor.on('data', (chunk) => chunks.push(chunk));
            decompressor.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            decompressor.on('error', reject);
            stream.pipe(decompressor);
        });
    });
}

module.exports = function registerPreviewIpc(mainWindow) {
    // 打开视频预览窗口
    ipcMain.handle('openPreviewWindow', (event, payload = {}) => {
        const { bvid, cid, title, videoQualityId, videoCodec, audioQualityId, audioCodec } = payload;
        if (!bvid || !cid) {
            return { success: false, message: '缺少 bvid 或 cid，无法打开预览' };
        }

        const previewData = { bvid, cid, title, videoQualityId, videoCodec, audioQualityId, audioCodec };

        if (previewWindow && !previewWindow.isDestroyed()) {
            if (previewWindow.isMinimized()) previewWindow.restore();
            previewWindow.focus();
            previewWindow.webContents.send('previewVideo', previewData);
            return { success: true };
        }

        previewWindow = new BrowserWindow({
            width: 960,
            height: 580,
            minWidth: 640,
            minHeight: 420,
            icon: path.join(__dirname, '../assets/icon/player.png'),
            backgroundColor: '#000000',
            ...(process.platform === 'linux' ? {} : {
                titleBarStyle: 'hidden',
                ...(process.platform === 'win32' ? {
                    titleBarOverlay: {
                        color: '#00000000',
                        symbolColor: '#ffffff',
                        height: 40,
                    },
                } : {}),
            }),
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        previewWindow.setMenu(null);
        previewWindow.webContents.setUserAgent(BROWSER_UA);
        previewWindow.loadFile(path.join(__dirname, '../web/player/web_player.html'));

        previewWindow.webContents.once('did-finish-load', () => {
            previewWindow.webContents.send('previewVideo', previewData);
        });

        previewWindow.on('closed', () => {
            previewWindow = null;
            closeProxyServer();
        });

        return { success: true };
    });

    // 获取下载同款的 DASH 流资源并转为本地代理流地址
    ipcMain.handle('getPreviewDash', async (event, payload = {}) => {
        try {
            const { bvid, cid, videoQualityId, videoCodec } = payload;
            if (!bvid || !cid) {
                return { success: false, message: '缺少 bvid 或 cid' };
            }
            const proxyPort = await ensureProxyServer();
            const dash = await fetchPreviewDashStreams(bvid, cid);
            const formatted = formatDashForPreview(dash, { videoQualityId, videoCodec });

            // 将所有远程视频流和音频流转换为本地代理流地址，确保带有防盗链 Referer、UA 和 CORS
            const proxiedVideoList = formatted.videoList.map(v => ({
                ...v,
                url: toProxyUrl(v.url, bvid, proxyPort),
            }));

            const proxiedDefaultVideo = formatted.defaultVideo ? {
                ...formatted.defaultVideo,
                url: toProxyUrl(formatted.defaultVideo.url, bvid, proxyPort),
            } : null;

            const proxiedDefaultAudioUrl = toProxyUrl(formatted.defaultAudioUrl, bvid, proxyPort);

            return {
                success: true,
                data: {
                    videoList: proxiedVideoList,
                    defaultVideo: proxiedDefaultVideo,
                    defaultAudioUrl: proxiedDefaultAudioUrl,
                }
            };
        } catch (error) {
            console.error('❌ 获取预览 DASH 流失败：', error);
            return { success: false, message: error.message || '获取预览 DASH 流失败' };
        }
    });

    // 获取预览用弹幕（传统接口，xml 文本）
    ipcMain.handle('getPreviewDanmu', async (event, payload = {}) => {
        try {
            const { cid } = payload;
            if (!cid) {
                return { success: false, message: '缺少 cid' };
            }
            const xml = await fetchPreviewDanmuXml(cid);
            return { success: true, data: xml };
        } catch (error) {
            console.error('❌ 获取预览弹幕失败：', error);
            return { success: false, message: error.message || '获取预览弹幕失败' };
        }
    });
};

