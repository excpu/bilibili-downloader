'use strict';
/**
 * js-media 回归检查（无测试框架，直接 node 运行；package.json 里 `npm test`）
 *
 * 覆盖三块：
 *   1. 配置 Box 字节一致性（avcC 回归）
 *      mp4box 的 DataStream.writeUint8Array 在 memcpy 快路径里源地址固定取
 *      array.buffer 的偏移 0，完全忽略 array.byteOffset；而我们的载荷是 Node
 *      内存池上的 Buffer 视图，导致写出的 avcC 变成内存池开头的无关字节
 *      （甚至是一整段 Bilibili CDN 的 JSON），ffmpeg 报
 *      "No start code is found / Error splitting the input into NAL units /
 *      unspecified pixel format"。仓库里没有 H.264 的 .m4s 样例，
 *      所以这里用合成夹具把这个行为锁死。
 *   2. 真实样例（assets/sample/test/*.m4s）的样本数 / 关键帧 / dependsOn 回归，
 *      外加合并后配置 Box 一致 + ffmpeg 有界解码无报错。
 *   3. 对照 ffmpeg mov.c 实现的边界用例：nonSync、open GOP、trun 计数被夸大、
 *      高位无符号 cts、文件被截断。
 *
 * 约定：全部通过时退出码 0，任何一项失败为非 0。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const demux = require(path.join(ROOT, 'modules/js-media/demux-m4s'));
const { muxFragmentedMp4 } = require(path.join(ROOT, 'modules/js-media/mp4'));
const { mergeBiliM4s } = require(path.join(ROOT, 'modules/js-media/media'));

const VIDEO_FIXTURE = path.join(ROOT, 'assets/sample/test/video.m4s'); // av01
const AUDIO_FIXTURE = path.join(ROOT, 'assets/sample/test/audio.m4s'); // mp4a

/* ------------------------------------------------------------------ 断言 */

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
    if (cond) {
        pass++;
        console.log('  PASS ' + name);
    } else {
        fail++;
        console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
    }
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
const CONFIG_BOXES = ['avcC', 'hvcC', 'av1C', 'esds', 'vpcC', 'dac3', 'dec3', 'dfLa', 'colr', 'pasp', 'btrt'];

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

/* ------------------------------------------------------------ 临时文件 */

const tmpFiles = [];
function writeTmp(buf, ext) {
    const p = path.join(os.tmpdir(), 'js-media-check-' + Date.now() + '-' +
        Math.random().toString(36).slice(2) + (ext || '.m4s'));
    fs.writeFileSync(p, buf);
    tmpFiles.push(p);
    return p;
}
function cleanTmp() {
    for (const p of tmpFiles) {
        try { fs.unlinkSync(p); } catch (_) { /* 已删除 */ }
    }
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
 * 用例 2：真实样例回归 —— 样本数 / 关键帧判定 / dependsOn，
 * 再合并成 MP4 校验配置 Box 一致 + ffmpeg 有界解码无报错。
 */
async function testRealFixtures() {
    console.log('== 2. 真实样例（av01 + mp4a）回归 ==');
    const v = await demux.demuxM4sIndex(VIDEO_FIXTURE);
    ok('视频样本数 3820', v.samples.length === 3820, 'got ' + v.samples.length);
    ok('视频关键帧数 31', v.samples.filter((s) => s.keyframe).length === 31,
        'got ' + v.samples.filter((s) => s.keyframe).length);
    ok('视频 dependsOn 全为 0（AV1 不分帧）', v.samples.every((s) => s.dependsOn === 0));
    const a = await demux.demuxM4sIndex(AUDIO_FIXTURE);
    ok('音频样本数 7164', a.samples.length === 7164, 'got ' + a.samples.length);
    ok('音频全部为关键帧', a.samples.filter((s) => s.keyframe).length === 7164);
    ok('音频 dependsOn=2 仍判为关键帧', a.samples.every((s) => s.dependsOn === 2 && s.keyframe));

    const outPath = path.join(os.tmpdir(), 'js-media-check-e2e-' + Date.now() + '.mp4');
    tmpFiles.push(outPath);
    await mergeBiliM4s(VIDEO_FIXTURE, AUDIO_FIXTURE, outPath);
    ok('合并输出非空', fs.statSync(outPath).size > 0, 'size=' + fs.statSync(outPath).size);

    compareConfigBoxes('合并输出配置 Box 与源逐字节一致',
        fs.readFileSync(VIDEO_FIXTURE), fs.readFileSync(outPath));

    // AV1 软解很慢，取前 20 秒足以暴露配置记录问题
    let ffPath = null;
    try { ffPath = require('ffmpeg-static'); } catch (_) { ffPath = null; }
    if (!ffPath || !fs.existsSync(ffPath)) {
        console.log('  SKIP ffmpeg 解码校验（未找到 ffmpeg-static 可执行文件）');
    } else {
        const r = spawnSync(ffPath,
            ['-v', 'error', '-xerror', '-nostats', '-t', '20', '-i', outPath, '-f', 'null', '-'],
            { encoding: 'utf8' });
        const err = (r.stderr || '').trim();
        ok('ffmpeg 解码无报错', r.status === 0 && !err, 'exit=' + r.status + ' ' + err.slice(0, 300));
    }

    v.close();
    a.close();
}

/**
 * 用例 3：对照 ffmpeg mov.c 的边界行为（清单落地后的守卫逻辑）。
 */
async function testEdgeCases() {
    console.log('== 3. 边界用例 ==');

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
        await testRealFixtures();
        await testEdgeCases();
    } catch (e) {
        console.error('FATAL ' + (e && e.stack ? e.stack : e));
        cleanTmp();
        process.exit(2);
    }
    cleanTmp();
    console.log('\nRESULT pass=' + pass + ' fail=' + fail);
    process.exit(fail ? 1 : 0);
})();
