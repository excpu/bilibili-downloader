/**
 * ASS 字幕合并模块（CommonJS）
 * 输入两段 ASS 文本（例如「弹幕 ASS」+「字幕 ASS」），输出一段合并后的 ASS 文本
 *
 * 合并策略：
 *  1. [Script Info]   —— 以第一段为准，缺失的键由第二段补齐（PlayResX/Y 冲突时可选缩放对齐）
 *  2. [V4+ Styles]    —— 样式按名称合并；同名且内容不同则为第二段样式自动改名（Default -> Default_B）
 *  3. [Events]        —— 对白按字段名对齐后拼接，样式名跟随改名，Layer 可整体偏移，默认按开始时间升序输出
 *
 * 零外部依赖，纯字符串处理，兼容 Node.js / Electron / Web Worker
 */

'use strict';

/* -------------------------------------------------------------------------- */
/*                                   常量                                     */
/* -------------------------------------------------------------------------- */

const STANDARD_EVENT_FORMAT = [
    'Layer', 'Start', 'End', 'Style', 'Name',
    'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'
];

const STANDARD_STYLE_FORMAT = [
    'Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour',
    'OutlineColour', 'BackColour', 'Bold', 'Italic', 'Underline', 'StrikeOut',
    'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow',
    'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding'
];

/** 字段名 -> 规范大小写（兼容小写 / 大小写混排的 ASS 文件） */
const FIELD_CANON = (() => {
    const map = {};
    for (const name of [...STANDARD_EVENT_FORMAT, ...STANDARD_STYLE_FORMAT]) {
        map[name.toLowerCase()] = name;
    }
    // V4（非 plus）样式表使用的旧字段名
    map.left = 'MarginL';
    map.right = 'MarginR';
    map.vsize = 'MarginV';
    return map;
})();

/** 各字段的缺省值（用于两份 ASS 字段集合不一致时补齐） */
const FIELD_DEFAULTS = {
    Layer: '0',
    Start: '0:00:00.00',
    End: '0:00:00.00',
    Style: 'Default',
    Name: '',
    MarginL: '0',
    MarginR: '0',
    MarginV: '0',
    Effect: '',
    Text: '',
    Fontname: 'Arial',
    Fontsize: '12',
    PrimaryColour: '&H00FFFFFF',
    SecondaryColour: '&H00FFFFFF',
    OutlineColour: '&H00000000',
    BackColour: '&H00000000',
    Bold: '0',
    Italic: '0',
    Underline: '0',
    StrikeOut: '0',
    ScaleX: '100',
    ScaleY: '100',
    Spacing: '0',
    Angle: '0',
    BorderStyle: '1',
    Outline: '2',
    Shadow: '2',
    Alignment: '2',
    Encoding: '1'
};

/** ASS 默认画布分辨率（文件内未声明 PlayResX/Y 时按规范取值） */
const DEFAULT_PLAY_RES = { x: 384, y: 288 };

/** 事件行类型 -> 规范大小写（部分工具会输出小写 dialogue:） */
const EVENT_KIND_CANONICAL = {
    dialogue: 'Dialogue',
    comment: 'Comment',
    annotation: 'Annotation',
    test: 'Test'
};

const DEFAULT_OPTIONS = {
    /** 合并后 [Script Info] 中的 Title */
    title: 'Bilibili Danmaku & Subtitle',
    /** 第二段样式冲突时的改名后缀 */
    styleSuffix: '_B',
    /** 第二段对白的 Layer 增量（负数表示压在第一段下方） */
    secondLayerOffset: 0,
    /** 第一段对白的 Layer 增量 */
    firstLayerOffset: 0,
    /** 两段分辨率不一致时，是否把坐标/字号换算到统一画布（画布默认取第一段） */
    scaleToFirst: true,
    /** 是否按开始时间升序重排全部对白（渲染器对时间倒退敏感，建议保持 true） */
    sortEvents: true,
    /** 同名且内容完全一致的样式是否去重 */
    deduplicateStyles: true,
    /** 换行符，ASS 惯例为 CRLF */
    eol: '\r\n'
};

