const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const got = require('got');
const { getBiliTicket } = require('./bilibili_ticket');
const { refreshBuvidCredentials } = require('./buvid3_4_nut');

const BUVID_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function isValidCookieValue(value) {
    return value !== '' && value !== undefined && value !== 'undefined';
}

function createEmptyData() {
    return {
        loginStatus: false,
        SESSDATA: '',
        bili_jct: '',
        ticket: '',
        buvid3: '',
        buvid4: '',
        b_nut: '',
        DedeUserID: '',
        DedeUserID__ckMd5: '',
        buvidRefreshAt: 0,
        ticketExpiry: Date.now()
    };
}

class Auth {
    constructor() {
        this.authFilePath = path.join(app.getPath('userData'), 'auth.dat');
        this._buvidRefreshPromise = null;
        this._queue = Promise.resolve();
    }

    // 串行化所有读写任务，避免并发时读到写了一半的密文
    _enqueue(task) {
        const run = this._queue.then(task, task);
        this._queue = run.then(() => { }, () => { });
        return run;
    }

    async _readData() {
        if (!fs.existsSync(this.authFilePath)) {
            return null;
        }
        const encryptedData = await fs.promises.readFile(this.authFilePath);
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encryptedData);
        return { data: JSON.parse(result), shouldReEncrypt };
    }

    async _writeData(data) {
        const encryptedData = await safeStorage.encryptStringAsync(JSON.stringify(data));
        // 先写临时文件再重命名（原子替换），防止写入中断留下损坏的凭据文件
        const tmpPath = `${this.authFilePath}.tmp`;
        await fs.promises.writeFile(tmpPath, encryptedData);
        await fs.promises.rename(tmpPath, this.authFilePath);
    }

    // 在读-改-写同一个队列任务内完成，避免并发保存互相覆盖
    _update(mutator) {
        return this._enqueue(async () => {
            const existing = await this._readData();
            const data = existing ? existing.data : createEmptyData();
            mutator(data);
            await this._writeData(data);
            return data;
        });
    }

    async load() {
        try {
            const result = await this._enqueue(() => this._readData());
            if (!result) {
                // 如果不存在文件则初始化为空
                const emptyData = createEmptyData();
                await this.save(emptyData);
                return emptyData;
            }
            // 系统密钥已轮换或安全等级变化时，用新密钥重新加密落盘
            if (result.shouldReEncrypt) {
                await this.save(result.data);
            }
            return result.data;
        } catch (error) {
            // 加载失败
            console.error('Failed to load auth data:', error);
        }
    }

    save(data) {
        return this._enqueue(async () => {
            try {
                await this._writeData(data);
            } catch (error) {
                // 保存失败
                console.error('Failed to save auth data:', error);
            }
        });
    }

    async loadLoginStatus() {
        const data = await this.load();
        return data ? data.loginStatus : false;
    }

    async updateLoginStatus(status) {
        await this._update((data) => {
            data.loginStatus = status;
        });
    }

    async updateLoginInfo(SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5) {
        await this._update((data) => {
            data.SESSDATA = SESSDATA;
            data.bili_jct = bili_jct;
            data.DedeUserID = DedeUserID;
            data.DedeUserID__ckMd5 = DedeUserID__ckMd5;
            data.loginStatus = true;
        });
    }

    hasFreshBuvid(data) {
        const refreshAt = Number(data?.buvidRefreshAt || 0);
        const now = Date.now();

        return (
            isValidCookieValue(data?.buvid3)
            && isValidCookieValue(data?.buvid4)
            && isValidCookieValue(data?.b_nut)
            && refreshAt > 0
            && now - refreshAt < BUVID_REFRESH_INTERVAL_MS
        );
    }

    async ensureBuvidCredentials(force = false) {
        const current = (await this.load()) || {};
        if (!force && this.hasFreshBuvid(current)) {
            return current;
        }

        if (this._buvidRefreshPromise) {
            return this._buvidRefreshPromise;
        }

        this._buvidRefreshPromise = (async () => {
            try {
                const refreshed = await refreshBuvidCredentials();

                return await this._update((data) => {
                    const buvid3 = refreshed.buvid3 || data.buvid3 || '';
                    const buvid4 = refreshed.buvid4 || data.buvid4 || '';
                    const bNut = refreshed.b_nut || data.b_nut || '';

                    const shouldSave = buvid3 !== data.buvid3 || buvid4 !== data.buvid4 || bNut !== data.b_nut;
                    if (shouldSave || !data.buvidRefreshAt) {
                        data.buvid3 = buvid3;
                        data.buvid4 = buvid4;
                        data.b_nut = bNut;
                        data.buvidRefreshAt = Date.now();
                    }
                });
            } catch (error) {
                console.error('Refresh buvid3/buvid4/b_nut failed:', error.message);
                return (await this.load()) || {};
            } finally {
                this._buvidRefreshPromise = null;
            }
        })();

        return this._buvidRefreshPromise;
    }

    async refreshBuvidInBackground() {
        if (this._buvidRefreshPromise) {
            return;
        }

        const current = (await this.load()) || {};
        if (this.hasFreshBuvid(current)) {
            return;
        }

        this.ensureBuvidCredentials().catch((error) => {
            console.error('Background buvid refresh failed:', error.message);
        });
    }

    // 调用官方接口注销凭据（SESSDATA 服务端失效），不影响本地凭据清理流程
    async logoutRemote() {
        const data = (await this.load()) || {};
        if (!isValidCookieValue(data.SESSDATA) || !isValidCookieValue(data.bili_jct)) {
            return { success: true }; // 未登录，无需请求官方接口
        }
        try {
            const response = await got.post('https://passport.bilibili.com/login/exit/v2', {
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Cookie': await this.getConstructedCookie()
                },
                form: {
                    biliCSRF: data.bili_jct,
                    gourl: 'https://www.bilibili.com'
                },
                responseType: 'json',
                http2: true,
                throwHttpErrors: false
            });
            const json = response.body || {};
            return { success: json.code === 0, message: json.message };
        } catch (error) {
            console.error('官方注销接口调用失败:', error.message);
            return { success: false, message: error.message };
        }
    }

    async logout() {
        await this._update((data) => {
            data.loginStatus = false;
            data.SESSDATA = '';
            data.bili_jct = '';
            data.ticket = '';
            data.ticketExpiry = 0;
        });
    }

    // 使用 Ticket 防止API被风控
    async updateTicket() {
        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        const data = (await this.load()) || {};
        const currentTime = Date.now();

        // 1. 检查是否真的需要更新
        if (data.ticket && data.ticketExpiry > currentTime) {
            return data.ticket;
        }

        // 2. 检查必要的参数是否存在
        if (!data.bili_jct) {
            throw new Error('Missing bili_jct, cannot update ticket.');
        }

        try {
            const response = await getBiliTicket(data.bili_jct);

            // 3. 这里的逻辑取决于 getBiliTicket 的返回结构
            // 假设成功时 response 为真，失败时可能返回 null 或带 message 的对象
            if (response && !response.error) {
                // 提前5分钟过期
                const ticketExpiry = Date.now() + THREE_DAYS_MS - 5 * 60 * 1000;

                await this._update((latest) => {
                    latest.ticket = response;
                    latest.ticketExpiry = ticketExpiry;
                });
                return response;
            } else {
                throw new Error(response?.message || 'Unknown error');
            }
        } catch (error) {
            // 4. 在这里统一捕获网络错误和业务错误
            console.error('Update Ticket Failed:', error.message);
            throw error;
        }
    }

    // 获取构造好的Cookie字符串
    async getConstructedCookie() {
        const data = (await this.load()) || {};
        this.refreshBuvidInBackground().catch((error) => {
            console.error('Background buvid refresh failed:', error.message);
        });

        const cookieParts = [];
        if (isValidCookieValue(data.SESSDATA)) {
            cookieParts.push(`SESSDATA=${data.SESSDATA}`);
        }
        if (isValidCookieValue(data.bili_jct)) {
            cookieParts.push(`bili_jct=${data.bili_jct}`);
        }
        if (isValidCookieValue(data.ticket)) {
            cookieParts.push(`bili_ticket=${data.ticket}`);
        }

        // buvid3 / buvid4 / b_nut 需要成组携带，避免发送不完整 cookie 组合。
        if (isValidCookieValue(data.buvid3) && isValidCookieValue(data.buvid4) && isValidCookieValue(data.b_nut)) {
            cookieParts.push(`buvid3=${data.buvid3}`);
            cookieParts.push(`buvid4=${data.buvid4}`);
            cookieParts.push(`b_nut=${data.b_nut}`);
        }
        // DedeUserID / DedeUserID__ckMd5 也需要携带 (适用于重新登录用户)
        if (isValidCookieValue(data.DedeUserID) && isValidCookieValue(data.DedeUserID__ckMd5)) {
            cookieParts.push(`DedeUserID=${data.DedeUserID}`);
            cookieParts.push(`DedeUserID__ckMd5=${data.DedeUserID__ckMd5}`);
        }

        //console.log('请求拼接:', cookieParts.join('; '));
        return cookieParts.join('; ');
    }
}

module.exports = Auth;