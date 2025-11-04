const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

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
}
module.exports = Auth;