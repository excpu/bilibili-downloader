const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { getBiliTicket } = require('./bilibili_ticket');

class Auth {
    constructor() {
        this.authFilePath = path.join(app.getPath('userData'), 'auth.dat');
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
        // 构造Cookie字符串，优先包含 buvid3 / buvid4 / b_nut 来减少风控的可能性
        if (data.buvid3 !== '' && data.buvid4 !== '' && data.b_nut !== '' && data.buvid3 !== undefined && data.buvid4 !== undefined && data.b_nut !== undefined && data.buvid3 !== "undefined" && data.buvid4 !== "undefined" && data.b_nut !== "undefined") {
            return `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct}; bili_ticket=${data.ticket}; buvid3=${data.buvid3}; buvid4=${data.buvid4}; b_nut=${data.b_nut}` || '';
        } else if (data.ticket !== '' && data.ticket !== undefined && data.ticket !== "undefined") {
            return `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct}; bili_ticket=${data.ticket}` || '';
        } else {
            return `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct}` || '';
        }
    }
}

module.exports = Auth;