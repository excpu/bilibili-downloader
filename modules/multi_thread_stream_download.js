const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Writable, pipeline } = require('stream');
const got = require('got');
const { createCancelError, isCancelError } = require('./download_cancel');

// 创建专用 HTTP 1.1 Agent 实例池，实现真正的多 TCP 连接并发加速下载
function createHttpAgents(concurrency) {
    const maxSockets = Math.max(16, concurrency * 2);
    return {
        http: new http.Agent({
            keepAlive: true,
            maxSockets: maxSockets,
            maxFreeSockets: concurrency,
            timeout: 60000,
            scheduling: 'fifo'
        }),
        https: new https.Agent({
            keepAlive: true,
            maxSockets: maxSockets,
            maxFreeSockets: concurrency,
            timeout: 60000,
            scheduling: 'fifo'
        })
    };
}

// 安全销毁 Agent 实例池以释放全部 TCP 物理套接字
function destroyHttpAgents(agents) {
    if (!agents) return;
    try { agents.http?.destroy(); } catch {}
    try { agents.https?.destroy(); } catch {}
}

// 读取用户全局设置的并发线程数
function readConfiguredConcurrency() {
    try {
        const Setting = require('./config_setting');
        const setting = new Setting();
        const concurrency = setting.getAria2Concurrency();
        if (typeof concurrency === 'number' && concurrency > 0) {
            return concurrency;
        }
    } catch {
        // 在独立环境或非 Electron 进程中运行时的降级处理：尝试直接从 config.json 读取
        try {
            const appData = process.env.APPDATA || (
                process.platform === 'darwin'
                    ? path.join(process.env.HOME, 'Library', 'Application Support')
                    : path.join(process.env.HOME, '.config')
            );
            const configPath = path.join(appData, 'bilibili.downloader.app', 'config.json');
            if (fs.existsSync(configPath)) {
                const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (conf && conf.aria2Concurrency) {
                    return Number(conf.aria2Concurrency);
                }
            }
        } catch {}
    }
    return 8; // 默认 8 线程
}

// 常量配置
const MAX_DOWNLOAD_DURATION_MS = 110 * 60 * 1000; // 1 小时 50 分钟（B站下载链接通常 2 小时有效）
const STALL_TIMEOUT_MS = 20 * 1000;              // 20 秒无数据流入判定为分片连接卡死
const CONNECT_TIMEOUT_MS = 15 * 1000;            // 15 秒连接建立超时
const BASE_RETRY_DELAY_MS = 1000;                // 指数退避起始延迟 1s
const MAX_RETRY_DELAY_MS = 10000;                // 指数退避最大延迟 10s
const DEFAULT_MAX_CHUNK_RETRIES = 15;            // 恶劣网络下单分片最大重试次数
const MAX_GLOBAL_CONSECUTIVE_FAILURES = 50;      // 全局连续失败上限（确定彻底不可用再报错）
const MIN_CHUNK_SIZE = 2048 * 1024;               // 单分片最小 2MB（避免过碎连接开销）
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;         // 单分片最大 16MB
const MIN_STEAL_SIZE = 1024 * 1024;              // 在途分片剩余不足 1MB 时不再切分
const MIN_STEAL_ETA_SECONDS = 1.5;               // 预计 1.5 秒内能下完的分片不再切分
const SPEED_SAMPLE_INTERVAL_MS = 500;            // 分片速度采样间隔
const WRITE_FLUSH_BYTES = 1024 * 1024;           // 写盘聚合：累计 1MB 再落盘
const WRITE_FLUSH_INTERVAL_MS = 500;             // 写盘聚合：最长 0.5 秒必须落盘一次，保证进度与断点及时

