// media.js
// js-media 的统一调度门面：调用方只依赖这一个模块，不直接 require 底层实现。
//
// 门面只做三件事：选容器 / 选处理路径、调度并行解封装、管理文件句柄生命周期。
// 具体职责分散在：
//   demux-m4s.js    B 站前缀 + MP4Box 解析，产出统一数据契约 TrackSource
//   track-source.js Track Info + Samples 抽象（解封装层与封装层之间唯一的接口约定）
//   mp4.js          Fragmented MP4 封装
//   matroska.js     Matroska (MKV) 封装
//   mp4-audio-reader.js  编解码无关的 MP4 音频解析（m4a / flac 共用）
//   m4a.js          AAC -> M4A 转封装
//   flac.js         FLAC -> 原生 FLAC 转封装
//   file-reader.js / bili-prefix.js / stream-writer.js 公共底座
//
// 音视频合并（走 TrackSource）与纯音频转封装（走 m4a.js / flac.js）是两条独立管线，
// 但对外统一从这里导出，选项语义（title / onProgress / signal）保持一致。
'use strict';

const path = require('path');
const { demuxM4s, demuxM4sIndex } = require('./demux-m4s');
const { muxFragmentedMp4 } = require('./mp4');
const { buildMkvFile } = require('./matroska');
const { m4sToM4a, m4sToM4aBuffer, probeM4sAudio } = require('./m4a');
const { m4sToFlac, m4sToFlacBuffer, probeFlacAudio } = require('./flac');
const { analyzeMp4Audio } = require('./mp4-audio-reader');
const { createFileReader } = require('./file-reader');

/**
 * 并行解复用视频与音频 .m4s，返回两个统一数据契约 TrackSource。
 * 任一路径传 null 表示该轨不存在（纯音频 / 纯视频），对应值为 null。
 * 调用方负责在 finally 里 close()。
 * @param {string|null} videoM4sPath
 * @param {string|null} audioM4sPath
 * @param {(p: string) => Promise<object>} demuxer
 * @returns {Promise<{ video: object|null, audio: object|null }>}
 */
async function demuxPair(videoM4sPath, audioM4sPath, demuxer) {
    const video = videoM4sPath ? demuxer(videoM4sPath) : null;
    const audio = audioM4sPath ? demuxer(audioM4sPath) : null;
    try {
        return { video: await video, audio: await audio };
    } catch (err) {
        // 任意一路失败时，已成功打开的另一路句柄也要释放
        Promise.allSettled([video, audio]).then((results) => {
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value && typeof r.value.close === 'function') {
                    r.value.close();
                }
            }
        });
        throw err;
    }
}

/**
 * 合并 Bilibili 视频 .m4s 和音频 .m4s 为单个 .mp4 文件（分片 MP4，流式落盘）
 * @param {string} videoM4sPath 视频 .m4s 路径
 * @param {string} audioM4sPath 音频 .m4s 路径
 * @param {string} outputMp4Path 输出 .mp4 路径
 * @param {object} [options]
 * @param {(progress: number) => void} [options.onProgress] 进度回调，0~1
 * @param {AbortSignal} [options.signal] 取消信号
 * @returns {Promise<{ outputMp4Path: string, videoSamples: number, audioSamples: number }>}
 */
async function mergeBiliM4s(videoM4sPath, audioM4sPath, outputMp4Path, options = {}) {
    const { onProgress = null, signal = null } = options;
    // 只解析元信息与 Sample 偏移，帧数据在写盘时按需读取（内存占用与文件大小无关）
    const { video, audio } = await demuxPair(videoM4sPath, audioM4sPath, demuxM4sIndex);
    try {
        const result = await muxFragmentedMp4({
            video,
            audio,
            outputPath: outputMp4Path,
            onProgress,
            signal,
        });
        return { outputMp4Path, videoSamples: result.videoSamples, audioSamples: result.audioSamples };
    } finally {
        video.close();
        audio.close();
    }
}

