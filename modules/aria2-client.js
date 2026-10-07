const WebSocket = require('ws');
const fs = require('fs');

class Aria2Client {
    /**
     * @param {Object} options 
     * @param {string} options.host RPC 地址，默认 'ws://localhost:6800/jsonrpc'
     * @param {string} options.secret RPC 密钥，没有可为空
     */
    constructor(options = {}) {
        this.host = options.host || 'ws://localhost:6800/jsonrpc';
        this.secret = options.secret || '';
        this.ws = null;
        this.msgId = 0;
        this.callbacks = {};
    }

    // 建立连接
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.host);

            this.ws.on('open', () => {
                resolve();
            });

            this.ws.on('message', (data) => {
                const response = JSON.parse(data);

                // 处理我们主动发出的 RPC 请求的回调
                if (response.id && this.callbacks[response.id]) {
                    if (response.error) {
                        // JSON-RPC 错误是普通对象（{code, message}），统一包装为 Error，避免上层 err.message 取值异常
                        const rpcError = new Error(response.error.message || 'Aria2 RPC 请求失败');
                        rpcError.code = response.error.code;
                        this.callbacks[response.id].reject(rpcError);
                    } else {
                        this.callbacks[response.id].resolve(response.result);
                    }
                    delete this.callbacks[response.id];
                }
            });

            this.ws.on('error', (err) => {
                this._rejectPendingCallbacks(err);
                reject(err);
            });

            this.ws.on('close', () => {
                // 连接意外断开时，必须主动拒绝所有挂起请求，否则调用方会一直卡住而非收到错误
                this._rejectPendingCallbacks(new Error('与 Aria2 的 WebSocket 连接已断开'));
            });
        });
    }

    // 连接异常时，确保所有等待响应的请求都能收到错误，而不是无限挂起
    _rejectPendingCallbacks(err) {
        for (const id of Object.keys(this.callbacks)) {
            this.callbacks[id].reject(err);
            delete this.callbacks[id];
        }
    }

    // 发送基础 RPC 请求
    request(method, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket 未连接'));
            }

            const id = `req_${++this.msgId}`;
            this.callbacks[id] = { resolve, reject };

            const payload = {
                jsonrpc: '2.0',
                id: id,
                method: method,
                params: this.secret ? [`token:${this.secret}`, ...params] : params
            };

            this.ws.send(JSON.stringify(payload));
        });
    }

    /**
     * 添加下载任务并监听进度
     * @param {string} url 下载链接
     * @param {Object} options 配置项 (如 dir, headers)
     * @param {Function} onProgress 进度回调函数
     * @returns {Promise} 最终下载结果
     */
    /**
     * 添加下载任务并监听进度
     * @param {string} url 下载链接
     * @param {Object} options 配置项 (如 dir, out, headers)
     * @param {Function} onProgress 进度回调函数
     * @returns {Promise} 最终下载结果
     */
    async download(url, options = {}, onProgress) {
        // 1. 处理自定义 Header
        let headerArray = [];
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                headerArray.push(`${key}: ${value}`);
            }
        }

        // 2. 组装 Aria2 参数
        const aria2Options = {
            dir: options.dir || process.cwd(), // 【核心】自定义下载目录，默认当前运行目录
            header: headerArray,
            split: String(options.concurrency || 8),
            'max-connection-per-server': String(options.concurrency || 8)
        };

        // 【核心】如果传入了自定义文件名，则添加到参数中
        if (options.out) {
            aria2Options.out = options.out;
        }

        // 3. 发送添加任务指令
        const gid = await this.request('aria2.addUri', [[url], aria2Options]);

        // 4. 开启轮询，监控下载进度
        return new Promise((resolve, reject) => {
            const timer = setInterval(async () => {
                try {
                    const status = await this.request('aria2.tellStatus', [
                        gid,
                        ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorCode', 'errorMessage', 'files']
                    ]);

                    const total = parseInt(status.totalLength, 10);
                    const completed = parseInt(status.completedLength, 10);
                    const speed = parseInt(status.downloadSpeed, 10);
                    const percent = total > 0 ? ((completed / total) * 100).toFixed(2) : 0;

                    // 触发进度回调
                    if (typeof onProgress === 'function') {
                        onProgress({
                            gid,
                            status: status.status,
                            percent: parseFloat(percent),
                            completedSize: completed,
                            totalSize: total,
                            speed: speed // byte/s
                        });
                    }

                    // 判断任务是否结束
                    if (status.status === 'complete') {
                        clearInterval(timer);

                        // 【核心修复】即使 aria2 上报 complete，也要校验 errorCode 与实际字节数/文件大小，
                        // 避免因重试后遗留的历史错误码或轮询竞态被当作下载成功，进而把不完整文件送去合并。
                        const errorCode = parseInt(status.errorCode, 10) || 0;
                        if (errorCode !== 0) {
                            reject(new Error(status.errorMessage || `下载失败（errorCode ${status.errorCode}）`));
                            return;
                        }

                        const filePath = status.files && status.files[0] && status.files[0].path;
                        if (total > 0 && completed < total) {
                            reject(new Error(`下载不完整：已完成 ${completed} 字节，总大小 ${total} 字节`));
                            return;
                        }

                        if (!filePath) {
                            reject(new Error('下载完成但未返回文件路径'));
                            return;
                        }

                        let actualSize = -1;
                        try {
                            actualSize = fs.statSync(filePath).size;
                        } catch (statErr) {
                            reject(new Error(`下载完成但本地文件不存在或无法访问: ${statErr.message}`));
                            return;
                        }

                        if (total > 0 && actualSize !== total) {
                            reject(new Error(`下载文件大小校验失败：磁盘文件 ${actualSize} 字节，预期 ${total} 字节`));
                            return;
                        }

                        if (typeof onProgress === 'function') {
                            onProgress({
                                gid,
                                status: status.status,
                                percent: 100,
                                completedSize: total > 0 ? total : completed,
                                totalSize: total > 0 ? total : completed,
                                speed: 0
                            });
                        }

                        resolve({ gid, path: filePath });
                    } else if (status.status === 'error') {
                        clearInterval(timer);
                        reject(new Error(status.errorMessage || '下载失败'));
                    } else if (status.status === 'removed') {
                        clearInterval(timer);
                        reject(new Error('任务被移除'));
                    }

                } catch (err) {
                    clearInterval(timer);
                    reject(err);
                }
            }, 200); // 每秒轮询一次
        });
    }

    // 关闭连接
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

