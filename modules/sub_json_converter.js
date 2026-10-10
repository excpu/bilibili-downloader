const fs = require('fs');
const path = require('path');
const { sanitizePath } = require('./sanitize_path');

/**
 * 将时间（秒）转换为 SRT 时间格式：00:00:00,000
 * @param {number|string} seconds 秒数
 * @returns {string} 格式化后的时间字符串
 */
function formatSrtTime(seconds) {
    const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms, 3)}`;
}

function parseSubItems(jsonInput) {
    if (!jsonInput) {
        return [];
    }

    let data = jsonInput;
    if (typeof jsonInput === 'string') {
        try {
            data = JSON.parse(jsonInput);
        } catch (err) {
            throw new Error(`Invalid JSON subtitle input: ${err.message}`);
        }
    }

    return Array.isArray(data)
        ? data
        : (data && Array.isArray(data.body) ? data.body : []);
}

/**
 * 将时间（秒）转换为 ASS 时间格式：H:MM:SS.cc（厘秒）
 */
function formatAssTime(seconds) {
    const totalCs = Math.max(0, Math.round((Number(seconds) || 0) * 100));
    const hours = Math.floor(totalCs / 360000);
    const minutes = Math.floor((totalCs % 360000) / 6000);
    const secs = Math.floor((totalCs % 6000) / 100);
    const cs = totalCs % 100;
    const pad = (n) => String(n).padStart(2, '0');
    return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(cs)}`;
}

/**
 * 将颜色转换为 ASS 的 &HAABBGGRR 格式
 * @param {string} color '#RRGGBB'、'#RRGGBBAA'（AA 为不透明度，FF 不透明）或已是 '&H...' 的 ASS 颜色
 */
function toAssColor(color, fallback) {
    if (typeof color !== 'string' || !color) {
        return fallback;
    }
    if (/^&H[0-9a-f]{6,8}&?$/i.test(color)) {
        return color.replace(/&?$/, '').toUpperCase();
    }
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
    if (!m) {
        return fallback;
    }
    const rr = m[1].slice(0, 2);
    const gg = m[1].slice(2, 4);
    const bb = m[1].slice(4, 6);
    const alpha = m[2]
        ? (255 - parseInt(m[2], 16)).toString(16).padStart(2, '0')
        : '00';
    return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

function sanitizeAssField(value) {
    return String(value).replace(/[\r\n,]+/g, ' ').trim();
}

/**
 * 将 Bilibili JSON 字幕转换为 ASS 字幕字符串
 * @param {object|string} jsonInput 同 jsonToSrt
 * @param {object} [options] ASS 转换所需的额外信息
 * @param {string} [options.title='Bilibili Subtitle'] 字幕标题
 * @param {number} [options.playResX=1920] 脚本分辨率宽
 * @param {number} [options.playResY=1080] 脚本分辨率高
 * @param {string} [options.fontName='Microsoft YaHei'] 字体
 * @param {number} [options.fontSize=48] 字号
 * @param {string} [options.primaryColor='#FFFFFF'] 文字颜色
 * @param {string} [options.outlineColor='#000000'] 描边颜色
 * @param {string} [options.backColor='#000000'] 阴影颜色
 * @param {boolean} [options.bold=false] 是否加粗
 * @param {number} [options.outline=2] 描边宽度
 * @param {number} [options.shadow=0] 阴影深度
 * @param {number} [options.alignment=2] 对齐方式（小键盘布局，2 为底部居中）
 * @param {number} [options.marginL=20] 左边距
 * @param {number} [options.marginR=20] 右边距
 * @param {number} [options.marginV=40] 垂直边距
 * @returns {string} ASS 格式字幕字符串
 */
function jsonToAss(jsonInput, options = {}) {
    const items = parseSubItems(jsonInput);
    const opt = options || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined ? Number(v) : d);

    const title = sanitizeAssField(opt.title || 'Bilibili Subtitle');
    const playResX = num(opt.playResX, 1920);
    const playResY = num(opt.playResY, 1080);
    const fontName = sanitizeAssField(opt.fontName || 'Microsoft YaHei');
    const fontSize = num(opt.fontSize, 48);
    const primary = toAssColor(opt.primaryColor, '&H00FFFFFF');
    const outlineColor = toAssColor(opt.outlineColor, '&H00000000');
    const back = toAssColor(opt.backColor, '&H00000000');
    const bold = opt.bold ? -1 : 0;
    const outline = num(opt.outline, 2);
    const shadow = num(opt.shadow, 0);
    const alignment = num(opt.alignment, 2);
    const marginL = num(opt.marginL, 20);
    const marginR = num(opt.marginR, 20);
    const marginV = num(opt.marginV, 40);

    const header = [
        '[Script Info]',
        `Title: ${title}`,
        'ScriptType: v4.00+',
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        `PlayResX: ${playResX}`,
        `PlayResY: ${playResY}`,
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineColor},${back},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ];

    const events = items.map((item) => {
        const start = formatAssTime(item ? item.from : 0);
        const end = formatAssTime(item ? item.to : 0);
        const text = (item && item.content != null ? String(item.content) : '')
            .replace(/\\/g, '\\\\')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}')
            .replace(/\r?\n/g, '\\N');
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
    });

    return header.concat(events).join('\n') + '\n';
}

/**
 * 将 Bilibili JSON 字幕转换为 SRT 字幕字符串
 * @param {object|string} jsonInput 可以是已解析的 JSON 对象（如 { body: [...] } 或直接 [...] 数组），也可以是 JSON 字符串
 * @returns {string} SRT 格式字幕字符串
 */
function jsonToSrt(jsonInput) {
    const items = parseSubItems(jsonInput);

    if (items.length === 0) {
        return '';
    }

    return items
        .map((item, index) => {
            const from = formatSrtTime(item ? item.from : 0);
            const to = formatSrtTime(item ? item.to : 0);
            const content = item && item.content != null ? String(item.content) : '';
            return `${index + 1}\n${from} --> ${to}\n${content}`;
        })
        .join('\n\n') + '\n';
}

/**
 * 将 SRT 字符串保存到本地文件
 * @param {string} srtString SRT 字幕内容
 * @param {string} dirPath 保存目录
 * @param {string} fileName 文件名（缺少 .srt 后缀时自动补全）
 * @returns {Promise<string>} 保存后的完整文件路径
 */
async function saveSrtToFile(srtString, dirPath, fileName) {
    return saveSubtitleFile(srtString, dirPath, fileName, 'srt');
}

/**
 * 将 ASS 字符串保存到本地文件
 * @param {string} assString ASS 字幕内容
 * @param {string} dirPath 保存目录
 * @param {string} fileName 文件名（缺少 .ass 后缀时自动补全）
 * @returns {Promise<string>} 保存后的完整文件路径
 */
async function saveAssToFile(assString, dirPath, fileName) {
    return saveSubtitleFile(assString, dirPath, fileName, 'ass');
}

async function saveSubtitleFile(content, dirPath, fileName, ext) {
    const finalName = new RegExp(`\\.${ext}$`, 'i').test(fileName) ? fileName : `${fileName}.${ext}`;
    const filePath = path.join(dirPath, sanitizePath(finalName));

    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf8');
    return filePath;
}

module.exports = jsonToSrt;
module.exports.saveSrtToFile = saveSrtToFile;
module.exports.saveAssToFile = saveAssToFile;
module.exports.jsonToAss = jsonToAss;
module.exports.jsonToSrt = jsonToSrt;
module.exports.convertJsonToSrt = jsonToSrt;
module.exports.subJsonToSrt = jsonToSrt;
module.exports.formatSrtTime = formatSrtTime;
