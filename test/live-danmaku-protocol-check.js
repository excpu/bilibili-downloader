const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
    decodeSocketData,
    decodeFrames,
    normalizeCommand,
    parseCommandBody,
} = require('../modules/live_danmaku_protocol');

function frame(operation, body, version = 0) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const packet = Buffer.alloc(16 + data.length);
    packet.writeUInt32BE(packet.length, 0);
    packet.writeUInt16BE(16, 4);
    packet.writeUInt16BE(version, 6);
    packet.writeUInt32BE(operation, 8);
    packet.writeUInt32BE(1, 12);
    data.copy(packet, 16);
    return packet;
}

function command(cmd, data = {}) {
    return frame(5, JSON.stringify({ cmd, data }));
}

test('WebSocket 二进制数据统一转换为 Buffer', async () => {
    const source = Buffer.from([1, 2, 3, 4]);
    assert.deepEqual(await decodeSocketData(source), source);
    assert.deepEqual(await decodeSocketData(source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength
    )), source);
    assert.deepEqual(await decodeSocketData(new Uint8Array([5, 6])), Buffer.from([5, 6]));
    assert.deepEqual(await decodeSocketData(new Blob([source])), source);
    assert.equal(await decodeSocketData(null), null);
});

test('解析普通包以及同一 WebSocket 消息内的连续包', () => {
    const first = command('ONLINE_RANK_COUNT', { count: 123 });
    const second = command('WATCHED_CHANGE', { num: 456 });
    const parsed = decodeFrames(Buffer.concat([first, second]));

    assert.equal(parsed.length, 2);
    assert.deepEqual(parseCommandBody(parsed[0].body), [{ cmd: 'ONLINE_RANK_COUNT', data: { count: 123 } }]);
    assert.deepEqual(parseCommandBody(parsed[1].body), [{ cmd: 'WATCHED_CHANGE', data: { num: 456 } }]);
});

test('递归解析 zlib 与 Brotli 压缩的弹幕包', () => {
    const danmaku = frame(5, JSON.stringify({
        cmd: 'DANMU_MSG',
        info: [[0, 1, 0, 0xff8800], '测试弹幕', [123, '测试用户']],
    }));
    const watched = command('WATCHED_CHANGE', { num: 456 });
    const inner = Buffer.concat([danmaku, watched]);

    for (const compressed of [
        frame(5, zlib.deflateSync(inner), 2),
        frame(5, zlib.brotliCompressSync(inner), 3),
    ]) {
        const parsed = decodeFrames(compressed);
        assert.equal(parsed.length, 2);
        const [message] = parseCommandBody(parsed[0].body);
        assert.equal(normalizeCommand(message).text, '测试弹幕');
        assert.equal(normalizeCommand(message).user, '测试用户');
        assert.equal(normalizeCommand(message).color, '#ff8800');
        assert.equal(normalizeCommand(parseCommandBody(parsed[1].body)[0]).type, 'watched');
    }
});

test('拒绝不完整或非法包头，避免静默丢弃坏数据', () => {
    assert.throws(() => decodeFrames(Buffer.alloc(10)), /包头不完整/);
    const invalid = frame(5, '{}');
    invalid.writeUInt32BE(15, 0);
    assert.throws(() => decodeFrames(invalid), /包长度无效/);
});

test('规范化直播弹幕和房间状态命令', () => {
    assert.deepEqual(normalizeCommand({
        cmd: 'DANMU_MSG:4:0:2:2:2',
        info: [[0, 4, 0, 0x123456], 'hello', [42, 'viewer']],
    }), {
        type: 'danmaku',
        text: 'hello',
        user: 'viewer',
        uid: 42,
        color: '#123456',
        mode: 4,
    });
    assert.deepEqual(normalizeCommand({ cmd: 'ONLINE_RANK_COUNT', data: { count: 77 } }), {
        type: 'online',
        value: 77,
    });
    assert.deepEqual(normalizeCommand({ cmd: 'PREPARING' }), { type: 'live_status', value: 0 });
    assert.equal(normalizeCommand({ cmd: 'UNKNOWN' }), null);
});

test('解析 DANMU_MSG 荣耀等级、粉丝勋章配色、大航海身份与表情贴纸', () => {
    const meta = [];
    meta[1] = 1;
    meta[3] = 0xffffff;
    meta[12] = 1;
    meta[13] = JSON.stringify({
        emoticon_unique: 'room_123_1',
        url: 'http://i0.hdslb.com/bfs/live/sticker.png',
        width: 120,
        height: 120,
    });
    meta[15] = {
        extra: JSON.stringify({
            dm_type: 1,
            emots: {
                '[热]': {
                    emoticon_id: 278,
                    url: 'http://i0.hdslb.com/bfs/live/hot.png',
                    width: 20,
                    height: 20,
                },
            },
        }),
        user: {
            uid: 10086,
            base: {
                name: 'invins-',
                name_color_str: '#E17AFF',
            },
            medal: {
                name: '旁汀生',
                level: 55,
                guard_level: 2,
                is_light: 1,
                guard_icon: 'http://i0.hdslb.com/bfs/live/guard2.png',
                v2_medal_color_start: '#EB5370CC',
                v2_medal_color_end: '#FF758FCC',
                v2_medal_color_border: '#FF9AB0FF',
            },
        },
    };

    const info = [];
    info[0] = meta;
    info[1] = '喝茶[热]';
    info[2] = [10086, 'invins-', 1, 0, 0, 10000, 1, ''];
    info[3] = [55, '旁汀生', '主播', 8888, 2951253, '', 0, 16771156, 2951253, 10329087, 2, 1, 999];
    info[4] = [40, 0, 10512625, 100, 2];
    info[7] = 2;
    info[16] = [52];

    assert.deepEqual(normalizeCommand({ cmd: 'DANMU_MSG', info }), {
        type: 'danmaku',
        text: '喝茶[热]',
        user: 'invins-',
        uid: 10086,
        color: '#ffffff',
        mode: 1,
        nameColor: '#E17AFF',
        isAdmin: true,
        rank: 2,
        wealthLevel: 52,
        level: 40,
        guardLevel: 2,
        medalName: '旁汀生',
        medalLevel: 55,
        medalRoom: 8888,
        medalGuardLevel: 2,
        medalGuardIcon: 'https://i0.hdslb.com/bfs/live/guard2.png',
        medalColorStart: '#EB5370CC',
        medalColorEnd: '#FF758FCC',
        medalColorBorder: '#FF9AB0FF',
        emotes: {
            '[热]': {
                id: 278,
                url: 'https://i0.hdslb.com/bfs/live/hot.png',
                width: 20,
                height: 20,
            },
        },
        sticker: {
            url: 'https://i0.hdslb.com/bfs/live/sticker.png',
            width: 120,
            height: 120,
        },
    });
});
