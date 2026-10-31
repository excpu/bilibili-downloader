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
const { createFileReader, createBufferReader } = require('./file-reader');

const MOVIE_TIMESCALE = 1000;
// 每个 chunk 的样本数：只影响 stco/co64 表的规模，不影响播放
const SAMPLES_PER_CHUNK = 512;
// 写盘聚合阈值，避免每帧都触发一次 write
const FLUSH_THRESHOLD = 1 << 20;

const MAX_UINT32 = 0xffffffff;
// 估算 co64 时给 ftyp/moov 预留的余量
const CO64_MARGIN = 64 * 1024 * 1024;

const IDENTITY_MATRIX = Buffer.concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
]);


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

// ================== 输入解析 ==================

// Box 遍历与样本定位与编码无关，已抽到 mp4-audio-reader.js 与 flac.js 共用。
const { analyzeMp4Audio } = require('./mp4-audio-reader');

/**
 * AAC 音频源：只放行 mp4a，并要求携带 esds
 * @param {{ size: number, read: Function }} reader
 */
function analyzeSource(reader) {
    return analyzeMp4Audio(reader);
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