const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { DEFAULT_OPTIONS: DEFAULT_DANMAKU_ASS_OPTIONS } = require('./xml2ass');
const { sanitizePath } = require('./sanitize_path');

const ARIA2_CONCURRENCY_VALUES = [1, 2, 4, 8, 16, 32, 64];
const DEFAULT_ARIA2_CONCURRENCY = 2;
// 界面主题取值：跟随系统 / 浅色 / 深色
const THEME_VALUES = ['system', 'light', 'dark'];
// 最终输出视频容器格式
const OUTPUT_FORMAT_VALUES = ['mp4', 'mkv'];
const DEFAULT_OUTPUT_FORMAT = 'mp4';
// 是否允许把 FLAC / 杜比全景声以非标方式封装进 MP4；关闭时这类音轨自动改用 MKV
const DEFAULT_MP4_ALLOW_NON_STANDARD_AUDIO = true;
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

// 弹幕 XML 转 ASS 设置：convertToAss 开启后按 assOptions 转换；keepXml 控制是否保留原始 xml
// convertStandalone 控制"直接点击下载弹幕"（独立下载）时是否也转换为 ASS
const DEFAULT_DANMAKU_SETTINGS = {
    convertToAss: false,
    convertStandalone: false,
    keepXml: true,
    assOptions: { ...DEFAULT_DANMAKU_ASS_OPTIONS },
};

