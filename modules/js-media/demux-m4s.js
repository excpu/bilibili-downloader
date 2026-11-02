// demux-m4s.js
// Bilibili .m4s（DASH 分片 MP4）解封装：B 站前缀处理、MP4Box 解析、解码器配置 Box
// 的"原样输出"标记，最终产出统一数据契约 TrackSource（见 track-source.js）。
//
// 这里不掺和任何封装（MP4 / MKV）逻辑，也不负责写盘。
'use strict';

const fs = require('fs');
const MP4Box = require('mp4box');
const { createTrackSource } = require('./track-source');
const { createFileReader } = require('./file-reader');
const biliPrefix = require('./bili-prefix');

// B 站 PC 客户端缓存的 .m4s 文件头带 9 个 ASCII '0' (0x30) 混淆字节
const M4S_PREFIX_LENGTH = biliPrefix.PREFIX_LENGTH;
const MAX_BATCH_READ_SIZE = 1 << 20;

/**
 * 判断一段字节开头是否是 Bilibili 的 9 字节 '0' 前缀
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 需要跳过的字节数
 */
function detectM4sPrefix(buf) {
    return biliPrefix.detectPrefixInBuffer(buf);
}

/**
 * 移除 Bilibili PC 客户端缓存 .m4s 文件开头的 9 个 '0' 混淆字节
 * @param {Buffer} nodeBuffer
 * @returns {ArrayBuffer} 带有 fileStart 属性的 ArrayBuffer
 */
function normalizeM4sBuffer(nodeBuffer) {
    const prefix = detectM4sPrefix(nodeBuffer);
    const cleanBuf = prefix ? nodeBuffer.subarray(prefix) : nodeBuffer;

    // 转换为 MP4Box.js 所需的 ArrayBuffer，并标记偏移量 fileStart = 0
    const arrayBuffer = cleanBuf.buffer.slice(
        cleanBuf.byteOffset,
        cleanBuf.byteOffset + cleanBuf.byteLength
    );
    arrayBuffer.fileStart = 0;
    return arrayBuffer;
}

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
    // MP4Box 的 DataStream.writeUint8Array 在走 memcpy 快路径时，源地址固定取
    // array.buffer 的偏移 0（完全忽略 array.byteOffset）。Node 的
    // Buffer.allocUnsafe / buffer.slice 返回的都是共享内存池上的视图，
    // byteOffset 通常不为 0，直接交给 MP4Box 会把内存池开头的无关字节
    // （例如 CDN 返回的 JSON）当成载荷写出去，导致 avcC 等配置 Box 全坏，
    // ffmpeg 报 "No start code is found / Error splitting the input into NAL units"。
    // 因此这里统一规整成 byteOffset 为 0 的独立副本。
    // 注意不能用 payload.slice()：Node 的 Buffer 把 slice 重定义成了
    // subarray（共享内存的视图，byteOffset 不变），必须用 TypedArray
    // 构造函数逐元素拷贝才能真正独立。
    box.data =
        payload instanceof Uint8Array && payload.byteOffset === 0
            ? payload
            : new Uint8Array(payload);
    // 基类 write() 会按 "载荷长度 + 8 字节头" 重新计算 size，
    // 清掉源文件可能带的 64-bit 扩展尺寸标记，保证走标准 8 字节头路径
    box.original_size = undefined;
    box.hdr_size = 8;
    box.write = MP4Box.Box.prototype.write;
}

/**
 * 从内存缓冲区中把 stsdEntry 的解码器配置子 Box 标记为"原样输出"
 * @param {object} stsdEntry
 * @param {Uint8Array} buffer 去掉前缀后的完整数据流
 */
function markStsdBoxesFromBuffer(stsdEntry, buffer) {
    if (!stsdEntry || !Array.isArray(stsdEntry.boxes) || !buffer) return;
    for (const b of stsdEntry.boxes) {
        if (!b || !b.type) continue;
        if (!Number.isFinite(b.start) || !Number.isFinite(b.size) || b.size <= 0) {
            continue;
        }
        const hdrSize = b.hdr_size || 8;
        if (b.size < hdrSize || b.start + b.size > buffer.length) {
            continue;
        }
        // slice() 复制一份，防止 MP4Box 内部释放/复用底层缓冲区
        makeBoxVerbatim(b, buffer.slice(b.start + hdrSize, b.start + b.size));
    }
}

