const fs = require('fs');
const path = require('path');
const got = require('got');

// 构造“本地残留分片不可继续使用”的统一错误对象，供外层捕获后清理并重下。
function createStalePartialFileError(destPath) {
    const error = new Error(`检测到残留的临时文件与当前下载范围不匹配，准备从头重新下载: ${path.basename(destPath)}`);
    error.code = 'STALE_PARTIAL_FILE';
    return error;
}

// 判断错误是否不适合继续重试：
// - 本地文件系统错误（权限、路径、磁盘空间等）
// - 大部分 4xx HTTP 错误（说明请求本身就无效）
function isNonRetriableError(err) {
    const nonRetriableFsCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'EINVAL', 'EISDIR', 'EBUSY']);

    if (err?.nonRetriable) return true;
    if (err?.code && nonRetriableFsCodes.has(err.code)) return true;

    if (typeof err?.statusCode === 'number') {
        return err.statusCode >= 400 && err.statusCode < 500 && ![408, 409, 413, 429].includes(err.statusCode);
    }

    return false;
}

// 流式下载文件，支持：
// 1. 断点续传
// 2. 进度/速度回调
// 3. 卡住超时检测
// 4. 外层自定义指数退避重试
async function downloadFileWithGot(url, destPath, headers, onProgress, maxRetries = 4) {
    if (!url || !destPath) {
        throw new Error('下载参数不完整：url 或保存路径为空');
    }

    const MAX_DOWNLOAD_DURATION_MS = 110 * 60 * 1000; // 1小时50分钟
    const STALL_TIMEOUT_MS = 15 * 1000; // 15秒无数据判定为卡住
    const BASE_RETRY_DELAY_MS = 1000; // 指数退避起始等待时间 1 秒
    const MAX_RETRY_DELAY_MS = 8000; // 指数退避最大等待时间 8 秒
    const deadline = Date.now() + MAX_DOWNLOAD_DURATION_MS;
    let retries = maxRetries;
    let knownTotalLength = 0;

    // 统一处理“下载完成”的进度回调，避免多个分支重复写相同逻辑。
    const reportComplete = () => {
        if (typeof onProgress === 'function') {
            onProgress(100, '0.00');
        }
    };

    while (retries >= 0) {
        try {
            if (Date.now() >= deadline) {
                throw new Error('下载链接已超过 1 小时 50 分钟有效期，停止重试并退出');
            }

            // 读取本地已下载大小；若已有部分文件，则尝试使用 Range 续传。
            let downloadedLength = 0;
            if (fs.existsSync(destPath)) {
                downloadedLength = fs.statSync(destPath).size;
            }

            // 如果已知总大小且本地文件已经完整，则直接结束。
            if (knownTotalLength > 0 && downloadedLength >= knownTotalLength) {
                reportComplete();
                return;
            }

            const reqHeaders = { ...headers };
            if (downloadedLength > 0) {
                reqHeaders.Range = `bytes=${downloadedLength}-`;
            }

            let lastDownloadedLength = downloadedLength;
            let lastTime = Date.now();

            await new Promise((resolve, reject) => {
                let writer = null;
                let settled = false;
                let lastActivityTime = Date.now();
                let stallCheckTimer = null;

                const updateActivity = () => {
                    lastActivityTime = Date.now();
                };

                const clearStallCheckTimer = () => {
                    if (stallCheckTimer) {
                        clearInterval(stallCheckTimer);
                        stallCheckTimer = null;
                    }
                };

                const finish = (error = null) => {
                    if (settled) return;
                    settled = true;
                    clearStallCheckTimer();

                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                };

                const remainingTime = Math.max(1, deadline - Date.now());

                // 禁用 got 自带 retry，仅保留本文件外层的统一重试策略，避免重复重试。
                const downloadStream = got.stream(url, {
                    method: 'GET',
                    headers: reqHeaders,
                    timeout: {
                        request: remainingTime,
                        response: Math.min(STALL_TIMEOUT_MS, remainingTime),
                        socket: Math.min(STALL_TIMEOUT_MS, remainingTime)
                    },
                    followRedirect: true,
                    maxRedirects: 5,
                    http2: true,
                    throwHttpErrors: false,
                    retry: {
                        limit: 0
                    }
                });

                // 定时检查是否长时间没有收到数据，避免连接假死一直挂住。
                stallCheckTimer = setInterval(() => {
                    if (!settled && Date.now() - lastActivityTime > STALL_TIMEOUT_MS) {
                        downloadStream.destroy(new Error(`下载卡住超过 ${STALL_TIMEOUT_MS / 1000} 秒，已中止并准备重试`));
                    }
                }, 5000);

                downloadStream.on('response', (response) => {
                    updateActivity();

                    const { statusCode, headers: responseHeaders } = response;

                    // 416 表示当前请求的 Range 不可用：
                    // - 如果本地文件其实已经完整，则直接视为成功
                    // - 否则说明分片文件不可信，需要删除后重下
                    if (statusCode === 416) {
                        const contentRange = responseHeaders['content-range'];
                        const totalFromRange = contentRange ? parseInt(String(contentRange).split('/')[1], 10) : 0;
                        const resolvedTotalLength = totalFromRange || knownTotalLength;

                        if (resolvedTotalLength > 0) {
                            knownTotalLength = resolvedTotalLength;
                        }

                        if (downloadedLength > 0 && resolvedTotalLength > 0 && downloadedLength >= resolvedTotalLength) {
                            reportComplete();
                            downloadStream.resume();
                            finish();
                        } else {
                            downloadStream.resume();
                            finish(createStalePartialFileError(destPath));
                        }
                        return;
                    }

                    // 仅接受 200（整文件响应）和 206（部分内容响应）。
                    // 其他状态码一律作为下载失败处理。
                    if (![200, 206].includes(statusCode)) {
                        const httpError = new Error(`下载失败：HTTP ${statusCode}`);
                        httpError.code = 'HTTP_STATUS_ERROR';
                        httpError.statusCode = statusCode;
                        httpError.nonRetriable = statusCode >= 400 && statusCode < 500 && ![408, 409, 413, 429].includes(statusCode);
                        downloadStream.resume();
                        finish(httpError);
                        return;
                    }

                    // 200 说明服务端忽略了 Range，需要从头覆盖写。
                    // 206 说明服务端接受了续传，继续追加并解析总大小。
                    if (statusCode === 200) {
                        downloadedLength = 0;
                        lastDownloadedLength = 0;
                        knownTotalLength = parseInt(responseHeaders['content-length'], 10) || 0;
                    } else {
                        const contentRange = responseHeaders['content-range'];
                        if (contentRange) {
                            knownTotalLength = parseInt(String(contentRange).split('/')[1], 10) || 0;
                        } else {
                            knownTotalLength = downloadedLength + (parseInt(responseHeaders['content-length'], 10) || 0);
                        }
                    }

                    if (knownTotalLength > 0 && downloadedLength >= knownTotalLength) {
                        reportComplete();
                        downloadStream.resume();
                        finish();
                        return;
                    }

                    // 续传场景使用追加写入；否则覆盖旧文件重新写。
                    const shouldAppend = statusCode === 206 && downloadedLength > 0;
                    writer = fs.createWriteStream(destPath, { flags: shouldAppend ? 'a' : 'w' });

                    writer.on('error', finish);
                    writer.on('finish', () => {
                        if (knownTotalLength > 0 && downloadedLength < knownTotalLength) {
                            finish(new Error('网络流意外关闭，文件未下载完整'));
                            return;
                        }

                        reportComplete();
                        finish();
                    });

                    downloadStream.pipe(writer);
                });

                downloadStream.on('data', (chunk) => {
                    updateActivity();
                    downloadedLength += chunk.length;

                    const now = Date.now();
                    const timeDiff = now - lastTime;

                    // 节流更新进度，避免过于频繁地向 UI 发送消息。
                    if (timeDiff >= 400) {
                        const percentage = knownTotalLength
                            ? Math.min(100, Math.round((downloadedLength / knownTotalLength) * 100))
                            : 0;
                        const bytesDiff = downloadedLength - lastDownloadedLength;
                        const speed = timeDiff > 0
                            ? (bytesDiff / (1024 * 1024)) / (timeDiff / 1000)
                            : 0;

                        if (typeof onProgress === 'function' && Number.isFinite(speed)) {
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

                    finish(err);
                });
            });

            return;
        } catch (err) {
            // 本地分片文件无效时，先删掉旧文件，再立即进入下一轮重试。
            if (err.code === 'STALE_PARTIAL_FILE') {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
                knownTotalLength = 0;
                console.warn(`⚠️ ${err.message}`);
                continue;
            }

            // 超过下载链接允许的最长生命周期后，不再继续重试。
            if (Date.now() >= deadline) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }

            // 对确定不可恢复的问题直接失败，避免浪费时间反复尝试。
            if (isNonRetriableError(err)) {
                throw new Error(`下载失败：${err.message}`);
            }

            retries--;
            if (retries < 0) {
                throw new Error(`下载失败，已重试耗尽: ${err.message}`);
            }

            // 使用指数退避：1s / 2s / 4s / 8s，降低短时间内连续重连的压力。
            const retryAttempt = maxRetries - retries;
            const exponentialDelay = Math.min(BASE_RETRY_DELAY_MS * (2 ** (retryAttempt - 1)), MAX_RETRY_DELAY_MS);
            const waitTime = Math.min(exponentialDelay, Math.max(0, deadline - Date.now()));

            if (waitTime <= 0) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }

            console.warn(`⚠️ 下载中断，将在 ${Math.round(waitTime / 1000)} 秒后进行第 ${retryAttempt}/${maxRetries} 次重试 - 错误: ${err.message}`);
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
}

module.exports = {
    downloadFileWithGot
};
