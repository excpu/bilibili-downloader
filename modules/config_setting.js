const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ARIA2_CONCURRENCY_VALUES = [2, 4, 8, 16, 32, 64];
const DEFAULT_ARIA2_CONCURRENCY = 8;
const DEFAULT_SUBTITLE_SETTINGS = {
    format: 'srt',
    appendLanguage: false,
    assOptions: {
        title: 'Bilibili Subtitle',
        playResX: 1920,
        playResY: 1080,
        fontName: 'Microsoft YaHei',
        fontSize: 48,
        primaryColor: '#FFFFFF',
        outlineColor: '#000000',
        backColor: '#000000',
        bold: false,
        outline: 2,
        shadow: 0,
        alignment: 2,
        marginL: 20,
        marginR: 20,
        marginV: 40,
    },
};

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
            aria2Concurrency: DEFAULT_ARIA2_CONCURRENCY,
            subtitleSettings: DEFAULT_SUBTITLE_SETTINGS,
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

    updateAria2Concurrency(concurrency) {
        const value = Number(concurrency);
        const data = this.load() || {};
        data.aria2Concurrency = ARIA2_CONCURRENCY_VALUES.includes(value)
            ? value
            : DEFAULT_ARIA2_CONCURRENCY;
        this.save(data);
    }

    getAria2Concurrency() {
        const data = this.load() || {};
        const value = Number(data.aria2Concurrency);
        return ARIA2_CONCURRENCY_VALUES.includes(value)
            ? value
            : DEFAULT_ARIA2_CONCURRENCY;
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

    updateSubtitleSettings(subtitleSettings) {
        const data = this.load() || {};
        const assOptions = subtitleSettings?.assOptions || {};
        const validFormat = subtitleSettings?.format === 'ass' ? 'ass' : 'srt';
        const numberOption = (key, fallback, minimum = 0, maximum = Infinity) => {
            const rawValue = assOptions[key];
            const value = rawValue === '' || rawValue === null || rawValue === undefined
                ? NaN
                : Number(rawValue);
            return Number.isFinite(value) && value >= minimum && value <= maximum
                ? value
                : fallback;
        };
        const stringOption = (key, fallback) =>
            typeof assOptions[key] === 'string' && assOptions[key].length > 0
                ? assOptions[key]
                : fallback;

        data.subtitleSettings = {
            format: validFormat,
            appendLanguage: subtitleSettings?.appendLanguage === true,
            assOptions: {
                title: stringOption('title', DEFAULT_SUBTITLE_SETTINGS.assOptions.title),
                playResX: numberOption('playResX', 1920, 1),
                playResY: numberOption('playResY', 1080, 1),
                fontName: stringOption('fontName', DEFAULT_SUBTITLE_SETTINGS.assOptions.fontName),
                fontSize: numberOption('fontSize', 48, 1),
                primaryColor: stringOption('primaryColor', '#FFFFFF'),
                outlineColor: stringOption('outlineColor', '#000000'),
                backColor: stringOption('backColor', '#000000'),
                bold: assOptions.bold === true,
                outline: numberOption('outline', 2),
                shadow: numberOption('shadow', 0),
                alignment: numberOption('alignment', 2, 1, 9),
                marginL: numberOption('marginL', 20),
                marginR: numberOption('marginR', 20),
                marginV: numberOption('marginV', 40),
            },
        };
        this.save(data);
        return data.subtitleSettings;
    }

    getSubtitleSettings() {
        const data = this.load() || {};
        const stored = data.subtitleSettings || {};
        const assOptions = stored.assOptions || {};
        return {
            format: stored.format === 'ass' ? 'ass' : 'srt',
            appendLanguage: stored.appendLanguage === true,
            assOptions: {
                ...DEFAULT_SUBTITLE_SETTINGS.assOptions,
                ...assOptions,
            },
        };
    }
}

module.exports = Setting;