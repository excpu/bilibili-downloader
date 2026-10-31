// mp4-audio-reader.js
// MP4 / M4S 音频源的通用解析：Box 遍历 + 样本表（stbl）/ 分片（moof）样本定位。
//
// 这套逻辑与具体音频编码无关（AAC、FLAC 通用），原先长在 m4a.js 里，
// 抽出来给 m4a.js 与 flac.js 共用，避免两份实现各自漂移。
// 与 demux-m4s.js 的区别：那边基于 mp4box、产出 TrackSource 供混流；
// 这边是手写的单音轨读取器，供"转封装成单个音频文件"的管线（M4A / 原生 FLAC）使用。
//
// 全程按需读取：不把整段音频读进内存。
'use strict';

const biliPrefix = require('./bili-prefix');

// mdhd 里没有合法语言时的兜底值：'und'（ISO-639-2 三字符各 5 bit 打包）
const LANGUAGE_UND = 0x55c4;

// B 站 PC 客户端缓存文件头部有 9 个 ASCII '0' 混淆字节，读取前先探测（见 bili-prefix.js）
const detectBiliPrefix = biliPrefix.detectPrefixInReader;

// ================== Box 遍历 ==================

function readBoxHeader(reader, pos, limit) {
    if (pos + 8 > limit) return null;
    const head = reader.read(pos, Math.min(16, limit - pos));
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8;

    if (size === 1) {
        if (head.length < 16) return null;
        size = Number(head.readBigUInt64BE(8));
        headerSize = 16;
    } else if (size === 0) {
        size = limit - pos;
    }

    if (size < headerSize || pos + size > limit) {
        throw new Error(`Box '${type}' 尺寸异常 (size=${size} @${pos})，文件可能已损坏`);
    }

    return { type, start: pos, end: pos + size, size, headerSize };
}

/**
 * 列举父 Box 的直接子 Box
 */
function childBoxes(reader, box) {
    const list = [];
    let pos = box.start + box.headerSize;
    while (pos + 8 <= box.end) {
        const child = readBoxHeader(reader, pos, box.end);
        if (!child) break;
        list.push(child);
        pos = child.end;
    }
    return list;
}

/**
 * 在父 Box 中查找指定类型的直接子 Box
 */
function findBox(reader, box, type) {
    return childBoxes(reader, box).find((b) => b.type === type) || null;
}

/**
 * 查找直接子 Box，缺失时报错
 */
function requireBox(reader, box, type, owner) {
    const found = findBox(reader, box, type);
    if (!found) throw new Error(`${owner} 中缺少 '${type}' Box，文件结构不完整`);
    return found;
}

/**
 * 读取 FullBox 的载荷（不含 size/type，含 version/flags）
 */
function readPayload(reader, box) {
    return reader.read(box.start + box.headerSize, box.size - box.headerSize);
}

/**
 * 解析 mdhd：时间刻度、时长与语言
 */
function parseMdhd(reader, mdhd) {
    const p = readPayload(reader, mdhd);
    if (p[0] === 1) {
        return {
            timescale: p.readUInt32BE(20),
            duration: Number(p.readBigUInt64BE(24)),
            language: p.readUInt16BE(32),
        };
    }
    return {
        timescale: p.readUInt32BE(12),
        duration: p.readUInt32BE(16),
        language: p.readUInt16BE(20),
    };
}

/**
 * 解析 hdlr 的 handler 类型（'soun' / 'vide' ...）
 */
function parseHdlr(reader, hdlr) {
    const p = readPayload(reader, hdlr);
    return p.toString('latin1', 8, 12);
}

/**
 * 解析 tkhd 中的 track_ID（音视频混流时要靠它只取音频分片）
 */
function parseTkhdTrackId(reader, tkhd) {
    const p = readPayload(reader, tkhd);
    // v1：4 字节 version/flags + 8 + 8 字节时间戳后是 track_ID
    return p.readUInt32BE(p[0] === 1 ? 20 : 12);
}

