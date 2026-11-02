'use strict';
/**
 * js-media 回归检查（无测试框架，直接 node 运行；package.json 里 `npm test`）
 *
 * 覆盖五块：
 *   1. 配置 Box 字节一致性（avcC 回归）
 *      mp4box 的 DataStream.writeUint8Array 在 memcpy 快路径里源地址固定取
 *      array.buffer 的偏移 0，完全忽略 array.byteOffset；而我们的载荷是 Node
 *      内存池上的 Buffer 视图，导致写出的 avcC 变成内存池开头的无关字节
 *      （甚至是一整段 Bilibili CDN 的 JSON），解码器报
 *      "No start code is found / Error splitting the input into NAL units /
 *      unspecified pixel format"。仓库里没有 H.264 的 .m4s 样例，
 *      所以这里用合成夹具把这个行为锁死。
 *   2. 真实样例解封装：test/test-media 下的编码矩阵
  *      AV1 / AVC / HEVC 视频，杜比视界（HEVC 基础层 + dvvC）视频，
 *      AAC / E-AC-3（5.1 杜比全景声）/ FLAC 音频，
 *      校验编码串、样本数、关键帧数、dependsOn、时间基、解码器配置 Box。
 *   3. 封装正确性：每一对样例分别封装成 MP4 与 MKV，再用 test/verify 下的
 *      ffprobe / ffmpeg 校验 ——
 *      流的编码 / 分辨率 / 像素格式 / 声道 / 采样率与源一致；
 *      包数与解封装出的样本数一致；
 *      streamhash 与源逐字节相同（证明只封装不重编码）；
 *      `ffmpeg -f null -` 全量解码无错误输出；
  *      杜比视界的 SampleEntry 标记与 DOVI 配置记录在两种容器里都保留。
 *   4. 纯音频转封装：AAC / E-AC-3 / FLAC 到 m4a / mkv / flac 的支持矩阵与产物校验。
 *   5. 对照解封装边界行为的用例：nonSync、open GOP、trun 计数被夸大、
 *      高位无符号 cts、文件被截断。
 *
 * test/verify 下缺少 ffmpeg / ffprobe 时，第 3、4 块里依赖外部工具的校验记为 SKIP，
 * 其余用例照常执行。
 *
 * 约定：全部通过时退出码 0，任何一项失败为非 0。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const demux = require(path.join(ROOT, 'modules/js-media/demux-m4s'));
const { muxFragmentedMp4 } = require(path.join(ROOT, 'modules/js-media/mp4'));
const { audioTrackParams } = require(path.join(ROOT, 'modules/js-media/track-source'));
const {
    mergeBiliM4sToFile,
    convertBiliM4sAudio,
    checkAudioConversion,
} = require(path.join(ROOT, 'modules/js-media/media'));

const MEDIA_DIR = path.join(__dirname, 'test-media');
const OUTPUT_DIR = path.join(__dirname, 'test-output');
const FFPROBE = path.join(__dirname, 'verify', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const FFMPEG = path.join(__dirname, 'verify', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
/** test/verify 里的校验工具齐全时才跑外部校验 */
const hasVerifier = fs.existsSync(FFPROBE) && fs.existsSync(FFMPEG);

/**
 * 真实样例矩阵。所有期望值都是从样例本身量出来的，改动样例时必须同步更新。
 * 视频 dependsOn 用集合比较：'hvc1' / 'avc1' 这类样例混有 1（open GOP）与 2（非同步点）。
 */
const FIXTURES = [
    {
        label: 'AV1 + AAC',
        video: 'video-av01.m4s',
        audio: 'audio-aac.m4s',
        videoCodec: 'av01.0.05M.08',
        videoSubtype: 'av01',
        videoBoxes: ['av1C'],
        width: 1364,
        height: 720,
        videoTimescale: 16000,
        videoSamples: 3820,
        videoKeyframes: 31,
        videoDependsOn: [0],
        audioCodec: 'mp4a.40.2',
        audioSubtype: 'mp4a',
        audioBoxes: ['esds'],
        audioTimescale: 48000,
        audioSamples: 7164,
        audioKeyframes: 7164,
        audioDependsOn: [2],
        audioChannels: 2,
        audioLayout: 'stereo',
        durationSeconds: 152.8,
    },
    {
        label: 'AVC + AAC',
        video: 'video-avc.m4s',
        audio: 'audio-aac.m4s',
        videoCodec: 'avc1.640028',
        videoSubtype: 'avc1',
        videoBoxes: ['avcC'],
        width: 1364,
        height: 720,
        videoTimescale: 16000,
        videoSamples: 3820,
        videoKeyframes: 31,
        videoDependsOn: [0],
        audioCodec: 'mp4a.40.2',
        audioSubtype: 'mp4a',
        audioBoxes: ['esds'],
        audioTimescale: 48000,
        audioSamples: 7164,
        audioKeyframes: 7164,
        audioDependsOn: [2],
        audioChannels: 2,
        audioLayout: 'stereo',
        durationSeconds: 152.8,
    },
    {
        label: 'HEVC + AAC',
        video: 'video-hevc.m4s',
        audio: 'audio-aac.m4s',
        videoCodec: 'hev1.1.6.L120.90',
        videoSubtype: 'hev1',
        videoBoxes: ['hvcC'],
        width: 1364,
        height: 720,
        videoTimescale: 16000,
        videoSamples: 3821,
        videoKeyframes: 31,
        videoDependsOn: [0],
        audioCodec: 'mp4a.40.2',
        audioSubtype: 'mp4a',
        audioBoxes: ['esds'],
        audioTimescale: 48000,
        audioSamples: 7164,
        audioKeyframes: 7164,
        audioDependsOn: [2],
        audioChannels: 2,
        audioLayout: 'stereo',
        durationSeconds: 152.84,
    },
    {
            // 杜比视界 profile 8：基础层仍是 HEVC，SampleEntry 用 hvc1（不是 dvh1），
            // 杜比视界信息放在 stsd 的 dvvC（不是 dvcC）里。
            label: '杜比视界 + 杜比全景声',
            video: 'dolby/video.m4s',
            audio: 'dolby/audio.m4s',
            videoCodec: 'hvc1.2.4.L153.90',
            videoSubtype: 'hvc1',
            videoBoxes: ['pasp', 'hvcC', 'dvvC'],
            width: 3840,
            height: 2160,
            videoTimescale: 60,
            videoSamples: 3372,
            videoKeyframes: 12,
            videoDependsOn: [1, 2],
            dolbyVisionBox: 'dvvC',
            audioCodec: 'ec-3',
            audioSubtype: 'ec-3',
            audioBoxes: ['dec3'],
            audioTimescale: 48000,
            audioSamples: 1756,
            audioKeyframes: 1756,
            audioDependsOn: [2],
            // dec3 里是 5.1：MP4Box 的 info.audio.channel_count 只报 2，必须从配置 Box 里解
            audioChannels: 6,
            audioLayout: '5.1(side)',
            durationSeconds: 56.2,
            audioDurationSeconds: 56.192,
        },
    {
        label: 'AVC + FLAC',
        video: 'flac/video.m4s',
        audio: 'flac/audio.m4s',
        videoCodec: 'avc1.64001f',
        videoSubtype: 'avc1',
        videoBoxes: ['avcC', 'pasp'],
        width: 854,
        height: 450,
        videoTimescale: 16000,
        videoSamples: 5620,
        videoKeyframes: 45,
        videoDependsOn: [1, 2],
        audioCodec: 'fLaC',
        audioSubtype: 'fLaC',
        audioBoxes: ['dfLa'],
        audioTimescale: 48000,
        audioSamples: 2342,
        audioKeyframes: 2342,
        audioDependsOn: [2],
        audioChannels: 2,
        audioLayout: 'stereo',
        durationSeconds: 224.8,
    },
];

