const { app } = require('electron');
const fs = require('fs');
const path = require('path');


// 配置文件保存在appData目录中的 config.json 不加密，和认证文件分开
class Setting {
    constructor() {
        this.settingFilePath = path.join(app.getPath('userData'), 'config.json');
        this.defaultDownloadPath = app.getPath('downloads');
        this.defaultData = {
            downloadInFolder: false,  // 是否在下载目录中创建子文件夹
            downloadEngine: "node", // 下载引擎，默认使用node got，也可以选择aria2
            downloadPath: "HomeDownloads", // 默认下载路径，用户可以修改
            danmuDownloadMethod: "traditional", // 弹幕下载方式：traditional / protobuf
            cdnHost: "", // 下载使用的 CDN 域名，空字符串表示使用默认（不替换）
        };
    }

    load() {
        try {
            if (fs.existsSync(this.settingFilePath)) {
                const data = fs.readFileSync(this.settingFilePath, 'utf-8');
                return JSON.parse(data);
            } else {
                this.save(this.defaultData);
                return this.defaultData;
            }
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    }

    save(data) {
        try {
            const jsonData = JSON.stringify(data, null, 4);
            fs.writeFileSync(this.settingFilePath, jsonData, 'utf-8');
        } catch (error) {
            console.error('保存设置失败:', error);
        }
    }

    reset() {
        this.save(this.defaultData);
    }

    updateDownloadEngine(engine) {
        const data = this.load() || {};
        data.downloadEngine = engine;
        this.save(data);
    }

    getDownloadEngine() {
        const data = this.load();
        return data ? data.downloadEngine : this.defaultData.downloadEngine;
    }

    updateDanmuDownloadMethod(method) {
        const data = this.load() || {};
        data.danmuDownloadMethod = method;
        this.save(data);
    }

    getDanmuDownloadMethod() {
        const data = this.load();
        return data ? data.danmuDownloadMethod : this.defaultData.danmuDownloadMethod;
    }

    updateDownloadPath(downloadPath) {
        const data = this.load() || {};
        data.downloadPath = downloadPath;
        this.save(data);
    }

    getDownloadPath() {
        const data = this.load() || {};
        const downloadPath = data.downloadPath;

        if (!downloadPath || downloadPath === 'HomeDownloads') {
            return this.defaultDownloadPath;
        }

        return downloadPath;
    }

    updateCdnHost(cdnHost) {
        const data = this.load() || {};
        data.cdnHost = cdnHost || '';
        this.save(data);
    }

    getCdnHost() {
        const data = this.load();
        return data ? (data.cdnHost || '') : this.defaultData.cdnHost;
    }
}

module.exports = Setting;