/**
 * 读取 stsd 中第一个 Sample Entry 的原始字节，并解析 AAC 相关字段
 *
 * 原始字节会被原样写进输出文件：esds（AudioSpecificConfig）这类配置记录
 * 不适合重新序列化生成，否则可能丢字段或引起播放器兼容问题。
 */
function readSampleEntry(reader, stsd) {
    const head = reader.read(stsd.start + stsd.headerSize, 8);
    const entryCount = head.readUInt32BE(4);
    if (entryCount < 1) {
        throw new Error('stsd 中没有 Sample Entry，无法确定音频编码');
    }

    const entryBox = readBoxHeader(reader, stsd.start + stsd.headerSize + 8, stsd.end);
    if (!entryBox) {
        throw new Error('stsd 中的 Sample Entry 已损坏');
    }

    const raw = reader.read(entryBox.start, entryBox.size);
    if (raw.readUInt32BE(0) !== raw.length) {
        throw new Error('Sample Entry 尺寸不一致，文件可能已损坏');
    }

    const result = {
        type: entryBox.type,
        raw,
        version: 0,
        channelCount: 0,
        sampleSize: 16,
        sampleRate: 0,
        hasEsds: false,
    };

    // AudioSampleEntry 固定字段：8 字节 Box 头 + 8 字节保留/索引 + 版本号
    if (raw.length >= 36) {
        result.version = raw.readUInt16BE(16);
        result.channelCount = raw.readUInt16BE(24);
        result.sampleSize = raw.readUInt16BE(26) || 16;
        result.sampleRate = raw.readUInt32BE(32) >>> 16;

        // version 0 时子 Box（esds 等）紧跟固定字段之后
        if (result.version === 0) {
            let pos = 36;
            while (pos + 8 <= raw.length) {
                const size = raw.readUInt32BE(pos);
                const type = raw.toString('latin1', pos + 4, pos + 8);
                if (type === 'esds') {
                    result.hasEsds = true;
                    break;
                }
                if (size < 8) break;
                pos += size;
            }
        }
    }

    return result;
}

/**
 * 解析 stts，展开成逐样本时长
 */
function parseStts(reader, stts, count) {
    const p = readPayload(reader, stts);
    const entries = p.readUInt32BE(4);
    const durations = new Array(count);
    let sample = 0;
    let offset = 8;
    for (let i = 0; i < entries && sample < count; i++) {
        const runCount = p.readUInt32BE(offset);
        const delta = p.readUInt32BE(offset + 4);
        for (let k = 0; k < runCount && sample < count; k++) {
            durations[sample++] = delta > 0 ? delta : 1;
        }
        offset += 8;
    }
    // 表项不足时用最后一个 delta 补齐
    const last = sample > 0 ? durations[sample - 1] : 1;
    while (sample < count) durations[sample++] = last;
    return durations;
}

/**
 * 解析 ctts，展开成逐样本合成时间偏移
 */
function parseCtts(reader, ctts, count) {
    const p = readPayload(reader, ctts);
    const version = p[0];
    const entries = p.readUInt32BE(4);
    const offsets = new Array(count).fill(0);
    let sample = 0;
    let offset = 8;
    for (let i = 0; i < entries && sample < count; i++) {
        const runCount = p.readUInt32BE(offset);
        const value = version === 1 ? p.readInt32BE(offset + 4) : p.readUInt32BE(offset + 4);
        for (let k = 0; k < runCount && sample < count; k++) offsets[sample++] = value;
        offset += 8;
    }
    return offsets;
}

/**
 * 解析 stsc，返回每个 chunk（0 基）包含的样本数
 */