/** 矩阵里出现过的轨道类型，供「纯音频转封装」用例使用 */
const AAC_AUDIO = 'audio-aac.m4s';
const DOLBY_AUDIO = 'dolby/audio.m4s';
const FLAC_AUDIO = 'flac/audio.m4s';

const VIDEO_FIXTURE = path.join(MEDIA_DIR, FIXTURES[0].video);
const AUDIO_FIXTURE = path.join(MEDIA_DIR, FIXTURES[0].audio);

/* ------------------------------------------------------------------ 断言 */

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name, cond, extra) {
    if (cond) {
        pass++;
        console.log('  PASS ' + name);
    } else {
        fail++;
        console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
    }
}
function skipped(name, why) {
    skip++;
    console.log('  SKIP ' + name + (why ? ' :: ' + why : ''));
}
async function throws(name, fn, substr) {
    try {
        await fn();
        fail++;
        console.log('  FAIL ' + name + '（期望抛错，实际成功）');
    } catch (e) {
        const msg = String((e && e.message) || e);
        if (!substr || msg.includes(substr)) {
            pass++;
            console.log('  PASS ' + name + ' -> ' + msg.slice(0, 80));
        } else {
            fail++;
            console.log('  FAIL ' + name + '（错误信息不符）-> ' + msg);
        }
    }
}

/* ------------------------------------------------------ ffprobe / ffmpeg */

/** ffprobe 读取流的完整信息（含 side_data_list），失败时返回 null */
function probeStreams(filePath) {
    const res = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], {
        encoding: 'utf8',
        maxBuffer: 32 << 20,
    });
    if (res.status !== 0 || !res.stdout) return null;
    try {
        return JSON.parse(res.stdout);
    } catch (_) {
        return null;
    }
}

/**
 * 用 ffprobe 统计每个流的包数，返回 { video: n, audio: n }
 * `-count_packets` 需要完整读一遍，但只解析包头，样例量级下仍是秒级。
 */
function countPackets(filePath) {
    const res = spawnSync(
        FFPROBE,
        ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets', '-of', 'json', filePath],
        { encoding: 'utf8', maxBuffer: 32 << 20 }
    );
    if (res.status !== 0 || !res.stdout) return null;
    try {
        const counts = {};
        for (const s of JSON.parse(res.stdout).streams || []) {
            const n = Number(s.nb_read_packets);
            if (Number.isFinite(n)) counts[s.codec_type] = n;
        }
        return counts;
    } catch (_) {
        return null;
    }
}

/**
 * ffmpeg 计算某条流的 MD5（只 remux 不重编码）。
 * 源与产物哈希相同即证明封装过程逐字节搬运了帧数据。
 */
function streamHash(filePath, map) {
    const res = spawnSync(FFMPEG, ['-v', 'error', '-i', filePath, '-map', map, '-c', 'copy',
        '-f', 'streamhash', '-hash', 'md5', '-'], { encoding: 'utf8', maxBuffer: 32 << 20 });
    if (res.status !== 0) return null;
    const line = String(res.stdout || '').split(/\r?\n/).find((l) => /^\d+,/.test(l.trim()));
    if (!line) return null;
    // 行格式：index, size, md5[, extra...]，取第 3 列
    return line.split(',')[2].trim();
}

/** 全量解码一遍，返回 { ok, stderr }。解码报错会出现在 stderr 上 */
function decodeCheck(filePath) {
    const res = spawnSync(FFMPEG, ['-v', 'error', '-i', filePath, '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 32 << 20 });
    return { ok: res.status === 0, stderr: String(res.stderr || '').trim() };
}

/** 从 ffprobe 输出里按类型取第一条流 */
function firstStream(probed, type) {
    if (!probed || !Array.isArray(probed.streams)) return null;
    return probed.streams.find((s) => s.codec_type === type) || null;
}

/** 杜比视界配置记录（ffprobe 的 side_data） */
function dolbyVisionSideData(stream) {
    const list = (stream && stream.side_data_list) || [];
    return list.find((d) => d.side_data_type === 'DOVI configuration record') || null;
}

/* ------------------------------------------------------------ Box 构造 */

const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff, 0); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
const fourcc = (s) => Buffer.from(s, 'latin1');

/** 普通 Box：size(4) + type(4) + body */
function box(type, ...payload) {
    const body = Buffer.concat(payload);
    return Buffer.concat([u32(body.length + 8), fourcc(type), body]);
}

/** FullBox：在 Box 头之后多 4 字节 version/flags */
function fb(type, version, flags, ...payload) {
    const vf = Buffer.alloc(4);
    vf.writeUInt8(version & 0xff, 0);
    vf.writeUInt8((flags >> 16) & 0xff, 1);
    vf.writeUInt8((flags >> 8) & 0xff, 2);
    vf.writeUInt8(flags & 0xff, 3);
    const body = Buffer.concat([vf, ...payload]);
    return Buffer.concat([u32(body.length + 8), fourcc(type), body]);
}

const MATRIX = Buffer.concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
]);

/** 合法的 H.264 解码配置记录：profile 0x4d / level 0x1f，1 个 SPS + 1 个 PPS */
const AVC_CONFIG = Buffer.concat([
    u8(1), u8(0x4d), u8(0x00), u8(0x1f), // configVersion / profile / compat / level
    u8(0xff),                            // reserved + lengthSizeMinusOne = 3
    u8(0xe1),                            // reserved + numSPS = 1
    u16(12), Buffer.from([0x67, 0x4d, 0x00, 0x1f, 0x96, 0x35, 0x05, 0x01, 0x1e, 0x8c, 0x77, 0xa0]),
    u8(1),                               // numPPS
    u16(6), Buffer.from([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0x58]),
]);

/** Bilibili 的 url Box 常带一段 JSON 载荷（flags=0，非 self-contained） */
const BILI_URL_JSON = '{"url":"https://upos-sz-mirroralix.bilibili.com/upgcxcode/12/34/abc/abc-1-307.m4s"}';

/**
 * 构造「单分片、仅视频轨」的完整分片 MP4。
 * @param {object} o
 * @param {number} o.sampleCount 实际写出的样本数
 * @param {number} [o.trunDeclaredCount] trun 里声明的样本数（构造被夸大的计数）
 * @param {boolean} [o.nonSync] 样本 sample_flags 带 depends_on=2（非同步点）
 * @param {boolean} [o.dependsYes] 样本 sample_flags 带 depends_on=1（open GOP）
 * @param {boolean} [o.ctsHighBit] 首个样本 composition_time = 0xFFFFFFFF
 * @param {number} [o.timescale]
 * @param {number} [o.sampleDur]
 * @param {number} [o.sampleSize]
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @param {Buffer[]} [o.extraChildren] avc1 里额外的配置子 Box（colr/pasp/btrt）
 * @param {Buffer} [o.urlBox] dref 里的 url Box（模拟带 JSON 载荷的情况）
 */
