// flac.js
// 把 Bilibili 的 M4S（分片 MP4 / DASH）FLAC 音频转封装成原生 .flac 文件。
//
// B 站下发的 FLAC 音轨并不是 .flac 文件，而是塞在 MP4 容器里的 FLAC 码流：
//   stsd 里是 fLaC Sample Entry，解码配置放在 dfLa box（FLAC 元数据块），
//   音频帧则按 moof/mdat 分片存放，每帧都是完整的 FLAC frame（自带 0xFFF8 同步码）。
// 原生 .flac 只需要 "fLaC" 魔数 + 元数据块 + 依次排列的帧，
// 所以这里是纯容器转换：帧数据原封不动搬运，不重编码、无音质损失，速度接近磁盘拷贝。
//
// STREAMINFO 是 FLAC 的必填元数据块，里面的 total samples / 最小最大帧长 / MD5
// 在 MP4 侧往往是占位值（帧长受分片影响无法预知），这里按实际帧数据回填，
// 否则部分播放器会把时长算成 0。
//
// 与 matroska.js 的 A_FLAC 路径互补：那边把 FLAC 放进 mkv（可带视频、可加章节），
// 这边产出单文件 .flac（体积小、兼容 Hi-Res 播放器与库管理工具）。
'use strict';

const fs = require('fs');
const { createFileWriter } = require('./stream-writer');
const { createFileReader, createBufferReader } = require('./file-reader');
const { analyzeMp4Audio } = require('./mp4-audio-reader');

const FLAC_MAGIC = Buffer.from('fLaC', 'latin1');
const STREAMINFO_BLOCK_TYPE = 0;
const STREAMINFO_SIZE = 34;
// 写盘聚合阈值，避免每帧都触发一次 write
const FLUSH_THRESHOLD = 1 << 20;

// FLAC 元数据块类型：PADDING 用于给后续工具原地写标签留出空间
const PADDING_BLOCK_TYPE = 1;

/**
 * 在 fLaC Sample Entry 的原始字节里找指定子 Box 的载荷
 *
 * Sample Entry 固定头是 8(Box) + 6(保留) + 2(版本号) + 16(声道/位深/采样率)，
 * 即子 Box 从偏移 36 开始（与 mp4-audio-reader.js 的 readSampleEntry 保持一致）。
 * @param {Buffer} entryRaw
 * @param {string} type
 * @returns {Buffer|null}
 */
function findEntryChildPayload(entryRaw, type) {
    let pos = 36;
    while (pos + 8 <= entryRaw.length) {
        const size = entryRaw.readUInt32BE(pos);
        if (size < 8) break;
        if (entryRaw.toString('latin1', pos + 4, pos + 8) === type) {
            return entryRaw.subarray(pos + 8, pos + size);
        }
        if (pos + size > entryRaw.length) break;
        pos += size;
    }
    return null;
}

/**
 * 把 dfLa 载荷拆成 FLAC 元数据块列表
 *
 * dfLa 是 FullBox，但各家封装对 version/flags 的处理并不一致：
 *  - 正常写法是 4 字节全 0 的 version/flags，紧跟元数据块；
 *  - 也见过不带 version/flags、甚至把 "fLaC" 魔数一起塞进来的。
 * 所以这里按块结构走一遍自适应识别，而不是硬切 4 字节。
 * @param {Buffer|null} dfLaPayload
 * @returns {Array<{ type: number, body: Buffer }>}
 */
function parseFlacMetadataBlocks(dfLaPayload) {
    if (!dfLaPayload || dfLaPayload.length < 4) return [];

    let off = 0;
    if (
        dfLaPayload.length > 4 &&
        dfLaPayload[0] === 0 &&
        dfLaPayload[1] === 0 &&
        dfLaPayload[2] === 0 &&
        dfLaPayload[3] === 0
    ) {
        off = 4;
    }
    if (dfLaPayload.toString('latin1', off, off + 4) === 'fLaC') off += 4;

    const blocks = [];
    while (off + 4 <= dfLaPayload.length) {
        const flagType = dfLaPayload[off];
        const length = (dfLaPayload[off + 1] << 16) | (dfLaPayload[off + 2] << 8) | dfLaPayload[off + 3];
        if (off + 4 + length > dfLaPayload.length) break;
        blocks.push({ type: flagType & 0x7f, body: dfLaPayload.subarray(off + 4, off + 4 + length) });
        off += 4 + length;
        if (flagType & 0x80) break;
    }
    return blocks;
}

/**
 * 编码一个 FLAC 元数据块（last 标志由调用方统一决定）
 * @param {number} type
 * @param {Buffer} body
 * @param {boolean} isLast
 * @returns {Buffer}
 */