function parseStsc(reader, stsc, chunkCount) {
    const p = readPayload(reader, stsc);
    const entries = p.readUInt32BE(4);
    const runs = [];
    let offset = 8;
    for (let i = 0; i < entries; i++) {
        runs.push({
            firstChunk: p.readUInt32BE(offset), // 1 基
            samplesPerChunk: p.readUInt32BE(offset + 4),
        });
        offset += 12;
    }
    if (runs.length === 0) {
        throw new Error('stsc 为空，无法确定 chunk 划分');
    }

    const perChunk = new Array(chunkCount).fill(runs[0].samplesPerChunk);
    let runIndex = 0;
    for (let chunk = 0; chunk < chunkCount; chunk++) {
        while (runIndex + 1 < runs.length && runs[runIndex + 1].firstChunk <= chunk + 1) {
            runIndex++;
        }
        perChunk[chunk] = runs[runIndex].samplesPerChunk;
    }
    return perChunk;
}

/**
 * 解析 stco / co64 的 chunk 偏移
 */
function parseChunkOffsets(reader, box) {
    const p = readPayload(reader, box);
    const count = p.readUInt32BE(4);
    const offsets = new Array(count);
    let offset = 8;
    for (let i = 0; i < count; i++) {
        if (box.type === 'co64') {
            offsets[i] = Number(p.readBigUInt64BE(offset));
            offset += 8;
        } else {
            offsets[i] = p.readUInt32BE(offset);
            offset += 4;
        }
    }
    return offsets;
}

/**
 * 按 stbl 样本表重建样本列表（渐进式输入）
 */
function parseTableSamples(reader, stbl, prefix) {
    const stsz = findBox(reader, stbl, 'stsz');
    if (!stsz) return null;

    const p = readPayload(reader, stsz);
    const fixedSize = p.readUInt32BE(4);
    const count = p.readUInt32BE(8);
    if (count === 0) return null;

    const sizes = new Array(count);
    for (let i = 0; i < count; i++) {
        sizes[i] = fixedSize !== 0 ? fixedSize : p.readUInt32BE(12 + i * 4);
    }

    const stts = requireBox(reader, stbl, 'stts', 'stbl');
    const durations = parseStts(reader, stts, count);

    const cttsBox = findBox(reader, stbl, 'ctts');
    const ctsOffsets = cttsBox ? parseCtts(reader, cttsBox, count) : null;

    const stco = findBox(reader, stbl, 'stco') || findBox(reader, stbl, 'co64');
    if (!stco) throw new Error('stbl 中缺少 stco/co64，无法定位样本数据');
    const chunkOffsets = parseChunkOffsets(reader, stco);

    const stsc = requireBox(reader, stbl, 'stsc', 'stbl');
    const perChunk = parseStsc(reader, stsc, chunkOffsets.length);

    const samples = [];
    let sample = 0;
    let dts = 0;
    for (let chunk = 0; chunk < chunkOffsets.length && sample < count; chunk++) {
        // chunk 偏移是去掉 9 字节前缀后的坐标
        let cursor = prefix + chunkOffsets[chunk];
        for (let k = 0; k < perChunk[chunk] && sample < count; k++) {
            samples.push({
                offset: cursor,
                size: sizes[sample],
                duration: durations[sample],
                dts,
                cts: dts + (ctsOffsets ? ctsOffsets[sample] : 0),
            });
            cursor += sizes[sample];
            dts += durations[sample];
            sample++;
        }
    }
    return samples;
}

/**
 * 解析 tfhd
 */
function parseTfhd(reader, tfhd) {
    const p = readPayload(reader, tfhd);
    const flags = p.readUInt32BE(0) & 0xffffff;
    const info = {
        trackId: p.readUInt32BE(4),
        baseDataOffset: null,
        defaultSampleDuration: 0,
        defaultSampleSize: 0,
        defaultBaseIsMoof: (flags & 0x020000) !== 0,
    };
    let offset = 8;
    if (flags & 0x000001) {
        info.baseDataOffset = Number(p.readBigUInt64BE(offset));
        offset += 8;
    }
    if (flags & 0x000002) offset += 4; // sample_description_index
    if (flags & 0x000008) {
        info.defaultSampleDuration = p.readUInt32BE(offset);
        offset += 4;
    }
    if (flags & 0x000010) info.defaultSampleSize = p.readUInt32BE(offset);
    return info;
}