/**
 * 使用 Aria2Client 下载文件，API 与 stream_download.downloadFileWithGot 完全相同
 * @param {string} url - 下载链接
 * @param {string} destPath - 完整保存路径（包含文件名）
 * @param {Object} headers - HTTP 请求头
 * @param {Function} onProgress - 进度回调：onProgress(percentage, speedMBs)
 * @param {number} maxRetries - 最大重试次数（此参数保留以兼容 stream_download 接口，aria2 暂不使用）
 * @param {number} concurrency - aria2 单任务并发连接数
 * @returns {Promise<void>}
 */
async function downloadWithAria2(url, destPath, headers = {}, onProgress, maxRetries = 4, concurrency = 8) {
    const path = require('path');
    
    // 从 destPath 提取目录和文件名
    const dir = path.dirname(destPath);
    const out = path.basename(destPath);
    
    // 创建 aria2 客户端实例
    const client = new Aria2Client({
        host: 'ws://localhost:6818/jsonrpc',
        secret: ''
    });
    
    try {
        // 建立连接
        await client.connect();
        
        // 调用下载，使用包装的 onProgress 回调
        await client.download(url, { dir, out, headers, concurrency }, (progress) => {
            // 将 aria2 的进度格式转换为 stream_download 的格式
            // stream_download: onProgress(percentage, speedMBs, downloadedBytes, totalBytes)
            // aria2: onProgress({ percent, speed(B/s), completedSize, totalSize, ... })
            if (typeof onProgress === 'function') {
                const speedMBs = (progress.speed / 1024 / 1024).toFixed(2);
                onProgress(progress.percent, speedMBs, progress.completedSize, progress.totalSize);
            }
        });
    } finally {
        // 断开连接
        client.disconnect();
    }
}

module.exports = Aria2Client;
module.exports.downloadWithAria2 = downloadWithAria2;