/**
 * 从已打开的文件中按 Box 的 start/size 切出原始载荷，并标记为"原样输出"。
 *
 * MP4Box 只在 Box 类没有自定义 write() 时才会填充 box.data
 * （见 parseOneBox -> parseDataAndRewind），像 avcC 这类带自定义 write()
 * 的 Box 解析后 box.data 是 undefined。仅靠 makeBoxVerbatim 传 undefined
 * 会让配置 Box 变成空载荷，因此这里直接从源文件字节切片。
 *
 * @param {{ read: (offset: number, length: number) => Buffer }} reader 输入读取器
 * @param {number} dataStart 文件内数据流起点（跳过 Bilibili 前缀后的偏移）
 * @param {object} box MP4Box 解析出的 Box 实例
 * @returns {boolean} 是否成功设置
 */
function readBoxPayloadVerbatim(reader, dataStart, box) {
    if (!box || !box.type) return false;
    // MP4Box 已经填好 .data 的 Box 保持原样（FullBox 的 .data 是去掉 version/flags 的视图）
    if (box.data && box.data.length > 0) return false;
    if (!Number.isFinite(box.start) || !Number.isFinite(box.size) || box.size <= 0) {
        return false;
    }
    const hdrSize = box.hdr_size || 8;
    if (box.size < hdrSize) return false;

    const payloadLength = box.size - hdrSize;
    let payload;
    try {
        payload = reader.read(dataStart + box.start + hdrSize, payloadLength);
    } catch (_) {
        // 配置 Box 越界或读不满时跳过，交给后续封装逻辑按缺失处理
        return false;
    }
    makeBoxVerbatim(box, payload);
    return true;
}

/** 沿 mdia.minf.stbl.stsd 路径取轨道的原始 Sample Entry */
function getStsdEntry(mp4boxfile, trackId, descriptionIndex = 0) {
    const rawTrak = mp4boxfile.getTrackById(trackId);
    const stbl =
        rawTrak && rawTrak.mdia && rawTrak.mdia.minf && rawTrak.mdia.minf.stbl;
    if (!stbl || !stbl.stsd || !Array.isArray(stbl.stsd.entries)) return null;
    const entries = stbl.stsd.entries;
    if (entries.length === 0) return null;
    // MP4Box 内部按 0-based 的 description_index 取 entry（tfhd/trex 里的值是 1-based，
    // 调用方负责换算），多 Sample Description 的轨道不能一律取 entries[0]
    const index = Number.isInteger(descriptionIndex) && descriptionIndex >= 0 &&
        descriptionIndex < entries.length ? descriptionIndex : 0;
    return entries[index];
}

/** 取 mvex.trex 里该轨道的缺省值（MP4Box 对缺失的 trex 会静默用 0 兜底） */
function findTrex(mp4boxfile, trackId) {
    const mvex = mp4boxfile.moov && mp4boxfile.moov.mvex;
    if (!mvex) return null;
    const trexs = Array.isArray(mvex.trexs)
        ? mvex.trexs
        : Array.isArray(mvex.boxes)
          ? mvex.boxes.filter((b) => b && b.type === 'trex')
          : [];
    return trexs.find((t) => t && t.track_id === trackId) || null;
}

/**
 * 检查分片是否依赖 MP4Box 会静默置 0 的缺省值。
 *
 * ffmpeg 的 mov_read_trun 在没有 tfhd 时直接丢弃整个 traf；MP4Box 只是把
 * default_sample_{duration,size,flags} 当成 0，结果是所有帧 duration 为 0、
 * is_sync 恒为 true。这里把这种情况报出来，避免产出时长错误、逐帧关键帧的文件。
 * @param {object} mp4boxfile
 * @param {number} trackId
 * @returns {string[]} 问题描述列表（空数组表示没问题）
 */