/**
 * 解析 tfdt（baseMediaDecodeTime）
 */
function parseTfdt(reader, tfdt) {
    const p = readPayload(reader, tfdt);
    return p[0] === 1 ? Number(p.readBigUInt64BE(4)) : p.readUInt32BE(4);
}

/**
 * 解析 trun，返回每帧的 size / duration / cts 偏移
 */
function parseTrun(reader, trun, tfhd) {
    const p = readPayload(reader, trun);
    const version = p[0];
    const flags = p.readUInt32BE(0) & 0xffffff;
    const sampleCount = p.readUInt32BE(4);
    let offset = 8;

    let dataOffset = 0;
    if (flags & 0x000001) {
        dataOffset = p.readInt32BE(offset);
        offset += 4;
    }
    if (flags & 0x000004) offset += 4; // first_sample_flags

    const hasDuration = (flags & 0x000100) !== 0;
    const hasSize = (flags & 0x000200) !== 0;
    const hasFlags = (flags & 0x000400) !== 0;
    const hasCts = (flags & 0x000800) !== 0;

    const entries = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        let duration = tfhd.defaultSampleDuration;
        let size = tfhd.defaultSampleSize;
        let ctsOffset = 0;

        if (hasDuration) {
            duration = p.readUInt32BE(offset);
            offset += 4;
        }
        if (hasSize) {
            size = p.readUInt32BE(offset);
            offset += 4;
        }
        // 样本 flags（同步帧标记等）只与随机访问有关，
        // 输出为单段 mdat 时不需要 stss，跳过后仍需推进读取偏移
        if (hasFlags) offset += 4;
        if (hasCts) {
            ctsOffset = version === 1 ? p.readInt32BE(offset) : p.readUInt32BE(offset);
            offset += 4;
        }

        entries[i] = {
            duration: duration > 0 ? duration : 1,
            size,
            ctsOffset,
        };
    }

    return { dataOffset, hasDataOffset: (flags & 0x000001) !== 0, entries };
}

/**
 * 解析 mvex/trex：分片文件的默认样本时长/尺寸通常只在这里声明一次
 * @returns {Map<number, { duration: number, size: number }>}
 */
function parseTrexDefaults(reader, moov) {
    const defaults = new Map();
    const mvex = findBox(reader, moov, 'mvex');
    if (!mvex) return defaults;

    for (const trex of childBoxes(reader, mvex).filter((b) => b.type === 'trex')) {
        const p = readPayload(reader, trex);
        defaults.set(p.readUInt32BE(4), {
            duration: p.readUInt32BE(12),
            size: p.readUInt32BE(16),
        });
    }
    return defaults;
}

/**
 * 解析一个 moof，把其中的样本按真实文件偏移展开
 * @param {object} state 跨 moof 共享的状态（缺少 tfdt 时用来续接解码时间）
 * @returns {{ trackId: number, samples: Array }[]}
 */