function buildFragmented(o) {
    const ts = o.timescale || 1000;
    const N = o.sampleCount;
    const declared = o.trunDeclaredCount != null ? o.trunDeclaredCount : N;
    const dur = o.sampleDur || 100;
    const sampleSize = o.sampleSize || 10;
    const width = o.width || 320;
    const height = o.height || 240;

    const ftyp = box('ftyp', fourcc('iso4'), u32(0x200), fourcc('iso4'), fourcc('dash'));

    // VisualSampleEntry: reserved(6) + dref(2) + pre_defined(2) + reserved(2)
    // + reserved(12) + width(2) + height(2) + horiz/vertresolution(8) + reserved(4)
    // + frame_count(2) + compressorname(32) + depth(2) + pre_defined(2)
    const avc1 = box('avc1',
        Buffer.alloc(6), u16(1),                          // reserved / data_reference_index
        u16(0), u16(0),                                   // pre_defined / reserved
        Buffer.alloc(12),                                 // reserved(12)
        u16(width), u16(height),
        u32(0x00480000), u32(0x00480000), u32(0),         // 72dpi 水平/垂直分辨率 + reserved
        u16(1),                                           // frame_count
        Buffer.concat([u8(4), Buffer.from('test', 'latin1'), Buffer.alloc(27)]), // compressorname(32)
        u16(0x0018), u16(0xffff),                         // depth / pre_defined
        box('avcC', AVC_CONFIG),
        ...(o.extraChildren || [])
    );
    const stsd = fb('stsd', 0, 0, u32(1), avc1);
    const stbl = box('stbl',
        stsd,
        fb('stts', 0, 0, u32(0)),
        fb('stsc', 0, 0, u32(0)),
        fb('stco', 0, 0, u32(0))
    );
    const urlBox = o.urlBox || box('url ', fb('url ', 0, 1)); // flags=1 即 self-contained
    const dinf = box('dinf', fb('dref', 0, 0, u32(1), urlBox));
    const minf = box('minf', fb('vmhd', 0, 1, Buffer.alloc(8)), dinf, stbl);
    const hdlr = fb('hdlr', 0, 0, u32(0), fourcc('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0', 'latin1'));
    const mdhd = fb('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(0), u16(0x55c4), u16(0));
    const tkhd = fb('tkhd', 0, 3,
        u32(0), u32(0), u32(1), u32(0), u32(N * dur),
        Buffer.alloc(8),
        u16(0), u16(0), u16(0), u16(0),
        MATRIX,
        u32(width << 16), u32(height << 16)
    );
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    const mvex = box('mvex', fb('trex', 0, 0, u32(1), u32(1), u32(dur), u32(0), u32(0)));
    const mvhd = fb('mvhd', 0, 0,
        u32(0), u32(0), u32(ts), u32(N * dur), u32(0x00010000),
        u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2)
    );
    const moov = box('moov', mvhd, trak, mvex);

    // trun 各字段由标志位决定，读取顺序固定为 duration / size / flags / cts
    const needFlags = !!(o.nonSync || o.dependsYes);
    const trunFlags = 0x1 | 0x100 | 0x200 | 0x800 | (needFlags ? 0x400 : 0);
    const entSize = needFlags ? 16 : 12;
    const entBuf = Buffer.alloc(N * entSize);
    let off = 0;
    for (let i = 0; i < N; i++) {
        entBuf.writeUInt32BE(dur, off); off += 4;
        entBuf.writeUInt32BE(sampleSize, off); off += 4;
        if (needFlags) {
            let flags = 0;
            if (o.nonSync) flags |= (1 << 16);
            if (o.dependsYes) flags |= (1 << 24);
            entBuf.writeUInt32BE(flags >>> 0, off); off += 4;
        }
        const cts = (o.ctsHighBit && i === 0) ? 0xffffffff : 0;
        entBuf.writeUInt32BE(cts >>> 0, off); off += 4;
    }
    const mfhd = fb('mfhd', 0, 0, u32(1));
    const tfhd = fb('tfhd', 0, 0x20000, u32(1)); // default_base_is_moof
    const tfdt = fb('tfdt', 0, 0, u32(0));
    const trunBody = Buffer.concat([u32(trunFlags), u32(declared), u32(0), entBuf]);
    const trun = Buffer.concat([u32(trunBody.length + 8), fourcc('trun'), trunBody]);
    const trafBody = Buffer.concat([tfhd, tfdt, trun]);
    const traf = Buffer.concat([u32(trafBody.length + 8), fourcc('traf'), trafBody]);
    const moofBody = Buffer.concat([mfhd, traf]);
    const moofSize = moofBody.length + 8;
    trunBody.writeUInt32BE(moofSize + 8, 8); // data_offset 指向 mdat 载荷起点
    const moof = Buffer.concat([u32(moofSize), fourcc('moof'), moofBody]);
    const mdat = Buffer.concat([u32(N * sampleSize + 8), fourcc('mdat'), Buffer.alloc(N * sampleSize, 0x41)]);

    return Buffer.concat([ftyp, moov, moof, mdat]);
}

/* ------------------------------------------------------------ Box 比对 */

/** 需要逐字节保真的解码器配置 / 显示相关 Box */
const CONFIG_BOXES = ['avcC', 'hvcC', 'av1C', 'esds', 'vpcC', 'dac3', 'dec3', 'dvcC', 'dvvC', 'dfLa', 'colr', 'pasp', 'btrt'];

/** 在缓冲区里找到指定类型的 Box，返回含 8 字节 Box 头的完整字节 */
function findBox(buf, type) {
    const t = Buffer.from(type, 'latin1');
    let i = 0;
    while ((i = buf.indexOf(t, i)) !== -1) {
        const size = buf.readUInt32BE(i - 4);
        // 只接受尺寸合理、整 Box 落在缓冲区内的命中，排除随机字节误匹配
        if (size >= 8 && size <= 4096 && i - 4 >= 0 && i - 4 + size <= buf.length) {
            return Buffer.from(buf.subarray(i - 4, i - 4 + size));
        }
        i += t.length;
    }
    return null;
}

/**
 * 源里出现的每个配置 Box，都必须在输出里有一份字节完全一致的副本。
 * 输出里多出来的 Box（例如音频轨自带的 esds）不参与比对。
 */
function compareConfigBoxes(label, srcBuf, outBuf) {
    let bad = 0;
    for (const name of CONFIG_BOXES) {
        const src = findBox(srcBuf, name);
        if (!src) continue;
        const out = findBox(outBuf, name);
        const same = !!out && Buffer.compare(src, out) === 0;
        console.log('  ' + name + ': src=' + src.length + 'B ' + src.subarray(8, 20).toString('hex') +
            ' | out=' + (out ? out.length + 'B ' + out.subarray(8, 20).toString('hex') : 'none') +
            ' | ' + (same ? 'OK' : 'MISMATCH'));
        if (!same) bad++;
    }
    ok(label, bad === 0, bad + ' 个配置 Box 不一致');
    return bad;
}

/* --------------------------------------------------------- MKV 结构解析 */

/**
 * 解析 Matroska 的 EBML 元素头。
 * @returns {{id: number, size: number, payloadStart: number, payloadEnd: number}|null}
 */