// 辅助睡眠函数
function sleep(ms, signal = null) {
    return new Promise(resolve => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}

// 判断两个 URL 是否指向同一个底层资源（支持因时效重签名前后 query 变化的情况）
function isSameResource(urlA, urlB, lenA, lenB) {
    if (lenA !== lenB) return false;
    if (urlA === urlB) return true;
    try {
        const pA = new URL(urlA).pathname;
        const pB = new URL(urlB).pathname;
        return pA === pB && lenA === lenB && lenA > 0;
    } catch {
        return false;
    }
}

// 判断错误是否属于“绝对无法恢复”的错误（确定链接彻底无法下载）
// 只有此类错误或重试彻底耗尽才会向外报错，避免恶劣网络下的临时抖动过早抛错
function isUnrecoverableError(err) {
    if (!err) return false;
    if (err.unrecoverable) return true;

    // 本地磁盘/文件系统不可恢复错误（权限拒绝、磁盘写满、非法路径等）
    const fatalFsCodes = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EINVAL', 'EISDIR']);
    if (err.code && fatalFsCodes.has(err.code)) {
        return true;
    }

    // HTTP 状态码判断：
    // 401 Unauthorized, 403 Forbidden (鉴权已过期/防盗链), 404 Not Found (资源已被删), 410 Gone
    // 注意：408(超时), 416(范围可纠正), 429(限流), 5xx(服务端瞬时故障) 均视为可恢复错误
    const statusCode = err.statusCode || err.response?.statusCode;
    if (typeof statusCode === 'number') {
        if ([401, 403, 404, 410].includes(statusCode)) {
            return true;
        }
        if (statusCode >= 400 && statusCode < 500 && ![408, 416, 429].includes(statusCode)) {
            return true;
        }
    }

    return false;
}

/**
 * 探测远程下载链接的有效性、总大小及 Range 分片支持情况
 * 适配恶劣网络：自动重试探测请求，确定链接完全不可用再抛错
 */
async function probeUrl(url, headers, maxRetries = 5, deadline, agents = null) {
    let retries = maxRetries;
    let attempt = 0;

    while (retries >= 0) {
        if (Date.now() >= deadline) {
            const err = new Error('下载链接已超过有效期，停止探测');
            err.unrecoverable = true;
            throw err;
        }

        try {
            // 使用 HTTP/1.1 Range: bytes=0-0 的 GET 请求进行探测
            // 相比 HEAD，很多 CDN 对 HEAD 处理不规范或直接返回 403/405，而 GET 0-0 兼容性最好且能直接测出 Range 支持
            const response = await got(url, {
                method: 'GET',
                headers: {
                    ...headers,
                    Range: 'bytes=0-0'
                },
                agent: agents || undefined,
                http2: false,
                timeout: {
                    lookup: 10000,
                    connect: CONNECT_TIMEOUT_MS,
                    response: 15000,
                    request: 25000
                },
                followRedirect: true,
                maxRedirects: 5,
                throwHttpErrors: false,
                retry: { limit: 0 }
            });

            const { statusCode, headers: resHeaders } = response;

            // 遇到明确不可恢复的状态码立即退出
            if ([401, 403, 404, 410].includes(statusCode)) {
                const fatalErr = new Error(`链接不可用：HTTP ${statusCode}`);
                fatalErr.statusCode = statusCode;
                fatalErr.unrecoverable = true;
                throw fatalErr;
            }

            // 206 Partial Content：完美支持分片下载
            if (statusCode === 206) {
                const contentRange = resHeaders['content-range'];
                let totalLength = 0;
                if (contentRange) {
                    const match = String(contentRange).match(/\/(\d+)/);
                    if (match) {
                        totalLength = parseInt(match[1], 10);
                    }
                }
                return {
                    acceptsRanges: true,
                    totalLength,
                    statusCode
                };
            }

            // 200 OK：服务端忽略了 Range 头，返回了整文件（说明不支持分片或该 URL 不接受分片）
            if (statusCode === 200) {
                const totalLength = parseInt(resHeaders['content-length'], 10) || 0;
                const acceptRanges = resHeaders['accept-ranges'];
                const acceptsRanges = acceptRanges === 'bytes';
                return {
                    acceptsRanges,
                    totalLength,
                    statusCode
                };
            }

            // 416 Range Not Satisfiable：可能是空文件
            if (statusCode === 416) {
                return {
                    acceptsRanges: false,
                    totalLength: 0,
                    statusCode
                };
            }

            // 遇到 429 或 5xx 等瞬时服务错误，进入重试循环
            throw new Error(`服务器响应异常: HTTP ${statusCode}`);
        } catch (err) {
            if (isUnrecoverableError(err)) {
                throw err;
            }

            retries--;
            attempt++;
            if (retries < 0) {
                throw new Error(`连接下载服务器失败，探测已耗尽重试: ${err.message}`);
            }

            const delay = Math.min(
                BASE_RETRY_DELAY_MS * Math.pow(1.5, attempt) + Math.random() * 500,
                MAX_RETRY_DELAY_MS
            );
            await sleep(delay);
        }
    }
}

/**
 * 单流流式下载降级方案（当服务端不支持 Range、文件极小或多线程无法切片时触发）
 * 采用 HTTP 1.1 单连接，同样具备卡死检测、断点续传与高韧性指数退避重试能力
 */
async function downloadSingleStream(url, destPath, tempPath, initialTotalLength, headers, onProgress, deadline, maxRetries = 15, agents = null, signal = null) {
    let retries = maxRetries;
    let knownTotalLength = initialTotalLength || 0;
    let lastDownloadedLength = 0;
    let lastTime = Date.now();

    const reportComplete = () => {
        if (typeof onProgress === 'function') {
            const finalSize = knownTotalLength || downloadedLength;
            onProgress(100, '0.00', finalSize, finalSize);
        }
    };

    while (retries >= 0) {
        if (signal?.aborted) throw createCancelError();
        if (Date.now() >= deadline) {
            const err = new Error('下载链接已超过有效期，停止重试并退出');
            err.unrecoverable = true;
            throw err;
        }

        let downloadedLength = 0;
        if (fs.existsSync(tempPath)) {
            try {
                downloadedLength = fs.statSync(tempPath).size;
            } catch {
                downloadedLength = 0;
            }
        }

        if (knownTotalLength > 0 && downloadedLength >= knownTotalLength) {
            // 已下载完成，移动到目标路径
            if (fs.existsSync(destPath)) {
                try { fs.unlinkSync(destPath); } catch {}
            }
            fs.renameSync(tempPath, destPath);
            reportComplete();
            return;
        }

        const reqHeaders = { ...headers };
        if (downloadedLength > 0) {
            reqHeaders.Range = `bytes=${downloadedLength}-`;
        }

        lastDownloadedLength = downloadedLength;
        lastTime = Date.now();

        try {
            await new Promise((resolve, reject) => {
                let writer = null;
                let settled = false;
                let lastActivityTime = Date.now();
                let stallCheckTimer = null;
                let downloadStream = null;

                const clearTimers = () => {
                    if (stallCheckTimer) {
                        clearInterval(stallCheckTimer);
                        stallCheckTimer = null;
                    }
                };

                const onAbort = () => finish(createCancelError());

                const finish = (error = null) => {
                    if (settled) return;
                    settled = true;
                    clearTimers();
                    signal?.removeEventListener('abort', onAbort);

                    if (downloadStream && !downloadStream.destroyed) {
                        try { downloadStream.destroy(); } catch {}
                    }

                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                const remainingTime = Math.max(1000, deadline - Date.now());

                downloadStream = got.stream(url, {
                    method: 'GET',
                    headers: reqHeaders,
                    agent: agents || undefined,
                    http2: false,
                    timeout: {
                        lookup: 10000,
                        connect: CONNECT_TIMEOUT_MS,
                        request: remainingTime,
                        response: Math.min(STALL_TIMEOUT_MS, remainingTime),
                        socket: Math.min(STALL_TIMEOUT_MS, remainingTime)
                    },
                    followRedirect: true,
                    maxRedirects: 5,
                    throwHttpErrors: false,
                    retry: { limit: 0 }
                });

                signal?.addEventListener('abort', onAbort, { once: true });

                stallCheckTimer = setInterval(() => {
                    if (!settled && Date.now() - lastActivityTime > STALL_TIMEOUT_MS) {
                        finish(new Error(`单流下载卡死超过 ${STALL_TIMEOUT_MS / 1000} 秒，已中止准备重试`));
                    }
                }, 4000);

                downloadStream.on('response', (response) => {
                    lastActivityTime = Date.now();
                    const { statusCode, headers: responseHeaders } = response;

                    if (statusCode === 416) {
                        if (downloadedLength > 0) {
                            // 可能是文件已写完
                            downloadStream.resume();
                            finish();
                        } else {
                            // 损坏的分片
                            if (fs.existsSync(tempPath)) {
                                try { fs.unlinkSync(tempPath); } catch {}
                            }
                            downloadStream.resume();
                            finish(new Error('请求范围不可用 (HTTP 416)，已重置临时文件'));
                        }
                        return;
                    }

                    if (![200, 206].includes(statusCode)) {
                        const httpError = new Error(`下载失败：HTTP ${statusCode}`);
                        httpError.statusCode = statusCode;
                        httpError.unrecoverable = isUnrecoverableError(httpError);
                        downloadStream.resume();
                        finish(httpError);
                        return;
                    }

                    if (statusCode === 200) {
                        downloadedLength = 0;
                        lastDownloadedLength = 0;
                        knownTotalLength = parseInt(responseHeaders['content-length'], 10) || 0;
                    } else {
                        const contentRange = responseHeaders['content-range'];
                        if (contentRange) {
                            const match = String(contentRange).match(/\/(\d+)/);
                            if (match) knownTotalLength = parseInt(match[1], 10) || knownTotalLength;
                        } else {
                            knownTotalLength = downloadedLength + (parseInt(responseHeaders['content-length'], 10) || 0);
                        }
                    }

                    if (typeof onProgress === 'function') {
                        const percentage = knownTotalLength
                            ? Number(Math.min(100, (downloadedLength / knownTotalLength) * 100).toFixed(2))
                            : 0;
                        onProgress(percentage, '0.00', downloadedLength, knownTotalLength);
                    }

                    const shouldAppend = statusCode === 206 && downloadedLength > 0;
                    writer = fs.createWriteStream(tempPath, { flags: shouldAppend ? 'a' : 'w' });

                    writer.on('error', finish);
                    writer.on('finish', () => {
                        if (knownTotalLength > 0 && downloadedLength < knownTotalLength) {
                            finish(new Error(`网络流意外中断：接收 ${downloadedLength}/${knownTotalLength} 字节`));
                            return;
                        }
                        finish();
                    });

                    downloadStream.pipe(writer);
                });

                downloadStream.on('data', (chunk) => {
                    lastActivityTime = Date.now();
                    downloadedLength += chunk.length;

                    const now = Date.now();
                    const timeDiff = now - lastTime;
                    if (timeDiff >= 200) {
                        const percentage = knownTotalLength
                            ? Number(Math.min(100, (downloadedLength / knownTotalLength) * 100).toFixed(2))
                            : 0;
                        const bytesDiff = downloadedLength - lastDownloadedLength;
                        const speed = timeDiff > 0
                            ? (bytesDiff / (1024 * 1024)) / (timeDiff / 1000)
                            : 0;

                        if (typeof onProgress === 'function' && Number.isFinite(speed)) {
                            onProgress(percentage, speed.toFixed(2), downloadedLength, knownTotalLength);
                        }

                        lastTime = now;
                        lastDownloadedLength = downloadedLength;
                    }
                });

                downloadStream.on('error', (err) => {
                    if (writer && !writer.destroyed) {
                        try { writer.destroy(); } catch {}
                    }
                    finish(err);
                });
            });

            // 下载成功
            if (fs.existsSync(destPath)) {
                try { fs.unlinkSync(destPath); } catch {}
            }
            fs.renameSync(tempPath, destPath);
            reportComplete();
            return;
        } catch (err) {
            if (isCancelError(err)) throw err;
            if (isUnrecoverableError(err)) {
                throw new Error(`单流下载遇到不可恢复错误: ${err.message}`);
            }

            retries--;
            if (retries < 0) {
                throw new Error(`单流下载已重试耗尽: ${err.message}`);
            }

            const attempt = maxRetries - retries;
            const delay = Math.min(
                BASE_RETRY_DELAY_MS * Math.pow(1.5, Math.min(attempt, 6)) + Math.random() * 500,
                MAX_RETRY_DELAY_MS
            );
            console.warn(`⚠️ [单流模式] 下载中断，将在 ${Math.round(delay / 1000)} 秒后进行第 ${attempt}/${maxRetries} 次重试: ${err.message}`);
            await sleep(delay);
        }
    }
}

/**
 * StreamDownload 多线程流下载器核心类
 */
class StreamDownload {
    /**
     * @param {Object} [options]
     * @param {number} [options.concurrency] - 并发线程数
     * @param {number} [options.maxRetries] - 最大重试次数
     * @param {number} [options.minChunkSize] - 最小分片字节大小
     * @param {number} [options.maxChunkSize] - 最大分片字节大小
     * @param {number} [options.stallTimeoutMs] - 卡死判定超时（毫秒）
     * @param {number} [options.connectTimeoutMs] - 连接超时（毫秒）
     * @param {Object} [options.headers] - 请求头
     */
    constructor(options = {}) {
        this.options = { ...options };
    }

    /**
     * 核心下载实现
     * @param {string} url - 下载链接
     * @param {string} destPath - 目标保存路径
     * @param {Object} [options] - 选项覆盖
     * @param {Function} [onProgress] - 进度回调 (progress: number, speed: string) => void
     * @returns {Promise<void>}
     */
    async download(url, destPath, options = {}, onProgress = null) {
        if (typeof options === 'function') {
            onProgress = options;
            options = {};
        }

        const mergedOptions = { ...this.options, ...options };
        const extSignal = mergedOptions.signal || null;
        // 内部统一的中止控制器：外部取消、致命错误、降级单流都通过它终止所有在途分片请求与退避等待
        const ctl = new AbortController();
        const signal = ctl.signal;
        if (extSignal) {
            if (extSignal.aborted) ctl.abort();
            else extSignal.addEventListener('abort', () => ctl.abort(), { once: true });
        }
        const headers = mergedOptions.headers || {};
        const resumeEnabled = mergedOptions.resume !== false;
        const maxRetries = typeof mergedOptions.maxRetries === 'number' && mergedOptions.maxRetries > 0
            ? mergedOptions.maxRetries
            : DEFAULT_MAX_CHUNK_RETRIES;

        // 获取并校验并发数：优先入参，若未指定则读取系统配置
        let concurrency = Number(mergedOptions.concurrency);
        if (!concurrency || isNaN(concurrency) || concurrency <= 0) {
            concurrency = readConfiguredConcurrency();
        }
        concurrency = Math.min(64, Math.max(1, Math.round(concurrency)));

        if (!url || !destPath) {
            throw new Error('下载参数不完整：url 或目标路径为空');
        }

        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        const tempPath = `${destPath}.tmp`;
        const statePath = `${destPath}.dstate.json`;
        const deadline = Date.now() + MAX_DOWNLOAD_DURATION_MS;

        // 创建专属 HTTP 1.1 多连接 Agent 实例池，为每个线程建立独立 TCP 连接
        const agents = createHttpAgents(concurrency);

        // 统一处理“下载完成”的进度回调
        const reportComplete = () => {
            if (typeof onProgress === 'function') {
                onProgress(100, '0.00', totalLength, totalLength);
            }
        };

        // 1. 探测链接与 Range 支持情况
        console.log(`🔍 [StreamDownload] 正在探测链接属性并检测分片支持...`);
        const probeResult = await probeUrl(url, headers, 6, deadline, agents).catch((err) => {
            destroyHttpAgents(agents);
            throw err;
        });
        if (signal?.aborted) {
            destroyHttpAgents(agents);
            throw createCancelError();
        }
        const { acceptsRanges, totalLength } = probeResult;

        // 2. 检查最终目标文件是否已经完整存在
        if (fs.existsSync(destPath) && totalLength > 0) {
            try {
                const stat = fs.statSync(destPath);
                if (stat.size === totalLength) {
                    console.log(`✅ [StreamDownload] 目标文件已存在且大小匹配 (${totalLength} 字节)，跳过下载`);
                    destroyHttpAgents(agents);
                    reportComplete();
                    return;
                }
            } catch {}
        }

        // 3. 若服务端不支持 Range，或无法获取总大小，或文件极小，或并发数为 1，降级为单流高韧性下载
        if (!acceptsRanges || !totalLength || totalLength <= MIN_CHUNK_SIZE || concurrency === 1) {
            console.log(concurrency === 1
                ? `ℹ️ [StreamDownload] 并发数为 1，转入高韧性单流模式（不切片）`
                : `ℹ️ [StreamDownload] 服务端未启用 Range 分片或文件较小 (${totalLength} 字节)，转入高韧性单流模式`);
            try {
                return await downloadSingleStream(
                    url,
                    destPath,
                    tempPath,
                    totalLength,
                    headers,
                    onProgress,
                    deadline,
                    maxRetries,
                    agents,
                    signal
                );
            } finally {
                destroyHttpAgents(agents);
            }
        }

        // 4. 多线程分片规划与状态恢复
        let chunks = resumeEnabled ? this._tryRestoreState(statePath, tempPath, url, totalLength) : null;
        if (!chunks) {
            // 清理可能存在的不一致旧临时文件
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch {}
            }
            if (fs.existsSync(statePath)) {
                try { fs.unlinkSync(statePath); } catch {}
            }

            // 计算切片大小与分片列表
            // 采用动态分片策略：切片大小维持在 MIN_CHUNK_SIZE 到 MAX_CHUNK_SIZE 之间
            let idealChunkSize = Math.ceil(totalLength / (concurrency * 2));
            if (idealChunkSize < MIN_CHUNK_SIZE) idealChunkSize = MIN_CHUNK_SIZE;
            if (idealChunkSize > MAX_CHUNK_SIZE) idealChunkSize = MAX_CHUNK_SIZE;

            chunks = [];
            let offset = 0;
            let chunkId = 0;
            while (offset < totalLength) {
                const end = Math.min(offset + idealChunkSize - 1, totalLength - 1);
                chunks.push({
                    id: chunkId++,
                    start: offset,
                    end: end,
                    downloaded: 0,
                    completed: false,
                    inFlight: false,
                    retries: 0
                });
                offset = end + 1;
            }
        } else {
            console.log(`♻️ [StreamDownload] 成功加载历史下载断点，从断点处继续多线程下载`);
        }

        // 5. 打开文件句柄并预分配空间
        let fileHandle = null;
        try {
            if (!fs.existsSync(tempPath)) {
                fileHandle = await fs.promises.open(tempPath, 'w+');
                await fileHandle.truncate(totalLength);
            } else {
                fileHandle = await fs.promises.open(tempPath, 'r+');
                const curStat = await fileHandle.stat();
                if (curStat.size !== totalLength) {
                    await fileHandle.truncate(totalLength);
                }
            }
        } catch (fhErr) {
            if (fileHandle) {
                try { await fileHandle.close(); } catch {}
            }
            throw new Error(`初始化本地下载文件失败: ${fhErr.message}`);
        }

        // 6. 状态持久化机制（防抖写入磁盘，避免频繁 I/O）
        let isSavingState = false;
        let pendingSaveState = false;
        let saveStateTimeout = null;

        const doSaveState = async () => {
            if (!resumeEnabled) return;
            if (isSavingState) {
                pendingSaveState = true;
                return;
            }
            isSavingState = true;
            try {
                const payload = {
                    url,
                    totalLength,
                    updatedAt: Date.now(),
                    chunks: chunks.map(c => ({
                        id: c.id,
                        start: c.start,
                        end: c.end,
                        downloaded: c.downloaded,
                        completed: c.completed
                    }))
                };
                const tmpStatePath = `${statePath}.${process.pid}.tmp`;
                await fs.promises.writeFile(tmpStatePath, JSON.stringify(payload), 'utf8');
                await fs.promises.rename(tmpStatePath, statePath).catch(() => {});
            } catch {
                // 状态保存失败不影响主下载进度
            } finally {
                isSavingState = false;
                if (pendingSaveState) {
                    pendingSaveState = false;
                    doSaveState();
                }
            }
        };

        const triggerSaveState = (immediate = false) => {
            if (immediate) {
                if (saveStateTimeout) {
                    clearTimeout(saveStateTimeout);
                    saveStateTimeout = null;
                }
                doSaveState();
                return;
            }
            if (!saveStateTimeout) {
                saveStateTimeout = setTimeout(() => {
                    saveStateTimeout = null;
                    doSaveState();
                }, 1500);
            }
        };

        // 7. 进度统计定时器（每 200ms 计算总体下载速度与百分比）
        // 速度按“网络接收字节”统计（实时、不受写盘聚合影响）；百分比/已下载量按已落盘字节统计（可靠、可断点续传）
        const netStats = { bytes: 0 };
        let lastReportedBytes = chunks.reduce((sum, c) => sum + c.downloaded, 0);
        let lastNetBytes = 0;
        let lastReportedTime = Date.now();
        let progressTimer = null;

        if (typeof onProgress === 'function') {
            const initialPercent = totalLength > 0
                ? Number(Math.min(100, (lastReportedBytes / totalLength) * 100).toFixed(2))
                : 0;
            onProgress(initialPercent, '0.00', lastReportedBytes, totalLength);

            progressTimer = setInterval(() => {
                const now = Date.now();
                const timeDiff = now - lastReportedTime;
                if (timeDiff <= 0) return;

                const currentDownloaded = chunks.reduce((sum, c) => sum + c.downloaded, 0);
                const netDiff = netStats.bytes - lastNetBytes;
                const speedMBs = (netDiff / (1024 * 1024)) / (timeDiff / 1000);

                const validSpeed = (Number.isFinite(speedMBs) && speedMBs >= 0)
                    ? speedMBs.toFixed(2)
                    : '0.00';

                const percent = totalLength > 0
                    ? Number(Math.min(100, (currentDownloaded / totalLength) * 100).toFixed(2))
                    : 0;

                onProgress(percent, validSpeed, currentDownloaded, totalLength);

                lastReportedBytes = currentDownloaded;
                lastNetBytes = netStats.bytes;
                lastReportedTime = now;
            }, 200);
        }

        // 8. 多线程工作池执行
        let fatalError = null;
        const failFast = (err) => {
            fatalError = fatalError || err;
            ctl.abort();
        };
        let globalConsecutiveFailures = 0;
        const effectiveConcurrency = Math.min(concurrency, chunks.length);
        const stallTimeoutMs = typeof mergedOptions.stallTimeoutMs === 'number' && mergedOptions.stallTimeoutMs > 0
            ? mergedOptions.stallTimeoutMs
            : STALL_TIMEOUT_MS;
        const connectTimeoutMs = typeof mergedOptions.connectTimeoutMs === 'number' && mergedOptions.connectTimeoutMs > 0
            ? mergedOptions.connectTimeoutMs
            : CONNECT_TIMEOUT_MS;

        const downloadContext = {
            url,
            headers,
            tempPath,
            deadline,
            agents,
            signal,
            netStats,
            stallTimeoutMs,
            connectTimeoutMs
        };

        console.log(`🚀 [StreamDownload] 启动 HTTP/1.1 多连接流下载，连接数/线程数: ${effectiveConcurrency}，总分片数: ${chunks.length}，文件总大小: ${(totalLength / (1024 * 1024)).toFixed(2)} MB`);

        // 动态再分段：没有待下载分片时，挑“预计剩余耗时”最长的在途分片，从中点切开，空闲线程接管后半段（类似 IDM）
        let nextChunkId = chunks.reduce((max, c) => Math.max(max, c.id), -1) + 1;
        const stealFromSlowestChunk = () => {
            const now = Date.now();
            const active = chunks.filter(c => !c.completed && c.inFlight);
            if (active.length === 0) return null;

            // 估算分片当前速度（B/s）：最近无数据时按空闲时长衰减，刚启动尚无样本的分片使用其他分片均值
            const measured = (c) => {
                const idleMs = Math.max(1, now - (c.sampleTime || now));
                const pending = (c.sampleBytes || 0) * 1000 / idleMs;
                if (!c.speed) return pending > 0 ? pending : null;
                return idleMs > 1000 ? Math.min(c.speed, pending) : c.speed;
            };
            const known = active.map(measured).filter(s => s !== null && s > 0);
            const avgSpeed = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
            const speedOf = (c) => {
                const s = measured(c);
                if (s !== null && s > 0) return Math.max(s, 1024);
                const age = now - (c.sampleTime || now);
                // 刚启动的分片给予宽限期；超过宽限仍无数据视为几乎停滞
                return age < 3000 && avgSpeed > 0 ? avgSpeed : 1024;
            };

            let target = null;
            let targetEta = 0;
            let targetRemaining = 0;
            for (const c of active) {
                const remaining = c.end - (c.start + c.downloaded) + 1;
                if (remaining < MIN_STEAL_SIZE) continue;
                const eta = remaining / speedOf(c);
                if (eta > targetEta) {
                    target = c;
                    targetEta = eta;
                    targetRemaining = remaining;
                }
            }
            // 预计很快就能下完的分片不值得再拆，新建连接的开销反而更大
            if (!target || targetEta < MIN_STEAL_ETA_SECONDS) return null;

            const splitStart = target.start + target.downloaded + Math.ceil(targetRemaining / 2);
            const stolen = {
                id: nextChunkId++,
                start: splitStart,
                end: target.end,
                downloaded: 0,
                completed: false,
                inFlight: true,
                retries: 0
            };
            target.end = splitStart - 1;
            chunks.splice(chunks.indexOf(target) + 1, 0, stolen);
            triggerSaveState(false);
            return stolen;
        };

        const claimNextChunk = () => {
            for (const chunk of chunks) {
                if (!chunk.completed && !chunk.inFlight) {
                    chunk.inFlight = true;
                    return chunk;
                }
            }
            return stealFromSlowestChunk();
        };

        const allChunksCompleted = () => {
            return chunks.every(c => c.completed);
        };

        const workerLoop = async (workerId) => {
            while (!fatalError && !allChunksCompleted() && Date.now() < deadline) {
                const chunk = claimNextChunk();
                if (!chunk) {
                    if (allChunksCompleted()) break;
                    // 暂无空闲分片，稍等其他线程
                    await sleep(200, signal);
                    continue;
                }

                let chunkDone = false;
                while (!chunkDone && !fatalError && Date.now() < deadline) {
                    try {
                        await this._downloadChunkStream(chunk, fileHandle, downloadContext);
                        chunkDone = true;
                        chunk.completed = true;
                        chunk.inFlight = false;
                        globalConsecutiveFailures = 0;
                        triggerSaveState(false);
                    } catch (err) {
                        if (signal.aborted) {
                            fatalError = fatalError || createCancelError();
                            chunk.inFlight = false;
                            throw fatalError;
                        }

                        // 检查是否需要直接降级单流模式
                        if (err.code === 'FALLBACK_TO_SINGLE_STREAM') {
                            failFast(err);
                            throw err;
                        }

                        // 检查不可恢复错误
                        if (isUnrecoverableError(err)) {
                            failFast(err);
                            chunk.inFlight = false;
                            throw err;
                        }

                        chunk.retries = (chunk.retries || 0) + 1;
                        globalConsecutiveFailures++;

                        console.warn(`⚠️ [线程 ${workerId + 1}] 分片 #${chunk.id} [${chunk.start}-${chunk.end}] 异常 (${err.message})，已重试 ${chunk.retries}/${maxRetries} 次`);

                        // 416 异常：通常由于服务端不接受当前断点偏移，自愈方案：重置该分片已下载偏移重新拉取
                        if (err.statusCode === 416) {
                            chunk.downloaded = 0;
                        }

                        // 单分片重试超限
                        if (chunk.retries >= maxRetries) {
                            const chunkErr = new Error(`分片 #${chunk.id} 连续重试 ${maxRetries} 次失败，确定网络异常或链接失效: ${err.message}`);
                            chunkErr.unrecoverable = true;
                            failFast(chunkErr);
                            chunk.inFlight = false;
                            throw chunkErr;
                        }

                        // 全局连续失败超限（表明完全断网或链接被封）
                        if (globalConsecutiveFailures >= MAX_GLOBAL_CONSECUTIVE_FAILURES) {
                            const globalErr = new Error(`多线程下载连续失败 ${MAX_GLOBAL_CONSECUTIVE_FAILURES} 次，确定网络连接已彻底断开或失效`);
                            globalErr.unrecoverable = true;
                            failFast(globalErr);
                            chunk.inFlight = false;
                            throw globalErr;
                        }

                        // 指数退避等待 + 随机抖动
                        const delay = Math.min(
                            BASE_RETRY_DELAY_MS * Math.pow(1.5, Math.min(chunk.retries, 6)) + Math.random() * 800,
                            MAX_RETRY_DELAY_MS
                        );
                        await sleep(delay, signal);
                    }
                }
            }
        };

        // 外部取消触发时，若尚无其他错误则记为取消
        const onAbort = () => {
            fatalError = fatalError || createCancelError();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        try {
            const workers = [];
            for (let i = 0; i < effectiveConcurrency; i++) {
                workers.push(workerLoop(i));
            }
            // 等待所有 worker 彻底退出（在途请求已中止）后再处理错误或降级，避免旧流继续写文件
            await Promise.allSettled(workers);

            if (fatalError) {
                throw fatalError;
            }

            if (!allChunksCompleted()) {
                if (Date.now() >= deadline) {
                    throw new Error('下载链接已超过 1 小时 50 分钟有效期，已停止下载');
                }
                throw new Error('多线程下载未能在预期内完成所有分片');
            }

            // 9. 下载完成，强制刷盘并校验文件完整性
            await fileHandle.sync();
            await fileHandle.close();
            fileHandle = null;

            const finalStat = await fs.promises.stat(tempPath);
            if (finalStat.size !== totalLength) {
                throw new Error(`下载文件大小校验失败：磁盘文件 ${finalStat.size} 字节，预期 ${totalLength} 字节`);
            }

            // 清理进度状态文件
            if (saveStateTimeout) {
                clearTimeout(saveStateTimeout);
                saveStateTimeout = null;
            }
            if (fs.existsSync(statePath)) {
                try { await fs.promises.unlink(statePath); } catch {}
            }

            // 原子替换临时文件为目标文件
            if (fs.existsSync(destPath)) {
                try { await fs.promises.unlink(destPath); } catch {}
            }
            await fs.promises.rename(tempPath, destPath);

            console.log(`🎉 [StreamDownload] 下载完成: ${path.basename(destPath)}`);
            reportComplete();
        } catch (err) {
            // 如果遇到需要降级单流模式的场景
            if (err.code === 'FALLBACK_TO_SINGLE_STREAM') {
                console.warn(`⚠️ [StreamDownload] 检测到服务端无法维持多线程 Range 请求，平滑降级为单流高韧性下载...`);
                if (progressTimer) {
                    clearInterval(progressTimer);
                    progressTimer = null;
                }
                if (saveStateTimeout) {
                    clearTimeout(saveStateTimeout);
                    saveStateTimeout = null;
                }
                if (fileHandle) {
                    try { await fileHandle.close(); } catch {}
                    fileHandle = null;
                }
                if (fs.existsSync(tempPath)) {
                    try { await fs.promises.unlink(tempPath); } catch {}
                }
                if (fs.existsSync(statePath)) {
                    try { await fs.promises.unlink(statePath); } catch {}
                }
                return await downloadSingleStream(
                    url,
                    destPath,
                    tempPath,
                    totalLength,
                    headers,
                    onProgress,
                    deadline,
                    maxRetries,
                    agents,
                    extSignal
                );
            }

            // 失败时立即落盘最新断点，供重试时续传
            if (!isCancelError(err)) {
                if (!resumeEnabled) {
                    if (fileHandle) {
                        try { await fileHandle.close(); } catch {}
                        fileHandle = null;
                    }
                    try { fs.unlinkSync(tempPath); } catch {}
                    try { fs.unlinkSync(statePath); } catch {}
                    throw err;
                }
                try { if (fileHandle) await fileHandle.sync(); } catch {}
                try {
                    fs.writeFileSync(statePath, JSON.stringify({
                        url,
                        totalLength,
                        updatedAt: Date.now(),
                        chunks: chunks.map(c => ({
                            id: c.id,
                            start: c.start,
                            end: c.end,
                            downloaded: c.downloaded,
                            completed: c.completed
                        }))
                    }), 'utf8');
                } catch {}
            }
            throw err;
        } finally {
            signal.removeEventListener('abort', onAbort);
            destroyHttpAgents(agents);
            if (progressTimer) {
                clearInterval(progressTimer);
                progressTimer = null;
            }
            if (saveStateTimeout) {
                clearTimeout(saveStateTimeout);
                saveStateTimeout = null;
            }
            if (fileHandle) {
                try { await fileHandle.close(); } catch {}
                fileHandle = null;
            }
        }
    }

    /**
     * 单个分片的流式拉取与断点拼接写入
     */
    _downloadChunkStream(chunk, fileHandle, context) {
        const { url, headers, deadline } = context;
        const fromByte = chunk.start + chunk.downloaded;
        const toByte = chunk.end;

        if (fromByte > toByte) {
            chunk.completed = true;
            return Promise.resolve();
        }

        let receivedInStream = 0;
        chunk.speed = 0;
        chunk.sampleBytes = 0;
        chunk.sampleTime = Date.now();

        const reqHeaders = {
            ...headers,
            Range: `bytes=${fromByte}-${toByte}`
        };

        const remainingTime = Math.max(1000, deadline - Date.now());

        return new Promise((resolve, reject) => {
            let settled = false;
            let lastActivityTime = Date.now();
            let stallTimer = null;
            let downloadStream = null;

            const onAbort = () => finish(createCancelError());
            if (context.signal) {
                if (context.signal.aborted) {
                    reject(createCancelError());
                    return;
                }
                context.signal.addEventListener('abort', onAbort, { once: true });
            }

            const cleanup = () => {
                context.signal?.removeEventListener('abort', onAbort);
                if (stallTimer) {
                    clearInterval(stallTimer);
                    stallTimer = null;
                }
            };

            const finish = (err) => {
                if (settled) return;
                settled = true;
                cleanup();

                if (downloadStream && !downloadStream.destroyed) {
                    try { downloadStream.destroy(); } catch {}
                }

                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };

            const stallTimeout = context.stallTimeoutMs || STALL_TIMEOUT_MS;
            const connectTimeout = context.connectTimeoutMs || CONNECT_TIMEOUT_MS;

            // 分片活跃看门狗定时器：超过 stallTimeout 未收到数据则主动中断并触发重试
            const checkInterval = Math.max(500, Math.min(4000, Math.floor(stallTimeout / 3)));
            stallTimer = setInterval(() => {
                if (settled) return;
                if (Date.now() - lastActivityTime > stallTimeout) {
                    finish(new Error(`分片 [${chunk.id}] 数据接收卡死超过 ${(stallTimeout / 1000).toFixed(1)} 秒`));
                }
            }, checkInterval);

            try {
                downloadStream = got.stream(url, {
                    method: 'GET',
                    headers: reqHeaders,
                    agent: context.agents || undefined,
                    http2: false,
                    timeout: {
                        lookup: 10000,
                        connect: connectTimeout,
                        request: remainingTime,
                        response: Math.min(stallTimeout, remainingTime),
                        socket: Math.min(stallTimeout, remainingTime)
                    },
                    followRedirect: true,
                    maxRedirects: 5,
                    throwHttpErrors: false,
                    retry: { limit: 0 }
                });
            } catch (initErr) {
                finish(initErr);
                return;
            }

            downloadStream.on('response', (response) => {
                lastActivityTime = Date.now();
                const { statusCode } = response;

                if (statusCode === 416) {
                    const rangeErr = new Error(`分片 [${chunk.id}] 请求 Range 无法满足 (HTTP 416)`);
                    rangeErr.statusCode = 416;
                    finish(rangeErr);
                    return;
                }

                // 若请求部分范围却返回 200，说明服务端已不接受 Range，需要降级
                if (statusCode === 200) {
                    const fallbackErr = new Error(`服务端不再响应 Range 分片，返回 HTTP 200`);
                    fallbackErr.code = 'FALLBACK_TO_SINGLE_STREAM';
                    fallbackErr.statusCode = 200;
                    finish(fallbackErr);
                    return;
                }

                if (statusCode !== 206) {
                    const httpErr = new Error(`分片下载响应异常: HTTP ${statusCode}`);
                    httpErr.statusCode = statusCode;
                    httpErr.unrecoverable = isUnrecoverableError(httpErr);
                    finish(httpErr);
                    return;
                }
            });

            // 自定义可写流，使用底层 FileHandle 的绝对位置写入，具备完美背压管控
            // 小块网络数据先聚合，累计到 WRITE_FLUSH_BYTES 或超过 WRITE_FLUSH_INTERVAL_MS 再一次性落盘，减少写入调用次数
            let currentWriteOffset = fromByte; // 已接收（含缓冲中）的末尾偏移
            let pendingBuffers = [];
            let pendingBytes = 0;
            let pendingPos = fromByte; // 缓冲区首字节对应的文件偏移
            let lastFlushTime = Date.now();

            const flushPending = async () => {
                if (pendingBytes === 0) return;
                const pos = pendingPos;
                const merged = pendingBuffers.length === 1 ? pendingBuffers[0] : Buffer.concat(pendingBuffers, pendingBytes);
                pendingBuffers = [];
                pendingBytes = 0;
                pendingPos = pos + merged.length;
                // 分片尾部可能在缓冲期间被空闲线程接管，只写入仍属于本分片的部分
                const writeLen = Math.min(merged.length, chunk.end + 1 - pos);
                if (writeLen <= 0) return;
                await fileHandle.write(merged, 0, writeLen, pos);
                chunk.downloaded += writeLen;
                receivedInStream += writeLen;
                lastFlushTime = Date.now();
            };

            const writable = new Writable({
                highWaterMark: 1024 * 1024,
                write(buf, encoding, cb) {
                    const now = Date.now();
                    lastActivityTime = now;
                    const pos = currentWriteOffset;
                    // 分片尾部已被接管（chunk.end 缩小）：落盘已缓冲数据，丢弃超出部分并结束本流
                    const allowed = chunk.end + 1 - pos;
                    if (allowed <= 0) {
                        flushPending().then(() => { cb(); finish(); }, cb);
                        return;
                    }
                    const data = buf.length > allowed ? buf.subarray(0, allowed) : buf;
                    pendingBuffers.push(data);
                    pendingBytes += data.length;
                    if (context.netStats) context.netStats.bytes += data.length;
                    currentWriteOffset += data.length;

                    // 采样分片速度，供再分段时判断最慢分片
                    chunk.sampleBytes = (chunk.sampleBytes || 0) + data.length;
                    const sampleSpan = now - chunk.sampleTime;
                    if (sampleSpan >= SPEED_SAMPLE_INTERVAL_MS) {
                        const instant = chunk.sampleBytes * 1000 / sampleSpan;
                        chunk.speed = chunk.speed ? 0.6 * instant + 0.4 * chunk.speed : instant;
                        chunk.sampleBytes = 0;
                        chunk.sampleTime = now;
                    }

                    const reachedEnd = currentWriteOffset > chunk.end;
                    if (reachedEnd || pendingBytes >= WRITE_FLUSH_BYTES || now - lastFlushTime >= WRITE_FLUSH_INTERVAL_MS) {
                        flushPending().then(() => {
                            cb();
                            if (currentWriteOffset > chunk.end) finish();
                        }, cb);
                    } else {
                        cb();
                    }
                },
                final(cb) {
                    flushPending().then(() => cb(), cb);
                }
            });

            pipeline(downloadStream, writable, (err) => {
                if (err) {
                    // 若发生 HTTP/2 会话协议异常，自动降级为 HTTP/1.1
                    if (err.message && (
                        err.message.includes('HTTP/2') ||
                        err.message.includes('NGHTTP2') ||
                        err.code === 'ERR_HTTP2_ERROR'
                    )) {
                        context.useHttp2 = false;
                    }
                    finish(err);
                } else {
                    const currentExpected = chunk.end - fromByte + 1;
                    if (receivedInStream < currentExpected) {
                        finish(new Error(`分片 [${chunk.id}] 数据流过早关闭，接收 ${receivedInStream}/${currentExpected} 字节`));
                    } else {
                        finish();
                    }
                }
            });
        });
    }

    /**
     * 尝试从本地持久化状态恢复分片下载进度
     */
    _tryRestoreState(statePath, tempPath, url, totalLength) {
        if (!fs.existsSync(statePath) || !fs.existsSync(tempPath)) {
            return null;
        }

        try {
            const fileStat = fs.statSync(tempPath);
            if (fileStat.size !== totalLength) {
                return null;
            }

            const raw = fs.readFileSync(statePath, 'utf8');
            const state = JSON.parse(raw);
            if (!state || state.totalLength !== totalLength) {
                return null;
            }

            if (!isSameResource(state.url, url, state.totalLength, totalLength)) {
                return null;
            }

            if (!Array.isArray(state.chunks) || state.chunks.length === 0) {
                return null;
            }

            // 校验分片区间的连续性与完整性
            let expectedStart = 0;
            for (const c of state.chunks) {
                if (c.start !== expectedStart || c.end < c.start) return null;
                expectedStart = c.end + 1;
            }
            if (expectedStart !== totalLength) return null;

            return state.chunks.map(c => {
                const expectedSize = c.end - c.start + 1;
                const downloaded = Math.min(Math.max(0, c.downloaded || 0), expectedSize);
                return {
                    id: c.id,
                    start: c.start,
                    end: c.end,
                    downloaded: downloaded,
                    completed: downloaded >= expectedSize,
                    inFlight: false,
                    retries: 0
                };
            });
        } catch {
            return null;
        }
    }

    /**
     * 静态便捷调用方法
     */
    static async download(url, destPath, options = {}, onProgress = null) {
        const downloader = new StreamDownload(options);
        return downloader.download(url, destPath, options, onProgress);
    }
}

/**
 * 与原有 stream_download.downloadFileWithGot 调用方式完全一致的多线程流下载对外接口
 * @param {string} url - 下载链接
 * @param {string} destPath - 目标保存路径
 * @param {Object} [headers] - HTTP 请求头
 * @param {Function} [onProgress] - 进度回调 (progress: number, speed: string) => void
 * @param {number} [maxRetries] - 最大重试次数
 * @param {number} [concurrency] - 并发线程数（不传则读取系统设置）
 * @returns {Promise<void>}
 */
async function downloadFileWithGotMulti(url, destPath, headers = {}, onProgress = null, maxRetries = 15, concurrency = null, signal = null, extra = {}) {
    if (typeof headers === 'function') {
        concurrency = typeof maxRetries === 'number' ? maxRetries : null;
        maxRetries = typeof onProgress === 'number' ? onProgress : 15;
        onProgress = headers;
        headers = {};
    }

    const downloader = new StreamDownload({
        concurrency,
        maxRetries,
        headers
    });

    return downloader.download(
        url,
        destPath,
        { headers, maxRetries, concurrency, signal, resume: extra?.resume !== false },
        onProgress
    );
}

const downloadFileWithGot = downloadFileWithGotMulti;

module.exports = {
    StreamDownload,
    downloadFileWithGotMulti,
    downloadFileWithGot,
    default: downloadFileWithGotMulti
};