function parseMoof(reader, moof, trexDefaults, state) {
    const trafs = childBoxes(reader, moof).filter((b) => b.type === 'traf');
    const result = [];
    // 未显式给出 data_offset 时，下一个 traf 的数据紧随前一个 traf 之后
    let previousDataEnd = null;

    for (const traf of trafs) {
        const tfhdBox = findBox(reader, traf, 'tfhd');
        if (!tfhdBox) continue;
        const tfhd = parseTfhd(reader, tfhdBox);

        // tfhd 的默认值优先，缺省时回落到 trex，再缺省则只能按样本自身字段
        const trex = trexDefaults.get(tfhd.trackId);
        if (trex) {
            if (!tfhd.defaultSampleDuration) tfhd.defaultSampleDuration = trex.duration;
            if (!tfhd.defaultSampleSize) tfhd.defaultSampleSize = trex.size;
        }

        const tfdtBox = findBox(reader, traf, 'tfdt');
        const baseDts = tfdtBox
            ? parseTfdt(reader, tfdtBox)
            : state.nextDts.has(tfhd.trackId)
                ? state.nextDts.get(tfhd.trackId)
                : 0;

        // 规范约定：显式 base-data-offset 优先；
        // 否则 default-base-is-moof 表示以 moof 起点为基准；
        // 再否则第一个 traf 以 moof 起点为基准，后续 traf 承接前一个 traf 的数据末尾。
        let base;
        if (tfhd.baseDataOffset !== null) base = tfhd.baseDataOffset;
        else if (tfhd.defaultBaseIsMoof) base = moof.start;
        else base = previousDataEnd !== null ? previousDataEnd : moof.start;

        const samples = [];
        let dts = baseDts;
        let dataEnd = previousDataEnd;

        for (const trunBox of childBoxes(reader, traf).filter((b) => b.type === 'trun')) {
            const trun = parseTrun(reader, trunBox, tfhd);
            // data_offset 是相对 base 的有符号偏移；缺失时按顺序续接
            let cursor = trun.hasDataOffset
                ? base + trun.dataOffset
                : dataEnd !== null
                    ? dataEnd
                    : moof.end;

            for (const entry of trun.entries) {
                if (entry.size <= 0) {
                    throw new Error('moof 中存在尺寸为 0 的样本，无法转封装');
                }
                samples.push({
                    offset: cursor,
                    size: entry.size,
                    duration: entry.duration,
                    dts,
                    cts: dts + entry.ctsOffset,
                });
                cursor += entry.size;
                dts += entry.duration;
            }
            dataEnd = cursor;
        }

        previousDataEnd = dataEnd;
        state.nextDts.set(tfhd.trackId, dts);
        if (samples.length > 0) result.push({ trackId: tfhd.trackId, samples });
    }

    return result;
}

/**
 * 遍历全部 moof，收集目标轨道的样本（音视频混流时只取音频那一轨）
 * @param {number} trackId 目标轨道 ID
 */
function collectFragmentedSamples(reader, moov, moofs, trackId) {
    const trexDefaults = parseTrexDefaults(reader, moov);
    const state = { nextDts: new Map() };
    const samples = [];
    for (const moof of moofs) {
        for (const traf of parseMoof(reader, moof, trexDefaults, state)) {
            if (traf.trackId !== trackId) continue;
            for (const sample of traf.samples) samples.push(sample);
        }
    }
    return samples;
}

/**
 * 解析音频源文件：定位轨道、编码配置与全部样本
 * @param {{ size: number, read: Function }} reader
 */
/**
 * 解析音频源文件：定位音频轨道、编码配置与全部样本
 *
 * @param {{ size: number, read: (offset: number, length: number) => Buffer }} reader
 * @param {object} [options]
 * @param {Array<string>} [options.supportedCodecs] 允许的 Sample Entry 类型，默认只放行 mp4a
 * @param {boolean} [options.requireEsds] 是否要求 mp4a 携带 esds（非 AAC 时应关闭）
 * @param {string} [options.codecLabel] 报错时展示的受支持编码说明
 * @param {string} [options.errorSubject] 报错时的主语（"本模块" / "FLAC 转封装"）
 * @returns {object} 源信息 + 样本列表（sample.offset 为原始文件坐标，含 B 站前缀）
 */