function readEbmlElement(buf, pos, end) {
    if (pos >= end) return null;
    const first = buf[pos];
    let idLen = 0;
    for (let i = 0; i < 4; i++) {
        if (first & (0x80 >> i)) { idLen = i + 1; break; }
    }
    if (!idLen || pos + idLen >= end) return null;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];

    const sizePos = pos + idLen;
    const sizeFirst = buf[sizePos];
    let sizeLen = 0;
    for (let i = 0; i < 8; i++) {
        if (sizeFirst & (0x80 >> i)) { sizeLen = i + 1; break; }
    }
    if (!sizeLen || sizePos + sizeLen > end) return null;
    let size = sizeFirst & (0xff >> sizeLen);
    for (let i = 1; i < sizeLen; i++) size = size * 256 + buf[sizePos + i];
    const payloadStart = sizePos + sizeLen;
    return { id, size, payloadStart, payloadEnd: payloadStart + size };
}

/** 遍历 [start, end) 内的同级元素 */
function eachEbmlElement(buf, start, end, fn) {
    let pos = start;
    while (pos < end) {
        const el = readEbmlElement(buf, pos, end);
        if (!el) return;
        fn(el);
        pos = el.payloadEnd;
    }
}

// 需要的 Matroska ID
const MKV_ID = {
    Segment: 0x18538067,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackType: 0x83,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    MaxBlockAdditionID: 0x55ee,
    BlockAdditionMapping: 0x41e4,
    BlockAddIDName: 0x41a4,
    BlockAddIDType: 0x41e7,
    BlockAddIDExtraData: 0x41ed,
};

/**
 * 读取 MKV 的 Tracks 块。
 *
 * Tracks 写在文件头部（SeekHead 之后、第一个 Cluster 之前），
 * 所以只读前 1 MiB 就够，不必把几百 MB 的产物整个读进内存。
 * @returns {Array<object>|null} [{ number, type, codecId, codecPrivate, blockAdditions }]
 */
function readMkvTracks(filePath) {
    let head;
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(1 << 20);
            const read = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    } catch (_) {
        return null;
    }

    const tracks = [];
    let found = false;

    const visitTrackEntry = (entry) => {
        const track = { blockAdditions: [] };
        eachEbmlElement(head, entry.payloadStart, entry.payloadEnd, (child) => {
            switch (child.id) {
                case MKV_ID.TrackNumber:
                    track.number = head.readUIntBE(child.payloadStart, child.size);
                    break;
                case MKV_ID.TrackType:
                    track.type = head.readUIntBE(child.payloadStart, child.size);
                    break;
                case MKV_ID.CodecID:
                    track.codecId = head.toString('latin1', child.payloadStart, child.payloadEnd);
                    break;
                case MKV_ID.CodecPrivate:
                    track.codecPrivate = head.subarray(child.payloadStart, child.payloadEnd);
                    break;
                case MKV_ID.MaxBlockAdditionID:
                    track.maxBlockAdditionId = head.readUIntBE(child.payloadStart, child.size);
                    break;
                case MKV_ID.BlockAdditionMapping: {
                    const mapping = {};
                    eachEbmlElement(head, child.payloadStart, child.payloadEnd, (sub) => {
                        if (sub.id === MKV_ID.BlockAddIDName) {
                            mapping.name = head.toString('latin1', sub.payloadStart, sub.payloadEnd);
                        } else if (sub.id === MKV_ID.BlockAddIDType) {
                            mapping.type = head.toString('latin1', sub.payloadStart, sub.payloadEnd);
                        } else if (sub.id === MKV_ID.BlockAddIDExtraData) {
                            mapping.extraData = head.subarray(sub.payloadStart, sub.payloadEnd);
                        }
                    });
                    track.blockAdditions.push(mapping);
                    break;
                }
                default:
                    break;
            }
        });
        tracks.push(track);
    };

    const walk = (start, end) => {
        eachEbmlElement(head, start, end, (el) => {
            if (el.id === MKV_ID.Segment) {
                walk(el.payloadStart, el.payloadEnd);
            } else if (el.id === MKV_ID.Tracks) {
                found = true;
                eachEbmlElement(head, el.payloadStart, el.payloadEnd, (child) => {
                    if (child.id === MKV_ID.TrackEntry) visitTrackEntry(child);
                });
            }
        });
    };
    walk(0, head.length);

    return found ? tracks : null;
}

/** 解封装产物里某个配置 Box 的载荷（不含 8 字节 Box 头），用作 CodecPrivate 的期望值 */
function boxPayload(stsdEntry, type) {
    const boxes = (stsdEntry && stsdEntry.boxes) || [];
    const found = boxes.find((b) => b && b.type === type);
    if (!found || !found.data || found.data.length === 0) return null;
    return Buffer.from(found.data.buffer, found.data.byteOffset, found.data.byteLength);
}

/** 视频 SampleEntry -> Matroska CodecID */
const MKV_VIDEO_CODEC = {
    av01: 'V_AV1',
    avc1: 'V_MPEG4/ISO/AVC',
    avc3: 'V_MPEG4/ISO/AVC',
    hev1: 'V_MPEGH/ISO/HEVC',
    hvc1: 'V_MPEGH/ISO/HEVC',
    dvh1: 'V_MPEGH/ISO/HEVC',
    dvhe: 'V_MPEGH/ISO/HEVC',
};

/** 音频 SampleEntry -> Matroska CodecID */
const MKV_AUDIO_CODEC = {
    mp4a: 'A_AAC',
    'fLaC': 'A_FLAC',
    'flac': 'A_FLAC',
    'ac-3': 'A_AC3',
    'ec-3': 'A_EAC3',
    opus: 'A_OPUS',
    alac: 'A_ALAC',
};

/**
 * MKV 产物的轨道结构校验。
 *
 * Matroska 里没有 MP4 的 stsd 子 Box 概念：解码器配置写进 CodecPrivate，
 * 杜比视界这类额外配置写成 BlockAdditionMapping。这里按轨道逐条核对：
 *  - CodecID 与源编码对应；
 *  - 视频 CodecPrivate 与源 hvcC / avcC / av1C 载荷逐字节一致；
 *  - 音频 AAC 的 CodecPrivate 是 ASC，FLAC 是规范化的 "fLaC" + STREAMINFO；
 *  - 杜比视界的 dvcC / dvvC 载荷完整出现在 BlockAdditionMapping 里。
 * @param {string} outPath MKV 产物
 * @param {object} fx 样例期望值
 * @param {object} srcVideoStsd 源视频的 stsd SampleEntry（提供配置 Box 载荷）
 */