/**
 * 合并 Bilibili 视频/音频 .m4s 并输出 MKV，可选内嵌 SRT / ASS 字幕
 *
 * 全程使用纯 Node.js（mp4box 解复用 + 自实现 Matroska 封装），不依赖 ffmpeg。
 * 选 MKV 而不是 MP4 的原因：MKV 可直接存放 SubRip / ASS 字幕轨（MP4 只能放
 * mov_text，会丢掉 ASS 样式），并且对 FLAC、杜比全景声等音轨兼容性更好。
 *
 * videoM4sPath 传 null 即输出「纯音频 mkv」，audioM4sPath 传 null 即纯视频。
 *
 * @param {string|null} videoM4sPath 视频 .m4s 路径（纯音频时传 null）
 * @param {string|null} audioM4sPath 音频 .m4s 路径
 * @param {string} outputMkvPath 输出 .mkv 路径
 * @param {object} [options]
 * @param {string} [options.subtitlePath] 字幕文件路径，支持 .srt / .ass / .ssa
 * @param {string} [options.subtitleTitle] 字幕轨名称，默认 "字幕"
 * @param {string} [options.subtitleLanguage] 字幕轨语言代码，默认 "chi"
 * @param {boolean} [options.subtitleDefault] 是否标记为默认字幕轨，默认 true
 * @param {string} [options.title] 文件标题元数据
 * @param {(progress: number) => void} [options.onProgress] 进度回调，0~1
 * @param {AbortSignal} [options.signal] 取消信号
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
        signal = null,
    } = options;

    if (!videoM4sPath && !audioM4sPath) {
        throw new Error('mergeBiliM4sToMkv 需要至少一路 .m4s 输入');
    }

    const { video, audio } = await demuxPair(videoM4sPath, audioM4sPath, demuxM4sIndex);

    try {
        await buildMkvFile({
            video,
            audio,
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
            signal,
        });
    } finally {
        if (video) video.close();
        if (audio) audio.close();
    }

    return {
        outputMkvPath,
        subtitleEmbedded: Boolean(subtitlePath),
        videoSamples: video ? video.samples.length : 0,
        audioSamples: audio ? audio.samples.length : 0,
    };
}

/**
 * 按输出文件扩展名自动选择容器：.mkv 走 Matroska 封装，其余走 MP4 分片封装
 *
 * @param {string} videoM4sPath 视频 .m4s 路径
 * @param {string} audioM4sPath 音频 .m4s 路径
 * @param {string} outputPath 输出路径，扩展名决定容器
 * @param {object} [options] 传给具体封装的选项（title / subtitlePath / onProgress / signal 等）
 */
async function mergeBiliM4sToFile(videoM4sPath, audioM4sPath, outputPath, options = {}) {
    if (path.extname(outputPath).toLowerCase() === '.mkv') {
        return mergeBiliM4sToMkv(videoM4sPath, audioM4sPath, outputPath, options);
    }

    return mergeBiliM4s(videoM4sPath, audioM4sPath, outputPath, options);
}

// ================== 纯音频转封装 ==================

// 各输出容器能承接的音频编码。js-media 只做"搬运不重编码"，
// 所以这里列的都是能原样塞进目标容器的编码，其余由调用方报错处理（纯 JS 版本无 ffmpeg 兜底）。
const AUDIO_OUTPUT_CODECS = {
    '.m4a': ['mp4a'],
    '.flac': ['fLaC'],
    // 纯音频 MKV：Matroska 对样本容器几乎没有约束，AAC/FLAC/E-AC3/Opus/ALAC 都能直接封装
    '.mkv': ['mp4a', 'flac', 'fLaC', 'ec-3', 'ac-3', 'opus', 'alac'],
};

/** 探测编码时用的解析参数：不同容器对编码的要求不同 */
const PROBE_OPTIONS = {
    '.m4a': { supportedCodecs: ['mp4a'], requireEsds: true, codecLabel: 'AAC（mp4a）', errorSubject: 'M4A 转封装' },
    '.flac': { supportedCodecs: ['fLaC'], requireEsds: false, codecLabel: 'FLAC（fLaC）', errorSubject: 'FLAC 转封装' },
    // 纯音频 MKV 先只探测不写文件，放宽到全部受支持编码
    '.mkv': {
        supportedCodecs: ['mp4a', 'flac', 'fLaC', 'ec-3', 'ac-3', 'opus', 'alac'],
        requireEsds: false,
        codecLabel: 'AAC/FLAC/E-AC3/AC-3/Opus/ALAC',
        errorSubject: 'MKV 音频封装',
    },
};

