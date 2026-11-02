// matroska.js
// 纯 Node.js 的 Matroska (MKV) 封装实现，不依赖 ffmpeg。
// 输入是 mp4box 解出的音视频 Sample，以及可选的字幕（SRT / ASS），输出 .mkv 字节流。
const fs = require('fs');
const path = require('path');
const { createFileWriter } = require('./stream-writer');
// 输入统一为 track-source.js 定义的 TrackSource 契约，不直接依赖解封装实现
const { sampleBytes, stsdBoxPayload, toBuffer, audioTrackParams } = require('./track-source');

// ================== EBML 基础写入 ==================

const ID = {
    EBML: 0x1a45dfa3,
    EBMLVersion: 0x4286,
    EBMLReadVersion: 0x42f7,
    EBMLMaxIDLength: 0x42f2,
    EBMLMaxSizeLength: 0x42f3,
    DocType: 0x4282,
    DocTypeVersion: 0x4287,
    DocTypeReadVersion: 0x4285,

    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Seek: 0x4dbb,
    SeekID: 0x53ab,
    SeekPosition: 0x53ac,

    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Duration: 0x4489,
    MuxingApp: 0x4d80,
    WritingApp: 0x5741,
    Title: 0x7ba9,

    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    FlagDefault: 0x88,
    FlagLacing: 0x9c,
    Name: 0x536e,
    Language: 0x22b59c,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
        MaxBlockAdditionID: 0x55ee,
        BlockAdditionMapping: 0x41e4,
        BlockAddIDName: 0x41a4,
        BlockAddIDType: 0x41e7,
        BlockAddIDValue: 0x41f0,
        BlockAddIDExtraData: 0x41ed,

        Video: 0xe0,
        PixelWidth: 0xb0,
        PixelHeight: 0xba,

    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    BitDepth: 0x6264,

    Cluster: 0x1f43b675,
    Timestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    BlockDuration: 0x9b,

    Cues: 0x1c53bb6b,
    CuePoint: 0xbb,
    CueTime: 0xb3,
    CueTrackPositions: 0xb7,
    CueTrack: 0xf7,
    CueClusterPosition: 0xf1,
};

const TRACK_TYPE = { VIDEO: 1, AUDIO: 2, SUBTITLE: 17 };

/** EBML 元素 ID 的原始字节 */
function idBytes(id) {
    const bytes = [];
    let v = id;
    while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    return Buffer.from(bytes);
}

/** EBML 变长整数（用于尺寸和轨道号），按最小长度编码 */
function ebmlVint(n) {
    let len = 1;
    while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
    const buf = Buffer.alloc(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) {
        buf[i] = v & 0xff;
        v = Math.floor(v / 256);
    }
    buf[0] |= 0x80 >> (len - 1);
    return buf;
}

function uintPayload(n) {
    n = Math.max(0, Math.floor(n));
    const bytes = [];
    do {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
    } while (n > 0);
    return Buffer.from(bytes);
}

function el(id, payload) {
    return Buffer.concat([idBytes(id), ebmlVint(payload.length), payload]);
}

function elUint(id, n) {
    return el(id, uintPayload(n));
}

/** 固定长度 uint，用于需要可预测体积的元素（SeekPosition） */
function elUintFixed(id, n, len) {
    const b = Buffer.alloc(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
    }
    return el(id, b);
}

function elFloat(id, v) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(Number.isFinite(v) ? v : 0, 0);
    return el(id, b);
}

function elString(id, s) {
    return el(id, Buffer.from(s === undefined || s === null ? '' : String(s), 'utf8'));
}

function elBinary(id, b) {
    return el(id, Buffer.from(b));
}

/**
 * 只写元素头（ID + 尺寸），不写载荷。
 * 用于体量太大、不方便整体持有载荷的元素（如整段 Segment）
 */
function elHeader(id, payloadLength) {
    return Buffer.concat([idBytes(id), ebmlVint(payloadLength)]);
}

// --- 长度预算：流式写盘前需要先知道每个元素的字节数 ---

function vintLength(n) {
    let len = 1;
    while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
    return len;
}

function idLength(id) {
    return idBytes(id).length;
}

function uintLength(n) {
    n = Math.max(0, Math.floor(n));
    let len = 1;
    while (n >= 256) {
        n = Math.floor(n / 256);
        len++;
    }
    return len;
}

/** el(id, payload) 序列化后的总字节数 */
function elLength(id, payloadLength) {
    return idLength(id) + vintLength(payloadLength) + payloadLength;
}

// ================== 字幕解析 ==================

/**
 * 读取字幕文本并统一成 UTF-8 字符串。
 * Bilibili 外挂字幕可能是 GBK 编码，这里按 BOM -> UTF-8 -> GBK 的顺序探测
 * @param {Buffer} raw
 * @returns {string}
 */
function decodeText(raw) {
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        return raw.subarray(3).toString('utf8');
    }
    if (raw[0] === 0xff && raw[1] === 0xfe) {
        return raw.subarray(2).toString('utf16le');
    }
    if (raw[0] === 0xfe && raw[1] === 0xff) {
        const swapped = Buffer.from(raw.subarray(2));
        swapped.swap16();
        return swapped.toString('utf16le');
    }
    const utf8 = raw.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
        return new TextDecoder('gbk').decode(raw);
    } catch (_) {
        return utf8;
    }
}

function timeToMs(h, m, s, frac, fracDigits) {
    // frac 按位数换算到毫秒
    const pad = (frac || '0').padEnd(3, '0').slice(0, 3);
    const ms = fracDigits === 2 ? Number(frac) * 10 : Number(pad);
    return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + ms;
}

const SRT_TIME_RE =
    /^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/**
 * 解析 SRT，原样保留文本（不做任何标记转换）
 * @param {string} input
 * @returns {Array<{ startMs: number, endMs: number, data: Buffer }>}
 */