function checkMkvTracks(outPath, fx, srcVideoStsd) {
    const tracks = readMkvTracks(outPath);
    ok('.mkv 可解析出轨道表', !!tracks && tracks.length === 2,
        tracks ? 'got ' + tracks.length + ' 条' : 'Tracks 元素缺失');
    if (!tracks || tracks.length !== 2) return;

    const video = tracks.find((t) => t.type === 1);
    const audio = tracks.find((t) => t.type === 2);
    ok('.mkv 视频轨存在', !!video, '未找到 TrackType=1');
    ok('.mkv 音频轨存在', !!audio, '未找到 TrackType=2');

    if (video) {
        ok('.mkv 视频 CodecID 为 ' + MKV_VIDEO_CODEC[fx.videoSubtype],
            video.codecId === MKV_VIDEO_CODEC[fx.videoSubtype], 'got ' + video.codecId);
        // 配置 Box 的载荷应原样成为 CodecPrivate（hvc1 / hev1 都用 hvcC）
        const configType = { av01: 'av1C', avc1: 'avcC', hev1: 'hvcC', hvc1: 'hvcC' }[fx.videoSubtype];
        const srcPayload = configType ? boxPayload(srcVideoStsd, configType) : null;
        ok('.mkv 视频 CodecPrivate 与源 ' + configType + ' 载荷一致',
            !!srcPayload && !!video.codecPrivate && Buffer.compare(srcPayload, video.codecPrivate) === 0,
            'src=' + (srcPayload ? srcPayload.length + 'B' : 'none') +
                ' out=' + (video.codecPrivate ? video.codecPrivate.length + 'B' : 'none'));

        if (fx.dolbyVisionBox) {
            // dvcC / dvvC 都是 24 字节的 DOVI 配置记录，只是 profile 用途不同
            const srcDvBox = boxPayload(srcVideoStsd, fx.dolbyVisionBox);
            const mapping = (video.blockAdditions || []).find((m) => m.type === fx.dolbyVisionBox);
            ok('.mkv 写入杜比视界 BlockAdditionMapping', !!mapping,
                '缺少 ' + fx.dolbyVisionBox + ' 映射');
            ok('.mkv 杜比视界映射类型与名称',
                !!mapping && mapping.name === 'Dolby Vision configuration',
                mapping ? 'got ' + JSON.stringify(mapping.name) : '缺少映射');
            ok('.mkv 杜比视界映射附带 ' + fx.dolbyVisionBox + ' 载荷',
                !!mapping && !!mapping.extraData && !!srcDvBox &&
                    Buffer.compare(mapping.extraData, srcDvBox) === 0,
                'src=' + (srcDvBox ? srcDvBox.length + 'B' : 'none') +
                    ' out=' + (mapping && mapping.extraData ? mapping.extraData.length + 'B' : 'none'));
            // ffmpeg 也把 MaxBlockAdditionID 写 0：配置只登记在映射表里
            ok('.mkv MaxBlockAdditionID 为 0',
                video.maxBlockAdditionId === 0, 'got ' + video.maxBlockAdditionId);
        } else {
            ok('.mkv 非杜比视界轨道没有 BlockAdditionMapping',
                (video.blockAdditions || []).length === 0,
                'got ' + (video.blockAdditions || []).length + ' 条');
        }
    }

    if (audio) {
        ok('.mkv 音频 CodecID 为 ' + MKV_AUDIO_CODEC[fx.audioSubtype],
            audio.codecId === MKV_AUDIO_CODEC[fx.audioSubtype], 'got ' + audio.codecId);
        // A_EAC3 / A_AC3 不带 CodecPrivate（参数在码流里），其余编码必须有
        const needsPrivate = fx.audioSubtype !== 'ec-3' && fx.audioSubtype !== 'ac-3';
        if (needsPrivate) {
            ok('.mkv 音频 CodecPrivate 非空', !!audio.codecPrivate && audio.codecPrivate.length > 0,
                audio.codecPrivate ? audio.codecPrivate.length + 'B' : '缺失');
        }
        if (fx.audioSubtype === 'fLaC' || fx.audioSubtype === 'flac') {
            // Matroska 要求 A_FLAC 的 CodecPrivate 以 fLaC 魔数开头并紧跟 STREAMINFO
            ok('.mkv FLAC CodecPrivate 以 fLaC 魔数开头',
                !!audio.codecPrivate && audio.codecPrivate.subarray(0, 4).toString('latin1') === 'fLaC',
                audio.codecPrivate ? JSON.stringify(audio.codecPrivate.subarray(0, 4).toString('latin1')) : '缺失');
            ok('.mkv FLAC CodecPrivate 首个元数据块为 STREAMINFO',
                !!audio.codecPrivate && (audio.codecPrivate[4] & 0x7f) === 0,
                audio.codecPrivate ? 'got type ' + (audio.codecPrivate[4] & 0x7f) : '缺失');
        }
    }
}

/* ------------------------------------------------------------ 临时文件 */

const tmpFiles = [];
function writeTmp(buf, ext) {
    const p = path.join(os.tmpdir(), 'js-media-check-' + Date.now() + '-' +
        Math.random().toString(36).slice(2) + (ext || '.m4s'));
    fs.writeFileSync(p, buf);
    tmpFiles.push(p);
    return p;
}

/** 输出统一落在 test/test-output，跑完清理。唯一后缀插在扩展名之前，避免破坏按扩展名的容器分派 */
function outputPath(name) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    const p = path.join(OUTPUT_DIR, base + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
    tmpFiles.push(p);
    return p;
}

function cleanTmp() {
    for (const p of tmpFiles) {
        try { fs.unlinkSync(p); } catch (_) { /* 已删除 */ }
    }
    // 产物目录是本次运行创建的，留下空目录会污染工作区
    try {
        if (fs.existsSync(OUTPUT_DIR) && fs.readdirSync(OUTPUT_DIR).length === 0) {
            fs.rmdirSync(OUTPUT_DIR);
        }
    } catch (_) { /* 非空或已被删除，忽略 */ }
}

/* --------------------------------------------------------------- 用例 */

/**
 * 用例 1：合成 Bilibili 风格的 avc1 分片文件，走完 解封装 -> 合并封装 全流程，
 * 校验 avcC / colr / pasp / btrt 与源逐字节一致（曾经 avcC 会被写成垃圾字节）。
 */
async function testAvcCIdentity() {
    console.log('== 1. 配置 Box 字节一致（avcC 回归）==');
    const srcBuf = buildFragmented({
        sampleCount: 20,
        timescale: 16000,
        sampleDur: 533,
        sampleSize: 40,
        width: 1920,
        height: 1080,
        extraChildren: [
            box('colr', fourcc('nclx'), u16(1), u16(1), u16(1), u8(0)),
            box('pasp', u32(1), u32(1)),
            box('btrt', u32(1000000), u32(2000000), u32(500000)),
        ],
        // 带 JSON 载荷的 url Box：正是这个形状（内存池里紧邻无关字节）触发了原缺陷
        urlBox: fb('url ', 0, 0, Buffer.from(BILI_URL_JSON + '\0', 'latin1')),
    });
    const srcPath = writeTmp(srcBuf);

    const video = await demux.demuxM4sIndex(srcPath);
    const audio = await demux.demuxM4sIndex(AUDIO_FIXTURE);
    const outPath = path.join(os.tmpdir(), 'js-media-check-avc-' + Date.now() + '.mp4');
    tmpFiles.push(outPath);
    await muxFragmentedMp4({ video, audio, outputPath: outPath });
    video.close();
    audio.close();

    // 解封装阶段就该把 avcC 载荷原样保留下来
    const avcC = (video.stsdEntry.boxes || []).find((b) => b.type === 'avcC');
    ok('解封装保留 avcC 载荷', !!avcC && Buffer.from(avcC.data).equals(AVC_CONFIG),
        avcC ? 'got ' + Buffer.from(avcC.data).subarray(0, 16).toString('hex') : 'avcC 缺失');
    // 交给 mp4box 的必须是 byteOffset 为 0 的独立副本，否则会踩 memcpy 的偏移 0 快路径
    ok('avcC 载荷副本 byteOffset 为 0', !!avcC && avcC.data.byteOffset === 0,
        avcC ? 'byteOffset=' + avcC.data.byteOffset : 'avcC 缺失');

    compareConfigBoxes('输出配置 Box 与源逐字节一致', srcBuf, fs.readFileSync(outPath));

    // 曾经的症状：avcC 内容变成 ftyp 之类的内存池开头字节
    const outAvcC = findBox(fs.readFileSync(outPath), 'avcC');
    const payload = outAvcC ? outAvcC.subarray(8) : Buffer.alloc(0);
    ok('输出 avcC 未被写成无关字节', payload.equals(AVC_CONFIG),
        'got ' + JSON.stringify(payload.subarray(0, 32).toString('latin1').replace(/[^\x20-\x7e]/g, '.')));
}