/* -------------------------------------------------------------------------- */
/*                                  时间工具                                   */
/* -------------------------------------------------------------------------- */

/**
 * 解析 ASS 时间串（H:MM:SS.cc / M:SS.cc / SS.cc）为秒
 * @param {string} value 时间串
 * @returns {number} 秒，解析失败返回 0
 */
function parseAssTime(value) {
    const str = String(value == null ? '' : value).trim();
    const parts = str.split(':');
    if (parts.length < 2) {
        const only = parseFloat(str.replace(',', '.'));
        return Number.isFinite(only) ? only : 0;
    }
    const seconds = parseFloat(parts[parts.length - 1].replace(',', '.'));
    let total = Number.isFinite(seconds) ? seconds : 0;
    // parts 形如 [H, M, S.cc]：越靠前权重越大
    const hoursIndex = parts.length - 3;
    if (hoursIndex >= 0) {
        const h = parseInt(parts[hoursIndex], 10);
        total += (Number.isFinite(h) ? h : 0) * 3600;
    }
    const m = parseInt(parts[parts.length - 2], 10);
    total += (Number.isFinite(m) ? m : 0) * 60;
    return Math.max(0, total);
}

/**
 * 将秒或 ASS/SRT 时间串格式化为 ASS 时间串 H:MM:SS.cc
 * @param {number|string} seconds 秒数，或时间串（0:01:02.33 / 00:01:02,333）
 * @returns {string} ASS 时间串
 */
