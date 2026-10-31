// mp4.js
// 纯 Node.js 的 Fragmented MP4（fMP4）封装：输入是统一数据契约 TrackSource（见 track-source.js），
// 输出按视频关键帧切片的 moof + mdat 流，帧数据在写盘时才按需读取，
// 因此内存占用与视频总长度无关。不依赖 ffmpeg。
//
// 只负责"封装"：解封装在 demux-m4s.js，容器选择在 media.js。
'use strict';

const MP4Box = require('mp4box');
const { createFileWriter } = require('./stream-writer');

// 写盘聚合阈值：把细碎的小帧（音频帧可能只有几百字节）聚成较大的写入块，减少 write 次数
const FLUSH_THRESHOLD = 1 << 20;

/**
 * 由 TrackSource 构造 MP4Box 的输出轨道参数
 * @param {object} source TrackSource
 * @param {'vide'|'soun'} hdlr
 * @returns {object|null} addTrack 参数，编码不受支持时返回 null
 */
function buildTrackOptions(source, hdlr) {
    const info = source.trackInfo;
    const opts = {
        timescale: info.timescale,
        type: source.codecSubtype, // 如 'avc1', 'hev1', 'hvc1', 'av01' / 'mp4a', 'ec-3', 'ac-3', 'fLaC'
        hdlr,
    };

    if (hdlr === 'vide') {
        opts.width = info.video ? info.video.width : info.track_width;
        opts.height = info.video ? info.video.height : info.track_height;
    } else {
        opts.samplerate = info.audio ? info.audio.sample_rate : info.timescale;
        opts.channel_count = info.audio ? info.audio.channel_count : 2;
        opts.samplesize = info.audio ? info.audio.sample_size : 16;
    }

    // FLAC 等编码需要把源 esds 作为 description 传给 MP4Box
    const esds = source.stsdEntry && source.stsdEntry.esds;
    if (esds) opts.description = esds;

    return opts;
}

/**
 * 将源轨道的解码器配置子 Box（avcC/hvcC/av1C/esds/dac3/dec3/dfLa/colr/pasp 等）完整同步到输出轨道
 *
 * 源 Box 已在解封装阶段被标记为"原样输出源文件字节"，
 * 因此这里只需把它们引用搬到输出 Sample Entry 上即可保证配置记录完全一致。
 * @param {object} outFile
 * @param {number} outTrackId
 * @param {object} srcStsdEntry
 */
function copyCodecConfigBoxes(outFile, outTrackId, srcStsdEntry) {
    if (!srcStsdEntry) return;
    const dstTrak = outFile.getTrackById(outTrackId);
    if (!dstTrak) return;

    const dstEntry =
        dstTrak.mdia &&
        dstTrak.mdia.minf &&
        dstTrak.mdia.minf.stbl &&
        dstTrak.mdia.minf.stbl.stsd &&
        dstTrak.mdia.minf.stbl.stsd.entries &&
        dstTrak.mdia.minf.stbl.stsd.entries[0];

    if (!dstEntry) return;

    if (!Array.isArray(dstEntry.boxes)) {
        dstEntry.boxes = [];
    }

    // 1. 同步 srcStsdEntry.boxes 中的所有子 Box
    if (Array.isArray(srcStsdEntry.boxes)) {
        for (const box of srcStsdEntry.boxes) {
            if (!box || !box.type) continue;
            dstEntry[box.type] = box;
            const existingIdx = dstEntry.boxes.findIndex(
                (b) => b && b.type === box.type
            );
            if (existingIdx !== -1) {
                dstEntry.boxes[existingIdx] = box;
            } else {
                dstEntry.boxes.push(box);
            }
        }
    }

    // 2. 兜底同步常见属性挂载的解码器配置 Box
    const configBoxNames = [
        'avcC',
        'hvcC',
        'av1C',
        'vpcC',
        'esds',
        'dac3',
        'dec3',
        'dfLa',
        'colr',
        'pasp',
    ];
    for (const name of configBoxNames) {
        if (srcStsdEntry[name]) {
            dstEntry[name] = srcStsdEntry[name];
            if (!dstEntry.boxes.includes(srcStsdEntry[name])) {
                dstEntry.boxes.push(srcStsdEntry[name]);
            }
        }
    }
}

/**
 * 计算各轨道时长并写入 mvhd / tkhd / mdhd，同时在 mvex 中补充 mehd（fragment_duration）
 * @param {object} outFile
 * @param {Array<{id: number, samples: Array}>} tracks
 */
