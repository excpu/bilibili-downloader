const fs = require('fs');
const path = require('path');
const got = require('got');

// 使用 got 流式下载文件并计算进度（支持断点续传）
async function downloadFileWithGot(url, destPath, headers, onProgress, maxRetries = 5) {
    const MAX_DOWNLOAD_DURATION_MS = 110 * 60 * 1000; // 1小时50分钟
    const STALL_TIMEOUT_MS = 15 * 1000; // 15秒无数据判定为卡住
    const INTERNAL_RETRY_DELAY_MS = 1000; // got 内部快速重试 1 秒
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
                if (onProgress) onProgress(100, '0.00');
                return;
            }

            let lastDownloadedLength = downloadedLength;
            let lastTime = Date.now();

            await new Promise((resolve, reject) => {
                let writer = null;
                let settled = false;
                let lastActivityTime = Date.now();
                let stallCheckTimer = null;

                const clearStallCheckTimer = () => {
                    if (stallCheckTimer) {
                        clearInterval(stallCheckTimer);
                        stallCheckTimer = null;
                    }
                };

                const updateActivity = () => {
                    lastActivityTime = Date.now();
                };

                const finish = (error) => {
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
                    retry: {
                        limit: Math.min(1, maxRetries),
                        methods: ['GET'],
                        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
                        errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'],
                        calculateDelay: ({ attemptCount, retryOptions }) => {
                            if (Date.now() >= deadline || attemptCount > retryOptions.limit) {
                                return 0;
                            }
                            return INTERNAL_RETRY_DELAY_MS;
                        }
                    }
                });

                stallCheckTimer = setInterval(() => {
                    if (!settled && Date.now() - lastActivityTime > STALL_TIMEOUT_MS) {
                        downloadStream.destroy(new Error(`下载卡住超过 ${STALL_TIMEOUT_MS / 1000} 秒，已中止并准备重试`));
                    }
                }, 5000);

                downloadStream.on('retry', (retryCount, error) => {
                    updateActivity();
                    console.warn(`⚠️ 下载遇到网络波动，got 正在快速重试... (第 ${retryCount} 次) - 错误: ${error.message}`);
                });

                downloadStream.on('response', (response) => {
                    updateActivity();

                    if (response.statusCode === 416) {
                        downloadStream.destroy();
                        const staleFileError = new Error('检测到残留的临时文件与当前下载范围不匹配，准备从头重新下载');
                        staleFileError.code = 'STALE_PARTIAL_FILE';
                        finish(staleFileError);
                        return;
                    }

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
                        if (onProgress) onProgress(100, '0.00');
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
                            if (onProgress) onProgress(100, '0.00');
                            finish();
                        }
                    });

                    downloadStream.pipe(writer);
                });

                downloadStream.on('data', (chunk) => {
                    updateActivity();
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
                        const staleFileError = new Error('检测到残留的临时文件与当前下载范围不匹配，准备从头重新下载');
                        staleFileError.code = 'STALE_PARTIAL_FILE';
                        finish(staleFileError);
                        return;
                    }

                    finish(err);
                });
            });

            return;
        } catch (err) {
            if (err.code === 'STALE_PARTIAL_FILE') {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
                totalLength = 0;
                console.warn(`⚠️ 检测到残留的半截文件，已清理并从头重新下载: ${path.basename(destPath)}`);
                continue;
            }

            if (Date.now() >= deadline) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }

            retries--;
            if (retries < 0) {
                throw new Error(`下载失败，已重试耗尽: ${err.message}`);
            }

            console.warn(`⚠️ 下载中断，正在尝试断点续传... (剩余重试次数: ${retries}) - 错误: ${err.message}`);

            const waitTime = Math.min(2000, Math.max(0, deadline - Date.now()));
            if (waitTime <= 0) {
                throw new Error(`下载失败：已超过 1 小时 50 分钟有效期，停止重试并退出。原始错误: ${err.message}`);
            }
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
}

module.exports = {
    downloadFileWithGot
};