function formatAssTime(seconds) {
    const value = typeof seconds === 'string' ? parseAssTime(seconds) : Number(seconds);
    const safe = Math.max(0, Number.isFinite(value) ? value : 0);
    const centiseconds = Math.round(safe * 100);
    const cs = centiseconds % 100;
    const totalSeconds = Math.floor(centiseconds / 100);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/*                                  解析 ASS                                   */
/* -------------------------------------------------------------------------- */

function splitLines(text) {
    return String(text == null ? '' : text)
        .replace(/^\uFEFF/, '')
        .split(/\r\n|\n|\r/);
}

function canonField(name) {
    const key = String(name).trim().toLowerCase();
    return FIELD_CANON[key] || String(name).trim();
}

function splitFormat(value) {
    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/** 按第一个冒号拆分 Key: Value */
function splitKeyValue(line) {
    const index = line.indexOf(':');
    if (index < 0) {
        return { key: line.trim(), value: '' };
    }
    return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

/** 固定字段数拆分（末尾字段允许包含逗号，如 Text / Fontname） */
function splitLimited(value, count, mergeIndex) {
    const out = [];
    let rest = String(value);
    for (let i = 0; i < count - 1; i++) {
        const comma = rest.indexOf(',');
        if (comma < 0) break;
        out.push(i === mergeIndex ? rest.slice(0, comma).trim() : rest.slice(0, comma));
        rest = rest.slice(comma + 1);
    }
    out.push(mergeIndex === count - 1 ? rest.trim() : rest);
    return out;
}

/**
 * 解析一段 ASS 文本为结构化文档
 * @param {string} text ASS 文本
 * @returns {{info: Array<[string,string]>, styleSection: string|null, styleFormat: string[], styles: object[], eventFormat: string[], events: object[], others: object[], warnings: string[]}}
 */
function parseAss(text) {
    const doc = {
        info: [],
        infoComments: [],
        styleSection: null,
        styleFormat: [],
        styles: [],
        eventFormat: [],
        events: [],
        others: [],
        warnings: []
    };

    let mode = null; // 'info' | 'styles' | 'events' | 'other'
    let otherBuffer = null;

    for (const rawLine of splitLines(text)) {
        const line = rawLine.trim();
        if (line === '') continue;

        const sectionMatch = /^\[(.+)\]$/.exec(line);
        if (sectionMatch) {
            const name = sectionMatch[1].trim();
            const lower = name.toLowerCase();
            otherBuffer = null;
            if (lower === 'script info') {
                mode = 'info';
            } else if (lower === 'v4+ styles' || lower === 'v4 styles' || lower === 'v4++ styles') {
                mode = 'styles';
                doc.styleSection = lower === 'v4 styles' ? 'V4 Styles' : 'V4+ Styles';
            } else if (lower === 'events') {
                mode = 'events';
            } else {
                mode = 'other';
                otherBuffer = { name, lines: [] };
                doc.others.push(otherBuffer);
            }
            continue;
        }

        if (line.startsWith(';') || line.startsWith('!--')) {
            if (mode === 'other' && otherBuffer) {
                otherBuffer.lines.push(line);
            } else if (mode === 'info' || mode === null) {
                doc.infoComments.push(line);
            }
            continue;
        }

        const { key, value } = splitKeyValue(line);
        const lowerKey = key.toLowerCase();

        if (mode === 'styles') {
            if (lowerKey === 'format') {
                doc.styleFormat = splitFormat(value).map(canonField);
            } else if (lowerKey === 'style') {
                const fields = doc.styleFormat.length
                    ? splitLimited(value, doc.styleFormat.length, doc.styleFormat.length - 1)
                    : [value];
                doc.styles.push(toFieldMap(doc.styleFormat, fields, 'Name'));
            }
            continue;
        }

        if (mode === 'events') {
            if (lowerKey === 'format') {
                doc.eventFormat = splitFormat(value).map(canonField);
                continue;
            }
            // Dialogue / Comment / Annotation 等，行首单词即事件类型
            const kindMatch = /^[A-Za-z][A-Za-z0-9]*$/.test(key) ? key : null;
            if (!kindMatch) {
                if (key) doc.warnings.push(`忽略无法识别的事件行：${key}`);
                continue;
            }
            const kindKey = kindMatch.toLowerCase();
            const canonicalKind = EVENT_KIND_CANONICAL[kindKey] || kindMatch;
            const count = Math.max(1, doc.eventFormat.length || STANDARD_EVENT_FORMAT.length);
            const format = doc.eventFormat.length ? doc.eventFormat : STANDARD_EVENT_FORMAT;
            const fields = splitLimited(value, count, count - 1);
            const event = toFieldMap(format, fields, 'Text');
            event.__kind = canonicalKind;
            doc.events.push(event);
            continue;
        }

        if (mode === 'other' && otherBuffer) {
            otherBuffer.lines.push(rawLine);
            continue;
        }

        // 未进入任何段落（或 info 段）时按 Script Info 键值处理
        doc.info.push([key, value]);
    }

    return doc;
}

/** 将拆分出的字段数组与 Format 字段名对齐，缺失项补默认值 */
function toFieldMap(format, values, lastField) {
    const names = format.length ? format : [...STANDARD_EVENT_FORMAT];
    const map = {};
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        let value = values[i];
        if (value === undefined || value === null) {
            value = FIELD_DEFAULTS[name] !== undefined ? FIELD_DEFAULTS[name] : '';
        }
        // 末尾字段允许含逗号，非末尾字段去掉多余空格
        map[name] = name === lastField || i === names.length - 1 ? String(value) : String(value).trim();
    }
    return map;
}

/** 读取 [Script Info] 中的键（大小写不敏感） */
function getInfoValue(doc, key) {
    const lower = key.toLowerCase();
    for (const [k, v] of doc.info) {
        if (k.toLowerCase() === lower) return v;
    }
    return null;
}

function getPlayRes(doc) {
    const parse = (v, d) => {
        const n = parseInt(String(v).trim(), 10);
        return Number.isFinite(n) && n > 0 ? n : d;
    };
    const xRaw = getInfoValue(doc, 'PlayResX');
    const yRaw = getInfoValue(doc, 'PlayResY');
    if (xRaw === null && yRaw === null) {
        return { x: DEFAULT_PLAY_RES.x, y: DEFAULT_PLAY_RES.y, explicit: false };
    }
    // 只声明了其中一个时，另一个按默认宽高比等比推断，避免画面拉伸
    let x = parse(xRaw === null ? '' : xRaw, 0);
    let y = parse(yRaw === null ? '' : yRaw, 0);
    if (!x && y) x = Math.round((y * DEFAULT_PLAY_RES.x) / DEFAULT_PLAY_RES.y);
    if (!y && x) y = Math.round((x * DEFAULT_PLAY_RES.y) / DEFAULT_PLAY_RES.x);
    return { x: x || DEFAULT_PLAY_RES.x, y: y || DEFAULT_PLAY_RES.y, explicit: true };
}

/* -------------------------------------------------------------------------- */
/*                                 坐标缩放                                    */
/* -------------------------------------------------------------------------- */

const COORD_COMMANDS = { pos: 2, org: 2, move: 4 };

/** 样式表中需要随分辨率等比换算的字段 -> 使用的缩放轴 */const STYLE_SCALE_AXES = {
    Fontsize: 'y',
    Outline: 'y',
    Shadow: 'y',
    Spacing: 'x',
    MarginL: 'x',
    MarginR: 'x',
    MarginV: 'y'
};

/**
 * 按分辨率差异缩放样式表中的数值字段
 * @param {object} fields 样式字段
 * @param {{x:number,y:number}|null} factor 缩放系数，null 表示无需缩放
 * @returns {object} 处理后的样式字段（新对象）
 */
function scaleStyleFields(fields, factor) {
    if (!factor) return fields;
    const out = { ...fields };
    for (const [name, axis] of Object.entries(STYLE_SCALE_AXES)) {
        if (out[name] === undefined) continue;
        out[name] = scaleMarginValue(out[name], factor[axis]);
    }
    return out;
}

/**
 * 按分辨率差异缩放 ASS 文本内的坐标与边距
 * @param {string} text 对白 Text 字段
 * @param {number} sx X 缩放比
 * @param {number} sy Y 缩放比
 * @returns {string} 缩放后的文本
 */
function scaleDialogueText(text, sx, sy) {
    if (!text || text.indexOf('\\') < 0) return text;
    return text.replace(/\\(pos|move|org)\(([^()]*)\)/gi, (whole, cmd, inner) => {
        const argCount = COORD_COMMANDS[cmd.toLowerCase()];
        const args = String(inner).split(',').map((item) => item.trim());
        if (args.length < argCount) return whole;
        const scaled = args.map((arg, index) => {
            if (index >= argCount) return arg; // \move 的时间参数不缩放
            const num = parseFloat(arg);
            if (!Number.isFinite(num)) return arg;
            const ratio = index % 2 === 0 ? sx : sy;
            return String(Math.round(num * ratio));
        });
        return `\\${cmd}(${scaled.join(',')})`;
    });
}

/** 缩放数值型边距字段 */
function scaleMarginValue(value, ratio) {
    const num = parseFloat(String(value).trim());
    if (!Number.isFinite(num)) return value;
    return String(Math.round(num * ratio));
}

const V4_COLOR = /^&[Hh](\p{Hex}{6,8})$/u;

/**
 * 将 V4（非 plus）样式的 &HRRGGBB 颜色转换为 V4+ 的 &HAABBGGRR
 * V4 颜色为 6 位且通道顺序 RGB；V4+ 为 8 位且为 AABBGGRR（AA=透明度）。
 * 已是 8 位的值视为 V4+ 格式直接保留。
 * @param {string} value 颜色字段
 * @returns {string} 转换后的颜色
 */
function convertV4ColorToV4Plus(value) {
    const match = V4_COLOR.exec(String(value).trim());
    if (!match) return value;
    const hex = match[1];
    if (hex.length !== 6) return value;
    const rr = hex.slice(0, 2);
    const gg = hex.slice(2, 4);
    const bb = hex.slice(4, 6);
    return `&H00${bb}${gg}${rr}`.toUpperCase();
}

const STYLE_COLOR_FIELDS = ['PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour'];

/** 把 V4 旧颜色统一转换为 V4+ 颜色 */
function convertStyleColors(fields) {
    const out = { ...fields };
    for (const name of STYLE_COLOR_FIELDS) {
        if (out[name] !== undefined) out[name] = convertV4ColorToV4Plus(out[name]);
    }
    return out;
}

/** 处理 \r(StyleName) / \r StyleName 样式复位标签中的改名 */
function renameStyleInText(text, renameMap) {
    if (!text || text.indexOf('\\r') < 0 || renameMap.size === 0) return text;
    // 样式名不能包含大括号，否则会连同 {\rName} 的右括号一起吃掉
    return text.replace(/\\r[ \t]*\(?\s*([^\s(){}]*)\s*\)?/gi, (whole, name) => {
        if (!name) return whole;
        const mapped = renameMap.get(String(name).toLowerCase());
        if (!mapped) return whole;
        const hasParen = whole.includes('(');
        return hasParen ? `\\r(${mapped})` : `\\r${mapped}`;
    });
}

/* -------------------------------------------------------------------------- */
/*                                   合并                                      */
/* -------------------------------------------------------------------------- */

function styleSignature(fields) {
    return Object.keys(fields)
        .sort()
        .map((key) => `${key}=${String(fields[key]).trim().toLowerCase()}`)
        .join('|');
}

/** 选择输出的样式段名：任一段为 V4+ 时统一按 V4+ 输出 */
function pickStyleSection(firstSection, secondSection) {
    if (firstSection === 'V4+ Styles' || secondSection === 'V4+ Styles') return 'V4+ Styles';
    return firstSection || secondSection || 'V4+ Styles';
}

/**
 * 合并两段 ASS 文档
 * @param {string} firstContent 第一段 ASS（通常是弹幕）
 * @param {string} secondContent 第二段 ASS（通常是字幕）
 * @param {object} [options] 见 DEFAULT_OPTIONS
 * @returns {{ assContent: string, report: object }}
 */
function mergeAss(firstContent, secondContent, options = {}) {
    const opt = { ...DEFAULT_OPTIONS, ...options };
    const eol = opt.eol === '\n' ? '\n' : '\r\n';
    const warnings = [];

    const first = parseAss(firstContent);
    const second = parseAss(secondContent);

    const firstHasEvents = first.events.length > 0;
    const secondHasEvents = second.events.length > 0;
    if (!firstHasEvents && !secondHasEvents) {
        warnings.push('两段 ASS 文件中都没有找到任何 Dialogue 事件');
    }

    /* ---------------------------- [Script Info] ---------------------------- */
    const infoEntries = [];
    const infoKeys = new Set();
    // 保留原有注释行，便于溯源（去重后按第一段、第二段顺序输出）
    const infoComments = [...new Set(first.infoComments.concat(second.infoComments))];
    const pushInfo = (key, value) => {
        const lower = key.toLowerCase();
        if (infoKeys.has(lower)) {
            const index = infoEntries.findIndex((item) => item[0].toLowerCase() === lower);
            if (index >= 0 && value !== '') infoEntries[index] = [key, value];
            return;
        }
        infoKeys.add(lower);
        infoEntries.push([key, value]);
    };
    for (const [key, value] of first.info) pushInfo(key, value);
    for (const [key, value] of second.info) {
        const lower = key.toLowerCase();
        // 分辨率相关键不覆盖第一段，交由缩放逻辑处理
        if (lower === 'playresx' || lower === 'playresy') {
            if (!infoKeys.has(lower)) pushInfo(key, value);
            continue;
        }
        if (!infoKeys.has(lower)) pushInfo(key, value);
    }
    if (opt.title) pushInfoForce(infoEntries, infoKeys, 'Title', opt.title);
    if (!infoKeys.has('scripttype')) infoEntries.push(['ScriptType', 'v4.00+']);

    /* ------------------------- 画布分辨率与缩放比例 ------------------------- */
    // 合并后的画布以第一段为准；第一段未声明分辨率时退让给第二段，
    // 此时需要换算的是第一段自己的坐标，避免把默认 384x288 当成画布。
    // 两段都未声明时坐标系同为默认值，不做任何缩放。
    const resFirst = getPlayRes(first);
    const resSecond = getPlayRes(second);
    const canvasRes = resFirst.explicit || !resSecond.explicit ? resFirst : resSecond;
    const resDiffers = canvasRes === resFirst
        ? (resSecond.explicit && (resFirst.x !== resSecond.x || resFirst.y !== resSecond.y))
        : (resFirst.explicit && (resFirst.x !== resSecond.x || resFirst.y !== resSecond.y));

    const scaleFor = (res) => {
        if (!resDiffers) return null;
        if (!res.x || !res.y || !canvasRes.x || !canvasRes.y) return null;
        if (res.x === canvasRes.x && res.y === canvasRes.y) return null;
        if (!opt.scaleToFirst) return null;
        return { x: canvasRes.x / res.x, y: canvasRes.y / res.y };
    };

    const firstScale = scaleFor(resFirst);
    const secondScale = scaleFor(resSecond);
    const scaled = Boolean(firstScale || secondScale);
    if (resDiffers && !scaled) {
        warnings.push(
            `两段 ASS 分辨率不一致（${resSecond.x}x${resSecond.y} / ${resFirst.x}x${resFirst.y}）且未开启缩放，位置可能出现偏移`
        );
    }
    // V4（非 plus）样式表的颜色为 &HRRGGBB，与 V4+ 的 &HBBGGRR 相反，混排会导致颜色错乱
    const firstIsV4 = first.styleSection === 'V4 Styles';
    const secondIsV4 = second.styleSection === 'V4 Styles';

    /* -------------------------------- Styles -------------------------------- */
    const styleFormat = unionFormat(first.styleFormat, second.styleFormat, STANDARD_STYLE_FORMAT);
    const outStyleFormat = styleFormat.includes('Name') ? styleFormat : ['Name', ...styleFormat];
    const mergedStyles = [];
    const styleIndexByName = new Map();
    const renameMap = new Map(); // 第二段样式名（小写）-> 合并后的新样式名
    const renames = {};         // 对外暴露的改名记录（旧名 -> 新名）

    const registerStyle = (fields, fromSecond) => {
        const baseName = fields.Name || 'Default';
        const baseKey = baseName.toLowerCase();
        let name = baseName;
        const existing = styleIndexByName.get(baseKey);
        if (existing) {
            if (opt.deduplicateStyles && existing.__signature === styleSignature(fields)) {
                return existing.Name; // 同名且内容完全一致，直接复用
            }
            name = makeUniqueName(baseName, styleIndexByName, opt.styleSuffix);
            if (fromSecond) {
                renameMap.set(baseKey, name);
                renames[baseName] = name;
            } else {
                warnings.push(`第一段存在同名样式 ${baseName}，已重命名为 ${name}`);
            }
        }
        const entry = { ...fields, Name: name };
        entry.__signature = styleSignature(entry);
        mergedStyles.push(entry);
        styleIndexByName.set(name.toLowerCase(), entry);
        return name;
    };

    // V4（非 plus）样式表的颜色为 &HRRGGBB，与 V4+ 的 &HBBGGRR 相反，需要按 6 位十六进制自动转换
    for (const style of first.styles) {
        const normalized = normalizeStyle(style, outStyleFormat);
        registerStyle(scaleStyleFields(firstIsV4 ? convertStyleColors(normalized) : normalized, firstScale), false);
    }
    for (const style of second.styles) {
        const normalized = normalizeStyle(style, outStyleFormat);
        registerStyle(scaleStyleFields(secondIsV4 ? convertStyleColors(normalized) : normalized, secondScale), true);
    }

    /* -------------------------------- Events -------------------------------- */
    const eventFormat = unionFormat(first.eventFormat, second.eventFormat, STANDARD_EVENT_FORMAT);
    const outEventFormat = eventFormat.includes('Text')
        ? moveLast(eventFormat, 'Text')
        : [...STANDARD_EVENT_FORMAT];
    // Layer 必须排在首位，Start/End 紧随其后，兼容顺序扫描型渲染器
    const orderedEventFormat = orderEventFormat(outEventFormat);

    const events = [];
    const declaredStyles = new Set(mergedStyles.map((item) => item.Name.toLowerCase()));

    const collect = (doc, fromSecond) => {
        const layerOffset = fromSecond ? opt.secondLayerOffset : opt.firstLayerOffset;
        for (const raw of doc.events) {
            const fields = {};
            for (const name of orderedEventFormat) {
                const value = raw[name];
                fields[name] = value === undefined || value === null
                    ? (FIELD_DEFAULTS[name] !== undefined ? FIELD_DEFAULTS[name] : '')
                    : String(value);
            }
            if (fields.Text === undefined) fields.Text = '';

            // 样式名映射（第二段改名 / 引用未定义样式时回退 Default）
            let styleName = fields.Style || 'Default';
            if (fromSecond) {
                const renamed = renameMap.get(styleName.toLowerCase());
                if (renamed) styleName = renamed;
            }
            if (declaredStyles.size > 0 && !declaredStyles.has(styleName.toLowerCase())) {
                const fallback = declaredStyles.has('default') ? 'Default' : mergedStyles[0].Name;
                warnings.push(`事件引用了未定义的样式 ${styleName}，已回退为 ${fallback}`);
                styleName = fallback;
            }
            fields.Style = styleName;

            if (fromSecond && renameMap.size > 0) {
                fields.Text = renameStyleInText(fields.Text, renameMap);
            }
            // 按各自与画布的分辨率差换算坐标与边距
            const factor = fromSecond ? secondScale : firstScale;
            if (factor) {
                fields.Text = scaleDialogueText(fields.Text, factor.x, factor.y);
                if (fields.MarginL !== '0') fields.MarginL = scaleMarginValue(fields.MarginL, factor.x);
                if (fields.MarginR !== '0') fields.MarginR = scaleMarginValue(fields.MarginR, factor.x);
                if (fields.MarginV !== '0') fields.MarginV = scaleMarginValue(fields.MarginV, factor.y);
            }

            if (layerOffset) {
                const layer = parseInt(fields.Layer, 10);
                // ASS 的 Layer 为非负整数，偏移后向下取 0
                fields.Layer = String(Math.max(0, (Number.isFinite(layer) ? layer : 0) + layerOffset));
            }

            events.push({
                kind: raw.__kind || 'Dialogue',
                fields,
                start: parseAssTime(fields.Start),
                end: parseAssTime(fields.End)
            });
        }
    };

    collect(first, false);
    collect(second, true);

    if (opt.sortEvents) {
        // 稳定排序：时间相同保持原有先后（第一段在前）
        events.forEach((event, index) => { event.__order = index; });
        events.sort((a, b) => (a.start - b.start) || (a.__order - b.__order));
    }

    const assContent = serialize({
        infoEntries,
        infoComments,
        // 任一段为 V4+ 时统一按 V4+ 输出（合并后的字段集可能含 Encoding 等 V4+ 专有项）
        styleSection: pickStyleSection(first.styleSection, second.styleSection),
        styleFormat: outStyleFormat,
        styles: mergedStyles,
        eventFormat: orderedEventFormat,
        events,
        others: first.others.concat(second.others),
        eol
    });

    return {
        assContent,
        report: {
            warnings,
            // 第二段样式因重名而被改写的映射（旧名 -> 新名）
            renameMap: { ...renames },
            styleCount: mergedStyles.length,
            eventCount: events.length,
            firstEventCount: first.events.length,
            secondEventCount: second.events.length,
            scaled,
            scale: { first: firstScale, second: secondScale },
            playRes: { x: canvasRes.x, y: canvasRes.y }
        }
    };
}

function pushInfoForce(entries, keys, key, value) {
    const lower = key.toLowerCase();
    const index = entries.findIndex((item) => item[0].toLowerCase() === lower);
    if (index >= 0) {
        entries[index] = [key, value];
        return;
    }
    keys.add(lower);
    entries.unshift([key, value]);
}

function unionFormat(a, b, fallback) {
    const base = a.length ? a : (b.length ? b : fallback);
    const out = [...base];
    const seen = new Set(out.map((item) => item.toLowerCase()));
    for (const name of [...a, ...b]) {
        if (!seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            out.push(name);
        }
    }
    return out;
}

function moveLast(list, name) {
    const rest = list.filter((item) => item !== name);
    return [...rest, name];
}

function orderEventFormat(list) {
    const priority = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect'];
    const head = priority.filter((name) => list.includes(name));
    const tail = list.filter((name) => !head.includes(name)); // Text 等自定义字段排在末尾
    return [...head, ...tail];
}

function makeUniqueName(baseName, indexMap, suffix) {
    let candidate = `${baseName}${suffix}`;
    let counter = 2;
    while (indexMap.has(candidate.toLowerCase())) {
        candidate = `${baseName}${suffix}${counter}`;
        counter++;
    }
    return candidate;
}

/** 按输出样式表字段集补齐样式字段 */
function normalizeStyle(fields, format) {
    const out = {};
    for (const name of format) {
        const value = fields[name];
        out[name] = value === undefined || value === null
            ? (FIELD_DEFAULTS[name] !== undefined ? FIELD_DEFAULTS[name] : '')
            : String(value);
    }
    return out;
}

/* -------------------------------------------------------------------------- */
/*                                  序列化                                     */
/* -------------------------------------------------------------------------- */

/**
 * 将结构化文档序列化为 ASS 文本
 * @param {{infoEntries: Array<[string,string]>, infoComments: string[], styleSection: string, styleFormat: string[], styles: object[], eventFormat: string[], events: object[], others: object[], eol: string}} doc
 * @returns {string} ASS 文本
 */
function serialize(doc) {
    const eol = doc.eol || '\r\n';
    const lines = [];

    lines.push('[Script Info]');
    lines.push('; Script generated by bilibili-downloader sub_combine');
    for (const comment of doc.infoComments || []) {
        lines.push(comment);
    }
    for (const [key, value] of doc.infoEntries) {
        lines.push(`${key}: ${value}`);
    }

    if (doc.styles.length > 0) {
        lines.push('', `[${doc.styleSection}]`);
        lines.push(`Format: ${doc.styleFormat.join(', ')}`);
        for (const style of doc.styles) {
            const values = doc.styleFormat.map((name) => String(style[name] ?? ''));
            lines.push(`Style: ${values.join(',')}`);
        }
    }

    lines.push('', '[Events]');
    lines.push(`Format: ${doc.eventFormat.join(', ')}`);
    for (const event of doc.events) {
        const values = doc.eventFormat.map((name) => {
            const value = event.fields[name] ?? (FIELD_DEFAULTS[name] !== undefined ? FIELD_DEFAULTS[name] : '');
            return name === 'Start' || name === 'End' ? ensureAssTime(String(value)) : String(value);
        });
        lines.push(`${event.kind}: ${values.join(',')}`);
    }

    for (const section of doc.others || []) {
        lines.push('', `[${section.name}]`);
        for (const line of section.lines) lines.push(line);
    }

    return lines.join(eol) + eol;
}

/** 时间字段规范化：允许输入秒数或 SRT 风格时间 */
function ensureAssTime(value) {
    if (/^\d+:\d{2}:\d{2}([.,]\d+)?$/.test(value.trim())) {
        return formatAssTime(parseAssTime(value));
    }
    const num = parseFloat(value);
    return Number.isFinite(num) ? formatAssTime(num) : value;
}

/* -------------------------------------------------------------------------- */
/*                                  对外接口                                   */
/* -------------------------------------------------------------------------- */

/**
 * 合并两段 ASS 文本，直接返回合并结果
 * @param {string} firstContent 第一段 ASS（弹幕）
 * @param {string} secondContent 第二段 ASS（字幕）
 * @param {object} [options] 可选配置，见 DEFAULT_OPTIONS
 * @returns {string} 合并后的 ASS 文本
 */
function combineAss(firstContent, secondContent, options = {}) {
    return mergeAss(firstContent, secondContent, options).assContent;
}

/**
 * 判断一段文本是否为 ASS 字幕（宽松检测）
 * @param {string} text 文件内容
 * @returns {boolean}
 */
function isAssContent(text) {
    const str = String(text == null ? '' : text).slice(0, 4096);
    return /\[script info\]/i.test(str) || /\[events\]/i.test(str) || /^\s*Dialogue\s*:/im.test(str);
}

module.exports = {
    DEFAULT_OPTIONS,
    combineAss,
    mergeAss,
    parseAss,
    isAssContent,
    parseAssTime,
    formatAssTime
};