function fillDurations(outFile, tracks) {
    const moov = outFile.moov;
    const movieTimescale = moov.mvhd.timescale || 1000;
    let movieDuration = 0;

    for (const t of tracks) {
        const trak = outFile.getTrackById(t.id);
        let end = 0;
        for (const s of t.samples) {
            end = Math.max(end, s.dts + s.duration);
        }
        const mediaTimescale = trak.mdia.mdhd.timescale;
        const inMovie = Math.round((end * movieTimescale) / mediaTimescale);
        trak.mdia.mdhd.duration = end;
        trak.tkhd.duration = inMovie;
        movieDuration = Math.max(movieDuration, inMovie);
    }
    moov.mvhd.duration = movieDuration;

    if (moov.mvex) {
        const mehd = new MP4Box.Box('mehd');
        mehd.type = 'mehd';
        // version 1: 4 字节 version/flags + 8 字节 fragment_duration，由基类 write() 补 8 字节头
        const payload = Buffer.alloc(12);
        payload.writeUInt32BE(0x01000000, 0);
        payload.writeUInt32BE(Math.floor(movieDuration / 0x100000000), 4);
        payload.writeUInt32BE(movieDuration >>> 0, 8);
        mehd.data = new Uint8Array(payload);
        // mehd 必须位于 trex 之前
        moov.mvex.boxes.unshift(mehd);
        moov.mvex.mehd = mehd;
    }
}

function buildTraf(trackId, baseDts, samples, isVideo) {
    const n = samples.length;
    const trunSize = 20 + n * 16;
    const size = 8 + 16 + 20 + trunSize;
    const b = Buffer.alloc(size);
    let p = 0;
    b.writeUInt32BE(size, p); b.write('traf', p + 4, 'latin1'); p += 8;
    // tfhd：default-base-is-moof
    b.writeUInt32BE(16, p); b.write('tfhd', p + 4, 'latin1');
    b.writeUInt32BE(0x020000, p + 8); b.writeUInt32BE(trackId, p + 12); p += 16;
    // tfdt v1
    b.writeUInt32BE(20, p); b.write('tfdt', p + 4, 'latin1');
    b.writeUInt32BE(0x01000000, p + 8);
    b.writeBigUInt64BE(BigInt(baseDts), p + 12); p += 20;
    // trun v1：data-offset | duration | size | flags | cts-offset
    b.writeUInt32BE(trunSize, p); b.write('trun', p + 4, 'latin1');
    b.writeUInt32BE(0x01000000 | 0x000f01, p + 8);
    b.writeUInt32BE(n, p + 12);
    const dataOffsetPos = p + 16;
    p += 20;
    for (const s of samples) {
        b.writeUInt32BE(s.duration, p);
        b.writeUInt32BE(s.size, p + 4);
        // 视频：关键帧 depends_on=2；非关键帧 depends_on=1 + non_sync
        const flags = !isVideo || s.keyframe ? 0x02000000 : 0x01010000;
        b.writeUInt32BE(flags, p + 8);
        b.writeInt32BE(s.cts - s.dts, p + 12);
        p += 16;
    }
    return { buf: b, dataOffsetPos };
}

/**
 * 按视频关键帧切分片：每个分片 = 1 个 moof（视频 traf + 音频 traf）+ 1 个 mdat，
 * 音频按时间对齐到相同的分片里，保证 sidx 引用的字节范围内视频从关键帧开始
 *
 * 只产出 moof 和样本范围，mdat 里的帧数据在写盘时才通过 readSample() 读取，
 * 因此内存占用与视频总长度无关。
 *
 * @param {{ id: number, timescale: number, samples: Array }} video
 * @param {{ id: number, timescale: number, samples: Array }} audio
 * @returns {Array<{ moof: Buffer, mdatSize: number, videoSamples: Array, audioSamples: Array, duration: number, earliestPts: number }>}
 */
