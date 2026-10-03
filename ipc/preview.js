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

// 启动本地轻量流代理服务，为 <video> 和 <audio> 请求提供正确的 Referer/UA/Range/CORS 支持，彻底避免 403 防盗链错误
function ensureProxyServer() {
    if (proxyServer && proxyPort > 0) {
        return Promise.resolve(proxyPort);
    }

    return new Promise((resolve, reject) => {
        proxyServer = http.createServer((req, res) => {
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

            const headers = {
                'Referer': bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
                'User-Agent': BROWSER_UA,
                'Origin': 'https://www.bilibili.com',
                'Cookie': auth.getConstructedCookie(),
            };

            // 透传 Range 请求头，确保支持拖拽进度条与部分缓冲
            if (req.headers.range) {
                headers['Range'] = req.headers.range;
            }

            try {
                const stream = got.stream(targetUrl, {
                    headers,
                    throwHttpErrors: false,
                    decompress: false, // 媒体文件不要自动解压，保证二进制流与 Range 一致
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
                    console.error('代理媒体流出错:', err.message);
                    if (!res.headersSent) {
                        res.writeHead(502);
                        res.end('Bad Gateway: ' + err.message);
                    }
                });

                req.on('close', () => {
                    stream.destroy();
                });
            } catch (err) {
                console.error('代理请求初始化失败:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end(err.message);
                }
            }
        });

        proxyServer.listen(0, '127.0.0.1', () => {
            proxyPort = proxyServer.address().port;
            console.log(`✅ 视频预览本地代理服务已启动: 127.0.0.1:${proxyPort}`);
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