function analyzeMp4Audio(reader, options = {}) {
    const {
        supportedCodecs = ['mp4a'],
        requireEsds = true,
        codecLabel = 'AAC（mp4a）',
        errorSubject = '本模块',
    } = options;
    const prefix = detectBiliPrefix(reader);
    const limit = reader.size;

    let moov = null;
    const moofs = [];
    try {
        let pos = prefix;
        while (pos + 8 <= limit) {
            const box = readBoxHeader(reader, pos, limit);
            if (!box) break;
            if (box.type === 'moov' && !moov) moov = box;
            else if (box.type === 'moof') moofs.push(box);
            pos = box.end;
        }
    } catch (err) {
        throw new Error(`输入不是有效的 MP4/M4S 音频：${err.message}`);
    }

    if (!moov) {
        throw new Error('未找到 moov：输入不是有效的 MP4/M4S 文件');
    }

    // 优先挑 handler 为 'soun' 的轨道，退化时取第一条轨道
    const traks = childBoxes(reader, moov).filter((b) => b.type === 'trak');
    if (traks.length === 0) {
        throw new Error('moov 中没有任何轨道');
    }

    let trak = null;
    for (const candidate of traks) {
        const mdia = findBox(reader, candidate, 'mdia');
        if (!mdia) continue;
        const hdlr = findBox(reader, mdia, 'hdlr');
        if (hdlr && parseHdlr(reader, hdlr) === 'soun') {
            trak = candidate;
            break;
        }
    }
    if (!trak) trak = traks[0];

    const tkhd = requireBox(reader, trak, 'tkhd', 'trak');
    const trackId = parseTkhdTrackId(reader, tkhd);
    const mdia = requireBox(reader, trak, 'mdia', 'trak');
    const mdhd = parseMdhd(reader, requireBox(reader, mdia, 'mdhd', 'mdia'));
    if (!mdhd.timescale) {
        throw new Error('mdhd 时间刻度无效');
    }

    const minf = requireBox(reader, mdia, 'minf', 'mdia');
    const stbl = requireBox(reader, minf, 'stbl', 'minf');
    const stsd = requireBox(reader, stbl, 'stsd', 'stbl');
    const sampleEntry = readSampleEntry(reader, stsd);

    if (!supportedCodecs.includes(sampleEntry.type)) {
        throw new Error(
            `不支持的音频编码 '${sampleEntry.type}'：${errorSubject}只处理 ${codecLabel} 音频`
        );
    }
    if (requireEsds && !sampleEntry.hasEsds) {
        throw new Error('mp4a 样本描述中缺少 esds（AudioSpecificConfig），无法生成合规 M4A');
    }

    let samples;
    if (moofs.length > 0) {
        samples = collectFragmentedSamples(reader, moov, moofs, trackId);
    } else {
        samples = parseTableSamples(reader, stbl, prefix);
        if (!samples) {
            throw new Error('输入既没有 moof 分片，也没有有效的 stbl 样本表');
        }
    }

    if (samples.length === 0) {
        throw new Error('未能从输入中提取到任何音频样本');
    }

    // 分片文件的 traf 顺序通常已正确；这里仅兜底校验
    for (let i = 1; i < samples.length; i++) {
        if (samples[i].dts < samples[i - 1].dts) {
            samples.sort((a, b) => a.dts - b.dts);
            break;
        }
    }

    const firstDts = samples[0].dts;
    let lastEnd = 0;
    let totalBytes = 0;
    for (const sample of samples) {
        sample.dts -= firstDts;
        sample.cts -= firstDts;
        if (sample.dts + sample.duration > lastEnd) lastEnd = sample.dts + sample.duration;
        totalBytes += sample.size;
        if (sample.offset < 0 || sample.offset + sample.size > limit) {
            throw new Error('样本数据超出文件范围，输入可能已被截断');
        }
    }

    // 保留源的 udta 元数据（B 站写入的 encoder / description 等），原样搬运
    const udtaBox = findBox(reader, moov, 'udta');
    const udta = udtaBox ? reader.read(udtaBox.start, udtaBox.size) : null;

    return {
        prefix,
        fragmented: moofs.length > 0,
        timescale: mdhd.timescale,
        mediaDuration: lastEnd,
        language: mdhd.language || LANGUAGE_UND,
        sampleEntry: sampleEntry.raw,
        codec: sampleEntry.type,
        channelCount: sampleEntry.channelCount,
        sampleSize: sampleEntry.sampleSize,
        sampleRate: sampleEntry.sampleRate || mdhd.timescale,
        samples,
        totalBytes,
        udta,
    };
}

// ================== 对外接口 ==================

module.exports = {
    analyzeMp4Audio,
    readBoxHeader,
    childBoxes,
    findBox,
    requireBox,
    readPayload,
    readSampleEntry,
    LANGUAGE_UND,
};