function buildFragments(video, audio) {
    const vs = video.samples;
    const as = audio.samples;
    const starts = [];
    for (let i = 0; i < vs.length; i++) {
        if (i === 0 || vs[i].keyframe) starts.push(i);
    }

    const fragments = [];
    let ai = 0;
    for (let k = 0; k < starts.length; k++) {
        const vFrom = starts[k];
        const vTo = k + 1 < starts.length ? starts[k + 1] : vs.length;
        const vSeg = vs.slice(vFrom, vTo);
        const isLast = k + 1 === starts.length;

        const aFrom = ai;
        if (isLast) {
            ai = as.length;
        } else {
            const endVideoTime = vs[vTo].dts / video.timescale;
            while (ai < as.length && as[ai].dts / audio.timescale < endVideoTime) ai++;
        }
        const aSeg = as.slice(aFrom, ai);

        const trafV = buildTraf(video.id, vSeg[0].dts, vSeg, true);
        const trafA = aSeg.length ? buildTraf(audio.id, aSeg[0].dts, aSeg, false) : null;

        const moofSize = 8 + 16 + trafV.buf.length + (trafA ? trafA.buf.length : 0);
        const moof = Buffer.alloc(moofSize);
        moof.writeUInt32BE(moofSize, 0); moof.write('moof', 4, 'latin1');
        moof.writeUInt32BE(16, 8); moof.write('mfhd', 12, 'latin1');
        moof.writeUInt32BE(0, 16); moof.writeUInt32BE(k + 1, 20);

        let mdatPos = 8;
        let p = 24;
        for (const [traf, segSamples] of [[trafV, vSeg], [trafA, aSeg]]) {
            if (!traf) continue;
            traf.buf.writeUInt32BE(moofSize + mdatPos, traf.dataOffsetPos);
            traf.buf.copy(moof, p);
            p += traf.buf.length;
            for (const s of segSamples) {
                if (!Number.isFinite(s.size)) {
                    throw new Error('Sample 缺少 size，无法计算 mdat 布局');
                }
                mdatPos += s.size;
            }
        }

        let minPts = Infinity;
        let duration = 0;
        for (const s of vSeg) {
            minPts = Math.min(minPts, s.cts);
            duration += s.duration;
        }
        fragments.push({
            moof,
            mdatSize: mdatPos,
            videoSamples: vSeg,
            audioSamples: aSeg,
            duration,
            earliestPts: minPts,
        });
    }
    return fragments;
}

/**
 * 生成索引视频轨的 sidx（version 1），每个引用对应一个以关键帧开头的分片
 */
function buildSidx(trackId, timescale, fragments) {
    const n = fragments.length;
    const size = 40 + n * 12;
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0); b.write('sidx', 4, 'latin1');
    b.writeUInt32BE(0x01000000, 8);
    b.writeUInt32BE(trackId, 12);
    b.writeUInt32BE(timescale, 16);
    b.writeBigUInt64BE(BigInt(fragments[0].earliestPts), 20);
    b.writeBigUInt64BE(0n, 28);
    b.writeUInt16BE(0, 36);
    b.writeUInt16BE(n, 38);
    let p = 40;
    for (const f of fragments) {
        b.writeUInt32BE((f.moof.length + f.mdatSize) & 0x7fffffff, p);
        b.writeUInt32BE(f.duration, p + 4);
        b.writeUInt32BE(0x90000000, p + 8); // starts_with_SAP=1, SAP_type=1, delta=0
        p += 12;
    }
    return b;
}

/**
 * 把 ftyp + moov 初始化段、sidx 索引和所有分片按顺序流式写入磁盘
 *
 * 每个分片写完 moof 后，按 trun 顺序逐帧从源 .m4s 读取并写入 mdat，
 * 内存里最多只有一个 Sample，与视频总长度无关。
 *
 * @param {object} params
 * @param {Buffer} params.initSegment ftyp + moov
 * @param {Buffer} params.sidx
 * @param {Array<object>} params.fragments buildFragments() 的结果
 * @param {(sample: object) => Buffer} params.readVideoSample
 * @param {(sample: object) => Buffer} params.readAudioSample
 * @param {(chunk: Buffer) => Promise<void>} params.write
 * @param {(progress: number) => void} [params.onProgress] 按已写字节给出的进度，0~1
 * @param {AbortSignal} [params.signal] 取消信号，中止时抛「转封装已取消」
 */
