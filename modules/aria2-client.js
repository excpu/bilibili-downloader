const WebSocket = require('ws');

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
                        this.callbacks[response.id].reject(response.error);
                    } else {
                        this.callbacks[response.id].resolve(response.result);
                    }
                    delete this.callbacks[response.id];
                }
            });

            this.ws.on('error', (err) => {
                reject(err);
            });
        });
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
            split: '8',
            'max-connection-per-server': '8'
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
                        ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'files']
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
                        resolve({ gid, path: status.files[0].path });
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
 * @returns {Promise<void>}
 */
async function downloadWithAria2(url, destPath, headers = {}, onProgress, maxRetries = 4) {
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
        await client.download(url, { dir, out, headers }, (progress) => {
            // 将 aria2 的进度格式转换为 stream_download 的格式
            // stream_download: onProgress(percentage, speedMBs)
            // aria2: onProgress({ percent, speed(B/s), ... })
            if (typeof onProgress === 'function') {
                const speedMBs = (progress.speed / 1024 / 1024).toFixed(2);
                onProgress(progress.percent, speedMBs);
            }
        });
    } finally {
        // 断开连接
        client.disconnect();
    }
}

module.exports = Aria2Client;
module.exports.downloadWithAria2 = downloadWithAria2;