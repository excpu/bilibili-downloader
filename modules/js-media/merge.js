// merge.js (biliM4sMerger.js)
const fs = require('fs');
const MP4Box = require('mp4box');
const { createFileWriter } = require('./stream-writer');
const { buildMkvFile } = require('./matroska');

/**
 * 让一个已解析的 Box 在序列化时原样输出源文件字节。
 *
 * MP4Box 的部分 Box 子类 write() 实现会丢字段（典型如 hvcC 的
 * min_spatial_segmentation_idc 保留位被 writeUint16 截断），
 * 因此这里用 Box 基类的 write()（只写 size/type + this.data）覆盖子类实现，
 * 并把 this.data 换成从源文件切出的原始载荷字节。
 * Box 对象上已解析出来的字段全部保留，getCodec() 等逻辑不受影响。
 * @param {object} box MP4Box 解析出的 Box 实例
 * @param {Uint8Array} payload Box 原始载荷（不含 Box 头）
 */
function makeBoxVerbatim(box, payload) {
    box.data = payload;
    // 基类 write() 会按 "载荷长度 + 8 字节头" 重新计算 size，
    // 清掉源文件可能带的 64-bit 扩展尺寸标记，保证走标准 8 字节头路径
    box.original_size = undefined;
    box.hdr_size = 8;
    box.write = MP4Box.Box.prototype.write;
}

/**
 * 移除 Bilibili PC 客户端缓存 .m4s 文件开头的 9 个 ASCII '0' (0x30) 混淆字节
 * @param {Buffer} nodeBuffer
 * @returns {ArrayBuffer} 带有 fileStart 属性的 ArrayBuffer
 */
function normalizeM4sBuffer(nodeBuffer) {
    let cleanBuf = nodeBuffer;

    // 检查前 9 个字节是否全为 0x30 ('0')
    if (cleanBuf.length > 9) {
        let isBiliHeader = true;
        for (let i = 0; i < 9; i++) {
            if (cleanBuf[i] !== 0x30) {
                isBiliHeader = false;
                break;
            }
        }
        if (isBiliHeader) {
            cleanBuf = cleanBuf.subarray(9);
        }
    }

    // 转换为 MP4Box.js 所需的 ArrayBuffer，并标记偏移量 fileStart = 0
    const arrayBuffer = cleanBuf.buffer.slice(
        cleanBuf.byteOffset,
        cleanBuf.byteOffset + cleanBuf.byteLength
    );
    arrayBuffer.fileStart = 0;
    return arrayBuffer;
}

    const M4S_PREFIX_LENGTH = 9;

    /**
     * 探测 .m4s 是否带 Bilibili 的 9 字节 '0' 前缀（读文件头判断，不加载整个文件）
     * @param {number} fd 已打开的文件描述符
     * @param {number} fileSize
     * @returns {number} 需要跳过的字节数
     */
    function probeM4sPrefix(fd, fileSize) {
        if (fileSize <= M4S_PREFIX_LENGTH) return 0;
        const head = Buffer.allocUnsafe(M4S_PREFIX_LENGTH);
        const read = fs.readSync(fd, head, 0, M4S_PREFIX_LENGTH, 0);
        if (read !== M4S_PREFIX_LENGTH) return 0;
        for (let i = 0; i < M4S_PREFIX_LENGTH; i++) {
            if (head[i] !== 0x30) return 0;
        }
        return M4S_PREFIX_LENGTH;
    }

/**
 * 解析单个 M4S 文件，提取轨道信息、原始 stsd 编码配置 Box 以及全部 Sample 帧
 * @param {string} filePath
 * @returns {Promise<{ trackInfo: object, stsdEntry: object, samples: Array }>}
 */