async function writeFragments({
    initSegment,
    sidx,
    fragments,
    readVideoSample,
    readAudioSample,
    write,
    onProgress = null,
    signal = null,
}) {
    // 进度分母：初始化段 + sidx + 每个分片的 moof 与 mdat，都是可预先算出的确定值
    let totalBytes = initSegment.length + sidx.length;
    for (const f of fragments) totalBytes += f.moof.length + f.mdatSize;
    let writtenBytes = 0;

    const abortIfRequested = () => {
        if (signal && signal.aborted) throw new Error('转封装已取消');
    };
    const report = () => {
        if (!onProgress) return;
        onProgress(totalBytes === 0 ? 1 : Math.min(1, writtenBytes / totalBytes));
    };

    await write(initSegment);
    await write(sidx);
    writtenBytes += initSegment.length + sidx.length;
    report();

    let pending = [];
    let pendingSize = 0;
    const push = async (buf) => {
        pending.push(buf);
        pendingSize += buf.length;
        writtenBytes += buf.length;
        if (pendingSize >= FLUSH_THRESHOLD) {
            const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
            pending = [];
            pendingSize = 0;
            await write(chunk);
            report();
        }
    };

    for (const fragment of fragments) {
        abortIfRequested();
        await push(fragment.moof);

        const header = Buffer.alloc(8);
        header.writeUInt32BE(fragment.mdatSize, 0);
        header.write('mdat', 4, 'latin1');
        await push(header);

        for (const s of fragment.videoSamples) await push(readVideoSample(s));
        for (const s of fragment.audioSamples) await push(readAudioSample(s));
    }

    if (pendingSize > 0) {
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
        await write(chunk);
    }
    report();
    if (onProgress) onProgress(1);
}

/**
 * 把音视频 TrackSource 封装成分片 MP4（.mp4）并流式写盘
 * @param {object} params
 * @param {object} params.video 视频轨 TrackSource
 * @param {object} params.audio 音频轨 TrackSource
 * @param {string} params.outputPath 输出 .mp4 路径
 * @param {(progress: number) => void} [params.onProgress] 进度回调，0~1
 * @param {AbortSignal} [params.signal] 取消信号
 * @returns {Promise<{ outputPath: string, videoSamples: number, audioSamples: number }>}
 */
async function muxFragmentedMp4({ video, audio, outputPath, onProgress = null, signal = null }) {
    // 1. 创建输出 MP4 容器（必须在添加样本前完成所有 addTrack）
    const outFile = MP4Box.createFile();

    const outVideoTrackId = outFile.addTrack(buildTrackOptions(video, 'vide'));
    if (outVideoTrackId === undefined || outVideoTrackId === null) {
        throw new Error(`不支持的视频编码格式，无法创建轨道: ${video.codec}`);
    }
    copyCodecConfigBoxes(outFile, outVideoTrackId, video.stsdEntry);

    const outAudioTrackId = outFile.addTrack(buildTrackOptions(audio, 'soun'));
    if (outAudioTrackId === undefined || outAudioTrackId === null) {
        throw new Error(`不支持的音频编码格式，无法创建轨道: ${audio.codec}`);
    }
    copyCodecConfigBoxes(outFile, outAudioTrackId, audio.stsdEntry);

    // 2. 回填时长。MP4Box 生成的 moov 默认 mvhd/tkhd/mdhd/mehd 时长全为 0，
    // 播放器会把它当作直播流而无法 Seek
    fillDurations(outFile, [
        { id: outVideoTrackId, samples: video.samples },
        { id: outAudioTrackId, samples: audio.samples },
    ]);

    // 3. 取出 ftyp + moov 作为初始化段（此时尚未添加任何 Sample，不含分片）
    // 注意：getBuffer() 返回的是 mp4box 的 DataStream 对象（带 buffer/byteOffset/byteLength
    // 访问器），并不是 ArrayBuffer。直接 Buffer.from(dataStream) 会得到 0 字节缓冲，
    // 这正是之前输出 0 KB 文件的根本原因。
    const stream = outFile.getBuffer();
    const initSegment = Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength);

    // 4. 按视频关键帧切分片并生成 sidx，然后逐片流式落盘
    const fragments = buildFragments(
        { id: outVideoTrackId, timescale: video.timescale, samples: video.samples },
        { id: outAudioTrackId, timescale: audio.timescale, samples: audio.samples }
    );
    const sidx = buildSidx(outVideoTrackId, video.timescale, fragments);

    const writer = createFileWriter(outputPath);
    try {
        await writeFragments({
            initSegment,
            sidx,
            fragments,
            readVideoSample: video.readSample,
            readAudioSample: audio.readSample,
            write: writer.write,
            onProgress,
            signal,
        });
        await writer.close();
    } catch (err) {
        writer.abort();
        throw err;
    }

    return {
        outputPath,
        videoSamples: video.samples.length,
        audioSamples: audio.samples.length,
    };
}

module.exports = {
    muxFragmentedMp4,
    buildFragments,
    buildSidx,
    writeFragments,
    copyCodecConfigBoxes,
    fillDurations,
};