function checkFragmentDefaults(mp4boxfile, trackId) {
    const problems = [];
    const moofs = Array.isArray(mp4boxfile.moofs) ? mp4boxfile.moofs : [];
    for (const moof of moofs) {
        const trafs = Array.isArray(moof.trafs) ? moof.trafs : [];
        for (const traf of trafs) {
            const tfhd = traf.tfhd;
            if (!tfhd || tfhd.track_id !== trackId) continue;
            const trex = findTrex(mp4boxfile, tfhd.track_id);
            if (trex) continue;
            const truns = Array.isArray(traf.truns) ? traf.truns : [];
            for (const trun of truns) {
                const noDuration = !(tfhd.flags & 8) && !(trun.flags & 256);
                const noSize = !(tfhd.flags & 16) && !(trun.flags & 512);
                const noFlags =
                    !(tfhd.flags & 32) && !(trun.flags & 1024) && !(trun.flags & 4);
                if (!noDuration && !noSize && !noFlags) continue;
                const missing = [];
                if (noDuration) missing.push('duration');
                if (noSize) missing.push('size');
                if (noFlags) missing.push('sample_flags');
                problems.push(
                    `track_id=${tfhd.track_id} 的 traf 既没有对应的 trex，trun/tfhd 也未提供 ` +
                        `${missing.join('、')} 缺省值，MP4Box 会把这些字段当成 0 处理`
                );
                break;
            }
        }
    }
    return problems;
}

/**
 * 校验 trun 声明的 sample_count 是否真的能由输入文件容纳。
 *
 * MP4Box 的 trun 解析只检查 Box 头，不检查每个条目，声明值大于实际可读条目时
 * 会一路读到别的 Box 里（拿到 NaN 或垃圾数据）却不报错，等价于 ffmpeg 在
 * mov_read_trun 里的 "trun sample count %u exceeds ... AVERROR_INVALIDDATA"。
 * @param {object} mp4boxfile
 * @param {number} trackId
 * @param {number} availableSamples 解析后可用的 Sample 数
 * @returns {string|null} 问题描述
 */
function checkTrunSampleCounts(mp4boxfile, trackId, availableSamples) {
    const moofs = Array.isArray(mp4boxfile.moofs) ? mp4boxfile.moofs : [];
    let declared = 0;
    let readable = 0;
    for (const moof of moofs) {
        const trafs = Array.isArray(moof.trafs) ? moof.trafs : [];
        for (const traf of trafs) {
            if (!traf.tfhd || traf.tfhd.track_id !== trackId) continue;
            const truns = Array.isArray(traf.truns) ? traf.truns : [];
            for (const trun of truns) {
                // 取 trun 实际解析出的第一个数组字段，finite 的条目才是真读到了数据
                const arrays = [
                    trun.sample_size,
                    trun.sample_duration,
                    trun.sample_flags,
                    trun.sample_composition_time_offset,
                ];
                const arr = arrays.find((a) => Array.isArray(a) && a.length > 0);
                // 没有任何逐 Sample 数组的 trun（全部字段走 tfhd/trex 默认值）
                // 无法通过数组长度判断是否被截断，跳过，避免把默认计数误报成夸大
                if (!arr) continue;
                declared += trun.sample_count || 0;
                for (let i = 0; i < trun.sample_count; i++) {
                    if (Number.isFinite(arr[i])) readable++;
                }
            }
        }
    }
    if (declared === 0) return null;
    if (readable < declared) {
        return (
            `trun 声明了 ${declared} 个 Sample，但输入文件只装得下 ${readable} 个` +
            `（实际解析出 ${availableSamples} 个），文件可能被截断或 trun 计数被夸大`
        );
    }
    return null;
}

/**
 * 挑选主媒体轨道：Bilibili 的 .m4s 只有一条音视频轨，但带字幕/数据轨的文件
 * 不能直接取 tracks[0]（MP4Box 的 info.tracks[i].type 是 'video' / 'audio' / …）
 */