/** 归一化编码名：fLaC（MP4 Sample Entry）与 flac（Matroska codec 前缀）视为同一种 */
function normalizeCodec(codec) {
    const c = String(codec || '').toLowerCase();
    return c === 'flac' ? 'flac' : c;
}

/**
 * 把 Bilibili 音频 .m4s 转封装为标准音频文件（不合并视频）
 *
 * 支持的输出容器由 AUDIO_OUTPUT_CODECS 决定：.m4a（AAC）、.flac（原生 FLAC）、
 * .mkv（纯音频 Matroska）。其余扩展名一律抛 ERR_UNSUPPORTED_OUTPUT_FORMAT，
 * 由调用方决定如何提示用户 —— 门面不替调用方做"偷偷换实现"的选择。
 *
 * 输入编码与目标容器不匹配时抛 ERR_UNSUPPORTED_AUDIO_CODEC。
 *
 * @param {string} audioM4sPath 输入 .m4s 路径
 * @param {string} outputPath 输出路径，扩展名决定容器
 * @param {object} [options]
 * @param {(progress: number) => void} [options.onProgress] 进度回调，0~1
 * @param {AbortSignal} [options.signal] 取消信号，中止时抛「转封装已取消」
 * @param {boolean} [options.keepMetadata] 是否复制源元数据（仅 .m4a），默认 true
 * @param {string} [options.title] 容器标题（仅 .mkv）
 * @returns {Promise<object>} 转封装结果（时长、采样率、样本数、写入字节数等）
 */
async function convertBiliM4sAudio(audioM4sPath, outputPath, options = {}) {
    const ext = path.extname(outputPath).toLowerCase();
    if (!AUDIO_OUTPUT_CODECS[ext]) {
        const err = new Error(
            `js-media 只支持把音频转封装为 ${Object.keys(AUDIO_OUTPUT_CODECS).join(' / ')}，收到 ${ext || '无扩展名'}：${outputPath}`
        );
        err.code = 'ERR_UNSUPPORTED_OUTPUT_FORMAT';
        throw err;
    }

    try {
        if (ext === '.flac') return await m4sToFlac(audioM4sPath, outputPath, options);
        if (ext === '.mkv') {
            return await mergeBiliM4sToMkv(null, audioM4sPath, outputPath, options);
        }
        return await m4sToM4a(audioM4sPath, outputPath, options);
    } catch (err) {
        throw tagCodecError(err);
    }
}

/**
 * 内存版纯音频转封装：输入 Buffer，返回完整音频 Buffer
 *
 * @param {Buffer|Uint8Array} input
 * @param {object} [options]
 * @param {string} [options.format] 输出容器对应的扩展名，默认 '.m4a'
 * @param {boolean} [options.keepMetadata] 是否复制源元数据（仅 .m4a）
 * @returns {object} { buffer, ...结果信息 }
 */
function convertBiliM4sAudioBuffer(input, options = {}) {
    const { format = '.m4a', ...rest } = options;
    const ext = String(format).toLowerCase();
    try {
        if (ext === '.flac') return m4sToFlacBuffer(input, rest);
        if (ext === '.mkv') {
            const err = new Error('纯音频 MKV 需要落盘，不支持内存版转封装');
            err.code = 'ERR_UNSUPPORTED_OUTPUT_FORMAT';
            throw err;
        }
        return m4sToM4aBuffer(input, rest);
    } catch (err) {
        throw tagCodecError(err);
    }
}

/** m4a.js / flac.js 用文案表达"编码不受支持"，门面统一补上可判定的 code */
function tagCodecError(err) {
    if (!err || err.code) return err;
    if (/不支持的音频编码|缺少 esds|缺少 dfLa|没有合法的 STREAMINFO/.test(err.message || '')) {
        err.code = 'ERR_UNSUPPORTED_AUDIO_CODEC';
    }
    return err;
}