function parseSrt(input) {
    const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const m = SRT_TIME_RE.exec(lines[i]);
        if (!m) {
            i++;
            continue;
        }
        const startMs = timeToMs(m[1], m[2], m[3], m[4]);
        const endMs = timeToMs(m[5], m[6], m[7], m[8]);
        i++;
        const text = [];
        while (i < lines.length && lines[i].trim() !== '' && !SRT_TIME_RE.test(lines[i])) {
            text.push(lines[i]);
            i++;
        }
        if (text.length > 0) {
            out.push({ startMs, endMs, data: Buffer.from(text.join('\n'), 'utf8') });
        }
        if (i < lines.length && lines[i].trim() === '') i++;
    }
    return out;
}

function assTimeToMs(value) {
    const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})\s*$/.exec(value || '');
    if (!m) return 0;
    const frac = parseFloat('0.' + m[4]);
    return (
        Number(m[1]) * 3600000 +
        Number(m[2]) * 60000 +
        Number(m[3]) * 1000 +
        Math.round(frac * 1000)
    );
}

/** 按分隔符切分，但最多切出 n 段（最后一段保留剩余内容） */
function splitLimited(text, n) {
    const parts = [];
    let rest = text;
    for (let i = 1; i < n; i++) {
        const idx = rest.indexOf(',');
        if (idx === -1) break;
        parts.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
    }
    parts.push(rest);
    return parts;
}

/**
 * 解析 ASS/SSA：分别返回 Header（写入 CodecPrivate）与 Dialogue 帧
 * @param {string} input
 * @returns {{ header: Buffer, samples: Array<{startMs:number,endMs:number,data:Buffer}> }}
 */
function parseAss(input) {
    const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

    let eventsStart = -1;
    let formatLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (/^\[events\]$/i.test(t)) {
            eventsStart = i;
        } else if (eventsStart >= 0 && /^format\s*:/i.test(t)) {
            formatLine = i;
            break;
        }
    }

    const headerEnd = formatLine >= 0 ? formatLine : lines.length - 1;
    const headerLines = lines.slice(0, headerEnd + 1);
    const findHeader = (key) => {
        const line = headerLines.find((l) =>
            new RegExp('^' + key + '\\s*:', 'i').test(l.trim())
        );
        return line ? line.trim() : null;
    };

    // CodecPrivate：前 5 行以 0x00 分隔，其余 Header 原样跟在后面
    const firstFive = [
        findHeader('Title') || 'Title: und',
        findHeader('ScriptType') || 'ScriptType: v4.00+',
        findHeader('WrapStyle') || 'WrapStyle: 0',
        findHeader('PlayResX') || 'PlayResX: 384',
        findHeader('PlayResY') || 'PlayResY: 288',
    ];
    const playResYIdx = headerLines.findIndex((l) => /^playresy\s*:/i.test(l.trim()));
    const restStart = playResYIdx >= 0 ? playResYIdx + 1 : headerLines.length;
    const restHeader = headerLines.slice(restStart).join('\n');
    const header = Buffer.concat([
        ...firstFive.map((l) => Buffer.from(l + '\0', 'utf8')),
        Buffer.from(restHeader.endsWith('\n') ? restHeader : restHeader + '\n', 'utf8'),
    ]);

    const samples = [];
    if (formatLine < 0) return { header, samples };

    const cols = lines[formatLine]
        .replace(/^format\s*:\s*/i, '')
        .split(',')
        .map((c) => c.trim().toLowerCase());
    const idxOf = (name) => cols.indexOf(name);
    const iLayer = idxOf('layer');
    const iStart = idxOf('start');
    const iEnd = idxOf('end');
    const iStyle = idxOf('style');
    const iName = idxOf('name');
    const iMarginL = idxOf('marginl');
    const iMarginR = idxOf('marginr');
    const iMarginV = idxOf('marginv');
    const iEffect = idxOf('effect');
    const iText = idxOf('text');

    let readOrder = 0;
    for (let i = formatLine + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!/^dialogue\s*:/i.test(line)) continue;
        const fields = splitLimited(line.replace(/^dialogue\s*:\s*/i, ''), cols.length);
        const pick = (idx) => (idx >= 0 && idx < fields.length ? fields[idx].trim() : '');
        const startMs = assTimeToMs(pick(iStart));
        const endMs = assTimeToMs(pick(iEnd));
        const text = iText >= 0 && iText < fields.length ? fields[iText] : '';
        if (endMs < startMs || text === '') continue;

        // Matroska 的 S_TEXT/ASS 帧格式：ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
        const frame = [
            readOrder++,
            pick(iLayer) || '0',
            pick(iStyle),
            pick(iName),
            pick(iMarginL) || '0',
            pick(iMarginR) || '0',
            pick(iMarginV) || '0',
            pick(iEffect),
            text,
        ].join(',');
        samples.push({ startMs, endMs, data: Buffer.from(frame, 'utf8') });
    }
    samples.sort((a, b) => a.startMs - b.startMs);
    return { header, samples };
}

// ================== 编解码器信息 ==================

/** 从 stsd 子 Box 中取出原始载荷字节（契约工具，见 track-source.js） */
const configPayload = stsdBoxPayload;

