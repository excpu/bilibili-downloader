// matroska.js
// 纯 Node.js 的 Matroska (MKV) 封装实现，不依赖 ffmpeg。
// 输入是 mp4box 解出的音视频 Sample，以及可选的字幕（SRT / ASS），输出 .mkv 字节流。
const fs = require('fs');
const path = require('path');
const { createFileWriter } = require('./stream-writer');

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

function int16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    return b;
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

/** 取样本字节：内存模式下直接返回 data，流式模式下按需从源文件读取 */
function sampleBytes(sample) {
    let data;
    if (sample.data) data = sample.data;
    else if (typeof sample.read === 'function') data = sample.read();
    else throw new Error('Sample 既没有 data 也没有 read()');
    if (data.length !== sample.size) {
        throw new Error(`Sample 长度不一致: 期望 ${sample.size}，实际 ${data.length}`);
    }
    return data;
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

/** 从 stsd 子 Box 中取出原始载荷字节 */
function configPayload(stsdEntry, type) {
    if (!stsdEntry) return null;
    const boxes = Array.isArray(stsdEntry.boxes) ? stsdEntry.boxes : [];
    const box = boxes.find((b) => b && b.type === type) || stsdEntry[type];
    if (!box) return null;
    if (box.data && box.data.length > 0) {
        return Buffer.from(box.data.buffer, box.data.byteOffset, box.data.byteLength);
    }
    return null;
}

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

    let pos = 4; // 跳过 version + flags
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

/**
 * 根据视频轨信息得到 Matroska 的 CodecID 与 CodecPrivate
 * @returns {{ codecId: string, codecPrivate: Buffer|null }}
 */
function videoCodecInfo(trackInfo, stsdEntry) {
    const subtype = String(trackInfo.codec || '').split('.')[0].toLowerCase();
    switch (subtype) {
        case 'avc1':
        case 'avc3':
            return { codecId: 'V_MPEG4/ISO/AVC', codecPrivate: configPayload(stsdEntry, 'avcC') };
        case 'hev1':
        case 'hvc1':
            return { codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: configPayload(stsdEntry, 'hvcC') };
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
    const sampleRate = trackInfo.audio ? trackInfo.audio.sample_rate : trackInfo.timescale;
    const channels = trackInfo.audio ? trackInfo.audio.channel_count : 2;

    switch (subtype) {
        case 'mp4a': {
            const asc =
                parseEsdsAsc(stsdEntry && stsdEntry.esds) ||
                fallbackAacAsc(trackInfo.codec, sampleRate, channels);
            return { codecId: 'A_AAC', codecPrivate: asc };
        }
        case 'flac': {
            const dfLa = configPayload(stsdEntry, 'dfLa');
            if (!dfLa) return { codecId: 'A_FLAC', codecPrivate: null };
            // dfLa 载荷：version/flags(4) + FLAC 元数据块；MKV 要求带 "fLaC" 魔数
            return { codecId: 'A_FLAC', codecPrivate: Buffer.concat([Buffer.from('fLaC'), dfLa.subarray(4)]) };
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

function demuxSamplesToMkv(demuxData, useCts) {
    const timescale = demuxData.trackInfo.timescale;
    const readSample = typeof demuxData.readSample === 'function' ? demuxData.readSample : null;

    return demuxData.samples.map((s) => {
        const timeMs = Math.max(0, Math.round(((useCts ? s.cts : s.dts) || 0) * 1000 / timescale));
        const durMs = Math.max(0, Math.round((s.duration || 0) * 1000 / timescale));

        if (s.data) {
            const data = Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength);
            return { timeMs, durMs, data, size: data.length, keyframe: Boolean(s.is_sync) };
        }
        if (readSample) {
            // 流式模式：只留元信息，写 Cluster 时才从源文件按偏移读取
            return {
                timeMs,
                durMs,
                size: s.size,
                offset: s.offset,
                read: () => readSample(s),
                keyframe: Boolean(s.is_sync),
            };
        }
        throw new Error('Sample 缺少 data，且未提供 readSample 读取器');
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
    return el(ID.TrackEntry, Buffer.concat(parts));
}

/** 块载荷长度：TrackNumber(vint) + 相对时间码(2) + flags(1) + 帧数据 */
function blockPayloadLength(trackNumber, sample) {
    return vintLength(trackNumber) + 3 + sample.size;
}

function simpleBlock(trackNumber, relativeTimecode, sample) {
    const flags = sample.keyframe ? 0x80 : 0x00;
    return el(
        ID.SimpleBlock,
        Buffer.concat([
            ebmlVint(trackNumber),
            int16(relativeTimecode),
            Buffer.from([flags]),
            sampleBytes(sample),
        ])
    );
}

function simpleBlockLength(trackNumber, sample) {
    return elLength(ID.SimpleBlock, blockPayloadLength(trackNumber, sample));
}

/** 字幕需要 BlockDuration 才能控制显示时长，因此用 BlockGroup 而不是 SimpleBlock */
function blockGroup(trackNumber, relativeTimecode, sample) {
    const block = Buffer.concat([
        ebmlVint(trackNumber),
        int16(relativeTimecode),
        Buffer.from([0x00]),
        sampleBytes(sample),
    ]);
    return el(
        ID.BlockGroup,
        Buffer.concat([el(ID.Block, block), elUint(ID.BlockDuration, Math.max(sample.durMs, 1))])
    );
}

function blockGroupLength(trackNumber, sample) {
    const blockLen = elLength(ID.Block, blockPayloadLength(trackNumber, sample));
    const durationValue = Math.max(sample.durMs, 1);
    const durationLen = elLength(ID.BlockDuration, uintLength(durationValue));
    return elLength(ID.BlockGroup, blockLen + durationLen);
}

/**
 * 把音轨/字幕按视频关键帧切成 Cluster，并保持视频 Sample 的解码顺序
 * @param {Array<object>} tracks
 * @returns {Array<{ ts: number, blocks: Array<{ track: object, sample: object }> }>}
 */
function buildClusters(tracks) {
    const videoTrack = tracks.find((t) => t.type === TRACK_TYPE.VIDEO) || null;
    const others = tracks.filter((t) => t !== videoTrack);
    const videoSamples = videoTrack ? videoTrack.samples : [];

    const starts = [];
    for (let i = 0; i < videoSamples.length; i++) {
        if (i === 0 || videoSamples[i].keyframe) starts.push(i);
    }
    if (starts.length === 0) starts.push(0);

    const pointers = new Map(others.map((t) => [t.number, 0]));
    const clusters = [];
    let previousTs = 0;

    for (let k = 0; k < starts.length; k++) {
        const from = starts[k];
        const to = k + 1 < starts.length ? starts[k + 1] : videoSamples.length;
        const videoSlice = videoSamples.slice(from, to);
        const limit = k + 1 < starts.length ? videoSamples[starts[k + 1]].timeMs : Infinity;

        const othersSlice = others.map((t) => {
            const arr = t.samples;
            const start = pointers.get(t.number);
            let end = start;
            while (end < arr.length && arr[end].timeMs < limit) end++;
            pointers.set(t.number, end);
            return { track: t, samples: arr.slice(start, end) };
        });

        let ts = videoSlice.length > 0 ? videoSlice[0].timeMs : previousTs;
        for (const o of othersSlice) {
            if (o.samples.length > 0) ts = Math.min(ts, o.samples[0].timeMs);
        }
        previousTs = ts;

        const blocks = [];
        const emitReady = (limitMs) => {
            for (const o of othersSlice) {
                while (o.samples.length > 0 && o.samples[0].timeMs <= limitMs) {
                    blocks.push({ track: o.track, sample: o.samples.shift() });
                }
            }
        };
        for (const s of videoSlice) {
            emitReady(s.timeMs);
            blocks.push({ track: videoTrack, sample: s });
        }
        emitReady(Infinity);

        if (blocks.length === 0) continue;
        clusters.push({ ts, blocks });
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
    for (const { track, sample } of cluster.blocks) {
        const rel = sample.timeMs - cluster.ts;
        if (rel < -32768 || rel > 32767) {
            throw new Error(`Sample 相对时间超出 Cluster 范围 (${rel} ms)`);
        }
        if (track.type === TRACK_TYPE.SUBTITLE) {
            yield blockGroup(track.number, rel, sample);
        } else {
            yield simpleBlock(track.number, rel, sample);
        }
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
 * 先算出 Cluster 布局和 Cues，再按 Cluster 边界逐块交给 write()。
 * 字幕/Sample 数据在需要时通过 sample.read() 从源文件读，写完即释放。
 *
 * @param {object} params
 * @param {Array<object>} params.tracks
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @param {(chunk: Buffer) => (void|Promise<void>)} params.write 顺序写出分块
 * @returns {Promise<{ clusters: number, durationMs: number, size: number }>}
 */
async function muxMatroskaToWriter({ tracks, title = null, onProgress = null, write }) {
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
        cuePointParts.push(
            el(
                ID.CuePoint,
                Buffer.concat([
                    elUint(ID.CueTime, clusters[i].ts),
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
        clusterPos += clusterSizes[i];
    }
    const cues = el(ID.Cues, Buffer.concat(cuePointParts));
    segmentPayloadLength += cues.length;

    const segmentHeaderLength = elHeader(ID.Segment, segmentPayloadLength).length;
        // SeekHead / Cues 里的位置都相对 Segment 载荷起始，即 cues 紧跟所有 Cluster
        buildSeekHead(infoPos, tracksPos, clusterPos).copy(seekHead);

        let written = 0;
        const emit = async (chunk) => {
            await write(chunk);
            written += chunk.length;
        };

        await emit(ebmlHeader);
        await emit(elHeader(ID.Segment, segmentPayloadLength));
        await emit(seekHead);
        await emit(info);
        await emit(tracksBuf);

        for (let i = 0; i < clusters.length; i++) {
            for (const chunk of clusterChunks(clusters[i])) await emit(chunk);
            if (onProgress) onProgress(Math.min((i + 1) / (clusters.length + 1), 0.99));
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
 * @returns {Promise<Buffer>}
 */
async function muxMatroska({ tracks, title = null, onProgress = null }) {
    const chunks = [];
    await muxMatroskaToWriter({
        tracks,
        title,
        onProgress,
        write: (chunk) => {
            chunks.push(chunk);
        },
    });
    return Buffer.concat(chunks);
}

/**
 * 由 demuxM4s 的结果构造 mkv 轨道信息
 * @param {object} video demuxM4s(视频) 的结果
 * @param {object} audio demuxM4s(音频) 的结果
 * @param {Array<object>|null} subtitle 字幕轨（已在 build 阶段解析）
 * @returns {Array<object>}
 */
function buildTracks(video, audio, subtitle) {
    const vCodec = videoCodecInfo(video.trackInfo, video.stsdEntry);
    const aCodec = audioCodecInfo(audio.trackInfo, audio.stsdEntry);
    const vInfo = video.trackInfo;
    const aInfo = audio.trackInfo;

    const tracks = [
        {
            number: 1,
            uid: 1,
            type: TRACK_TYPE.VIDEO,
            codecId: vCodec.codecId,
            codecPrivate: vCodec.codecPrivate,
            isDefault: true,
            language: 'und',
            width: vInfo.video ? vInfo.video.width : vInfo.track_width,
            height: vInfo.video ? vInfo.video.height : vInfo.track_height,
            samples: demuxSamplesToMkv(video, true),
        },
        {
            number: 2,
            uid: 2,
            type: TRACK_TYPE.AUDIO,
            codecId: aCodec.codecId,
            codecPrivate: aCodec.codecPrivate,
            isDefault: true,
            language: 'und',
            sampleRate: aInfo.audio ? aInfo.audio.sample_rate : aInfo.timescale,
            channels: aInfo.audio ? aInfo.audio.channel_count : 2,
            bitDepth: aInfo.audio ? aInfo.audio.sample_size : 16,
            samples: demuxSamplesToMkv(audio, false),
        },
    ];

    if (subtitle) {
        tracks.push({
            number: 3,
            uid: 3,
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
 * @param {object} params.video demuxM4s(视频) 的结果
 * @param {object} params.audio demuxM4s(音频) 的结果
 * @param {object|null} [params.subtitle] 字幕轨参数，传给 loadSubtitleTrack
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @returns {Promise<Buffer>}
 */
async function buildMkvBuffer({ video, audio, subtitle = null, title = null, onProgress = null }) {
    const subtitleTrack = subtitle ? await loadSubtitleTrack(subtitle) : null;
    const tracks = buildTracks(video, audio, subtitleTrack);
    return muxMatroska({ tracks, title, onProgress });
}

/**
 * 把 mkv 流式写入文件（不把整个文件放进内存）
 * @param {object} params
 * @param {object} params.video demuxM4s(视频) 的结果
 * @param {object} params.audio demuxM4s(音频) 的结果
 * @param {object|null} [params.subtitle] 字幕轨参数，传给 loadSubtitleTrack
 * @param {string} params.outputPath 输出 .mkv 路径
 * @param {string} [params.title]
 * @param {(progress: number) => void} [params.onProgress]
 * @returns {Promise<{ outputPath: string, size: number, clusters: number, durationMs: number }>}
 */
async function buildMkvFile({
    video,
    audio,
    subtitle = null,
    outputPath,
    title = null,
    onProgress = null,
}) {
    const subtitleTrack = subtitle ? await loadSubtitleTrack(subtitle) : null;
    const tracks = buildTracks(video, audio, subtitleTrack);

    const writer = createFileWriter(outputPath);
    try {
        const result = await muxMatroskaToWriter({
            tracks,
            title,
            onProgress,
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