/**
 * 判断某个音频 .m4s 能否由 js-media 转封装成目标格式（不写任何文件）
 *
 * 调用方据此决定能否转封装 —— 只看输出扩展名是不够的，
 * 因为同一容器能装的编码也不止一种。探测本身失败时返回 supported:false
 * 而不是抛出，方便调用方直接分支。
 *
 * @param {string} inputPath 音频 .m4s 路径
 * @param {string} outputPath 期望的输出路径
 * @returns {{ supported: boolean, reason?: string, codec?: string }}
 */
function checkAudioConversion(inputPath, outputPath) {
    const ext = path.extname(outputPath).toLowerCase();
    const allowed = AUDIO_OUTPUT_CODECS[ext];
    if (!allowed) {
        return {
            supported: false,
            reason: `js-media 不支持输出 ${ext || '无扩展名'} 音频`,
        };
    }

    let info;
    try {
        // 只做解析不写文件：走各容器自己的探测口，失败时从文案里取回编码名
        info = ext === '.flac'
            ? probeFlacAudio(inputPath)
            : ext === '.mkv'
                ? probeAudioCodecWithReader(inputPath, PROBE_OPTIONS['.mkv'])
                : probeM4sAudio(inputPath);
    } catch (err) {
        const m = /不支持的音频编码 '([^']+)'/.exec(err.message || '');
        if (m) {
            return {
                supported: false,
                codec: m[1],
                reason: `音频编码 ${m[1]} 无法转封装为 ${ext}，js-media 的 ${ext} 只支持 ${allowed.join('/')}`,
            };
        }
        return { supported: false, reason: `无法解析音频轨道：${err.message}` };
    }

    const codec = normalizeCodec(info.codec);
    if (!allowed.map(normalizeCodec).includes(codec)) {
        return {
            supported: false,
            codec: info.codec,
            reason: `音频编码 ${info.codec} 无法转封装为 ${ext}，js-media 的 ${ext} 只支持 ${allowed.join('/')}`,
        };
    }
    return { supported: true, codec: info.codec };
}

/**
 * 用共享解析器探测音频编码（供纯音频 MKV 这类"容器宽、编码多"的场景）
 * @param {string} inputPath
 * @param {object} probeOptions analyzeMp4Audio 的选项
 */
function probeAudioCodecWithReader(inputPath, probeOptions) {
    const reader = createFileReader(inputPath);
    try {
        const source = analyzeMp4Audio(reader, probeOptions);
        return { codec: source.codec, sampleRate: source.sampleRate, channelCount: source.channelCount };
    } finally {
        reader.close();
    }
}

/**
 * 只读取音频 .m4s 的编码名（MP4 Sample Entry 类型），不写任何文件
 *
 * 供调用方判断容器兼容性使用（如 FLAC / 杜比全景声是否要改用 MKV）。
 * 解析失败时返回空字符串，让调用方按"未知编码"处理，而不是中断任务。
 *
 * @param {string} inputPath 音频 .m4s 路径
 * @returns {string} 编码名（'mp4a' / 'fLaC' / 'ec-3' …），失败为 ''
 */
function probeAudioCodec(inputPath) {
    try {
        return probeAudioCodecWithReader(inputPath, PROBE_OPTIONS['.mkv']).codec || '';
    } catch (err) {
        // 编码不在放行列表里时，解析器会把 Sample Entry 类型写进报错文案，直接取回
        const m = /不支持的音频编码 '([^']+)'/.exec(err.message || '');
        if (m) return m[1];
        console.warn(`[js-media] 音频编码探测失败: ${inputPath}`, err.message);
        return '';
    }
}

module.exports = {
    mergeBiliM4s,
    mergeBiliM4sToMkv,
    mergeBiliM4sToFile,
    convertBiliM4sAudio,
    convertBiliM4sAudioBuffer,
    checkAudioConversion,
    probeAudioCodec,
    // 解封装层单独导出，便于只读取轨道信息的场景复用
    demuxM4s,
    demuxM4sIndex,
    // 底层实现按需导出：新代码应优先使用上面的门面函数
    m4sToM4a,
    m4sToM4aBuffer,
    probeM4sAudio,
    m4sToFlac,
    m4sToFlacBuffer,
    probeFlacAudio,
};