/**
 * 解封装一份样例并缓存 stsd（多条用例复用，避免反复解析几百 MB 的文件）。
 * @param {string} relPath 相对 test/test-media 的路径
 * @returns {Promise<{stsdEntry: object, trackInfo: object}>}
 */
const stsdCache = new Map();
async function sourceStsd(relPath) {
    if (!stsdCache.has(relPath)) {
        const source = await demux.demuxM4sIndex(path.join(MEDIA_DIR, relPath));
        stsdCache.set(relPath, { stsdEntry: source.stsdEntry, trackInfo: source.trackInfo });
        source.close();
    }
    return stsdCache.get(relPath);
}

/** 源轨道的时长（秒），用 Sample 的时间戳算出来 */
async function sourceDurationSeconds(relPath) {
    const source = await demux.demuxM4sIndex(path.join(MEDIA_DIR, relPath));
    try {
        return source.durationUnits() / source.trackInfo.timescale;
    } finally {
        source.close();
    }
}

/**
 * 用例 2：真实样例矩阵的解封装回归 —— 编码串 / 样本数 / 关键帧 / dependsOn /
 * 时间基 / 时长 / 解码器配置 Box。
 */
async function testFixtureDemux() {
    console.log('== 2. 真实样例解封装矩阵 ==');
    for (const fx of FIXTURES) {
        console.log(' -- ' + fx.label + '（' + fx.video + ' + ' + fx.audio + '）');
        const v = await demux.demuxM4sIndex(path.join(MEDIA_DIR, fx.video));
        const a = await demux.demuxM4sIndex(path.join(MEDIA_DIR, fx.audio));
        try {
            const vBoxes = (v.stsdEntry && v.stsdEntry.boxes ? v.stsdEntry.boxes : []).map((b) => b.type);
            const aBoxes = (a.stsdEntry && a.stsdEntry.boxes ? a.stsdEntry.boxes : []).map((b) => b.type);
            const vKey = v.samples.filter((s) => s.keyframe).length;
            const aKey = a.samples.filter((s) => s.keyframe).length;

            ok('视频编码 ' + fx.videoCodec, v.trackInfo.codec === fx.videoCodec,
                'got ' + v.trackInfo.codec);
            ok('视频 SampleEntry 为 ' + fx.videoSubtype, v.codecSubtype === fx.videoSubtype,
                'got ' + v.codecSubtype);
            ok('视频时间基 1/' + fx.videoTimescale, v.trackInfo.timescale === fx.videoTimescale,
                'got 1/' + v.trackInfo.timescale);
            ok('视频配置 Box ' + fx.videoBoxes.join('+'),
                fx.videoBoxes.every((t) => vBoxes.includes(t)), 'got ' + vBoxes.join('+'));
            ok('视频样本数 ' + fx.videoSamples, v.samples.length === fx.videoSamples,
                'got ' + v.samples.length);
            ok('视频关键帧数 ' + fx.videoKeyframes, vKey === fx.videoKeyframes, 'got ' + vKey);
            ok('视频 dependsOn ' + JSON.stringify(fx.videoDependsOn),
                sameSet(v.samples.map((s) => s.dependsOn), fx.videoDependsOn),
                'got ' + JSON.stringify(uniqueSorted(v.samples.map((s) => s.dependsOn))));
            ok('视频尺寸 ' + fx.width + 'x' + fx.height,
                !!v.trackInfo.video && v.trackInfo.video.width === fx.width &&
                    v.trackInfo.video.height === fx.height,
                'got ' + (v.trackInfo.video ? v.trackInfo.video.width + 'x' + v.trackInfo.video.height : 'none'));
            ok('视频时长 ≈ ' + fx.durationSeconds + 's',
                nearSeconds(v.durationUnits() / v.trackInfo.timescale, fx.durationSeconds),
                'got ' + (v.durationUnits() / v.trackInfo.timescale).toFixed(3) + 's');

            ok('音频编码 ' + fx.audioCodec, a.trackInfo.codec === fx.audioCodec,
                'got ' + a.trackInfo.codec);
            ok('音频 SampleEntry 为 ' + fx.audioSubtype, a.codecSubtype === fx.audioSubtype,
                'got ' + a.codecSubtype);
            ok('音频时间基 1/' + fx.audioTimescale, a.trackInfo.timescale === fx.audioTimescale,
                'got 1/' + a.trackInfo.timescale);
            ok('音频配置 Box ' + fx.audioBoxes.join('+'),
                fx.audioBoxes.every((t) => aBoxes.includes(t)), 'got ' + aBoxes.join('+'));
            ok('音频样本数 ' + fx.audioSamples, a.samples.length === fx.audioSamples,
                'got ' + a.samples.length);
            ok('音频关键帧数 ' + fx.audioKeyframes, aKey === fx.audioKeyframes, 'got ' + aKey);
            ok('音频 dependsOn ' + JSON.stringify(fx.audioDependsOn),
                sameSet(a.samples.map((s) => s.dependsOn), fx.audioDependsOn),
                'got ' + JSON.stringify(uniqueSorted(a.samples.map((s) => s.dependsOn))));

            // 杜比（E-AC-3）的 stsd 声道数不可信，封装层必须从 dec3 里解出 5.1
            const params = audioTrackParams(a.trackInfo, a.stsdEntry);
            ok('音频声道数 ' + fx.audioChannels, params.channelCount === fx.audioChannels,
                'got ' + params.channelCount + '（stsd 报 ' + (a.trackInfo.audio || {}).channel_count + '）');
            ok('音频时长 ≈ ' + (fx.audioDurationSeconds || fx.durationSeconds) + 's',
                nearSeconds(a.durationUnits() / a.trackInfo.timescale,
                    fx.audioDurationSeconds || fx.durationSeconds),
                'got ' + (a.durationUnits() / a.trackInfo.timescale).toFixed(3) + 's');

            if (fx.dolbyVisionBox) {
                const dvBox = (v.stsdEntry.boxes || []).find((b) => b.type === fx.dolbyVisionBox);
                ok('保留杜比视界配置 Box ' + fx.dolbyVisionBox,
                    !!dvBox && dvBox.data.length === 24,
                    dvBox ? 'got ' + dvBox.data.length + 'B' : fx.dolbyVisionBox + ' 缺失');
            }
        } finally {
            v.close();
            a.close();
        }
    }
}

function uniqueSorted(list) {
    return Array.from(new Set(list)).sort((x, y) => x - y);
}

/** 时长比较：默认允许 0.1 s 误差（容器时间基取整） */
function nearSeconds(actual, expected, tolerance = 0.1) {
    return Number.isFinite(actual) && Math.abs(actual - expected) < tolerance;
}