/** 读取 esds 中的 DecoderSpecificInfo（AAC 的 AudioSpecificConfig） */
function parseEsdsAsc(esdsBox) {
    if (!esdsBox || !esdsBox.data) return null;
    const buf = Buffer.from(esdsBox.data.buffer, esdsBox.data.byteOffset, esdsBox.data.byteLength);

    const readDescriptor = (pos) => {
        if (pos + 1 >= buf.length) return null;
        const tag = buf[pos];
        let p = pos + 1;
        let len = 0;
        let byte;
        do {
            if (p >= buf.length) return null;
            byte = buf[p++];
            len = (len << 7) | (byte & 0x7f);
        } while (byte & 0x80);
        return { tag, start: p, end: Math.min(p + len, buf.length) };
    };

    // 注意：mp4box 的 box.data 已经把 FullBox 的 version + flags 计入 hdr_size，
    // 因此这里从 0 开始就是第一个描述符（esds 的 ES_Descriptor）
    let pos = 0;
    let dcd = null;
    let guard = 0;
    while (pos < buf.length && guard++ < 16) {
        const d = readDescriptor(pos);
        if (!d) break;
        if (d.tag === 0x03) {
            let p = d.start + 2; // ES_ID
            const flags = buf[p++];
            if (flags & 0x80) p += 2;
            if (flags & 0x40) p += 1 + buf[p];
            if (flags & 0x20) p += 2;
            pos = p;
            continue;
        }
        if (d.tag === 0x04) {
            dcd = { start: d.start + 13, end: d.end };
            pos = d.start + 13;
            continue;
        }
        if (d.tag === 0x05) {
            return Buffer.from(buf.subarray(d.start, d.end));
        }
        if (dcd && pos >= dcd.start && pos < dcd.end) {
            pos = d.end;
            continue;
        }
        // 无法识别的描述符，尝试前进
        pos = d.end;
    }
    return null;
}

const ASC_FREQ_TABLE = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
    7350,
];

