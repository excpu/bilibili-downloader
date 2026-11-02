// mp4.js
// 纯 Node.js 的 Fragmented MP4（fMP4）封装：输入是统一数据契约 TrackSource（见 track-source.js），
// 输出按视频关键帧切片的 moof + mdat 流，帧数据在写盘时才按需读取，
// 因此内存占用与视频总长度无关。不依赖 ffmpeg。
//
// 只负责"封装"：解封装在 demux-m4s.js，容器选择在 media.js。
'use strict';

const MP4Box = require('mp4box');
const { createFileWriter } = require('./stream-writer');
const { audioTrackParams } = require('./track-source');

// 写盘聚合阈值：把细碎的小帧（音频帧可能只有几百字节）聚成较大的写入块，减少 write 次数
const FLUSH_THRESHOLD = 1 << 20;

// 单个分片的最短时长（秒）。没有 stss 或整段都是关键帧时，只按关键帧切分会退化成
// 逐帧分片，moof 开销能占到文件体积的两成以上，所以关键帧过密时按这个时长强制合并。
const MIN_FRAGMENT_SECONDS = 4;

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
        // 音频参数统一走 track-source 的解析：杜比（AC-3/E-AC-3）的 stsd 字段不可信，
        // 必须从 dac3 / dec3 里取真实采样率与声道数
        const audio = info.audio || {};
        const params = audioTrackParams(info, source.stsdEntry);
        opts.samplerate = params.sampleRate;
        opts.channel_count = params.channelCount;
        // stsd 里没写位深时按 PCM 惯例给 16 bit，与原行为一致
        opts.samplesize = audio.sample_size || 16;
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

    // 按源文件里的子 Box 顺序重建目标 boxes：MP4Box 自己创建的 Box（如 mp4a 的
    // esds）位置可能与源不一致，而部分解码器要求配置 Box（avcC/hvcC/esds）排在前面。
    // 源里以属性挂载、但不在 boxes 数组里的配置 Box 也要一起搬过来。
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
    const srcBoxes = Array.isArray(srcStsdEntry.boxes)
        ? srcStsdEntry.boxes.filter((b) => b && b.type)
        : [];
    const seen = new Set();
    const ordered = [];
    for (const box of srcBoxes) {
        if (seen.has(box.type)) continue;
        seen.add(box.type);
        ordered.push(box);
    }
    for (const name of configBoxNames) {
        const box = srcStsdEntry[name];
        if (!box || seen.has(box.type || name)) continue;
        seen.add(box.type || name);
        ordered.push(box);
    }

    // 目标里 MP4Box 额外生成、源中没有对应类型的 Box 保留在后面
    for (const box of dstEntry.boxes) {
        if (box && box.type && !seen.has(box.type)) {
            seen.add(box.type);
            ordered.push(box);
        }
    }

    dstEntry.boxes = ordered;
    for (const box of ordered) {
        dstEntry[box.type] = box;
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

/** trun 里各字段的可写范围检查，越界时报出字段名而不是让 Buffer 抛 RangeError */
function checkWriteRange(name, value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(
            `Sample 的 ${name} 超出 trun 可写范围 [${min}, ${max}]: ${value}`
        );
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
        // 三个字段分别用 writeUInt32BE / writeUInt32BE / writeInt32BE 写出，
        // 越界只会得到 Node 的 RangeError（不带 Sample 序号），这里提前给出可定位的报错
        checkWriteRange('duration', s.duration, 0, 0xffffffff);
        checkWriteRange('size', s.size, 1, 0xffffffff);
        checkWriteRange('cts - dts', s.cts - s.dts, -0x80000000, 0x7fffffff);
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
 * 选择每个分片的起始视频帧。
 *
 * 默认在视频关键帧处切分。但关键帧密度异常时（源没有 stss 导致 MP4Box 把
 * 每一帧都标成关键帧，或编码本身就是全 I 帧）逐帧分片会让 moof 头开销占到
 * 文件体积的两成以上。因此当"平均每个分片不足 MIN_FRAGMENT_SECONDS"时，
 * 改成只在关键帧且距上一个分片点已满最短时长时才切分：既能合并过密的关键帧，
 * 又保证每个分片仍从关键帧开始（sidx 声明的 SAP 才不会说谎）；
 * 正常 GOP 的内容保持原有的逐关键帧切分不变。
 * @param {Array<object>} vs 视频 Sample 列表
 * @param {number} timescale 视频轨道时间尺度
 * @returns {number[]} 分片起始帧下标（严格递增，首元素为 0）
 */
function pickFragmentStarts(vs, timescale) {
    const starts = [];
    for (let i = 0; i < vs.length; i++) {
        if (i === 0 || vs[i].keyframe) starts.push(i);
    }
    if (starts.length < 2) return starts;

    const scale = timescale > 0 ? timescale : 1000;
    let totalDuration = 0;
    for (const s of vs) totalDuration += Number.isFinite(s.duration) ? s.duration : 0;
    const avgSeconds = totalDuration / scale / (starts.length - 1);
    if (avgSeconds >= MIN_FRAGMENT_SECONDS) return starts;

    // 关键帧过密：按最短分片时长合并
    const minDuration = Math.max(1, Math.round(MIN_FRAGMENT_SECONDS * scale));
    const merged = [0];
    let accumulated = 0;
    for (let i = 1; i < vs.length; i++) {
        if (vs[i].keyframe && accumulated >= minDuration) {
            merged.push(i);
            accumulated = 0;
        }
        accumulated += Number.isFinite(vs[i].duration) ? vs[i].duration : 0;
    }
    return merged;
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
    const starts = pickFragmentStarts(vs, video.timescale);
    const ends = [];
    for (let k = 0; k < starts.length; k++) {
        ends.push(k + 1 < starts.length ? starts[k + 1] : vs.length);
    }
    // DTS 必须非递减，否则 tfdt / sidx 的时间基准会倒序、解码顺序错乱
    for (let i = 1; i < vs.length; i++) {
        if (vs[i].dts < vs[i - 1].dts) {
            throw new Error(
                `视频 Sample 的 DTS 出现回退：第 ${i - 1} 帧 dts=${vs[i - 1].dts}，` +
                    `第 ${i} 帧 dts=${vs[i].dts}`
            );
        }
    }
    // 每个分片以关键帧开头（tfdt 基准时间递增由上面的 DTS 检查保证）
    for (const start of starts) {
        if (start !== 0 && !vs[start].keyframe) {
            throw new Error(`分片起点第 ${start} 帧不是关键帧，sidx 的 SAP 声明会不成立`);
        }
    }

    const fragments = [];
    let ai = 0;
    for (let k = 0; k < starts.length; k++) {
        const vFrom = starts[k];
        const vTo = ends[k];
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

        // sidx 的 first_presentation_time 是"该范围内第一个随机访问点的呈现时间"，
        // 也就是分片首帧（关键帧）的 cts，而不是整段里的最小 cts
        let earliestPts = Infinity;
        if (vSeg.length > 0) {
            earliestPts = vSeg[0].cts;
        } else if (aSeg.length > 0) {
            earliestPts = aSeg[0].cts;
        }
        let duration = 0;
        for (const s of vSeg) {
            duration += s.duration;
        }
        fragments.push({
            moof,
            mdatSize: mdatPos,
            videoSamples: vSeg,
            audioSamples: aSeg,
            duration,
            earliestPts: Number.isFinite(earliestPts) ? earliestPts : 0,
        });
    }
    return fragments;
}

/**
 * 生成索引视频轨的 sidx（version 1），每个引用对应一个以关键帧开头的分片
 *
 * starts_with_SAP / SAP_type 由分片首帧实际是不是随机访问点决定，
 * 不再一律写死 "SAP=1"；否则没有 stss 的源会谎报每个分片都可独立解码。
 */
function buildSidx(trackId, timescale, fragments) {
    const n = fragments.length;
    const size = 40 + n * 12;
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0); b.write('sidx', 4, 'latin1');
    b.writeUInt32BE(0x01000000, 8);
    b.writeUInt32BE(trackId, 12);
    b.writeUInt32BE(timescale, 16);
    // first_presentation_time 是 64 位无符号，负数（cts 偏移异常）会直接写坏 Box
    const firstPts = fragments.length > 0 ? fragments[0].earliestPts : 0;
    if (!Number.isSafeInteger(firstPts) || firstPts < 0) {
        throw new Error(
            `sidx 的 first_presentation_time 无法表示（需要非负整数，实际 ${firstPts}），` +
                '通常是 trun 的合成时间偏移异常'
        );
    }
    b.writeBigUInt64BE(BigInt(firstPts), 20);
    b.writeBigUInt64BE(0n, 28);
    b.writeUInt16BE(0, 36);
    b.writeUInt16BE(n, 38);
    let p = 40;
    for (let i = 0; i < fragments.length; i++) {
        const f = fragments[i];
        const refSize = f.moof.length + f.mdatSize;
        // reference_size 只有 31 位可用，超过就没法用 sidx 索引了
        if (refSize > 0x7fffffff) {
            throw new Error(
                `第 ${i + 1} 个分片过大（${refSize} 字节），超出 sidx 单个引用的 31 位长度上限`
            );
        }
        if (!Number.isInteger(f.duration) || f.duration < 0 || f.duration > 0xffffffff) {
            throw new Error(
                `第 ${i + 1} 个分片的时长无法用 sidx 表示（32 位无符号，实际 ${f.duration}）`
            );
        }
        const first = f.videoSamples.length > 0 ? f.videoSamples[0] : null;
        // 分片首帧是关键帧时，本封装写出的 sample_flags 是 depends_on=2 且非 non_sync，
        // 属于闭合 GOP 的随机访问点（SAP_type=1）；否则该分片不能独立起播
        const isSap = !first || first.keyframe;
        const sapType = isSap ? 1 : 0;
        // 第 3 个 32 位字：starts_with_SAP(1) | SAP_type(3) | SAP_delta_time(28)
        const word = ((isSap ? 0x80000000 : 0) | (sapType << 28)) >>> 0;
        b.writeUInt32BE(refSize, p);
        b.writeUInt32BE(f.duration, p + 4);
        b.writeUInt32BE(word, p + 8); // starts_with_SAP | SAP_type | delta=0
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
    readVideoSamples = null,
    readAudioSamples = null,
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

    // 攒数据本身是同步的，只有真正触发 flush 时才 await：避免每帧（长视频可达
    // 十万级帧）都创建一个 Promise；flush 触发点和写出的 chunk 序列与原来一致
    let pending = [];
    let pendingSize = 0;
    const flush = async () => {
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
        pending = [];
        pendingSize = 0;
        await write(chunk);
        report();
    };
    const push = (buf) => {
        pending.push(buf);
        pendingSize += buf.length;
        writtenBytes += buf.length;
    };

    const pushSamples = async (samples, readSample, readSamples) => {
        for (let start = 0; start < samples.length;) {
            let end = start;
            let batchSize = 0;
            while (end < samples.length) {
                const size = samples[end].size;
                if (end > start && batchSize + size > FLUSH_THRESHOLD) break;
                batchSize += size;
                end++;
                if (batchSize >= FLUSH_THRESHOLD) break;
            }

            const batch = samples.slice(start, end);
            const data = readSamples ? readSamples(batch) : batch.map(readSample);
            for (const sampleData of data) {
                push(sampleData);
                if (pendingSize >= FLUSH_THRESHOLD) await flush();
            }
            start = end;
        }
    };

    for (const fragment of fragments) {
        abortIfRequested();
        push(fragment.moof);
        if (pendingSize >= FLUSH_THRESHOLD) await flush();

        const header = Buffer.alloc(8);
        header.writeUInt32BE(fragment.mdatSize, 0);
        header.write('mdat', 4, 'latin1');
        push(header);
        if (pendingSize >= FLUSH_THRESHOLD) await flush();

        await pushSamples(fragment.videoSamples, readVideoSample, readVideoSamples);
        await pushSamples(fragment.audioSamples, readAudioSample, readAudioSamples);
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
            readVideoSamples: video.readSamples,
            readAudioSamples: audio.readSamples,
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
