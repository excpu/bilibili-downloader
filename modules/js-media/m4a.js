// m4a.js
// 把 Bilibili 的 M4S（分片 MP4 / DASH）AAC 音频转封装成标准的 M4A 文件。
//
// B 站下发的 audio.m4s 是分片 MP4：样本索引散落在各个 moof/traf/trun 中，
// 而标准 M4A（iTunes / 播放器 / 车载 / 剪辑软件）要求单段 mdat + moov.stbl 样本表。
// 这里只重排容器结构，AAC 码流原封不动（不重编码），
// 因此速度接近磁盘拷贝，且不会产生任何音质损失。
//
// 输入兼容：
//   - B 站 CDN 下发的 audio.m4s（含 moof 分片）
//   - PC 客户端缓存文件（文件头带 9 个 ASCII '0' 混淆字节）
//   - 渐进式（非分片）MP4/M4A 音频，按 stbl 样本表读取
//
// 全程按需读取：不把整段音频读进内存，也不依赖 ffmpeg。
'use strict';

const fs = require('fs');
const { createFileWriter } = require('./stream-writer');

const MOVIE_TIMESCALE = 1000;
// 每个 chunk 的样本数：只影响 stco/co64 表的规模，不影响播放
const SAMPLES_PER_CHUNK = 512;
// 写盘聚合阈值，避免每帧都触发一次 write
const FLUSH_THRESHOLD = 1 << 20;

const BILI_PREFIX_LENGTH = 9;
const BILI_PREFIX_BYTE = 0x30; // '0'

const MAX_UINT32 = 0xffffffff;
// 估算 co64 时给 ftyp/moov 预留的余量
const CO64_MARGIN = 64 * 1024 * 1024;

const IDENTITY_MATRIX = Buffer.concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
]);

const LANGUAGE_UND = 0x55c4; // 'und'

// ================== 二进制写入小工具 ==================

function u16(value) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(value & 0xffff, 0);
    return b;
}

function u32(value) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
}

function u64(value) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(value))), 0);
    return b;
}

function ascii(text) {
    return Buffer.from(text, 'latin1');
}

/**
 * 拼一个 ISO BMFF Box（size + type + payload）
 * @param {string} type 4 字符 Box 类型
 * @param {...(Buffer|Uint8Array)} parts
 * @returns {Buffer}
 */
function makeBox(type, ...parts) {
    const body = Buffer.concat(parts);
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32BE(head.length + body.length, 0);
    head.write(type, 4, 4, 'latin1');
    return Buffer.concat([head, body]);
}

/**
 * 拼一个 FullBox（size + type + version/flags + payload）
 * @param {string} type
 * @param {number} version
 * @param {number} flags
 * @param {...(Buffer|Uint8Array)} parts
 * @returns {Buffer}
 */
function makeFullBox(type, version, flags, ...parts) {
    const versionFlags = Buffer.allocUnsafe(4);
    versionFlags.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
    return makeBox(type, versionFlags, ...parts);
}

// ================== 输入读取抽象 ==================

/**
 * 以随机读取方式访问输入文件
 * @param {string} filePath
 */
function createFileReader(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;

    return {
        size,
        read(offset, length) {
            if (length <= 0) return Buffer.alloc(0);
            const buf = Buffer.allocUnsafe(length);
            let filled = 0;
            while (filled < length) {
                const got = fs.readSync(fd, buf, filled, length - filled, offset + filled);
                if (got <= 0) {
                    throw new Error(`读取输入失败 (${filePath} @${offset + filled})：文件可能已被截断`);
                }
                filled += got;
            }
            return buf;
        },
        close() {
            if (fd === undefined) return;
            try {
                fs.closeSync(fd);
            } catch (_) {
                // 忽略重复关闭
            }
        },
    };
}

/**
 * 用 Buffer 冒充读取器，供内存输入复用同一套解析/封装逻辑
 * @param {Buffer} buffer
 */
function createBufferReader(buffer) {
    return {
        size: buffer.length,
        read(offset, length) {
            return buffer.subarray(offset, offset + length);
        },
        close() { },
    };
}

// ================== 输入解析 ==================

/**
 * 探测 Bilibili PC 客户端缓存的 9 字节 ASCII '0' 前缀
 * @param {{ size: number, read: (offset: number, length: number) => Buffer }} reader
 * @returns {number} 需要跳过的字节数
 */
