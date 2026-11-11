const zlib = require('zlib');

const HEADER_LENGTH = 16;
const MAX_NESTING_DEPTH = 8;

async function decodeSocketData(data) {
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === 'string') return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
        return Buffer.from(data);
    }
    if (data && typeof data.arrayBuffer === 'function') {
        return Buffer.from(await data.arrayBuffer());
    }
    return null;
}

function decodeFrames(buffer, depth = 0) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('直播弹幕数据不是 Buffer');
    if (depth > MAX_NESTING_DEPTH) throw new Error('直播弹幕压缩包嵌套过深');

    const packets = [];
    let offset = 0;
    while (offset < buffer.length) {
        if (buffer.length - offset < HEADER_LENGTH) {
            throw new Error('直播弹幕包头不完整');
        }

        const totalLength = buffer.readUInt32BE(offset);
        const headerLength = buffer.readUInt16BE(offset + 4);
        const version = buffer.readUInt16BE(offset + 6);
        const operation = buffer.readUInt32BE(offset + 8);

        if (
            totalLength < HEADER_LENGTH
            || headerLength < HEADER_LENGTH
            || headerLength > totalLength
            || offset + totalLength > buffer.length
        ) {
            throw new Error('直播弹幕包长度无效');
        }

        const body = buffer.subarray(offset + headerLength, offset + totalLength);
        if (operation === 5 && version === 2) {
            packets.push(...decodeFrames(zlib.inflateSync(body), depth + 1));
        } else if (operation === 5 && version === 3) {
            packets.push(...decodeFrames(zlib.brotliDecompressSync(body), depth + 1));
        } else {
            packets.push({ operation, version, body });
        }
        offset += totalLength;
    }
    return packets;
}

function normalizeCommand(packet) {
    const cmd = String(packet?.cmd || '').split(':')[0];
    const data = packet?.data || {};

    switch (cmd) {
        case 'DANMU_MSG': {
            const info = packet.info || [];
            const meta = Array.isArray(info[0]) ? info[0] : [];
            const user = Array.isArray(info[2]) ? info[2] : [];
            const medal = Array.isArray(info[3]) ? info[3] : [];
            const extra = info[4] && typeof info[4] === 'object' ? info[4] : {};
            const text = String(info[1] ?? '').trim();
            if (!text) return null;
            const color = Number(meta[3]);
            return {
                type: 'danmaku',
                text,
                user: String(user[1] || ''),
                uid: Number(user[0]) || 0,
                color: Number.isFinite(color) ? `#${(color & 0xffffff).toString(16).padStart(6, '0')}` : '#ffffff',
                mode: Number(meta[1]) || 1,
                // 弹幕姬需要的用户身份：等级、大航海、粉丝勋章
                level: Number(extra.level_info?.current_level) || 0,
                guardLevel: Number(extra.guard_level || medal[4]) || 0,
                medalName: String(medal[0] || ''),
                medalLevel: Number(medal[1]) || 0,
                medalRoom: Number(medal[3]) || 0,
            };
        }
        case 'SUPER_CHAT_MESSAGE': {
            const scText = String(data.message || '').trim();
            if (!scText) return null;
            return {
                type: 'superchat',
                text: scText,
                user: String(data.user_info?.uname || ''),
                price: Number(data.price) || 0,
                // 官方展示时长（秒），用于估算卡片保留时间
                duration: Number(data.time) || 0,
            };
        }
        case 'SEND_GIFT':
            return {
                type: 'gift',
                text: `${data.uname || ''} 赠送 ${data.giftName || ''} ×${data.num || 1}`,
                user: String(data.uname || ''),
                giftName: String(data.giftName || ''),
                num: Number(data.num) || 1,
                price: Number(data.total_coin) || 0,
            };
        case 'WATCHED_CHANGE':
            return { type: 'watched', value: Number(data.num) || 0, text: `${data.num || 0} 看过` };
        case 'ONLINE_RANK_COUNT':
            return { type: 'online', value: Number(data.count) || 0 };
        case 'INTERACT_WORD':
            return { type: 'enter', text: `${data.uname || ''} 进入直播间`, user: String(data.uname || '') };
        case 'LIVE':
            return { type: 'live_status', value: 1 };
        case 'PREPARING':
            return { type: 'live_status', value: 0 };
        case 'ROOM_REAL_TIME_MESSAGE_UPDATE':
            return { type: 'room_fans', value: Number(data.fans) || 0, fansClub: Number(data.fans_club) || 0 };
        default:
            return null;
    }
}

function parseCommandBody(body) {
    const text = body.toString('utf8');
    if (!text) return [];
    const packet = JSON.parse(text);
    return Array.isArray(packet) ? packet : [packet];
}

module.exports = {
    decodeSocketData,
    decodeFrames,
    normalizeCommand,
    parseCommandBody,
};