/** 没拿到 esds 时，按编码字符串 + 采样率兜底构造 2 字节 AudioSpecificConfig */
function fallbackAacAsc(codecString, sampleRate, channels) {
    const parts = String(codecString || 'mp4a.40.2').split('.');
    const audioObjectType = Number(parts[2]) || 2;
    let freqIndex = ASC_FREQ_TABLE.indexOf(sampleRate);
    if (freqIndex < 0) freqIndex = 3; // 48000
    const channelConfig = Math.min(Math.max(channels || 2, 1), 7);
    const value = (audioObjectType << 11) | (freqIndex << 7) | (channelConfig << 3);
    return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

const FLAC_STREAMINFO_SIZE = 34;

/**
 * 把 MP4 的 dfLa 载荷整理成 Matroska 要求的 FLAC CodecPrivate。
 *
 * Matroska 的 A_FLAC CodecPrivate 必须是 "fLaC" 魔数 + FLAC 元数据块（含 4 字节块头），
 * 且第一个块必须是 STREAMINFO。而 dfLa 只是 FLAC 元数据块的容器：
 *  - 有的封装带 FullBox 的 version/flags（4 字节），有的不带；
 *  - 也见过把 "fLaC" 魔数一起塞进 dfLa 的。
 * 所以这里按块结构重新解析并规范化输出，避免直接切固定 4 字节出错。
 *
 * @param {Buffer|null} dfLa
 * @returns {Buffer|null}
 */
function buildFlacCodecPrivate(dfLa) {
    if (!dfLa || dfLa.length < 4) return null;

    let start = 0;
    // dfLa 是 FullBox：version(1) + flags(3)，正常情况下都为 0
    if (dfLa.length > 4 && dfLa[0] === 0 && dfLa[1] === 0 && dfLa[2] === 0 && dfLa[3] === 0) {
        start = 4;
    }
    if (dfLa.toString('latin1', start, start + 4) === 'fLaC') start += 4;

    // 按 FLAC 元数据块结构走一遍，拿到 STREAMINFO 与其他块
    const blocks = [];
    let off = start;
    while (off + 4 <= dfLa.length) {
        const flagType = dfLa[off];
        const type = flagType & 0x7f;
        const isLast = (flagType & 0x80) !== 0;
        const length = (dfLa[off + 1] << 16) | (dfLa[off + 2] << 8) | dfLa[off + 3];
        if (off + 4 + length > dfLa.length) break;
        blocks.push({ type, body: dfLa.subarray(off + 4, off + 4 + length) });
        off += 4 + length;
        if (isLast) break;
    }

    // 必须有 STREAMINFO（type 0）且长度合法，否则 ffmpeg 会报 Invalid FLAC private data
    const streamInfo = blocks.find((b) => b.type === 0);
    if (!streamInfo || streamInfo.body.length < FLAC_STREAMINFO_SIZE) return null;

    const parts = [Buffer.from('fLaC', 'latin1')];
    for (let i = 0; i < blocks.length; i++) {
        const { type, body } = blocks[i];
        // 最后一个元数据块要置 last-metadata-block 标志
        const flagType = (i === blocks.length - 1 ? 0x80 : 0x00) | (type & 0x7f);
        parts.push(
            Buffer.from([flagType, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
            body
        );
    }
    return Buffer.concat(parts);
}

/**
 * 从 stsd 里取杜比视界配置记录（dvcC / dvvC）。
 *
 * 杜比视界在 MP4 里靠 stsd 子 Box 传递，Matroska 没有对应位置，
 * 只能按官方推荐的 BlockAdditionMapping 方式挂到 TrackEntry 上，
 * 否则播放器会把这条 HEVC 当成普通 HDR10，丢失杜比视界信息。
 * @returns {Array<{ name: string, type: string, extraData: Buffer }>}
 */
function dolbyVisionBlockAdditions(stsdEntry) {
    for (const type of ['dvcC', 'dvvC']) {
        const extraData = configPayload(stsdEntry, type);
        if (extraData && extraData.length > 0) {
            return [{ name: 'Dolby Vision configuration', type, extraData }];
        }
    }
    return [];
}

/**
 * 根据视频轨信息得到 Matroska 的 CodecID 与 CodecPrivate
 *
 * 杜比视界（dvh1 / dvhe）在 Matroska 里仍以 V_MPEGH/ISO/HEVC 存放，
 * 差别是把 dvcC 配置记录写成 BlockAdditionMapping，这样播放器才知道
 * 视频自带 Dolby Vision 增强层（否则只能当作普通 HDR10 解码）。
 * @returns {{ codecId: string, codecPrivate: Buffer|null, blockAdditions?: Array<object> }}
 */
function videoCodecInfo(trackInfo, stsdEntry) {
    const subtype = String(trackInfo.codec || '').split('.')[0].toLowerCase();
    switch (subtype) {
        case 'avc1':
        case 'avc3':
            return { codecId: 'V_MPEG4/ISO/AVC', codecPrivate: configPayload(stsdEntry, 'avcC') };
        case 'hev1':
        case 'hvc1':
        case 'dvh1':
        case 'dvhe':
            return {
                codecId: 'V_MPEGH/ISO/HEVC',
                codecPrivate: configPayload(stsdEntry, 'hvcC'),
                blockAdditions: dolbyVisionBlockAdditions(stsdEntry),
            };
        case 'av01':
            return { codecId: 'V_AV1', codecPrivate: configPayload(stsdEntry, 'av1C') };
        default:
            throw new Error(`Matroska 暂不支持的视频编码: ${trackInfo.codec}`);
    }
}

/**
 * 根据音频轨信息得到 Matroska 的 CodecID 与 CodecPrivate
 * @returns {{ codecId: string, codecPrivate: Buffer|null }}
 */
function audioCodecInfo(trackInfo, stsdEntry) {
    const subtype = String(trackInfo.codec || '').split('.')[0].toLowerCase();
    const { sampleRate, channelCount: channels } = audioTrackParams(trackInfo, stsdEntry);

    switch (subtype) {
        case 'mp4a': {
            const asc =
                parseEsdsAsc(stsdEntry && stsdEntry.esds) ||
                fallbackAacAsc(trackInfo.codec, sampleRate, channels);
            return { codecId: 'A_AAC', codecPrivate: asc };
        }
        case 'flac': {
                    return { codecId: 'A_FLAC', codecPrivate: buildFlacCodecPrivate(configPayload(stsdEntry, 'dfLa')) };
                }
        case 'opus': {
            const dOps = configPayload(stsdEntry, 'dOps');
            return {
                codecId: 'A_OPUS',
                codecPrivate: dOps ? Buffer.concat([Buffer.from('OpusHead'), dOps]) : null,
            };
        }
        case 'ac-3':
            return { codecId: 'A_AC3', codecPrivate: null };
        case 'ec-3':
            return { codecId: 'A_EAC3', codecPrivate: null };
        case 'alac': {
            const alac = configPayload(stsdEntry, 'alac');
            // alac box 载荷前 4 字节是 version/flags
            return { codecId: 'A_ALAC', codecPrivate: alac ? alac.subarray(4) : null };
        }
        default:
            throw new Error(`Matroska 暂不支持的音频编码: ${trackInfo.codec}`);
    }
}

// ================== 轨道与分片构造 ==================

/**
 * 把 TrackSource 的帧列表转成 mkv 样本描述。
 * 流式契约（source.streamed）只留元信息与 read() 闭包，写 Cluster 时才取字节。
 */
function demuxSamplesToMkv(source, useCts) {
    const timescale = source.timescale;

    return source.samples.map((s) => {
        const timeMs = Math.max(0, Math.round(((useCts ? s.cts : s.dts) || 0) * 1000 / timescale));
        const durMs = Math.max(0, Math.round((s.duration || 0) * 1000 / timescale));

        if (s.data) {
            const data = toBuffer(s.data);
            return { timeMs, durMs, data, size: data.length, keyframe: s.keyframe };
        }
        if (source.readSample) {
            // 流式模式：只留元信息，写 Cluster 时才从源文件按偏移读取
            return {
                timeMs,
                durMs,
                size: s.size,
                offset: s.offset,
                read: () => source.readSample(s),
                keyframe: s.keyframe,
            };
        }
        throw new Error(`Sample 缺少 data，且未提供 readSample 读取器 (${source.label})`);
    });
}

function buildTrackEntry(track) {
    const parts = [
        elUint(ID.TrackNumber, track.number),
        elUint(ID.TrackUID, track.uid),
        elUint(ID.TrackType, track.type),
        elUint(ID.FlagLacing, 0),
        elUint(ID.FlagDefault, track.isDefault ? 1 : 0),
        elString(ID.Language, track.language || 'und'),
        elString(ID.CodecID, track.codecId),
    ];
    if (track.name) parts.push(elString(ID.Name, track.name));
    if (track.codecPrivate && track.codecPrivate.length > 0) {
        parts.push(elBinary(ID.CodecPrivate, track.codecPrivate));
    }
    if (track.type === TRACK_TYPE.VIDEO) {
        parts.push(
            el(
                ID.Video,
                Buffer.concat([elUint(ID.PixelWidth, track.width), elUint(ID.PixelHeight, track.height)])
            )
        );
    } else if (track.type === TRACK_TYPE.AUDIO) {
        const audioParts = [
            elFloat(ID.SamplingFrequency, track.sampleRate),
            elUint(ID.Channels, track.channels),
        ];
        if (track.bitDepth) audioParts.push(elUint(ID.BitDepth, track.bitDepth));
        parts.push(el(ID.Audio, Buffer.concat(audioParts)));
    }
    if (track.blockAdditions && track.blockAdditions.length > 0) {
        // MaxBlockAdditionID 与 ffmpeg 保持一致写 0：配置只登记在映射表里，不出现在 Block 中
        parts.push(elUint(ID.MaxBlockAdditionID, 0));
        for (const addition of track.blockAdditions) {
            parts.push(buildBlockAdditionMapping(addition));
        }
    }
    return el(ID.TrackEntry, Buffer.concat(parts));
}

/**
 * BlockAdditionMapping：把 MP4 侧的解码器额外配置（如杜比视界的 dvcC）
 * 以 Matroska 官方约定的形式挂到轨道上
 */
function buildBlockAdditionMapping(addition) {
    const mapping = [
        elString(ID.BlockAddIDName, addition.name),
        elString(ID.BlockAddIDType, addition.type),
    ];
    if (addition.extraData && addition.extraData.length > 0) {
        mapping.push(elBinary(ID.BlockAddIDExtraData, addition.extraData));
    }
    return el(ID.BlockAdditionMapping, Buffer.concat(mapping));
}

/** 块载荷长度：TrackNumber(vint) + 相对时间码(2) + flags(1) + 帧数据 */
function blockPayloadLength(trackNumber, sample) {
    return vintLength(trackNumber) + 3 + sample.size;
}

function simpleBlock(trackNumber, relativeTimecode, sample, data = sampleBytes(sample)) {
    const track = ebmlVint(trackNumber);
    const payloadLength = track.length + 3 + data.length;
    const result = Buffer.allocUnsafe(elLength(ID.SimpleBlock, payloadLength));
    let p = writeElementHeader(result, 0, ID.SimpleBlock, payloadLength);
    track.copy(result, p);
    p += track.length;
    result.writeInt16BE(relativeTimecode, p);
    p += 2;
    result[p++] = sample.keyframe ? 0x80 : 0x00;
    data.copy(result, p);
    return result;
}

function simpleBlockLength(trackNumber, sample) {
    return elLength(ID.SimpleBlock, blockPayloadLength(trackNumber, sample));
}

/** 字幕需要 BlockDuration 才能控制显示时长，因此用 BlockGroup 而不是 SimpleBlock */
function blockGroup(trackNumber, relativeTimecode, sample, data = sampleBytes(sample)) {
    const track = ebmlVint(trackNumber);
    const blockPayloadLength = track.length + 3 + data.length;
    const blockLength = elLength(ID.Block, blockPayloadLength);
    const durationElement = elUint(ID.BlockDuration, Math.max(sample.durMs, 1));
    const groupPayloadLength = blockLength + durationElement.length;
    const result = Buffer.allocUnsafe(elLength(ID.BlockGroup, groupPayloadLength));
    let p = writeElementHeader(result, 0, ID.BlockGroup, groupPayloadLength);
    p = writeElementHeader(result, p, ID.Block, blockPayloadLength);
    track.copy(result, p);
    p += track.length;
    result.writeInt16BE(relativeTimecode, p);
    p += 2;
    result[p++] = 0;
    data.copy(result, p);
    p += data.length;
    durationElement.copy(result, p);
    return result;
}

function writeElementHeader(target, offset, id, payloadLength) {
    const idBuffer = idBytes(id);
    const sizeBuffer = ebmlVint(payloadLength);
    idBuffer.copy(target, offset);
    sizeBuffer.copy(target, offset + idBuffer.length);
    return offset + idBuffer.length + sizeBuffer.length;
}

function blockGroupLength(trackNumber, sample) {
    const blockLen = elLength(ID.Block, blockPayloadLength(trackNumber, sample));
    const durationValue = Math.max(sample.durMs, 1);
    const durationLen = elLength(ID.BlockDuration, uintLength(durationValue));
    return elLength(ID.BlockGroup, blockLen + durationLen);
}

/**
 * SimpleBlock 的相对时间码是 int16，Cluster 时长必须严格控制在 32.7 s 以内。
 * 这里取 30 s 上限，保证即使块时间有抖动也不会溢出。
 */
const MAX_CLUSTER_DURATION_MS = 30000;
const MAX_CLUSTER_WRITE_SIZE = 1 << 20;

/**
 * 把音轨/字幕按时间窗切成 Cluster，并保持视频 Sample 的解码顺序
 *
 * Cluster 边界取「视频关键帧时间」+ 固定 MAX_CLUSTER_DURATION_MS 兜底。
 * 只按关键帧切会在两种情况下出错：
 *  1) 关键帧稀疏或整段视频只有一个关键帧 —— SimpleBlock 的 int16 相对时间码会溢出；
 *  2) 视频比音轨短 —— 剩下的音频会被全部塞进最后一个 Cluster（同样溢出）。
 * @param {Array<object>} tracks
 * @returns {Array<{ ts: number, blocks: Array<{ track: object, sample: object }> }>}
 */
function buildClusters(tracks) {
    const videoTrack = tracks.find((t) => t.type === TRACK_TYPE.VIDEO) || null;
    const others = tracks.filter((t) => t !== videoTrack);
    const videoSamples = videoTrack ? videoTrack.samples : [];

    let endMs = 0;
    for (const t of tracks) {
        for (const s of t.samples) endMs = Math.max(endMs, s.timeMs + s.durMs);
    }
    if (endMs <= 0) return [];

    const boundaries = new Set([0]);
    for (const s of videoSamples) {
        if (s.keyframe && s.timeMs > 0) boundaries.add(s.timeMs);
    }
    for (let ms = MAX_CLUSTER_DURATION_MS; ms < endMs; ms += MAX_CLUSTER_DURATION_MS) {
        boundaries.add(ms);
    }
    const starts = Array.from(boundaries).sort((a, b) => a - b);

    const pointers = new Map(others.map((t) => [t.number, 0]));
    const clusters = [];
    let videoIndex = 0;

    for (let k = 0; k < starts.length; k++) {
        const limit = k + 1 < starts.length ? starts[k + 1] : Infinity;

        const videoSlice = [];
        while (
            videoIndex < videoSamples.length &&
            videoSamples[videoIndex].timeMs < limit
        ) {
            videoSlice.push(videoSamples[videoIndex]);
            videoIndex++;
        }

        const othersSlice = others.map((t) => {
            const arr = t.samples;
            const start = pointers.get(t.number);
            let end = start;
            while (end < arr.length && arr[end].timeMs < limit) end++;
            pointers.set(t.number, end);
            return { track: t, samples: arr, index: start, end };
        });

        const blocks = [];
        const emitReady = (limitMs) => {
            for (const o of othersSlice) {
                while (o.index < o.end && o.samples[o.index].timeMs <= limitMs) {
                    blocks.push({ track: o.track, sample: o.samples[o.index] });
                    o.index++;
                }
            }
        };
        for (const s of videoSlice) {
            emitReady(s.timeMs);
            blocks.push({ track: videoTrack, sample: s });
        }
        emitReady(Infinity);

        if (blocks.length === 0) continue;
        // Cluster 时间戳取块内最早时间（B 帧的 cts 可能比解码顺序更早）
        let ts = Infinity;
        for (const b of blocks) ts = Math.min(ts, b.sample.timeMs);
        let cueTime = null;
        if (videoTrack) {
            // 只有以视频关键帧开头的 Cluster 才适合做跳转目标（Cues）
            const firstVideo = videoSlice.length > 0 ? videoSlice[0] : null;
            cueTime =
                firstVideo && firstVideo.keyframe && firstVideo.timeMs === ts
                    ? firstVideo.timeMs
                    : null;
        } else {
            // 纯音频：每个 Cluster 都以音频帧开头，可直接作为跳转点
            cueTime = ts;
        }
        clusters.push({ ts, cueTime, blocks });
    }
    return clusters;
}

/**
 * Cluster 载荷长度（不含 Cluster 自身的 ID + 尺寸字段）
 * @param {object} cluster
 */
function clusterPayloadLength(cluster) {
    let payload = elLength(ID.Timestamp, uintLength(cluster.ts));
    for (const { track, sample } of cluster.blocks) {
        payload +=
            track.type === TRACK_TYPE.SUBTITLE
                ? blockGroupLength(track.number, sample)
                : simpleBlockLength(track.number, sample);
    }
    return payload;
}

/**
 * Cluster 的完整序列化长度（Cluster 头里的尺寸字段要求先知道总长）
 * @param {object} cluster
 */
function clusterLength(cluster) {
    const payload = clusterPayloadLength(cluster);
    return idLength(ID.Cluster) + vintLength(payload) + payload;
}

/**
 * 把 Cluster 逐块产出（不整体拼成一个 Buffer，避免大 Cluster 占内存）
 * @param {object} cluster
 * @returns {Generator<Buffer>}
 */
function* clusterChunks(cluster) {
    yield elHeader(ID.Cluster, clusterPayloadLength(cluster));
    yield elUint(ID.Timestamp, cluster.ts);
    const blocks = cluster.blocks;
    for (let i = 0; i < blocks.length;) {
        const { track, sample } = blocks[i];
        let end = i + 1;
        let runSize = sample.size || 0;
        while (
            typeof track.readSamples === 'function' &&
            Number.isFinite(sample.offset) &&
            end < blocks.length &&
            blocks[end].track === track &&
            blocks[end].sample.offset === blocks[end - 1].sample.offset + blocks[end - 1].sample.size &&
            runSize + blocks[end].sample.size <= MAX_CLUSTER_WRITE_SIZE
        ) {
            runSize += blocks[end].sample.size;
            end++;
        }

        const run = blocks.slice(i, end);
        const data =
            run.length > 1 ? track.readSamples(run.map((block) => block.sample)) : null;
        for (let j = 0; j < run.length; j++) {
            const block = run[j];
            const rel = block.sample.timeMs - cluster.ts;
            if (rel < -32768 || rel > 32767) {
                throw new Error(`Sample 相对时间超出 Cluster 范围 (${rel} ms)`);
            }
            if (block.track.type === TRACK_TYPE.SUBTITLE) {
                yield blockGroup(block.track.number, rel, block.sample, data ? data[j] : undefined);
            } else {
                yield simpleBlock(block.track.number, rel, block.sample, data ? data[j] : undefined);
            }
        }
        i = end;
    }
}

function buildSeekHead(infoPos, tracksPos, cuesPos) {
    const entries = [
        [ID.Info, infoPos],
        [ID.Tracks, tracksPos],
        [ID.Cues, cuesPos],
    ];
    return el(
        ID.SeekHead,
        Buffer.concat(
            entries.map(([id, pos]) =>
                el(
                    ID.Seek,
                    Buffer.concat([
                        elBinary(ID.SeekID, idBytes(id)),
                        elUintFixed(ID.SeekPosition, pos, 8),
                    ])
                )
            )
        )
    );
}

/**
 * 分块把完整的 mkv 写出去（流式落盘核心）
 *
 * 相比一次性返回 Buffer，这里不把整个文件放进内存：
 * 先算出 Cluster 布局和 Cues，再按 Cluster 边界聚合后交给 write()。
 * 字幕/Sample 数据在需要时通过 sample.read() 从源文件读，写完即释放。
 *
 * @param {object} params
 * @param {Array<object>} params.tracks
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal] 取消信号，中止时抛「转封装已取消」
 * @param {(chunk: Buffer) => (void|Promise<void>)} params.write 顺序写出分块
 * @returns {Promise<{ clusters: number, durationMs: number, size: number }>}
 */
async function muxMatroskaToWriter({ tracks, title = null, onProgress = null, signal = null, write }) {
    let durationMs = 0;
    for (const t of tracks) {
        for (const s of t.samples) {
            durationMs = Math.max(durationMs, s.timeMs + s.durMs);
        }
    }

    const ebmlHeader = el(
        ID.EBML,
        Buffer.concat([
            elUint(ID.EBMLVersion, 1),
            elUint(ID.EBMLReadVersion, 1),
            elUint(ID.EBMLMaxIDLength, 4),
            elUint(ID.EBMLMaxSizeLength, 8),
            elString(ID.DocType, 'matroska'),
            elUint(ID.DocTypeVersion, 4),
            elUint(ID.DocTypeReadVersion, 2),
        ])
    );

    const infoParts = [
        elUint(ID.TimecodeScale, 1000000),
        elFloat(ID.Duration, durationMs),
        elString(ID.MuxingApp, 'bilibili-downloader'),
        elString(ID.WritingApp, 'bilibili-downloader (js-media)'),
    ];
    if (title) infoParts.push(elString(ID.Title, title));
    const info = el(ID.Info, Buffer.concat(infoParts));

    const tracksBuf = el(ID.Tracks, Buffer.concat(tracks.map(buildTrackEntry)));

    const clusters = buildClusters(tracks);

    // SeekHead 的 SeekPosition 用固定 8 字节，长度可预知
    const seekHead = buildSeekHead(0, 0, 0);
    const seekHeadLength = seekHead.length;
    const infoPos = seekHeadLength;
    const tracksPos = infoPos + info.length;

    // Segment 载荷长度 = Segment 头之后所有字节
    let segmentPayloadLength = infoPos + info.length + tracksBuf.length;
    const clusterSizes = new Array(clusters.length);
    for (let i = 0; i < clusters.length; i++) {
        clusterSizes[i] = clusterLength(clusters[i]);
        segmentPayloadLength += clusterSizes[i];
    }

    const cueTrack = (tracks.find((t) => t.type === TRACK_TYPE.VIDEO) || tracks[0]).number;
    const cuePointParts = [];
    let clusterPos = tracksPos + tracksBuf.length;
    for (let i = 0; i < clusters.length; i++) {
        // 只给「以关键帧开头」的 Cluster 建 Cue，否则跳转过去解不出画面
        if (clusters[i].cueTime !== null) {
            cuePointParts.push(
                el(
                    ID.CuePoint,
                    Buffer.concat([
                        elUint(ID.CueTime, clusters[i].cueTime),
                        el(
                            ID.CueTrackPositions,
                            Buffer.concat([
                                elUint(ID.CueTrack, cueTrack),
                                elUint(ID.CueClusterPosition, clusterPos),
                            ])
                        ),
                    ])
                )
            );
        }
        clusterPos += clusterSizes[i];
    }
    // 即使没有 CuePoint 也写出空 Cues，保证 SeekHead 里的 Cues 位置始终有效
    const cues = el(ID.Cues, Buffer.concat(cuePointParts));
    segmentPayloadLength += cues.length;

    const segmentHeaderLength = elHeader(ID.Segment, segmentPayloadLength).length;
        // SeekHead / Cues 里的位置都相对 Segment 载荷起始，即 cues 紧跟所有 Cluster
        buildSeekHead(infoPos, tracksPos, clusterPos).copy(seekHead);

        let written = 0;
        // 输出总长可预先算出（Segment 载荷长度 + 各段头），进度按已写字节给出
        const totalBytes =
            ebmlHeader.length + segmentHeaderLength + segmentPayloadLength;
        const emit = async (chunk) => {
            await write(chunk);
            written += chunk.length;
        };
        const report = () => {
            if (onProgress) {
                onProgress(totalBytes === 0 ? 1 : Math.min(1, written / totalBytes));
            }
        };

        await emit(ebmlHeader);
        await emit(elHeader(ID.Segment, segmentPayloadLength));
        await emit(seekHead);
        await emit(info);
        await emit(tracksBuf);

        let pending = [];
        let pendingSize = 0;
        const flushCluster = async () => {
            if (pendingSize === 0) return;
            const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
            pending = [];
            pendingSize = 0;
            await emit(chunk);
        };

        for (let i = 0; i < clusters.length; i++) {
            if (signal && signal.aborted) throw new Error('转封装已取消');
            for (const chunk of clusterChunks(clusters[i])) {
                pending.push(chunk);
                pendingSize += chunk.length;
                if (pendingSize >= MAX_CLUSTER_WRITE_SIZE) await flushCluster();
            }
            await flushCluster();
            report();
        }

        await emit(cues);
        if (onProgress) onProgress(1);

        return { clusters: clusters.length, durationMs, size: written + segmentHeaderLength };
    }

/**
 * 把轨道与 Cluster 组装成完整 mkv 文件（内存版，测试与小文件用）
 * @param {object} params
 * @param {Array<object>} params.tracks
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Buffer>}
 */
async function muxMatroska({ tracks, title = null, onProgress = null, signal = null }) {
    const chunks = [];
    await muxMatroskaToWriter({
        tracks,
        title,
        onProgress,
        signal,
        write: (chunk) => {
            chunks.push(chunk);
        },
    });
    return Buffer.concat(chunks);
}

/**
 * 由 TrackSource 构造 mkv 轨道信息
 *
 * video / audio 都可以省略，但至少要给一个：
 * 只给 audio 就是「纯音频 mkv」（B 站 FLAC / 杜比全景声单独下载走这条），
 * 轨道编号按实际给出的轨道顺序分配，缺视频时音频轨就是 1 号轨。
 * @param {object|null} video 视频轨 TrackSource（见 track-source.js）
 * @param {object|null} audio 音频轨 TrackSource
 * @param {Array<object>|null} subtitle 字幕轨（已在 build 阶段解析）
 * @returns {Array<object>}
 */
function buildTracks(video, audio, subtitle) {
    if (!video && !audio) {
        throw new Error('buildTracks 需要至少一条视频或音频轨');
    }

    const tracks = [];
    let nextNumber = 1;

    if (video) {
        const vCodec = videoCodecInfo(video.trackInfo, video.stsdEntry);
        const vInfo = video.trackInfo;
        tracks.push({
            number: nextNumber,
            uid: nextNumber,
            type: TRACK_TYPE.VIDEO,
            codecId: vCodec.codecId,
            codecPrivate: vCodec.codecPrivate,
                        blockAdditions: vCodec.blockAdditions,
            isDefault: true,
            language: 'und',
            width: vInfo.video ? vInfo.video.width : vInfo.track_width,
            height: vInfo.video ? vInfo.video.height : vInfo.track_height,
            samples: demuxSamplesToMkv(video, true),
            readSamples: video.readSamples,
        });
        nextNumber++;
    }

    if (audio) {
        const aCodec = audioCodecInfo(audio.trackInfo, audio.stsdEntry);
        const aInfo = audio.trackInfo;
            const aParams = audioTrackParams(aInfo, audio.stsdEntry);
            tracks.push({
                number: nextNumber,
                uid: nextNumber,
                type: TRACK_TYPE.AUDIO,
                codecId: aCodec.codecId,
                codecPrivate: aCodec.codecPrivate,
                isDefault: true,
                language: 'und',
                sampleRate: aParams.sampleRate,
                channels: aParams.channelCount,
                bitDepth: aInfo.audio ? aInfo.audio.sample_size : 16,
                samples: demuxSamplesToMkv(audio, false),
                readSamples: audio.readSamples,
            });
            nextNumber++;
        }

    if (subtitle) {
        tracks.push({
            number: nextNumber,
            uid: nextNumber,
            type: TRACK_TYPE.SUBTITLE,
            codecId: subtitle.codecId,
            codecPrivate: subtitle.codecPrivate,
            isDefault: subtitle.isDefault,
            language: subtitle.language || 'und',
            name: subtitle.name,
            samples: subtitle.samples,
        });
    }
    return tracks;
}

/**
 * 读取字幕文件并转成 mkv 字幕轨
 * @param {object} opts
 * @param {string} opts.filePath 字幕路径（.srt / .ass / .ssa）
 * @param {string} [opts.title] 轨道名
 * @param {string} [opts.language] 轨道语言
 * @param {boolean} [opts.isDefault] 是否默认字幕轨
 * @returns {Promise<object|null>}
 */
async function loadSubtitleTrack({ filePath, title, language, isDefault }) {
    const ext = path.extname(filePath).toLowerCase();
    const text = decodeText(await fs.promises.readFile(filePath));

    if (ext === '.srt') {
        const parsed = parseSrt(text);
        if (parsed.length === 0) throw new Error(`字幕文件没有可用条目: ${filePath}`);
        return {
            codecId: 'S_TEXT/UTF8',
            codecPrivate: null,
            name: title,
            language,
            isDefault,
            samples: parsed.map((s) => ({
                timeMs: s.startMs,
                durMs: Math.max(1, s.endMs - s.startMs),
                data: s.data,
                            size: s.data.length,
                            keyframe: true,
                        })),
                    };
                }
                if (ext === '.ass' || ext === '.ssa') {
                    const parsed = parseAss(text);
                    if (parsed.samples.length === 0) throw new Error(`字幕文件没有可用对白: ${filePath}`);
                    return {
                        codecId: 'S_TEXT/ASS',
                        codecPrivate: parsed.header,
                        name: title,
                        language,
                        isDefault,
                        samples: parsed.samples.map((s) => ({
                            timeMs: s.startMs,
                            durMs: Math.max(1, s.endMs - s.startMs),
                            data: s.data,
                            size: s.data.length,
                            keyframe: true,
                        })),
                    };
                }
    throw new Error(`不支持的字幕格式: ${ext}（仅支持 .srt / .ass / .ssa）`);
}

/**
 * 生成 mkv 文件内容（一次性返回完整 Buffer，小文件/测试用）
 * @param {object} params
 * @param {object|null} [params.video] 视频轨 TrackSource（见 track-source.js），纯音频时省略
 * @param {object|null} [params.audio] 音频轨 TrackSource
 * @param {object|null} [params.subtitle] 字幕轨参数，传给 loadSubtitleTrack
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Buffer>}
 */
async function buildMkvBuffer({ video, audio, subtitle = null, title = null, onProgress = null, signal = null }) {
    const subtitleTrack = subtitle ? await loadSubtitleTrack(subtitle) : null;
    const tracks = buildTracks(video, audio, subtitleTrack);
    return muxMatroska({ tracks, title, onProgress, signal });
}

/**
 * 把 mkv 流式写入文件（不把整个文件放进内存）
 * @param {object} params
 * @param {object|null} [params.video] 视频轨 TrackSource（见 track-source.js），纯音频时省略
 * @param {object|null} [params.audio] 音频轨 TrackSource
 * @param {object|null} [params.subtitle] 字幕轨参数，传给 loadSubtitleTrack
 * @param {string} params.outputPath 输出 .mkv 路径
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ outputPath: string, size: number, clusters: number, durationMs: number }>}
 */
async function buildMkvFile({
    video,
    audio,
    subtitle = null,
    outputPath,
    title = null,
    onProgress = null,
    signal = null,
}) {
    const subtitleTrack = subtitle ? await loadSubtitleTrack(subtitle) : null;
    const tracks = buildTracks(video, audio, subtitleTrack);

    const writer = createFileWriter(outputPath);
    try {
        const result = await muxMatroskaToWriter({
            tracks,
            title,
            onProgress,
            signal,
            write: writer.write,
        });
        const { size } = await writer.close();
        return { outputPath, ...result, size };
    } catch (err) {
        writer.abort();
        throw err;
    }
}

module.exports = {
    buildMkvBuffer,
    buildMkvFile,
    loadSubtitleTrack,
    parseSrt,
    parseAss,
    muxMatroska,
    muxMatroskaToWriter,
    buildTracks,
    decodeText,
};