function encodeMetadataBlock(type, body, isLast) {
    const head = Buffer.allocUnsafe(4);
    head[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
    head[1] = (body.length >> 16) & 0xff;
    head[2] = (body.length >> 8) & 0xff;
    head[3] = body.length & 0xff;
    return Buffer.concat([head, body]);
}

/**
 * 解出 STREAMINFO 的各字段
 *
 * 布局（从 MSB 起算的位域）：
 *   字节 0-1   最小块大小   2-3 最大块大小
 *   字节 4-6   最小帧长     7-9 最大帧长
 *   位 80-99   采样率(20b) | 位 100-102 声道数-1(3b) | 位 103-107 位宽-1(5b)
 *   位 108-143 总样本数(36b)  字节 18-33 MD5
 * @param {Buffer} streaminfo
 */
function readStreaminfo(streaminfo) {
    // total samples 是 36 bit，跨字节 13 的低 4 位与字节 14-17，
    // 不能直接 readUIntBE(13,5) & 0xfffffffff —— JS 位运算会截断成 32 位
    const totalSamples =
        (streaminfo[13] & 0x0f) * 0x100000000 + streaminfo.readUInt32BE(14);
    return {
        sampleRate: streaminfo.readUIntBE(10, 3) >> 4,
        channels: ((streaminfo[12] >> 1) & 0x07) + 1,
        bitsPerSample: (((streaminfo[12] & 0x01) << 4) | (streaminfo[13] >> 4)) + 1,
        totalSamples,
        minFrameSize: streaminfo.readUIntBE(4, 3),
        maxFrameSize: streaminfo.readUIntBE(7, 3),
    };
}

/**
 * 回填 STREAMINFO 里 MP4 侧无法预知/不准确的字段
 *
 * 分片封装时帧长和总样本数通常写 0 占位（ffmpeg 甚至会留下偏大的 max），
 * 总样本数为 0 会让部分播放器把时长算成 0，所以这里补齐。
 * 帧长：我们逐帧搬运，实测值就是权威值，直接覆盖；
 * 总样本数：只在源里为 0 时补，尊重源（避免覆盖切片场景下的原始时长）。
 * 注意位 104-107 属于位宽字段，改 total samples 时只能动低 4 位。
 * @param {Buffer} streaminfo 至少 34 字节
 * @param {object} stats 实测的帧长/帧数
 * @returns {Buffer} 新 Buffer
 */
function patchStreaminfo(streaminfo, stats) {
    const out = Buffer.from(streaminfo.subarray(0, STREAMINFO_SIZE));
    const info = readStreaminfo(out);

    // 最小/最大帧长（字节）
    const putFrameSize = (offset, value) => {
        const v = Math.min(0xffffff, Math.max(0, value));
        out[offset] = (v >> 16) & 0xff;
        out[offset + 1] = (v >> 8) & 0xff;
        out[offset + 2] = v & 0xff;
    };
    if (stats.frameCount > 0) {
        putFrameSize(4, stats.minFrameSize);
        putFrameSize(7, stats.maxFrameSize);
    }

    // 总样本数（36 bit）
    if (info.totalSamples === 0 && stats.totalSamples > 0) {
        const n = BigInt(stats.totalSamples);
        out[13] = (out[13] & 0xf0) | Number((n >> 32n) & 0x0fn);
        out.writeUInt32BE(Number(n & 0xffffffffn), 14);
    }

    return out;
}

/**
 * 解析并校验 FLAC 音频源：编码必须是 fLaC，且 dfLa 里要有合法 STREAMINFO
 * @param {{ size: number, read: Function }} reader
 * @returns {object} analyzeMp4Audio 的结果 + header 相关字段
 */
function analyzeFlacSource(reader) {
    const source = analyzeMp4Audio(reader, {
        supportedCodecs: ['fLaC'],
        requireEsds: false,
        codecLabel: 'FLAC（fLaC）',
        errorSubject: 'FLAC 转封装',
    });

    // dfLa 直接按 stsd 里的原始字节取，不重新序列化，避免丢字段
    const dfLaPayload = source.sampleEntry
        ? findEntryChildPayload(source.sampleEntry, 'dfLa')
        : null;
    if (!dfLaPayload) {
        throw new Error('fLaC 样本描述中缺少 dfLa（FLAC 元数据块），无法生成合规 FLAC');
    }

    const blocks = parseFlacMetadataBlocks(dfLaPayload);
    const streaminfo = blocks.find((b) => b.type === STREAMINFO_BLOCK_TYPE);
    if (!streaminfo || streaminfo.body.length < STREAMINFO_SIZE) {
        throw new Error('dfLa 中没有合法的 STREAMINFO 元数据块，无法生成合规 FLAC');
    }

    // STREAMINFO 是权威来源：fLaC Sample Entry 里的采样率/声道字段对 Hi-Res
    // 并不可靠（version 1 的入口字段甚至被规范定为 0），所以以块内位域为准
    const si = readStreaminfo(streaminfo.body);

    return {
        ...source,
        blocks,
        streaminfo: streaminfo.body,
        sampleRate: si.sampleRate || source.sampleRate,
        channels: si.channels || source.channelCount,
        bitsPerSample: si.bitsPerSample || source.sampleSize,
    };
}

/**
 * 生成文件头：fLaC 魔数 + 元数据块（STREAMINFO 回填实测值，最后一个块置 last 标志）
 * @param {object} source analyzeFlacSource 的结果
 * @param {object} stats 实测帧统计
 * @returns {Buffer}
 */
function buildFlacHeader(source, stats) {
    const blocks = source.blocks.map((b) => ({ type: b.type, body: b.body }));

    // STREAMINFO 必须排在第一个
    const siIndex = blocks.findIndex((b) => b.type === STREAMINFO_BLOCK_TYPE);
    if (siIndex > 0) {
        const [si] = blocks.splice(siIndex, 1);
        blocks.unshift(si);
    }
    blocks[0].body = patchStreaminfo(blocks[0].body, stats);

    // 源里没有 PADDING 时补一个，方便后续工具原地写入标签而不必重写整文件
    if (!blocks.some((b) => b.type === PADDING_BLOCK_TYPE)) {
        blocks.push({ type: PADDING_BLOCK_TYPE, body: Buffer.alloc(64) });
    }

    const parts = [FLAC_MAGIC];
    for (let i = 0; i < blocks.length; i++) {
        parts.push(encodeMetadataBlock(blocks[i].type, blocks[i].body, i === blocks.length - 1));
    }
    return Buffer.concat(parts);
}

/**
 * 帧头校验：FLAC frame 必须以 15 bit 同步码开头（0xFF + 高 4 位 0xF）
 * @param {Buffer} frame
 * @returns {boolean}
 */
function hasFlacSync(frame) {
    return frame.length >= 2 && frame[0] === 0xff && (frame[1] & 0xf8) === 0xf8;
}

/**
 * 实测帧统计，用于回填 STREAMINFO
 *
 * FLAC 的 total samples 是「每声道的 PCM 样本数」而不是帧数，
 * 一帧含 block_size 个样本，所以只能由样本时长（timescale 单位）折算：
 *   totalSamples = mediaDuration( tick ) × sampleRate / timescale
 * 当 timescale == sampleRate（B 站音频常见）时即等于时长秒数 × 采样率。
 */
function buildFrameStats(source) {
    let minFrameSize = Infinity;
    let maxFrameSize = 0;
    for (const s of source.samples) {
        if (s.size < minFrameSize) minFrameSize = s.size;
        if (s.size > maxFrameSize) maxFrameSize = s.size;
    }
    const totalSamples = Math.round(
        (source.mediaDuration * source.sampleRate) / source.timescale
    );
    return {
        minFrameSize: minFrameSize === Infinity ? 0 : minFrameSize,
        maxFrameSize,
        frameCount: source.samples.length,
        totalSamples: Number.isFinite(totalSamples) && totalSamples > 0 ? totalSamples : 0,
    };
}

function buildResult(source, outputPath, bytesWritten, headerLength) {
    const stats = buildFrameStats(source);
    return {
        outputPath,
        codec: 'flac',
        sampleRate: source.sampleRate,
        channelCount: source.channels,
        bitsPerSample: source.bitsPerSample,
        duration: source.mediaDuration / source.timescale,
        sampleCount: source.samples.length,
        frameBytes: source.totalBytes,
        size: bytesWritten,
        headerSize: headerLength,
        minFrameSize: stats.minFrameSize,
        maxFrameSize: stats.maxFrameSize,
        prefixSkipped: source.prefix > 0,
        fragmentedInput: source.fragmented,
    };
}

/**
 * 逐帧搬运：相邻样本合并成一次读取，减少 syscall
 * @param {object} params
 * @returns {Promise<number>} 写入的帧字节数
 */
async function writeFrames({ reader, samples, write, onProgress, signal, headerLength }) {
    const totalBytes = samples.reduce((sum, s) => sum + s.size, 0);
    const FLUSH = FLUSH_THRESHOLD;
    let pending = [];
    let pendingSize = 0;
    let written = 0;
    let index = 0;

    const flush = async () => {
        if (pendingSize === 0) return;
        await write(Buffer.concat(pending));
        pending = [];
        written += pendingSize;
        pendingSize = 0;
        if (onProgress) {
            const done = headerLength + written;
            onProgress(Math.min(1, totalBytes === 0 ? 1 : done / (headerLength + totalBytes)));
        }
    };

    while (index < samples.length) {
        if (signal && signal.aborted) throw new Error('转封装已取消');

        // 把后续连续存放的样本并进同一次 read
        let runStart = samples[index].offset;
        let runEnd = runStart + samples[index].size;
        let count = 1;
        while (
            index + count < samples.length &&
            samples[index + count].offset === runEnd &&
            count < 512
        ) {
            runEnd += samples[index + count].size;
            count++;
        }
        const run = reader.read(runStart, runEnd - runStart);

        let cursor = 0;
        for (let k = 0; k < count; k++) {
            const size = samples[index + k].size;
            const frame = run.subarray(cursor, cursor + size);
            if (!hasFlacSync(frame)) {
                throw new Error(
                    `第 ${index + k + 1} 帧不是合法的 FLAC frame（缺少 0xFFF8 同步码），输入可能不是 FLAC 音频`
                );
            }
            cursor += size;
        }
        pending.push(run);
        pendingSize += runEnd - runStart;
        index += count;

        if (pendingSize >= FLUSH) await flush();
    }
    await flush();
    // 最后一次 flush 才收到中止时，上面循环里的检查已经来不及，
    // 这里补一次，保证「取消」不会静默产出一个完整文件
    if (signal && signal.aborted) throw new Error('转封装已取消');
    return written;
}

/**
 * 把 FLAC 音频 .m4s 转封装成原生 .flac 文件（流式落盘，不重编码）
 * @param {string} inputPath 输入 .m4s 路径
 * @param {string} outputPath 输出 .flac 路径
 * @param {object} [options]
 * @param {(progress: number) => void} [options.onProgress] 进度回调，0~1
 * @param {AbortSignal} [options.signal] 取消信号，中止时抛「转封装已取消」
 * @returns {Promise<object>} 转封装结果
 */
async function m4sToFlac(inputPath, outputPath, options = {}) {
    const { onProgress = null, signal = null } = options;
    const reader = createFileReader(inputPath);
    let writer = null;
    try {
        const source = analyzeFlacSource(reader);
        const header = buildFlacHeader(source, buildFrameStats(source));
        writer = createFileWriter(outputPath);
        await writer.write(header);

        await writeFrames({
            reader,
            samples: source.samples,
            write: writer.write,
            onProgress,
            signal,
            headerLength: header.length,
        });

        const { size } = await writer.close();
        writer = null;
        return buildResult(source, outputPath, size, header.length);
    } catch (err) {
        if (writer) writer.abort();
        // 与 m4a.js 一致：失败时不留半截文件
        await new Promise((resolve) => fs.unlink(outputPath, () => resolve()));
        throw err;
    } finally {
        reader.close();
    }
}

/**
 * 内存版转封装：输入 Buffer，返回完整 .flac Buffer（测试与小文件用）
 * @param {Buffer|Uint8Array} input
 * @param {object} [options]
 * @returns {{ buffer: Buffer, ...结果信息 }}
 */
function m4sToFlacBuffer(input, options = {}) {
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
        throw new TypeError('m4sToFlacBuffer 需要 Buffer 输入，文件路径请使用 m4sToFlac()');
    }
    const reader = createBufferReader(input);
    const source = analyzeFlacSource(reader);
    const header = buildFlacHeader(source, buildFrameStats(source));

    const parts = [header];
    let frameBytes = 0;
    for (const sample of source.samples) {
        const frame = reader.read(sample.offset, sample.size);
        if (!hasFlacSync(frame)) {
            throw new Error('输入包含非法 FLAC frame（缺少 0xFFF8 同步码），可能不是 FLAC 音频');
        }
        parts.push(frame);
        frameBytes += sample.size;
    }
    const buffer = Buffer.concat(parts);
    return { ...buildResult(source, null, buffer.length, header.length), buffer };
}

/**
 * 只读取信息不写文件：供调用方判断能否处理这条 FLAC 流
 * @param {string} inputPath
 * @returns {object}
 */
function probeFlacAudio(inputPath) {
    const reader = createFileReader(inputPath);
    try {
        const source = analyzeFlacSource(reader);
        const stats = buildFrameStats(source);
        return {
            codec: 'fLaC',
            sampleRate: source.sampleRate,
            channelCount: source.channels,
            bitsPerSample: source.bitsPerSample,
            timescale: source.timescale,
            duration: source.mediaDuration / source.timescale,
            sampleCount: source.samples.length,
            dataBytes: source.totalBytes,
            fragmentedInput: source.fragmented,
            prefixSkipped: source.prefix > 0,
            minFrameSize: stats.minFrameSize,
            maxFrameSize: stats.maxFrameSize,
            metadataBlocks: source.blocks.map((b) => b.type),
        };
    } finally {
        reader.close();
    }
}

module.exports = {
    m4sToFlac,
    m4sToFlacBuffer,
    probeFlacAudio,
    // 底层工具按需导出，便于单测
    parseFlacMetadataBlocks,
    encodeMetadataBlock,
    patchStreaminfo,
    hasFlacSync,
};
