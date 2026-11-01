// track-source.js
// 解封装层（demux-m4s.js）与封装层（mp4.js / matroska.js）之间唯一的接口约定，
// 也就是"统一数据契约"：Track Info + Samples 抽象。
//
// 封装器只依赖这里产出的 TrackSource，不关心帧数据是来自内存还是源文件、
// 也不关心它来自哪一种解封装实现，从而让 MP4 / MKV 两条封装路径互不影响。
//
// TrackSource 结构：
//   {
//     label,                        出错信息里显示的数据来源
//     trackInfo,                    MP4Box getInfo().tracks[0]（原样透传）
//     stsdEntry,                    原始 Sample Entry Box，其配置子 Box 已标记"原样输出"
//     timescale, codec, codecSubtype,
//     samples: [ { dts, cts, duration, size, keyframe, nonSync, dependsOn,
//                  offset?, data? } ],
//     streamed,                     true = 帧数据不在内存里，必须用 readSample() 取
//     readSample(sample) => Buffer, 取某一帧的原始字节（两种模式都可用）
//     sampleBytes(sample) => Buffer,取任意契约内 Sample 的字节
//     durationUnits(),              最后一帧的结束时间（以 timescale 为单位）
//     close(),                      释放底层资源（文件句柄等），可重复调用
//   }
'use strict';

/** MP4Box 的 Box 载荷（Uint8Array / Buffer 混合）统一成 Buffer */
function boxPayloadBytes(box) {
    if (!box || !box.data || box.data.length === 0) return null;
    const d = box.data;
    return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
}

/** 从 stsd 的 Sample Entry 中取指定类型的解码器配置 Box（avcC/hvcC/av1C/esds/dfLa/...） */
function findStsdBox(stsdEntry, type) {
    if (!stsdEntry) return null;
    const boxes = Array.isArray(stsdEntry.boxes) ? stsdEntry.boxes : [];
    return boxes.find((b) => b && b.type === type) || stsdEntry[type] || null;
}

/** 取指定类型解码器配置 Box 的原始字节 */
function stsdBoxPayload(stsdEntry, type) {
    return boxPayloadBytes(findStsdBox(stsdEntry, type));
}