function pickTrackInfo(info, filePath) {
    const tracks = info && Array.isArray(info.tracks) ? info.tracks : [];
    if (tracks.length === 0) {
        throw new Error(`未在文件中找到媒体轨道: ${filePath}`);
    }
    const media = tracks.find((t) => t && (t.type === 'video' || t.type === 'audio'));
    return media || tracks[0];
}

/**
 * 按 ffmpeg 的规则判定随机访问点：
 * keyframe = !(sample_flags & (IS_NON_SYNC | DEPENDS_YES))
 * IS_NON_SYNC 是 bit 16（对应 MP4Box 的 is_sync === false），
 * DEPENDS_YES 是 depends_on 字段的 bit 0（值 1，以及保留值 3）。
 * open GOP 里依赖后续帧的 IDR 不能当作随机访问点。
 * @param {object} sample
 * @returns {boolean}
 */
function isKeyframeSample(sample) {
    const dependsOn = Number.isFinite(sample.depends_on) ? sample.depends_on : 0;
    return sample.is_sync !== false && (dependsOn & 1) === 0;
}

/** 把 MP4Box 的 Sample 转成契约字段（附带源文件偏移，供流式模式使用） */
function toContractSample(sample, descriptionIndexGetter) {
    return {
        dts: sample.dts,
        cts: sample.cts,
        duration: sample.duration,
        size: sample.size,
        offset: sample.offset,
        data: sample.data || null,
        keyframe: isKeyframeSample(sample),
        nonSync: sample.is_sync === false ? 1 : 0,
        dependsOn: Number.isFinite(sample.depends_on) ? sample.depends_on : 0,
        descriptionIndex: descriptionIndexGetter(sample),
    };
}

/**
 * 校验 Sample 偏移表是否真的落在数据流范围内。
 *
 * MP4Box 对 stco/co64 条目不足、trun 计数夸大等情况都不会报错，只会给出
 * undefined / NaN 的偏移，或指向别的 Box 的字节；等到写盘阶段才失败会浪费
 * 已经下载好的整段数据，所以在解封装结束时就检查一次。
 *
 * @param {Array<object>} samples 契约 Sample 列表
 * @param {number} dataSize 去掉 Bilibili 前缀后的数据流长度
 * @param {string} filePath
 * @returns {string|null}
 */
function checkSampleOffsets(samples, dataSize, filePath) {
    let maxEnd = 0;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!Number.isInteger(s.offset) || s.offset < 0) {
            return (
                `第 ${i} 个 Sample 的偏移量无效 (offset=${s.offset})，` +
                `stco/co64 条目数可能与 Sample 数不匹配: ${filePath}`
            );
        }
        const end = s.offset + s.size;
        if (end > maxEnd) maxEnd = end;
    }
    // 正常文件的最后一个 Sample 恰好写到数据流末尾，所以这里用 >，不是 >=
    if (maxEnd > dataSize) {
        return (
            `Sample 偏移表超出数据流范围（最大结束偏移 ${maxEnd} > 数据长度 ${dataSize}），` +
            `文件可能被截断或 trun/stsz 计数被夸大: ${filePath}`
        );
    }
    return null;
}

/**
 * 用 stts 末段时长补齐末帧 duration。
 *
 * 非分片 MP4 走 MP4Box 的 progressive 路径时，末帧 duration 是按
 * mdhd.duration - 已累计时长算出来的；Bilibili 的 mdhd.duration 恒为 0，
 * 末帧时长会变成 0，导致总时长、mvhd/mehd 和 sidx 末段全部偏小。
 * @param {object} mp4boxfile
 * @param {number} trackId
 * @param {Array<object>} samples
 */