function demuxM4s(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (readErr, data) => {
            if (readErr) return reject(readErr);

            // 必须传入 true (keepMdatData = true)，否则在 start() 前解析完的 mdat 帧数据会被丢弃
            const mp4boxfile = MP4Box.createFile(true);
            const collectedSamples = [];
            let trackInfo = null;
            let stsdEntry = null;
            let cleanBuffer = null;

            mp4boxfile.onError = (err) => {
                reject(new Error(`MP4Box 解析失败 (${filePath}): ${err}`));
            };

            mp4boxfile.onReady = (info) => {
                if (!info.tracks || info.tracks.length === 0) {
                    return reject(new Error(`未在文件中找到媒体轨道: ${filePath}`));
                }
                trackInfo = info.tracks[0];

                // 获取原始轨道中的 Sample Entry（包含 avcC / hvcC / av1C / esds / dac3 / dec3 / dfLa 等配置 Box）
                const rawTrak = mp4boxfile.getTrackById(trackInfo.id);
                if (
                    rawTrak &&
                    rawTrak.mdia &&
                    rawTrak.mdia.minf &&
                    rawTrak.mdia.minf.stbl &&
                    rawTrak.mdia.minf.stbl.stsd &&
                    rawTrak.mdia.minf.stbl.stsd.entries.length > 0
                ) {
                    stsdEntry = rawTrak.mdia.minf.stbl.stsd.entries[0];

                    // 把每个解码器配置子 Box 标记为"原样输出源文件字节"，
                    // 避免 MP4Box 回写时丢字段（如 hvcC 保留位）
                    if (Array.isArray(stsdEntry.boxes) && cleanBuffer) {
                        for (const b of stsdEntry.boxes) {
                            if (!b || !b.type) continue;
                            if (
                                !Number.isFinite(b.start) ||
                                !Number.isFinite(b.size) ||
                                b.size <= 0
                            ) {
                                continue;
                            }
                            const hdrSize = b.hdr_size || 8;
                            if (b.size < hdrSize || b.start + b.size > cleanBuffer.length) {
                                continue;
                            }
                            // slice() 复制一份，防止 MP4Box 内部释放/复用底层缓冲区
                            makeBoxVerbatim(
                                b,
                                cleanBuffer.slice(b.start + hdrSize, b.start + b.size)
                            );
                        }
                    }
                }

                // 设置提取所有帧
                mp4boxfile.setExtractionOptions(trackInfo.id, null, {
                    nbSamples: Infinity,
                });
                mp4boxfile.start();
            };

            mp4boxfile.onSamples = (id, user, samples) => {
                for (let i = 0; i < samples.length; i++) {
                    const s = samples[i];
                    if (!s || !s.data) continue;

                    // 浅拷贝生成独立对象保存 s.data 引用，防止后续 releaseUsedSamples 原地清空 s.data
                    collectedSamples.push({
                        data: s.data,
                        duration: s.duration,
                        dts: s.dts,
                        cts: s.cts,
                        is_sync: s.is_sync,
                    });
                }

                // 释放 MP4Box 内部已消费的样本引用
                if (samples.length > 0) {
                    mp4boxfile.releaseUsedSamples(
                        id,
                        samples[samples.length - 1].number + 1
                    );
                }
            };

            try {
                const arrayBuffer = normalizeM4sBuffer(data);
                // 零拷贝视图，仅用于在 onReady 中截取配置 Box 的原始字节
                cleanBuffer = new Uint8Array(arrayBuffer);
                mp4boxfile.appendBuffer(arrayBuffer);
                mp4boxfile.flush();
                cleanBuffer = null;

                if (!trackInfo) {
                    return reject(new Error(`未能完成 moov 头解析: ${filePath}`));
                }
                if (collectedSamples.length === 0) {
                    return reject(
                        new Error(`未能提取到有效媒体帧 (sample.data 为空): ${filePath}`)
                    );
                }

                resolve({
                    trackInfo,
                    stsdEntry,
                    samples: collectedSamples,
                });
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * 流式解析单个 M4S 文件：只解析元信息（轨道、编码配置、Sample 偏移表），
 * 不把 Sample 数据留在内存里，需要时再按偏移从文件读取。
 *
 * 与 demuxM4s 的区别：demuxM4s 会把所有帧数据读进内存（适合小文件），
 * demuxM4sIndex 只保留偏移，配合 Matroska 流式写盘可以做到低内存占用。
 *
 * @param {string} filePath
 * @returns {Promise<{ trackInfo: object, stsdEntry: object, samples: Array, readSample: (s: object) => Buffer, close: () => void }>}
 */
function demuxM4sIndex(filePath) {
    return new Promise((resolve, reject) => {
        let fd;
        try {
            fd = fs.openSync(filePath, 'r');
        } catch (err) {
            return reject(err);
        }

        const closeFd = () => {
            if (fd === undefined) return;
            try {
                fs.closeSync(fd);
            } catch (_) {
                // 忽略重复关闭
            }
            fd = undefined;
        };

        const fail = (err) => {
            closeFd();
            reject(err);
        };

        try {
            const fileSize = fs.fstatSync(fd).size;
            const prefix = probeM4sPrefix(fd, fileSize);
            // fileStart 坐标以去掉前缀后的数据流为 0，Sample 偏移可直接用于 Seek
            const dataStart = prefix;

            const mp4boxfile = MP4Box.createFile(false);
            let trackInfo = null;
            let stsdEntry = null;
            let parseError = null;

            mp4boxfile.onError = (err) => {
                parseError = new Error(`MP4Box 解析失败 (${filePath}): ${err}`);
            };

            const CHUNK_SIZE = 1024 * 1024;
            for (let pos = dataStart; pos < fileSize; pos += CHUNK_SIZE) {
                const len = Math.min(CHUNK_SIZE, fileSize - pos);
                const chunk = Buffer.allocUnsafe(len);
                const got = fs.readSync(fd, chunk, 0, len, pos);
                if (got <= 0) break;
                const arrayBuffer = chunk.buffer.slice(
                    chunk.byteOffset,
                    chunk.byteOffset + got
                );
                arrayBuffer.fileStart = pos - dataStart;
                mp4boxfile.appendBuffer(arrayBuffer);
                if (parseError) break;

                if (!trackInfo) {
                    const info = mp4boxfile.moov ? mp4boxfile.getInfo() : null;
                    if (info && info.tracks && info.tracks.length > 0) {
                        trackInfo = info.tracks[0];
                        const rawTrak = mp4boxfile.getTrackById(trackInfo.id);
                        const stbl = rawTrak && rawTrak.mdia && rawTrak.mdia.minf && rawTrak.mdia.minf.stbl;
                        if (stbl && stbl.stsd && stbl.stsd.entries.length > 0) {
                            stsdEntry = stbl.stsd.entries[0];
                        }
                    }
                }
            }
            mp4boxfile.flush();

            if (parseError) return fail(parseError);
            if (!trackInfo) {
                return fail(new Error(`未能完成 moov 头解析: ${filePath}`));
            }

            const rawTrak = mp4boxfile.getTrackById(trackInfo.id);
            const samples = (rawTrak && rawTrak.samples) || [];
            if (samples.length === 0) {
                return fail(new Error(`未能提取到有效媒体帧: ${filePath}`));
            }

            const readSample = (sample) => {
                if (fd === undefined) throw new Error('M4S 文件已关闭，无法读取 Sample');
                const at = dataStart + sample.offset;
                const buf = Buffer.allocUnsafe(sample.size);
                let filled = 0;
                while (filled < sample.size) {
                    const got = fs.readSync(fd, buf, filled, sample.size - filled, at + filled);
                    if (got <= 0) {
                        throw new Error(
                            `读取 Sample 失败 (${filePath} @${at + filled})：文件可能已被截断`
                        );
                    }
                    filled += got;
                }
                return buf;
            };

            // mp4box 已不再需要底层 Buffer，及时释放
            mp4boxfile.stream.cleanBuffers();

            resolve({
                trackInfo,
                stsdEntry,
                samples: samples.map((s) => ({
                    offset: s.offset,
                    size: s.size,
                    dts: s.dts,
                    cts: s.cts,
                    duration: s.duration,
                    is_sync: s.is_sync,
                })),
                readSample,
                close: closeFd,
            });
        } catch (err) {
            fail(err);
        }
    });
}

/**
 * 将源轨道的解码器配置子 Box（avcC/hvcC/av1C/esds/dac3/dec3/dfLa/colr/pasp 等）完整同步到输出轨道
 *
 * 源 Box 已在 demuxM4s 中被标记为"原样输出源文件字节"，
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
        const flags = !isVideo || s.is_sync ? 0x02000000 : 0x01010000;
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
        if (i === 0 || vs[i].is_sync) starts.push(i);
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
 */
async function writeFragments({ initSegment, sidx, fragments, readVideoSample, readAudioSample, write }) {
    await write(initSegment);
    await write(sidx);

    let pending = [];
    let pendingSize = 0;
    // 把细碎的小帧（音频帧可能只有几百字节）聚成较大的写入块，减少 write 次数
    const FLUSH_THRESHOLD = 1 << 20;
    const push = async (buf) => {
        pending.push(buf);
        pendingSize += buf.length;
        if (pendingSize >= FLUSH_THRESHOLD) {
            const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
            pending = [];
            pendingSize = 0;
            await write(chunk);
        }
    };

    for (const fragment of fragments) {
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
}

/**
 * 合并 Bilibili 视频 .m4s 和 音频 .m4s 为单个 .mp4 文件（流式落盘）
 * @param {string} videoM4sPath 视频 .m4s 路径
 * @param {string} audioM4sPath 音频 .m4s 路径
 * @param {string} outputMp4Path 输出 .mp4 路径
 * @returns {Promise<{ outputMp4Path: string, videoSamples: number, audioSamples: number }>}
 */
async function mergeBiliM4s(videoM4sPath, audioM4sPath, outputMp4Path) {
    // 1. 并行解复用视频与音频 M4S：只保留轨道信息、编码配置与 Sample 偏移表
    const [videoData, audioData] = await Promise.all([
        demuxM4sIndex(videoM4sPath),
        demuxM4sIndex(audioM4sPath),
    ]);

    try {
        const vInfo = videoData.trackInfo;
        const aInfo = audioData.trackInfo;

        // 2. 创建输出 MP4 容器（必须在调用 addSample 前完成所有 addTrack）
        const outFile = MP4Box.createFile();

        const vSubtype = vInfo.codec.split('.')[0]; // 如 'avc1', 'hev1', 'hvc1', 'av01'
        const videoTrackOpts = {
            timescale: vInfo.timescale,
            width: vInfo.video ? vInfo.video.width : vInfo.track_width,
            height: vInfo.video ? vInfo.video.height : vInfo.track_height,
            type: vSubtype,
            hdlr: 'vide',
        };

        if (videoData.stsdEntry && videoData.stsdEntry.esds) {
            videoTrackOpts.description = videoData.stsdEntry.esds;
        }

        const outVideoTrackId = outFile.addTrack(videoTrackOpts);
        if (outVideoTrackId === undefined || outVideoTrackId === null) {
            throw new Error(`不支持的视频编码格式，无法创建轨道: ${vInfo.codec}`);
        }
        copyCodecConfigBoxes(outFile, outVideoTrackId, videoData.stsdEntry);

        const aSubtype = aInfo.codec.split('.')[0]; // 如 'mp4a', 'ec-3', 'ac-3', 'fLaC'
        const audioTrackOpts = {
            timescale: aInfo.timescale,
            samplerate: aInfo.audio ? aInfo.audio.sample_rate : aInfo.timescale,
            channel_count: aInfo.audio ? aInfo.audio.channel_count : 2,
            samplesize: aInfo.audio ? aInfo.audio.sample_size : 16,
            type: aSubtype,
            hdlr: 'soun',
        };

        if (audioData.stsdEntry && audioData.stsdEntry.esds) {
            audioTrackOpts.description = audioData.stsdEntry.esds;
        }

        const outAudioTrackId = outFile.addTrack(audioTrackOpts);
        if (outAudioTrackId === undefined || outAudioTrackId === null) {
            throw new Error(`不支持的音频编码格式，无法创建轨道: ${aInfo.codec}`);
        }
        copyCodecConfigBoxes(outFile, outAudioTrackId, audioData.stsdEntry);

        const videoSampleCount = videoData.samples.length;
        const audioSampleCount = audioData.samples.length;

        // 3. 回填时长。MP4Box 生成的 moov 默认 mvhd/tkhd/mdhd/mehd 时长全为 0，
        // 播放器会把它当作直播流而无法 Seek
        fillDurations(outFile, [
            { id: outVideoTrackId, samples: videoData.samples },
            { id: outAudioTrackId, samples: audioData.samples },
        ]);

        // 4. 取出 ftyp + moov 作为初始化段（此时尚未添加任何 Sample，不含分片）
        // 注意：getBuffer() 返回的是 mp4box 的 DataStream 对象（带 buffer/byteOffset/byteLength
        // 访问器），并不是 ArrayBuffer。直接 Buffer.from(dataStream) 会得到 0 字节缓冲，
        // 这正是之前输出 0 KB 文件的根本原因。
        const stream = outFile.getBuffer();
        const initSegment = Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength);

        // 5. 按视频关键帧切分片并生成 sidx，然后逐片流式落盘
        const fragments = buildFragments(
            { id: outVideoTrackId, timescale: vInfo.timescale, samples: videoData.samples },
            { id: outAudioTrackId, timescale: aInfo.timescale, samples: audioData.samples }
        );
        const sidx = buildSidx(outVideoTrackId, vInfo.timescale, fragments);

        const writer = createFileWriter(outputMp4Path);
        try {
            await writeFragments({
                initSegment,
                sidx,
                fragments,
                readVideoSample: videoData.readSample,
                readAudioSample: audioData.readSample,
                write: writer.write,
            });
            await writer.close();
        } catch (err) {
            writer.abort();
            throw err;
        }

        return {
            outputMp4Path,
            videoSamples: videoSampleCount,
            audioSamples: audioSampleCount,
        };
    } finally {
        videoData.close();
        audioData.close();
    }
}

/**
 * 合并 Bilibili 视频/音频 .m4s 并输出 MKV，可选内嵌 SRT / ASS 字幕
 *
 * 全程使用纯 Node.js（mp4box 解复用 + 自实现 Matroska 封装），不依赖 ffmpeg。
 * 选 MKV 而不是 MP4 的原因：MKV 可直接存放 SubRip / ASS 字幕轨（MP4 只能放
 * mov_text，会丢掉 ASS 样式），并且对 FLAC、杜比全景声等音轨兼容性更好。
 *
 * @param {string} videoM4sPath 视频 .m4s 路径
 * @param {string} audioM4sPath 音频 .m4s 路径
 * @param {string} outputMkvPath 输出 .mkv 路径
 * @param {object} [options]
 * @param {string} [options.subtitlePath] 字幕文件路径，支持 .srt / .ass / .ssa
 * @param {string} [options.subtitleTitle] 字幕轨名称，默认 "字幕"
 * @param {string} [options.subtitleLanguage] 字幕轨语言代码，默认 "chi"
 * @param {boolean} [options.subtitleDefault] 是否标记为默认字幕轨，默认 true
 * @param {string} [options.title] 文件标题元数据
 * @param {(progress: number) => void} [options.onProgress] 进度回调，0~1
 * @returns {Promise<{ outputMkvPath: string, subtitleEmbedded: boolean, videoSamples: number, audioSamples: number }>}
 */
async function mergeBiliM4sToMkv(videoM4sPath, audioM4sPath, outputMkvPath, options = {}) {
    const {
        subtitlePath = null,
        subtitleTitle = '字幕',
        subtitleLanguage = 'chi',
        subtitleDefault = true,
        title = null,
        onProgress = null,
    } = options;

     // 只解析元信息与 Sample 偏移，帧数据在写盘时按需读取（流式落盘，内存占用与文件大小无关）
     const [videoData, audioData] = await Promise.all([
         demuxM4sIndex(videoM4sPath),
         demuxM4sIndex(audioM4sPath),
     ]);

     try {
         await buildMkvFile({
             video: videoData,
             audio: audioData,
             subtitle: subtitlePath
                 ? {
                       filePath: subtitlePath,
                       title: subtitleTitle,
                       language: subtitleLanguage,
                       isDefault: subtitleDefault,
                   }
                 : null,
             outputPath: outputMkvPath,
             title,
             onProgress,
         });
     } finally {
         videoData.close();
         audioData.close();
     }

     return {
         outputMkvPath,
         subtitleEmbedded: Boolean(subtitlePath),
         videoSamples: videoData.samples.length,
         audioSamples: audioData.samples.length,
     };
 }
module.exports = {
    mergeBiliM4s,
    mergeBiliM4sToMkv,
    demuxM4s,
    demuxM4sIndex,
    normalizeM4sBuffer,
};
