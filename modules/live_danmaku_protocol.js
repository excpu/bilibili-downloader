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

function httpsUrl(url) {
    return typeof url === 'string' && url ? url.replace(/^http:\/\//, 'https://') : '';
}

function hexFromInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '';
    return `#${(Math.trunc(num) & 0xffffff).toString(16).padStart(6, '0')}`;
}

function normalizeCssColor(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed) ? trimmed : '';
}

function parseJsonObject(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// 从 DANMU_MSG 的 meta[15].extra 中解析行内表情映射（emots）
// 结构：{ "[热]": { descript, url, width, height, ... } }，key 即文本中的占位符
function extractEmotes(extraObj) {
    if (!extraObj?.emots || typeof extraObj.emots !== 'object') return null;
    const emotes = {};
    for (const [key, emote] of Object.entries(extraObj.emots)) {
        const url = httpsUrl(emote?.url);
        if (!url) continue;
        emotes[key] = {
            id: Number(emote.emoticon_id) || 0,
            url,
            width: Number(emote.width) || 0,
            height: Number(emote.height) || 0,
        };
    }
    return Object.keys(emotes).length ? emotes : null;
}

// 从 DANMU_MSG 的 info[0][12]/[13] 解析直播间专属大表情贴纸（dm_type === 1）
function extractSticker(meta, extraObj) {
    const dmType = Number(meta[12] ?? extraObj?.dm_type) || 0;
    const rawSticker = parseJsonObject(meta[13]);
    const url = httpsUrl(rawSticker?.url);
    if (!url || (dmType !== 1 && !rawSticker?.emoticon_unique)) return null;
    return {
        url,
        width: Number(rawSticker.width) || 0,
        height: Number(rawSticker.height) || 0,
    };
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
            const ul = Array.isArray(info[4]) ? info[4] : [];
            const wealthArr = Array.isArray(info[16]) ? info[16] : [];

            const meta15 = meta[15] && typeof meta[15] === 'object' ? meta[15] : null;
            const extraObj = parseJsonObject(meta15?.extra);
            const uinfo = meta15?.user && typeof meta15.user === 'object' ? meta15.user : null;
            const uBase = uinfo?.base && typeof uinfo.base === 'object' ? uinfo.base : null;
            const uMedal = uinfo?.medal && typeof uinfo.medal === 'object' ? uinfo.medal : null;

            const sticker = extractSticker(meta, extraObj);
            const text = String(info[1] ?? '').trim();
            if (!text && !sticker) return null;

            const color = Number(meta[3]);
            const result = {
                type: 'danmaku',
                text,
                user: String(user[1] || uBase?.name || ''),
                uid: Number(user[0] || uinfo?.uid) || 0,
                color: Number.isFinite(color) ? `#${(color & 0xffffff).toString(16).padStart(6, '0')}` : '#ffffff',
                mode: Number(meta[1]) || 1,
            };

            const nameColor = normalizeCssColor(uBase?.name_color_str || user[7]) || hexFromInt(uBase?.name_color);
            if (nameColor) result.nameColor = nameColor;

            if (Number(user[2]) === 1) result.isAdmin = true;

            const rank = Number(ul[4]) || 0;
            if (rank >= 1 && rank <= 3) result.rank = rank;

            const wealthLevel = Number(wealthArr[0] || uinfo?.wealth?.level) || 0;
            if (wealthLevel > 0) result.wealthLevel = wealthLevel;

            const ulLevel = Number(ul[0]) || 0;
            if (ulLevel > 0) result.level = ulLevel;

            // info[7] 为当前直播间大航海身份：1 总督 / 2 提督 / 3 舰长
            const guardLevel = Number(info[7] || uinfo?.guard?.level) || 0;
            if (guardLevel >= 1 && guardLevel <= 3) result.guardLevel = guardLevel;

            // info[3] 下标：0 等级, 1 名称, 3 房间号, 4 颜色, 7 边框色, 8 起始色, 9 结束色, 10 大航海, 11 点亮
            const medalName = String(uMedal?.name ?? medal[1] ?? '');
            const medalLevel = Number(uMedal?.level ?? medal[0]) || 0;
            if (medalName) {
                result.medalName = medalName;
                result.medalLevel = medalLevel;
                const medalRoom = Number(medal[3]) || 0;
                if (medalRoom) result.medalRoom = medalRoom;

                const medalGuard = Number(uMedal?.guard_level ?? medal[10]) || 0;
                if (medalGuard >= 1 && medalGuard <= 3) result.medalGuardLevel = medalGuard;

                const guardIcon = httpsUrl(uMedal?.guard_icon);
                if (guardIcon) result.medalGuardIcon = guardIcon;

                const rawLight = uMedal?.is_light ?? medal[11];
                if (rawLight !== undefined && Number(rawLight) === 0) {
                    result.medalLight = false;
                }

                const startColor = normalizeCssColor(uMedal?.v2_medal_color_start)
                    || hexFromInt(uMedal?.color_start ?? medal[8] ?? medal[4]);
                const endColor = normalizeCssColor(uMedal?.v2_medal_color_end)
                    || hexFromInt(uMedal?.color_end ?? medal[9] ?? medal[4]);
                const borderColor = normalizeCssColor(uMedal?.v2_medal_color_border)
                    || hexFromInt(uMedal?.color_border ?? medal[7] ?? medal[4]);
                if (startColor) result.medalColorStart = startColor;
                if (endColor) result.medalColorEnd = endColor;
                if (borderColor) result.medalColorBorder = borderColor;
            }

            const emotes = extractEmotes(extraObj);
            if (emotes) result.emotes = emotes;
            if (sticker) result.sticker = sticker;

            return result;
        }
        case 'SUPER_CHAT_MESSAGE': {
            const scText = String(data.message || '').trim();
            if (!scText) return null;
            const scResult = {
                type: 'superchat',
                text: scText,
                user: String(data.user_info?.uname || ''),
                price: Number(data.price) || 0,
                // 官方展示时长（秒），用于估算卡片保留时间
                duration: Number(data.time) || 0,
            };
            const scGuard = Number(data.user_info?.guard_level || data.medal_info?.guard_level) || 0;
            if (scGuard >= 1 && scGuard <= 3) scResult.guardLevel = scGuard;
            const headerBg = normalizeCssColor(data.background_bottom_color);
            const bodyBg = normalizeCssColor(data.background_color);
            if (headerBg) scResult.headerBg = headerBg;
            if (bodyBg) scResult.bodyBg = bodyBg;
            if (data.medal_info?.medal_name) {
                scResult.medalName = String(data.medal_info.medal_name);
                scResult.medalLevel = Number(data.medal_info.medal_level) || 0;
                if (scGuard >= 1 && scGuard <= 3) scResult.medalGuardLevel = scGuard;
            }
            return scResult;
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
