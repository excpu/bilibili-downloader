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
    updateTicket() {
        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        let data = this.load() || {};
        const currentTime = Date.now();
        if (!data.ticket || data.ticketExpiry < currentTime) {
            return getBiliTicket(data.bili_jct).then(response => {
                if (response) {
                    data.ticket = response;
                    data.ticketExpiry = Date.now() + THREE_DAYS_MS - 5 * 60 * 1000; // 提前5分钟过期
                    this.save(data);
                    return data.ticket;
                } else {
                    throw new Error('Failed to obtain BiliTicket: ' + (response.message || 'Unknown error'));
                }
            });
        } else {
            return Promise.resolve(data.ticket);
        }
    }
}

module.exports = Auth;