function repairLastSampleDuration(mp4boxfile, trackId, samples) {
    const last = samples[samples.length - 1];
    if (!last || last.duration !== 0) return;
    const rawTrak = mp4boxfile.getTrackById(trackId);
    const stts = rawTrak && rawTrak.mdia && rawTrak.mdia.minf &&
        rawTrak.mdia.minf.stbl && rawTrak.mdia.minf.stbl.stts;
    const deltas = stts && Array.isArray(stts.sample_deltas) ? stts.sample_deltas : [];
    for (let i = deltas.length - 1; i >= 0; i--) {
        if (Number.isInteger(deltas[i]) && deltas[i] > 0) {
            last.duration = deltas[i];
            return;
        }
    }
}

/**
 * 探测 .m4s 是否带 Bilibili 的 9 字节 '0' 前缀（读文件头判断，不加载整个文件）
 * @param {number} fd 已打开的文件描述符
 * @param {number} fileSize
 * @returns {number} 需要跳过的字节数
 */
function probeM4sPrefix(fd, fileSize) {
    return biliPrefix.detectPrefixInFd(fd, fileSize);
}

/**
 * 解析单个 M4S 文件，把全部帧读进内存（适合小文件 / 需要随机访问的场景）
 * @param {string} filePath
 * @returns {Promise<object>} TrackSource
 */
