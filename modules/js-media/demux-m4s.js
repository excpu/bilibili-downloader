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
    box.data = payload;
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
function getStsdEntry(mp4boxfile, trackId) {
    const rawTrak = mp4boxfile.getTrackById(trackId);
    const stbl =
        rawTrak && rawTrak.mdia && rawTrak.mdia.minf && rawTrak.mdia.minf.stbl;
    if (stbl && stbl.stsd && stbl.stsd.entries && stbl.stsd.entries.length > 0) {
        return stbl.stsd.entries[0];
    }
    return null;
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
                    if (!s || !s.data) continue;

                    // 浅拷贝生成独立对象保存 s.data 引用，防止后续 releaseUsedSamples 原地清空 s.data
                    collectedSamples.push({
                        data: s.data,
                        duration: s.duration,
                        dts: s.dts,
                        cts: s.cts,
                        keyframe: s.is_sync,
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
                    // 文件被截断：停止追加，交给后面的 moov 校验给出明确错误
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
                        trackInfo = info.tracks[0];
                        stsdEntry = getStsdEntry(mp4boxfile, trackInfo.id);
                    }
                }
            }
            mp4boxfile.flush();

            if (parseError) return fail(parseError);
            if (!trackInfo) {
                return fail(new Error(`未能完成 moov 头解析: ${filePath}`));
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

            const readSample = (sample) => {
                if (reader.closed) throw new Error('M4S 文件已关闭，无法读取 Sample');
                return reader.read(dataStart + sample.offset, sample.size);
            };

            // mp4box 已不再需要底层 Buffer，及时释放
            mp4boxfile.stream.cleanBuffers();

            resolve(
                createTrackSource({
                    trackInfo,
                    stsdEntry,
                    samples: rawSamples,
                    readSample,
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