/** Sample 的字节（内存模式取 data，流式模式调用 read()），并校验长度 */
function sampleBytes(sample) {
    let data;
    if (sample.data) data = toBuffer(sample.data);
    else if (typeof sample.read === 'function') data = sample.read();
    else throw new Error('Sample 既没有 data 也没有 read()');
    if (Number.isFinite(sample.size) && data.length !== sample.size) {
        throw new Error(`Sample 长度不一致: 期望 ${sample.size}，实际 ${data.length}`);
    }
    return data;
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

const UINT32_MAX = 0xffffffff;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/** MP4 里除 tfdt 外几乎所有数值字段都是 32 位，越界要提前报错而不是让写盘抛 RangeError */
function checkUint32(value, name, label, index) {
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的 ${name} 超出 32 位无符号范围: ${value}`
        );
    }
}

function normalizeSample(raw, label, index) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`TrackSource(${label}): 第 ${index} 个 Sample 无效`);
    }
    const dts = Number.isFinite(raw.dts) ? raw.dts : 0;
    const cts = Number.isFinite(raw.cts) ? raw.cts : dts;
    const duration = Number.isFinite(raw.duration) ? raw.duration : 0;
    const data = raw.data || null;
    const size = Number.isFinite(raw.size) ? raw.size : data ? data.length : NaN;
    // ffmpeg 的 mov_read_trun 对 size == 0 的 Sample 直接判为非法数据，
    // 否则多个零长度 Sample 会共用同一个 offset，读出来的字节属于别的帧
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的 size 无效 (size=${size})，` +
                '分片信息（trun）可能被截断或计数被夸大'
        );
    }
    if (!Number.isInteger(dts) || !Number.isInteger(cts) || !Number.isInteger(duration)) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的时间戳不是整数 ` +
                `(dts=${raw.dts}, cts=${raw.cts}, duration=${raw.duration})`
        );
    }
    if (duration < 0) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的 duration 为负数: ${duration}`
        );
    }
    // 下面三项都会被 mp4.js 用 writeUInt32BE / writeInt32BE 原样写出
    checkUint32(duration, 'duration', label, index);
    checkUint32(size, 'size', label, index);
    const ctsOffset = cts - dts;
    if (ctsOffset < INT32_MIN || ctsOffset > INT32_MAX) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的合成时间偏移 (cts - dts) 超出 ` +
                `32 位有符号范围: ${ctsOffset}（cts=${cts}, dts=${dts}）。` +
                '常见于 trun version 0 把无符号偏移当成了有符号值'
        );
    }
    // tfdt 用 64 位写 baseDts，但 JS 只在 2^53 以内精确
    if (Math.abs(dts) > Number.MAX_SAFE_INTEGER) {
        throw new Error(
            `TrackSource(${label}): 第 ${index} 个 Sample 的 dts 超出安全整数范围: ${dts}`
        );
    }

    // 关键帧判定同时看 non_sync 与 depends_on（对齐 ffmpeg 的
    // !(MOV_FRAG_SAMPLE_FLAG_IS_NON_SYNC | MOV_FRAG_SAMPLE_FLAG_DEPENDS_YES)），
    // open GOP 里依赖后续帧的 IDR 不能当作随机访问点
    const nonSync = Number.isFinite(raw.nonSync) ? raw.nonSync : raw.is_sync === false ? 1 : 0;
    const dependsOn = Number.isFinite(raw.dependsOn) ? raw.dependsOn : 0;
    const keyframe = raw.keyframe !== undefined
        ? Boolean(raw.keyframe)
        : raw.is_sync !== false && (dependsOn & 1) === 0;

    const sample = { dts, cts, duration, size, keyframe, nonSync, dependsOn };
    // 流式模式记录源文件偏移，内存模式直接带上帧数据
    if (Number.isFinite(raw.offset)) sample.offset = raw.offset;
    if (data) sample.data = data;
    return sample;
}

/**
 * 把解封装结果包装成契约对象，并做一次性校验 / 归一化
 * @param {object} params
 * @param {object} params.trackInfo MP4Box 轨道信息
 * @param {object|null} [params.stsdEntry] 原始 Sample Entry
 * @param {Array<object>} params.samples 帧列表
 * @param {(sample: object) => Buffer} [params.readSample] 流式读取器
 * @param {() => void} [params.close] 资源释放
 * @param {string} [params.label] 出错信息里的数据来源
 * @returns {object} TrackSource
 */
function createTrackSource({
    trackInfo,
    stsdEntry = null,
    samples,
    readSample = null,
    close = null,
    label = 'unknown',
}) {
    if (!trackInfo || !Number.isFinite(trackInfo.timescale)) {
        throw new Error(`TrackSource(${label}): 缺少有效的轨道信息 (trackInfo.timescale)`);
    }
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new Error(`TrackSource(${label}): 未能提取到有效媒体帧`);
    }

    const normalized = samples.map((s, i) => normalizeSample(s, label, i));
    const streamed = typeof readSample === 'function';

    const source = {
        label,
        trackInfo,
        stsdEntry,
        timescale: trackInfo.timescale,
        codec: trackInfo.codec,
        codecSubtype: String(trackInfo.codec || '').split('.')[0],
        samples: normalized,
        streamed,

        // 显式绑定，方便封装器把 readSample 当普通函数传递（如 writeFragments 的参数）
        readSample: (sample) => {
            if (streamed) return readSample(sample);
            if (sample && sample.data) return toBuffer(sample.data);
            throw new Error(`TrackSource(${label}): Sample 缺少 data，无法读取帧数据`);
        },

        sampleBytes: (sample) => {
            if (sample && (sample.data || typeof sample.read === 'function')) {
                return sampleBytes(sample);
            }
            return source.readSample(sample);
        },

        durationUnits() {
            let end = 0;
            for (const s of normalized) {
                end = Math.max(end, s.dts + s.duration);
            }
            return end;
        },

        close() {
            if (typeof close === 'function') close();
        },
    };

    Object.defineProperty(source, 'sampleCount', {
        value: normalized.length,
        enumerable: true,
    });

    return source;
}

module.exports = {
    createTrackSource,
    sampleBytes,
    toBuffer,
    boxPayloadBytes,
    findStsdBox,
    stsdBoxPayload,
};