function demuxM4s(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (readErr, data) => {
            if (readErr) return reject(readErr);

            // 必须传入 true (keepMdatData = true)，否则在 start() 前解析完的 mdat 帧数据会被丢弃
            const mp4boxfile = MP4Box.createFile(true);
            const collectedSamples = [];
            let droppedSamples = 0;
            let trackInfo = null;
            let stsdEntry = null;
            let cleanBuffer = null;
            let rejectOnce = null;

            mp4boxfile.onError = (err) => {
                reject(new Error(`MP4Box 解析失败 (${filePath}): ${err}`));
            };

            mp4boxfile.onReady = (info) => {
                try {
                    trackInfo = pickTrackInfo(info, filePath);
                } catch (err) {
                    rejectOnce = err;
                    return;
                }
                stsdEntry = getStsdEntry(mp4boxfile, trackInfo.id);
                // 把解码器配置子 Box（avcC / hvcC / av1C / esds / dac3 / dec3 / dfLa 等）
                // 标记为"原样输出源文件字节"，避免 MP4Box 回写时丢字段（如 hvcC 保留位）
                markStsdBoxesFromBuffer(stsdEntry, cleanBuffer);

                // 设置提取所有帧
                mp4boxfile.setExtractionOptions(trackInfo.id, null, {
                    nbSamples: Infinity,
                });
                mp4boxfile.start();
            };

            mp4boxfile.onSamples = (id, user, samples) => {
                for (let i = 0; i < samples.length; i++) {
                    const s = samples[i];
                    // MP4Box 取不到帧数据时给的是 undefined，这里计数后统一报错，
                    // 不再静默丢帧（丢帧会让时长与 Sample 数都对不上）
                    if (!s || !s.data) {
                        droppedSamples++;
                        continue;
                    }

                    // 浅拷贝生成独立对象保存 s.data 引用，防止后续 releaseUsedSamples 原地清空 s.data
                    collectedSamples.push({
                        data: s.data,
                        duration: s.duration,
                        dts: s.dts,
                        cts: s.cts,
                        size: s.size,
                        keyframe: isKeyframeSample(s),
                        nonSync: s.is_sync === false ? 1 : 0,
                        dependsOn: Number.isFinite(s.depends_on) ? s.depends_on : 0,
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

                if (rejectOnce) {
                    return reject(rejectOnce);
                }
                if (!trackInfo) {
                    return reject(new Error(`未能完成 moov 头解析: ${filePath}`));
                }

                // 与索引模式一致的结构性校验：缺省值缺失、trun 计数被夸大
                const defaults = checkFragmentDefaults(mp4boxfile, trackInfo.id);
                if (defaults.length > 0) {
                    return reject(
                        new Error(`分片缺少缺省 Sample 信息: ${filePath}: ${defaults[0]}`)
                    );
                }
                const trunProblem = checkTrunSampleCounts(
                    mp4boxfile,
                    trackInfo.id,
                    collectedSamples.length + droppedSamples
                );
                if (trunProblem) {
                    return reject(
                        new Error(`分片 Sample 数量异常 (${filePath}): ${trunProblem}`)
                    );
                }

                if (collectedSamples.length === 0) {
                    return reject(
                        new Error(`未能提取到有效媒体帧 (sample.data 为空): ${filePath}`)
                    );
                }
                if (droppedSamples > 0) {
                    return reject(
                        new Error(
                            `有 ${droppedSamples} 个 Sample 在数据流中找不到对应的帧数据` +
                                `（共 ${collectedSamples.length + droppedSamples} 个，` +
                                `文件可能被截断或 mdat 缺失）: ${filePath}`
                        )
                    );
                }

                resolve(
                    createTrackSource({
                        trackInfo,
                        stsdEntry,
                        samples: collectedSamples,
                        label: filePath,
                    })
                );
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
 * demuxM4sIndex 只保留偏移，配合流式写盘可以做到内存占用与文件大小无关。
 *
 * @param {string} filePath
 * @returns {Promise<object>} TrackSource（streamed = true，含 readSample / close）
 */
function demuxM4sIndex(filePath) {
    return new Promise((resolve, reject) => {
        let reader;
        try {
            // 报错文案沿用解封装层的说法，Sample 读不满时提示语保持不变
            reader = createFileReader(filePath, { errorLabel: '读取 Sample 失败' });
        } catch (err) {
            return reject(err);
        }

        const fail = (err) => {
            reader.close();
            reject(err);
        };

        try {
            const fileSize = reader.size;
            const prefix = biliPrefix.detectPrefixInReader(reader);
            // fileStart 坐标以去掉前缀后的数据流为 0，Sample 偏移可直接用于 Seek
            const dataStart = prefix;
            const dataSize = fileSize - dataStart;

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
                let chunk;
                try {
                    chunk = reader.read(pos, len);
                } catch (_) {
                    // 文件被截断：停止追加，交给后面的校验给出明确错误
                    break;
                }
                const arrayBuffer = chunk.buffer.slice(
                    chunk.byteOffset,
                    chunk.byteOffset + chunk.length
                );
                arrayBuffer.fileStart = pos - dataStart;
                mp4boxfile.appendBuffer(arrayBuffer);
                if (parseError) break;

                if (!trackInfo) {
                    const info = mp4boxfile.moov ? mp4boxfile.getInfo() : null;
                    if (info && info.tracks && info.tracks.length > 0) {
                        trackInfo = pickTrackInfo(info, filePath);
                        stsdEntry = getStsdEntry(mp4boxfile, trackInfo.id);
                    }
                }
            }
            mp4boxfile.flush();

            if (parseError) return fail(parseError);
            if (!trackInfo) {
                return fail(new Error(`未能完成 moov 头解析: ${filePath}`));
            }

            // 循环里拿到的是 moov 刚解析完时的快照，之后追加的分片还没统计进去；
            // 全部解析完再取一次，轨道上的 nb_samples / duration 才是完整值
            {
                const finalInfo = mp4boxfile.moov ? mp4boxfile.getInfo() : null;
                if (finalInfo && finalInfo.tracks && finalInfo.tracks.length > 0) {
                    trackInfo = pickTrackInfo(finalInfo, filePath);
                }
            }

            // 分片缺省值检查必须在 cleanBuffers() 之前（依赖 moof/traf 结构）
            const defaults = checkFragmentDefaults(mp4boxfile, trackInfo.id);
            if (defaults.length > 0) {
                return fail(
                    new Error(`分片缺少缺省 Sample 信息: ${filePath}: ${defaults[0]}`)
                );
            }

            // 趁输入还没关闭，把解码器配置子 Box（avcC/hvcC/av1C/esds/dfLa 等）
            // 的原始字节读出来并标记为原样输出。
            // MP4Box 只对没有自定义 write() 的 Box 填充 .data，avcC 之类必须自己切。
            if (stsdEntry && Array.isArray(stsdEntry.boxes)) {
                for (const b of stsdEntry.boxes) readBoxPayloadVerbatim(reader, dataStart, b);
            }

            const rawTrak = mp4boxfile.getTrackById(trackInfo.id);
            const rawSamples = (rawTrak && rawTrak.samples) || [];
            if (rawSamples.length === 0) {
                return fail(new Error(`未能提取到有效媒体帧: ${filePath}`));
            }

            // trun.sample_count 被夸大时，MP4Box 会读到 Box 之外的垃圾数据但仍然成功建表
            const trunProblem = checkTrunSampleCounts(
                mp4boxfile,
                trackInfo.id,
                rawSamples.length
            );
            if (trunProblem) {
                return fail(new Error(`分片 Sample 数量异常 (${filePath}): ${trunProblem}`));
            }
            if (
                Number.isInteger(trackInfo.nb_samples) &&
                trackInfo.nb_samples > 0 &&
                trackInfo.nb_samples !== rawSamples.length
            ) {
                return fail(
                    new Error(
                        `轨道声明的 Sample 数 (${trackInfo.nb_samples}) 与实际解析出的数量 ` +
                            `(${rawSamples.length}) 不一致，文件可能不完整: ${filePath}`
                    )
                );
            }

            // 非分片文件（progressive 路径）的末帧 duration 依赖 mdhd.duration，
            // Bilibili 的 m4s 里 mdhd.duration 恒为 0，需要用 stts 末段时长补回
            repairLastSampleDuration(mp4boxfile, trackInfo.id, rawSamples);

            const samples = rawSamples.map(
                (s) => toContractSample(s, () => s.description_index)
            );

            const offsetProblem = checkSampleOffsets(samples, dataSize, filePath);
            if (offsetProblem) {
                return fail(new Error(`Sample 偏移表无效: ${offsetProblem}`));
            }

            // 多 Sample Description 的轨道，配置 Box 要按帧自己的 description_index 取
            if (
                stsdEntry &&
                stsdEntry.boxes &&
                samples.some((s) => s.descriptionIndex > 0)
            ) {
                const firstIndex = samples[0].descriptionIndex;
                if (firstIndex > 0) {
                    stsdEntry = getStsdEntry(mp4boxfile, trackInfo.id, firstIndex);
                }
            }

            const readSample = (sample) => {
                if (reader.closed) throw new Error('M4S 文件已关闭，无法读取 Sample');
                return reader.read(dataStart + sample.offset, sample.size);
            };
            const readSamples = (requestedSamples) => {
                const result = new Array(requestedSamples.length);
                let i = 0;
                while (i < requestedSamples.length) {
                    let end = i + 1;
                    let runSize = requestedSamples[i].size;
                    while (
                        end < requestedSamples.length &&
                        runSize + requestedSamples[end].size <= MAX_BATCH_READ_SIZE &&
                        requestedSamples[end].offset ===
                            requestedSamples[end - 1].offset + requestedSamples[end - 1].size
                    ) {
                        runSize += requestedSamples[end].size;
                        end++;
                    }

                    const run = reader.read(dataStart + requestedSamples[i].offset, runSize);
                    let offset = 0;
                    for (let j = i; j < end; j++) {
                        const size = requestedSamples[j].size;
                        result[j] = run.subarray(offset, offset + size);
                        offset += size;
                    }
                    i = end;
                }
                return result;
            };

            // mp4box 已不再需要底层 Buffer，及时释放
            mp4boxfile.stream.cleanBuffers();

            resolve(
                createTrackSource({
                    trackInfo,
                    stsdEntry,
                    samples,
                    readSample,
                    readSamples,
                    close: reader.close,
                    label: filePath,
                })
            );
        } catch (err) {
            fail(err);
        }
    });
}

module.exports = {
    demuxM4s,
    demuxM4sIndex,
    normalizeM4sBuffer,
    detectM4sPrefix,
    probeM4sPrefix,
    makeBoxVerbatim,
    readBoxPayloadVerbatim,
    M4S_PREFIX_LENGTH,
};