function detectBiliPrefix(reader) {
    if (reader.size <= BILI_PREFIX_LENGTH) return 0;
    const head = reader.read(0, BILI_PREFIX_LENGTH);
    for (let i = 0; i < BILI_PREFIX_LENGTH; i++) {
        if (head[i] !== BILI_PREFIX_BYTE) return 0;
    }
    return BILI_PREFIX_LENGTH;
}

/**
 * 读取一个 Box 头（支持 64 位 largesize 与 size==0）
 * @param {{ size: number, read: (offset: number, length: number) => Buffer }} reader
 * @param {number} pos
 * @param {number} limit
 * @returns {{ type: string, start: number, end: number, size: number, headerSize: number }|null}
 */
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
function analyzeSource(reader) {
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

    if (sampleEntry.type !== 'mp4a') {
        throw new Error(
            `不支持的音频编码 '${sampleEntry.type}'：本模块只处理 AAC（mp4a）音频`
        );
    }
    if (!sampleEntry.hasEsds) {
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

// ================== M4A 封装 ==================

function buildFtyp() {
    // 'M4A ' 是 iTunes 系标准品牌；isom/iso2/mp41 保证通用播放器兼容
    return makeBox(
        'ftyp',
        ascii('M4A '),
        u32(0),
        ascii('M4A '),
        ascii('isom'),
        ascii('iso2'),
        ascii('mp41')
    );
}

function buildMvhd({ timescale, duration, nextTrackId }) {
    const v1 = duration > MAX_UINT32;
    const times = v1
        ? Buffer.concat([u64(0), u64(0), u32(timescale), u64(duration)])
        : Buffer.concat([u32(0), u32(0), u32(timescale), u32(duration)]);
    const tail = Buffer.concat([
        u32(0x00010000), // rate 1.0
        u16(0x0100), // volume 1.0
        u16(0),
        u32(0),
        u32(0),
        IDENTITY_MATRIX,
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), // pre_defined
        u32(nextTrackId),
    ]);
    return makeFullBox('mvhd', v1 ? 1 : 0, 0, times, tail);
}

function buildTkhd({ duration, trackId }) {
    const v1 = duration > MAX_UINT32;
    const times = v1
        ? Buffer.concat([u64(0), u64(0), u32(trackId), u32(0), u64(duration)])
        : Buffer.concat([u32(0), u32(0), u32(trackId), u32(0), u32(duration)]);
    const tail = Buffer.concat([
        u32(0), u32(0), // reserved
        u16(0), u16(0), // layer, alternate_group
        u16(0x0100), u16(0), // volume 1.0（音频轨）, reserved
        IDENTITY_MATRIX,
        u32(0), u32(0), // width, height
    ]);
    // flags: track_enabled | track_in_movie
    return makeFullBox('tkhd', v1 ? 1 : 0, 0x000003, times, tail);
}

function buildMdhd({ timescale, duration, language }) {
    const v1 = duration > MAX_UINT32;
    const times = v1
        ? Buffer.concat([u64(0), u64(0), u32(timescale), u64(duration)])
        : Buffer.concat([u32(0), u32(0), u32(timescale), u32(duration)]);
    return makeFullBox('mdhd', v1 ? 1 : 0, 0, times, u16(language), u16(0));
}

function buildHdlr() {
    return makeFullBox(
        'hdlr',
        0,
        0,
        u32(0),
        ascii('soun'),
        u32(0),
        u32(0),
        u32(0),
        Buffer.from('SoundHandler\0', 'utf8')
    );
}

function buildDinf() {
    const url = makeFullBox('url ', 0, 1); // flags=1：媒体数据就在本文件里
    return makeBox('dinf', makeFullBox('dref', 0, 0, u32(1), url));
}

function buildStsd(sampleEntry) {
    // 直接搬运源的 Sample Entry 字节，esds 等配置原样保留
    return makeFullBox('stsd', 0, 0, u32(1), sampleEntry);
}

/**
 * 把逐样本时长合并成 stts 的游程表
 */
function buildStts(samples) {
    const runs = [];
    for (const sample of samples) {
        const last = runs[runs.length - 1];
        if (last && last[1] === sample.duration) last[0] += 1;
        else runs.push([1, sample.duration]);
    }
    const body = Buffer.allocUnsafe(runs.length * 8);
    runs.forEach(([count, delta], i) => {
        body.writeUInt32BE(count, i * 8);
        body.writeUInt32BE(delta, i * 8 + 4);
    });
    return makeFullBox('stts', 0, 0, u32(runs.length), body);
}

/**
 * 仅当存在合成时间偏移时输出 ctts，避免给普通 AAC 塞入无意义的表
 */
function buildCtts(samples) {
    let hasOffset = false;
    let hasNegative = false;
    for (const sample of samples) {
        const offset = sample.cts - sample.dts;
        if (offset !== 0) hasOffset = true;
        if (offset < 0) hasNegative = true;
    }
    if (!hasOffset) return null;

    const runs = [];
    for (const sample of samples) {
        const offset = sample.cts - sample.dts;
        const last = runs[runs.length - 1];
        if (last && last[1] === offset) last[0] += 1;
        else runs.push([1, offset]);
    }

    const body = Buffer.allocUnsafe(runs.length * 8);
    runs.forEach(([count, offset], i) => {
        body.writeUInt32BE(count, i * 8);
        body.writeUInt32BE(offset >>> 0, i * 8 + 4);
    });
    return makeFullBox('ctts', hasNegative ? 1 : 0, 0, u32(runs.length), body);
}

function buildStsz(samples) {
    const sizes = Buffer.allocUnsafe(samples.length * 4);
    samples.forEach((sample, i) => sizes.writeUInt32BE(sample.size, i * 4));
    return makeFullBox('stsz', 0, 0, u32(0), u32(samples.length), sizes);
}

function buildStsc(chunks) {
    // 每个 chunk 的样本数必须显式登记：末尾 chunk 通常不足一个满块，
    // 若只写一条记录，播放器会按满块推算样本总数而报 "wrong sample count"
    const runs = [];
    chunks.forEach((chunk, index) => {
        const last = runs[runs.length - 1];
        if (last && last.samplesPerChunk === chunk.count) return;
        runs.push({ firstChunk: index + 1, samplesPerChunk: chunk.count }); // firstChunk 为 1 基
    });

    const body = Buffer.allocUnsafe(runs.length * 12);
    runs.forEach((run, i) => {
        body.writeUInt32BE(run.firstChunk, i * 12);
        body.writeUInt32BE(run.samplesPerChunk, i * 12 + 4);
        body.writeUInt32BE(1, i * 12 + 8); // sample_description_index
    });
    return makeFullBox('stsc', 0, 0, u32(runs.length), body);
}

function buildChunkOffsetTable(offsets, useCo64) {
    const body = useCo64
        ? Buffer.allocUnsafe(offsets.length * 8)
        : Buffer.allocUnsafe(offsets.length * 4);
    offsets.forEach((offset, i) => {
        if (useCo64) body.writeBigUInt64BE(BigInt(offset), i * 8);
        else body.writeUInt32BE(offset, i * 4);
    });
    return makeFullBox(useCo64 ? 'co64' : 'stco', 0, 0, u32(offsets.length), body);
}

function buildMoov({ timescale, mediaDuration, language, sampleEntry, samples, chunks, chunkOffsets, useCo64, udta }) {
    const movieDuration = Math.max(1, Math.round((mediaDuration * MOVIE_TIMESCALE) / timescale));

    const stblParts = [buildStsd(sampleEntry), buildStts(samples)];
    const ctts = buildCtts(samples);
    if (ctts) stblParts.push(ctts);
    stblParts.push(
        buildStsz(samples),
        buildStsc(chunks),
        buildChunkOffsetTable(chunkOffsets, useCo64)
    );

    const smhd = makeFullBox('smhd', 0, 0, u16(0), u16(0));
    const minf = makeBox('minf', smhd, buildDinf(), makeBox('stbl', ...stblParts));
    const mdia = makeBox(
        'mdia',
        buildMdhd({ timescale, duration: mediaDuration, language }),
        buildHdlr(),
        minf
    );
    const trak = makeBox('trak', buildTkhd({ duration: movieDuration, trackId: 1 }), mdia);

    const moovParts = [
        buildMvhd({ timescale: MOVIE_TIMESCALE, duration: movieDuration, nextTrackId: 2 }),
        trak,
    ];
    if (udta) moovParts.push(udta);

    return makeBox('moov', ...moovParts);
}

function buildMdatHeader(dataSize) {
    const total = 8 + dataSize;
    if (total > MAX_UINT32) {
        const header = Buffer.allocUnsafe(16);
        header.writeUInt32BE(1, 0);
        header.write('mdat', 4, 4, 'latin1');
        header.writeBigUInt64BE(BigInt(total), 8);
        return header;
    }
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(total, 0);
    header.write('mdat', 4, 4, 'latin1');
    return header;
}

/**
 * 按固定样本数划分 chunk，便于生成紧凑的 stco/co64
 */
function buildChunks(samples) {
    const chunks = [];
    for (let i = 0; i < samples.length; i += SAMPLES_PER_CHUNK) {
        const slice = samples.slice(i, i + SAMPLES_PER_CHUNK);
        chunks.push({
            count: slice.length,
            size: slice.reduce((sum, sample) => sum + sample.size, 0),
        });
    }
    return chunks;
}

/**
 * 计算输出布局：ftyp + moov + mdat，chunk 偏移指向 mdat 内真实数据位置
 */
function buildOutputLayout(source, options = {}) {
    const { samples, timescale, language, sampleEntry, mediaDuration, udta } = source;
    const keepMetadata = options.keepMetadata !== false;

    const ftyp = buildFtyp();
    const chunks = buildChunks(samples);
    const dataSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    // 数据超 4GB 时改用 co64，预留余量以免 moov 自身把偏移顶出 32 位
    const useCo64 = dataSize > MAX_UINT32 - CO64_MARGIN;
    const mdatHeader = buildMdatHeader(dataSize);

    const moovParams = {
        timescale,
        mediaDuration,
        language,
        sampleEntry,
        samples,
        chunks,
        useCo64,
        udta: keepMetadata ? udta : null,
    };

    // 先用占位偏移算出 moov 尺寸（偏移只改数值、不改长度）
    const placeholder = buildMoov({
        ...moovParams,
        chunkOffsets: new Array(chunks.length).fill(0),
    });

    let cursor = ftyp.length + placeholder.length + mdatHeader.length;
    const chunkOffsets = chunks.map((chunk) => {
        const offset = cursor;
        cursor += chunk.size;
        return offset;
    });

    const moov = buildMoov({ ...moovParams, chunkOffsets });
    if (moov.length !== placeholder.length) {
        throw new Error('内部错误：moov 尺寸不稳定，chunk 偏移会失效');
    }

    return {
        initSegment: Buffer.concat([ftyp, moov, mdatHeader]),
        chunks,
        chunkOffsets,
        dataSize,
        useCo64,
    };
}

// ================== 写入与对外接口 ==================

/**
 * 按顺序把样本数据聚合写入输出流
 *
 * 源文件里相邻的样本会合并成一次读取：分片 m4s 的样本在各自 mdat 内连续，
 * 合并后能把上千次 syscall 压到几十次。
 */
async function writeSamples({ reader, samples, write, onProgress, signal, dataSize }) {
    let written = 0;
    let pending = [];
    let pendingSize = 0;

    const flush = async () => {
        if (pendingSize === 0) return;
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
        pending = [];
        pendingSize = 0;
        await write(chunk);
        if (typeof onProgress === 'function') {
            onProgress(dataSize === 0 ? 1 : Math.min(1, written / dataSize));
        }
    };

    let runStart = -1;
    let runEnd = -1;

    const pushRun = () => {
        if (runStart < 0) return;
        pending.push(reader.read(runStart, runEnd - runStart));
        pendingSize += runEnd - runStart;
        written += runEnd - runStart;
        runStart = -1;
        runEnd = -1;
    };

    for (const sample of samples) {
        if (signal && signal.aborted) {
            throw new Error('转封装已取消');
        }
        if (runStart >= 0 && sample.offset === runEnd) {
            runEnd += sample.size;
        } else {
            pushRun();
            runStart = sample.offset;
            runEnd = sample.offset + sample.size;
        }
        if (pendingSize + (runEnd - runStart) >= FLUSH_THRESHOLD) {
            pushRun();
            await flush();
        }
    }

    pushRun();
    await flush();
    if (typeof onProgress === 'function') onProgress(1);
}

function buildResult(source, outputPath, bytesWritten, layout) {
    return {
        outputPath: outputPath || null,
        codec: source.codec,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        timescale: source.timescale,
        duration: source.mediaDuration / source.timescale,
        sampleCount: source.samples.length,
        chunkCount: layout.chunks.length,
        dataBytes: layout.dataSize,
        bytesWritten,
        fragmentedInput: source.fragmented,
        prefixSkipped: source.prefix > 0,
        useCo64: layout.useCo64,
    };
}

/**
 * 读取 Bilibili M4S 音频的元信息（不写文件）
 *
 * @param {string} inputPath 输入 .m4s / .mp4 / .m4a 路径
 * @returns {{
 *   codec: string, sampleRate: number, channelCount: number, timescale: number,
 *   duration: number, sampleCount: number, dataBytes: number,
 *   fragmentedInput: boolean, prefixSkipped: boolean,
 * }}
 */
function probeM4sAudio(inputPath) {
    const reader = createFileReader(inputPath);
    try {
        const source = analyzeSource(reader);
        return {
            codec: source.codec,
            sampleRate: source.sampleRate,
            channelCount: source.channelCount,
            timescale: source.timescale,
            duration: source.mediaDuration / source.timescale,
            sampleCount: source.samples.length,
            dataBytes: source.totalBytes,
            fragmentedInput: source.fragmented,
            prefixSkipped: source.prefix > 0,
        };
    } finally {
        reader.close();
    }
}

/**
 * 把 Bilibili M4S AAC 音频转封装为标准 M4A 文件
 *
 * @param {string} inputPath 输入 .m4s 路径（支持 B 站 CDN 文件与 PC 客户端缓存文件）
 * @param {string} outputPath 输出 .m4a 路径
 * @param {object} [options]
 * @param {(progress: number) => void} [options.onProgress] 进度回调，取值 0~1
 * @param {boolean} [options.keepMetadata] 是否复制源 moov.udta 元数据，默认 true
 * @param {AbortSignal} [options.signal] 取消信号
 * @returns {Promise<{
 *   outputPath: string|null, codec: string, sampleRate: number, channelCount: number,
 *   timescale: number, duration: number, sampleCount: number, chunkCount: number,
 *   dataBytes: number, bytesWritten: number, fragmentedInput: boolean,
 *   prefixSkipped: boolean, useCo64: boolean,
 * }>} 输出信息（时长、采样率、样本数、写入字节数等）
 */
async function m4sToM4a(inputPath, outputPath, options = {}) {
    const reader = createFileReader(inputPath);
    try {
        const source = analyzeSource(reader);
        const layout = buildOutputLayout(source, options);

        const writer = createFileWriter(outputPath);
        try {
            await writer.write(layout.initSegment);
            await writeSamples({
                reader,
                samples: source.samples,
                write: writer.write,
                onProgress: options.onProgress,
                signal: options.signal,
                dataSize: layout.dataSize,
            });
            const closed = await writer.close();
            return buildResult(source, outputPath, closed.size, layout);
        } catch (err) {
            writer.abort();
            // 失败时清掉半成品，避免留下无法播放的文件
            await new Promise((resolve) => {
                fs.unlink(outputPath, () => resolve());
            });
            throw err;
        }
    } finally {
        reader.close();
    }
}

/**
 * 内存版转封装：输入 Buffer，返回完整 M4A Buffer
 *
 * 适合小文件或需要直接上传/转发的场景；大文件请用 m4sToM4a() 流式写盘。
 *
 * @param {Buffer|Uint8Array} input M4S 内容
 * @param {object} [options]
 * @param {boolean} [options.keepMetadata] 是否复制源 moov.udta 元数据，默认 true
 * @returns {{ buffer: Buffer, codec: string, sampleRate: number, channelCount: number,
 *   timescale: number, duration: number, sampleCount: number, chunkCount: number,
 *   dataBytes: number, bytesWritten: number, fragmentedInput: boolean,
 *   prefixSkipped: boolean, useCo64: boolean }}
 */
function m4sToM4aBuffer(input, options = {}) {
    if (!Buffer.isBuffer(input)) {
        throw new TypeError('m4sToM4aBuffer 需要 Buffer 输入，文件路径请使用 m4sToM4a()');
    }
    const reader = createBufferReader(input);
    const source = analyzeSource(reader);
    const layout = buildOutputLayout(source, options);

    const parts = [layout.initSegment];
    for (const sample of source.samples) {
        parts.push(reader.read(sample.offset, sample.size));
    }
    const buffer = Buffer.concat(parts);

    const result = buildResult(source, null, buffer.length, layout);
    return { buffer, ...result };
}

module.exports = {
    m4sToM4a,
    m4sToM4aBuffer,
    probeM4sAudio,
};