function sameSet(list, expected) {
    const a = uniqueSorted(list);
    const b = uniqueSorted(expected);
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * 用例 3：封装正确性 —— 每对样例分别封装成 MP4 与 MKV，
 * 用 test/verify 下的 ffprobe / ffmpeg 校验产物与源一致。
 *
 * 校验点：
 *  - 流参数（编码 / 分辨率 / 像素格式 / 声道 / 采样率 / 时长）与源一致；
 *  - 解封装出的样本数 == 容器里的包数（没有丢帧或多写）；
 *  - streamhash 与源相同（只搬运不重编码）；
 *  - 全量解码无错误；
 *  - 杜比视界的 SampleEntry 标记与 DOVI 配置记录在 MKV 里也保留。
 */
async function testMuxMatrix() {
    console.log('== 3. 封装正确性（MP4 + MKV，ffprobe / ffmpeg 校验）==');
    if (!hasVerifier) {
        skipped('封装正确性校验', '缺少 test/verify/ffprobe 或 ffmpeg');
        return;
    }

    for (const fx of FIXTURES) {
        const videoPath = path.join(MEDIA_DIR, fx.video);
        const audioPath = path.join(MEDIA_DIR, fx.audio);
        const srcProbe = probeStreams(videoPath);
        const srcAudioProbe = probeStreams(audioPath);
        const srcV = firstStream(srcProbe, 'video');
        const srcA = firstStream(srcAudioProbe, 'audio');
        const srcVHash = streamHash(videoPath, '0:v:0');
        const srcAHash = streamHash(audioPath, '0:a:0');

        for (const container of ['mp4', 'mkv']) {
            console.log(' -- ' + fx.label + ' -> .' + container);
            const outPath = outputPath(fx.video.replace(/[\\/]/g, '-').replace(/\.m4s$/, '') + '.' + container);

            let result;
            try {
                result = await mergeBiliM4sToFile(videoPath, audioPath, outPath);
            } catch (e) {
                ok('封装 .' + container, false, String((e && e.message) || e));
                continue;
            }
            ok('封装 .' + container + ' 成功', fs.statSync(outPath).size > 0,
                'size=' + fs.statSync(outPath).size);
            ok('视频样本书目 ' + fx.videoSamples,
                result.videoSamples === fx.videoSamples, 'got ' + result.videoSamples);
            ok('音频样本书目 ' + fx.audioSamples,
                result.audioSamples === fx.audioSamples, 'got ' + result.audioSamples);

            // 容器格式不同，配置的存放位置也不同：
            // MP4 是 stsd 里的同名单 Box，MKV 是轨道的 CodecPrivate 还是 BlockAdditionMapping
            if (container === 'mp4') {
                compareConfigBoxes('.mp4 配置 Box 与源一致',
                    fs.readFileSync(videoPath), fs.readFileSync(outPath));
            } else {
                const srcVideo = await sourceStsd(fx.video);
                checkMkvTracks(outPath, fx, srcVideo.stsdEntry);
            }

            const probed = probeStreams(outPath);
            ok('.' + container + ' ffprobe 可解析', !!probed, 'ffprobe 失败');
            const outV = firstStream(probed, 'video');
            const outA = firstStream(probed, 'audio');
            if (!outV || !outA) {
                ok('.' + container + ' 音视频双轨齐全', false,
                    'video=' + !!outV + ' audio=' + !!outA);
                continue;
            }

            // 视频参数与源一致
            ok('.' + container + ' 视频编码 ' + srcV.codec_name,
                outV.codec_name === srcV.codec_name, 'got ' + outV.codec_name);
            ok('.' + container + ' 分辨率 ' + srcV.width + 'x' + srcV.height,
                outV.width === srcV.width && outV.height === srcV.height,
                'got ' + outV.width + 'x' + outV.height);
            ok('.' + container + ' 像素格式 ' + srcV.pix_fmt,
                outV.pix_fmt === srcV.pix_fmt, 'got ' + outV.pix_fmt);
            // MP4 的 SampleEntry 标记必须与源一致（杜比视界 profile 8 的源是 hvc1，不是 dvh1）
            if (container === 'mp4') {
                ok('.mp4 保留 SampleEntry 标记 ' + srcV.codec_tag_string,
                    outV.codec_tag_string === srcV.codec_tag_string, 'got ' + outV.codec_tag_string);
            }

            // 音频参数与源一致（杜比全景声必须仍是 5.1）
            ok('.' + container + ' 音频编码 ' + srcA.codec_name,
                outA.codec_name === srcA.codec_name, 'got ' + outA.codec_name);
            ok('.' + container + ' 音频声道 ' + fx.audioChannels,
                outA.channels === fx.audioChannels, 'got ' + outA.channels);
            ok('.' + container + ' 声道布局 ' + fx.audioLayout,
                outA.channel_layout === fx.audioLayout, 'got ' + outA.channel_layout);
            ok('.' + container + ' 采样率 ' + srcA.sample_rate,
                Number(outA.sample_rate) === Number(srcA.sample_rate), 'got ' + outA.sample_rate);

            // 时长：封装产物必须覆盖与源相同的时长，否则说明时间戳换算错了。
            // 容差 0.5 s：HEVC / DV 这类带 B 帧的源有 ctts 负偏移（ffmpeg 报首帧 dts=-0.12s），
            // 而 MP4Box 会把 dts 归一到 0，产物因此最多比源多出若干个重排帧的时长。
            // MKV 不写流级时长，退回容器时长。
            const containerDuration = Number((probed.format && probed.format.duration) || 0);
            const srcVideoDuration = await sourceDurationSeconds(fx.video);
            const srcAudioDuration = await sourceDurationSeconds(fx.audio);
            const outVideoDuration = Number(outV.duration) || containerDuration;
            const outAudioDuration = Number(outA.duration) || containerDuration;
            ok('.' + container + ' 视频时长 ≈ ' + srcVideoDuration.toFixed(2) + 's',
                nearSeconds(outVideoDuration, srcVideoDuration, 0.5),
                'got ' + outVideoDuration);
            ok('.' + container + ' 音频时长 ≈ ' + srcAudioDuration.toFixed(2) + 's',
                nearSeconds(outAudioDuration, srcAudioDuration, 0.5),
                'got ' + outAudioDuration);

            // 杜比视界配置记录必须在产物里能被 ffprobe 读出来
            if (fx.dolbyVisionBox) {
                const dovi = dolbyVisionSideData(outV);
                ok('.' + container + ' 保留杜比视界配置记录', !!dovi,
                    'side_data 缺失');
                if (dovi) {
                    const srcDovi = dolbyVisionSideData(srcV);
                    ok('.' + container + ' 杜比视界 profile 一致 (' + srcDovi.dv_profile + ')',
                        dovi.dv_profile === srcDovi.dv_profile &&
                            dovi.dv_bl_signal_compatibility_id === srcDovi.dv_bl_signal_compatibility_id,
                        'got profile=' + dovi.dv_profile +
                            ' bl_compat=' + dovi.dv_bl_signal_compatibility_id);
                }
            }

            // 包数必须与解封装出的样本数一致
            const packets = countPackets(outPath);
            ok('.' + container + ' 视频包数 ' + fx.videoSamples,
                !!packets && packets.video === fx.videoSamples,
                'got ' + (packets ? packets.video : 'ffprobe 失败'));
            ok('.' + container + ' 音频包数 ' + fx.audioSamples,
                !!packets && packets.audio === fx.audioSamples,
                'got ' + (packets ? packets.audio : 'ffprobe 失败'));

            // streamhash：源与产物逐字节相同，证明没有重编码 / 丢帧
            const outVHash = streamHash(outPath, '0:v:0');
            const outAHash = streamHash(outPath, '0:a:0');
            ok('.' + container + ' 视频码流与源逐字节一致',
                !!srcVHash && srcVHash === outVHash, 'src=' + srcVHash + ' out=' + outVHash);
            ok('.' + container + ' 音频码流与源逐字节一致',
                !!srcAHash && srcAHash === outAHash, 'src=' + srcAHash + ' out=' + outAHash);

            // 全量解码：任何结构 / 参数集问题都会让解码器往 stderr 吐错误
            const decoded = decodeCheck(outPath);
            ok('.' + container + ' 全量解码无错误', decoded.ok && !decoded.stderr,
                decoded.stderr.split(/\r?\n/)[0] || 'exit=' + decoded.ok);
        }
    }
}

/**
 * 用例 4：纯音频转封装的支持矩阵。
 *
 * AAC / E-AC-3 / FLAC 三种音频分别尝试 m4a / mkv / flac，
 * 支持的要产出可正常解码的文件，不支持的必须给出 ERR_UNSUPPORTED_AUDIO_CODEC。
 */
async function testAudioConversion() {
    console.log('== 4. 纯音频转封装矩阵 ==');
    const cases = [
        { file: AAC_AUDIO, ext: '.m4a', supported: true, codec: 'aac' },
        { file: AAC_AUDIO, ext: '.mkv', supported: true, codec: 'aac' },
        { file: AAC_AUDIO, ext: '.flac', supported: false },
        { file: DOLBY_AUDIO, ext: '.m4a', supported: false },
        { file: DOLBY_AUDIO, ext: '.mkv', supported: true, codec: 'eac3' },
        { file: DOLBY_AUDIO, ext: '.flac', supported: false },
        { file: FLAC_AUDIO, ext: '.m4a', supported: false },
        { file: FLAC_AUDIO, ext: '.mkv', supported: true, codec: 'flac' },
        { file: FLAC_AUDIO, ext: '.flac', supported: true, codec: 'flac' },
    ];

    for (const c of cases) {
        const srcPath = path.join(MEDIA_DIR, c.file);
                const outPath = outputPath(c.file.replace(/[\\/]/g, '-').replace(/\.m4s$/, '') + c.ext);
        const label = c.file + ' -> ' + c.ext;

        const check = checkAudioConversion(srcPath, outPath);
        ok(label + ' 预检结论正确', check.supported === c.supported,
            'got supported=' + check.supported + ' ' + (check.reason || ''));

        if (!c.supported) {
            await throws(label + ' 拒绝转封装',
                () => convertBiliM4sAudio(srcPath, outPath), '不支持的音频编码');
            continue;
        }

        try {
            await convertBiliM4sAudio(srcPath, outPath);
        } catch (e) {
            ok(label + ' 转封装成功', false, String((e && e.message) || e));
            continue;
        }
        ok(label + ' 转封装成功', fs.statSync(outPath).size > 0,
            'size=' + fs.statSync(outPath).size);

        if (!hasVerifier) {
            skipped(label + ' 产物校验', '缺少 test/verify/ffprobe 或 ffmpeg');
            continue;
        }
        const probed = probeStreams(outPath);
        const stream = firstStream(probed, 'audio');
        ok(label + ' 产物音频编码 ' + c.codec, !!stream && stream.codec_name === c.codec,
            'got ' + (stream ? stream.codec_name : 'ffprobe 失败'));
        ok(label + ' 声道数与源一致 ' + expectedChannels(c.file),
            !!stream && stream.channels === expectedChannels(c.file),
            'got ' + (stream ? stream.channels : 'ffprobe 失败'));
        // 纯音频只校验音频流；MKV 里可能还有字幕，所以按 a:0 取
        ok(label + ' 音频码流与源逐字节一致',
            streamHash(srcPath, '0:a:0') === streamHash(outPath, '0:a:0'),
            'hash 不一致');
        const decoded = decodeCheck(outPath);
        ok(label + ' 全量解码无错误', decoded.ok && !decoded.stderr,
            decoded.stderr.split(/\r?\n/)[0] || 'exit=' + decoded.ok);
    }
}

/** 各音频样例的真实声道数（杜比全景声是 5.1） */
function expectedChannels(file) {
    if (file === DOLBY_AUDIO) return 6;
    return 2;
}

/**
 * 用例 5：解封装边界行为的守卫用例（清单落地后的边界逻辑）。
 */
async function testEdgeCases() {
    console.log('== 5. 边界用例 ==');

    const base = writeTmp(buildFragmented({ sampleCount: 10 }));
    const bb = await demux.demuxM4sIndex(base);
    ok('基线解析出 10 个样本', bb.samples.length === 10, 'got ' + bb.samples.length);
    ok('基线全部为关键帧', bb.samples.filter((s) => s.keyframe).length === 10);
    bb.close();

    const ns = writeTmp(buildFragmented({ sampleCount: 10, nonSync: true }));
    const nsb = await demux.demuxM4sIndex(ns);
    ok('nonSync 样本不判为关键帧', nsb.samples.filter((s) => s.keyframe).length === 0,
        'got ' + nsb.samples.filter((s) => s.keyframe).length);
    nsb.close();

    const dg = writeTmp(buildFragmented({ sampleCount: 10, dependsYes: true }));
    const dgb = await demux.demuxM4sIndex(dg);
    ok('depends_on=1（open GOP）不判为关键帧', dgb.samples.filter((s) => s.keyframe).length === 0,
        'got ' + dgb.samples.filter((s) => s.keyframe).length);
    ok('depends_on 值被保留', dgb.samples.every((s) => s.dependsOn === 1));
    dgb.close();

    const inf = writeTmp(buildFragmented({ sampleCount: 10, trunDeclaredCount: 15 }));
    await throws('拒绝夸大的 trun.sample_count', () => demux.demuxM4sIndex(inf), '计数被夸大');

    const huge = writeTmp(buildFragmented({ sampleCount: 10, trunDeclaredCount: 200000 }));
    await throws('极端夸大的计数被 trun 守卫拦下', () => demux.demuxM4sIndex(huge), '');

    const hi = writeTmp(buildFragmented({ sampleCount: 10, ctsHighBit: true }));
    await throws('拒绝 >= 2^31 的无符号 cts', () => demux.demuxM4sIndex(hi), '');

    const full = buildFragmented({ sampleCount: 10 });
    const trunc = writeTmp(full.subarray(0, Math.floor(full.length * 0.6)));
    await throws('拒绝被截断的文件', () => demux.demuxM4sIndex(trunc), '');
}

/* --------------------------------------------------------------- 主流程 */

(async () => {
    try {
        await testAvcCIdentity();
        await testFixtureDemux();
        await testMuxMatrix();
        await testAudioConversion();
        await testEdgeCases();
    } catch (e) {
        console.error('FATAL ' + (e && e.stack ? e.stack : e));
        cleanTmp();
        process.exit(2);
    }
    cleanTmp();
    console.log('\nRESULT pass=' + pass + ' fail=' + fail + (skip ? ' skip=' + skip : ''));
    process.exit(fail ? 1 : 0);
})();
