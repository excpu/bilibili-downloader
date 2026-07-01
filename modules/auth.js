const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { getBiliTicket } = require('./bilibili_ticket');
const { refreshBuvidCredentials } = require('./buvid3_4_nut');

const BUVID_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function isValidCookieValue(value) {
    return value !== '' && value !== undefined && value !== 'undefined';
}

class Auth {
    constructor() {
        this.authFilePath = path.join(app.getPath('userData'), 'auth.dat');
        this._buvidRefreshPromise = null;
    }

    load() {
        try {
            if (fs.existsSync(this.authFilePath)) {
                const encryptedData = fs.readFileSync(this.authFilePath);
                const decryptedData = safeStorage.decryptString(encryptedData);
                return JSON.parse(decryptedData);
            } else {
                // 如果不存在文件则初始化为空
                const emptyData = {
                    loginStatus: false,
                    SESSDATA: '',
                    bili_jct: '',
                    ticket: '',
                    buvid3: '',
                    buvid4: '',
                    b_nut: '',
                    buvidRefreshAt: 0,
                    ticketExpiry: Date.now()
                };
                this.save(emptyData);
                return emptyData;
            }
        } catch (error) {
            // 加载失败
            console.error('Failed to load auth data:', error);
        }
    }

    save(data) {
        try {
            const jsonData = JSON.stringify(data);
            const encryptedData = safeStorage.encryptString(jsonData);
            fs.writeFileSync(this.authFilePath, encryptedData);
        } catch (error) {
            // 保存失败
            console.error('Failed to save auth data:', error);
        }
    }

    loadLoginStatus() {
        const data = this.load();
        return data ? data.loginStatus : false;
    }

    updateLoginStatus(status) {
        const data = this.load() || {};
        data.loginStatus = status;
        this.save(data);
    }

    updateLoginInfo(SESSDATA, bili_jct) {
        const data = this.load() || {};
        data.SESSDATA = SESSDATA;
        data.bili_jct = bili_jct;
        data.loginStatus = true;
        this.save(data);
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
        const current = this.load() || {};
        if (!force && this.hasFreshBuvid(current)) {
            return current;
        }

        if (this._buvidRefreshPromise) {
            return this._buvidRefreshPromise;
        }

        this._buvidRefreshPromise = (async () => {
            try {
                const refreshed = await refreshBuvidCredentials();
                const latest = this.load() || {};

                const buvid3 = refreshed.buvid3 || latest.buvid3 || '';
                const buvid4 = refreshed.buvid4 || latest.buvid4 || '';
                const bNut = refreshed.b_nut || latest.b_nut || '';

                const shouldSave = buvid3 !== latest.buvid3 || buvid4 !== latest.buvid4 || bNut !== latest.b_nut;
                if (shouldSave || !latest.buvidRefreshAt) {
                    latest.buvid3 = buvid3;
                    latest.buvid4 = buvid4;
                    latest.b_nut = bNut;
                    latest.buvidRefreshAt = Date.now();
                    this.save(latest);
                }

                return latest;
            } catch (error) {
                console.error('Refresh buvid3/buvid4/b_nut failed:', error.message);
                return this.load() || {};
            } finally {
                this._buvidRefreshPromise = null;
            }
        })();

        return this._buvidRefreshPromise;
    }

    refreshBuvidInBackground() {
        if (this._buvidRefreshPromise) {
            return;
        }

        const current = this.load() || {};
        if (this.hasFreshBuvid(current)) {
            return;
        }

        this.ensureBuvidCredentials().catch((error) => {
            console.error('Background buvid refresh failed:', error.message);
        });
    }

    logout() {
        const data = this.load() || {};
        data.loginStatus = false;
        data.SESSDATA = '';
        data.bili_jct = '';
        data.ticket = '';
        data.ticketExpiry = 0;
        this.save(data);
    }

    // 使用 Ticket 防止API被风控
    async updateTicket() {
        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        const data = this.load() || {};
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
                data.ticket = response;
                // 提前5分钟过期
                data.ticketExpiry = Date.now() + THREE_DAYS_MS - 5 * 60 * 1000;

                this.save(data);
                return data.ticket;
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
    getConstructedCookie() {
        const data = this.load();
        this.refreshBuvidInBackground();

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

        //console.log('请求拼接:', cookieParts.join('; '));
        return cookieParts.join('; ');
    }
}

module.exports = Auth;