// 配置文件保存在appData目录中的 config.json 不加密，和认证文件分开
class Setting {
    constructor() {
        this.settingFilePath = path.join(app.getPath('userData'), 'config.json');
        this.defaultDownloadPath = app.getPath('downloads');
        this.defaultData = {
            theme: 'system',  // 界面主题：system / light / dark
            downloadInFolder: false,  // 是否在下载目录中创建与视频/集合同名的子文件夹
            downloadFolderNesting: false,  // 是否启用文件夹嵌套（分P、合集分层保存）
            downloadEngine: "node-multi", // 下载引擎，node aria2 node-multi
            downloadPath: "HomeDownloads", // 默认下载路径，用户可以修改
            danmuDownloadMethod: "traditional", // 弹幕下载方式：traditional / protobuf
            cdnHost: "", // 下载使用的 CDN 域名，空字符串表示使用默认（不替换）
            outputFormat: DEFAULT_OUTPUT_FORMAT, // 合并后输出格式：mp4 / mkv
            mp4AllowNonStandardAudio: DEFAULT_MP4_ALLOW_NON_STANDARD_AUDIO, // MP4 是否允许非标封装 FLAC / 杜比全景声
            experimentalMergeEnabled: false, // 是否使用实验性 js-media 合并工具
            aria2Concurrency: DEFAULT_ARIA2_CONCURRENCY,
            subtitleSettings: DEFAULT_SUBTITLE_SETTINGS,
            danmakuSettings: DEFAULT_DANMAKU_SETTINGS,
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

    updateTheme(theme) {
        const data = this.load() || {};
        data.theme = THEME_VALUES.includes(theme) ? theme : 'system';
        this.save(data);
        return data.theme;
    }

    updateOutputFormat(format) {
        const data = this.load() || {};
        const normalized = String(format || '').toLowerCase();
        if (data.experimentalMergeEnabled === true) {
            return 'mp4';
        }
        data.outputFormat = OUTPUT_FORMAT_VALUES.includes(normalized)
            ? normalized
            : DEFAULT_OUTPUT_FORMAT;
        this.save(data);
        return data.outputFormat;
    }

    getOutputFormat() {
        const data = this.load();
        if (data && data.experimentalMergeEnabled === true) {
            return 'mp4';
        }
        const format = String(data ? data.outputFormat : '').toLowerCase();
        return OUTPUT_FORMAT_VALUES.includes(format) ? format : DEFAULT_OUTPUT_FORMAT;
    }

    updateExperimentalMergeEnabled(enabled) {
        const data = this.load() || {};
        data.experimentalMergeEnabled = enabled === true;
        this.save(data);
        return data.experimentalMergeEnabled;
    }

    getExperimentalMergeEnabled() {
        const data = this.load() || {};
        return data.experimentalMergeEnabled === true;
    }

        updateMp4AllowNonStandardAudio(enabled) {
            const data = this.load() || {};
            data.mp4AllowNonStandardAudio = enabled !== false;
            this.save(data);
            return data.mp4AllowNonStandardAudio;
        }

        getMp4AllowNonStandardAudio() {
            const data = this.load() || {};
            return data.mp4AllowNonStandardAudio !== false;
        }

        /**
         * 判断给定音频流是否为 MP4 无法标准封装的音轨（FLAC / 杜比全景声）。
         * 同时根据音轨 id 与编码前缀判断，避免上游字段缺失时漏判。
         * @param {{audioId?: number|string, audioCodec?: string}} audioInfo
         * @returns {boolean}
         */
        isNonStandardMp4Audio(audioInfo = {}) {
            const audioId = parseInt(audioInfo.audioId);
            if (audioId === 30251 || audioId === 30250) {
                return true;
            }

            const codec = String(audioInfo.audioCodec || '').toLowerCase().split('.')[0];
            return codec === 'flac' || codec === 'ec-3' || codec === 'eac3' || codec === 'ac-3';
        }

        /**
         * 结合输出格式设置与当前音轨，解析本次实际使用的容器格式。
         * 选择 MP4 且未勾选"允许非标封装"时，遇到 FLAC / 杜比全景声自动改用 MKV。
         * @param {{audioId?: number|string, audioCodec?: string}} [audioInfo]
         * @param {string} [format] 指定的输出格式，缺省读取设置
         * @returns {'mp4'|'mkv'}
         */
        resolveOutputFormat(audioInfo = {}, format) {
            if (this.getExperimentalMergeEnabled()) {
                return 'mp4';
            }
            const preferred = OUTPUT_FORMAT_VALUES.includes(String(format || '').toLowerCase())
                ? String(format).toLowerCase()
                : this.getOutputFormat();

            if (preferred !== 'mp4' || this.getMp4AllowNonStandardAudio()) {
                return preferred;
            }

            return this.isNonStandardMp4Audio(audioInfo) ? 'mkv' : preferred;
        }

    getTheme() {
        const data = this.load();
        const theme = data ? data.theme : this.defaultData.theme;
        return THEME_VALUES.includes(theme) ? theme : 'system';
    }

    updateNodeResumeEnabled(enabled) {
        const data = this.load() || {};
        data.nodeResumeEnabled = Boolean(enabled);
        this.save(data);
    }

    getNodeResumeEnabled() {
        const data = this.load() || {};
        return data.nodeResumeEnabled !== false;
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

    updateDownloadInFolder(enabled) {
        const data = this.load() || {};
        data.downloadInFolder = Boolean(enabled);
        this.save(data);
    }

    getDownloadInFolder() {
        const data = this.load() || {};
        return data.downloadInFolder === true;
    }

    updateDownloadFolderNesting(enabled) {
        const data = this.load() || {};
        data.downloadFolderNesting = Boolean(enabled);
        this.save(data);
    }

    getDownloadFolderNesting() {
        const data = this.load() || {};
        return data.downloadFolderNesting === true;
    }

    /**
     * 根据下载目录与文件夹设置，解析出本次下载实际使用的目录。
     * folderNames 由渲染进程按"外层在前、内层在后"的顺序给出（如 [合集名, 视频名, 分P名]）：
     * - 未勾选创建文件夹：始终返回下载目录本身（保持原有行为）
     * - 勾选创建文件夹、未勾选嵌套：只使用第一层文件夹，所有文件放入同一目录
     * - 两者都勾选：按完整层级创建嵌套目录
     * @param {string|string[]} folderNames 文件夹名称层级
     * @returns {string} 实际下载目录
     */
    resolveDownloadDir(folderNames = []) {
        const baseDir = this.getDownloadPath();
        if (!this.getDownloadInFolder()) {
            return baseDir;
        }

        const names = (Array.isArray(folderNames) ? folderNames : [folderNames])
            .filter(item => typeof item === 'string' && item.trim().length > 0)
            .map(item => sanitizePath(item.trim()));

        if (names.length === 0) {
            return baseDir;
        }

        const chain = this.getDownloadFolderNesting() ? names : names.slice(0, 1);
        return path.join(baseDir, ...chain);
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

    updateDanmakuSettings(danmakuSettings) {
        const data = this.load() || {};
        const assOptions = danmakuSettings?.assOptions || {};
        const numberOption = (key, fallback, minimum = -Infinity, maximum = Infinity) => {
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
        const boolOption = (key, fallback) =>
            typeof assOptions[key] === 'boolean' ? assOptions[key] : fallback;

        const blockModes = Array.isArray(assOptions.blockModes)
            ? assOptions.blockModes
                .map(Number)
                .filter(mode => Number.isInteger(mode) && mode >= 1 && mode <= 6)
            : [...DEFAULT_DANMAKU_SETTINGS.assOptions.blockModes];

        // blockRegex 以字符串形式存储，空字符串表示不启用
        const blockRegexSource = typeof assOptions.blockRegex === 'string'
            ? assOptions.blockRegex.trim()
            : '';
        let blockRegex = null;
        if (blockRegexSource) {
            try {
                blockRegex = new RegExp(blockRegexSource, 'i').source;
            } catch {
                blockRegex = null;
            }
        }

        const defaults = DEFAULT_DANMAKU_SETTINGS.assOptions;
        data.danmakuSettings = {
            convertToAss: danmakuSettings?.convertToAss === true,
            convertStandalone: danmakuSettings?.convertStandalone === true,
            keepXml: danmakuSettings?.keepXml !== false,
            assOptions: {
                resX: numberOption('resX', defaults.resX, 1),
                resY: numberOption('resY', defaults.resY, 1),
                fontName: stringOption('fontName', defaults.fontName),
                fontSize: numberOption('fontSize', defaults.fontSize, 1),
                scaleFontSize: boolOption('scaleFontSize', defaults.scaleFontSize),
                bold: boolOption('bold', defaults.bold),
                opacity: numberOption('opacity', defaults.opacity, 0, 1),
                outlineWidth: numberOption('outlineWidth', defaults.outlineWidth, 0),
                shadowDepth: numberOption('shadowDepth', defaults.shadowDepth, 0),
                lineSpacing: numberOption('lineSpacing', defaults.lineSpacing, 0),
                marginTop: numberOption('marginTop', defaults.marginTop, 0),
                marginBottom: numberOption('marginBottom', defaults.marginBottom, 0),
                scrollArea: numberOption('scrollArea', defaults.scrollArea, 0.01, 1),
                fixedArea: numberOption('fixedArea', defaults.fixedArea, 0.01, 1),
                scrollDuration: numberOption('scrollDuration', defaults.scrollDuration, 0.1),
                fixedDuration: numberOption('fixedDuration', defaults.fixedDuration, 0.1),
                horizontalPadding: numberOption('horizontalPadding', defaults.horizontalPadding, 0),
                allowOverlap: boolOption('allowOverlap', defaults.allowOverlap),
                maxOverlapOffset: numberOption('maxOverlapOffset', defaults.maxOverlapOffset, 0),
                timeOffset: numberOption('timeOffset', defaults.timeOffset),
                blockModes,
                blockColor: boolOption('blockColor', defaults.blockColor),
                blockRegex,
                deduplicate: boolOption('deduplicate', defaults.deduplicate),
                deduplicateWindow: numberOption('deduplicateWindow', defaults.deduplicateWindow, 0),
            },
        };
        this.save(data);
        return data.danmakuSettings;
    }

    getDanmakuSettings() {
        const data = this.load() || {};
        const stored = data.danmakuSettings || {};
        return {
            convertToAss: stored.convertToAss === true,
            convertStandalone: stored.convertStandalone === true,
            keepXml: stored.keepXml !== false,
            assOptions: {
                ...DEFAULT_DANMAKU_SETTINGS.assOptions,
                ...(stored.assOptions || {}),
            },
        };
    }
}

module.exports = Setting;