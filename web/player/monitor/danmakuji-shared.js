// 弹幕姬共享逻辑：显示设置、消息过滤与房间列表维护。
// 独立窗口弹幕姬与多房间弹幕姬控制台共用，纯函数部分可直接在 Node 中测试。
(function (global) {
    const FONT_SIZE_MIN = 11;
    const FONT_SIZE_MAX = 22;
    const COLUMN_VALUES = ['auto', 1, 2, 3, 4];
    const DENSITY_GAP = { compact: 0, normal: 3, loose: 7 };
    const MAX_ROOMS = 12;
    const MAX_RECENT = 10;
    const RATE_WINDOW = 60 * 1000;

    const DEFAULT_SETTINGS = {
        fontSize: 13,
        density: 'normal',
        columns: 'auto',
        showMedal: true,
        showWealth: true,
        showSuperchat: true,
        superchatOnly: false,
        showEnter: false,
        showGift: false,
        showTimestamp: false,
        highlightGuard: true,
        autoScroll: true,
        keyword: '',
        blocked: '',
    };

    function toNumber(value, fallback) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function normalizeSettings(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const settings = { ...DEFAULT_SETTINGS };

        settings.fontSize = Math.round(clamp(
            toNumber(source.fontSize, DEFAULT_SETTINGS.fontSize),
            FONT_SIZE_MIN,
            FONT_SIZE_MAX
        ));
        if (Object.prototype.hasOwnProperty.call(DENSITY_GAP, source.density)) {
            settings.density = source.density;
        }
        const columns = source.columns === 'auto' ? 'auto' : toNumber(source.columns, NaN);
        if (COLUMN_VALUES.includes(columns)) settings.columns = columns;

        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof source[key] === 'boolean') {
                settings[key] = source[key];
            }
        }
        if (typeof source.keyword === 'string') settings.keyword = source.keyword.slice(0, 60);
        if (typeof source.blocked === 'string') settings.blocked = source.blocked.slice(0, 200);
        return settings;
    }

    function densityGap(density) {
        return DENSITY_GAP[density] ?? DENSITY_GAP.normal;
    }

    // 与主进程 parseRoomId 保持一致：纯房间号、短号或直播间链接
    function parseRoomInput(input) {
        const str = String(input ?? '').trim();
        if (!str) return null;
        if (/^\d+$/.test(str)) return Number(str);
        const liveMatch = str.match(/live\.bilibili\.com\/(?:[a-z0-9]+\/)?(\d+)/i);
        if (liveMatch) return Number(liveMatch[1]);
        return null;
    }

    // 屏蔽词支持中英文逗号、顿号与空格分隔
    function splitKeywords(text) {
        return String(text || '')
            .split(/[,，、\s]+/)
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);
    }

    function messageText(message) {
        return `${message?.text || ''} ${message?.user || ''}`.toLowerCase();
    }

    // 过滤在消息入列时进行：被过滤的弹幕不占用历史，也不参与滚动高度计算
    function shouldShowMessage(message, settings) {
        if (!message || typeof message !== 'object') return false;
        const prefs = settings || DEFAULT_SETTINGS;
        if (prefs.superchatOnly && message.type !== 'superchat') return false;

        switch (message.type) {
            case 'danmaku':
                if (!message.text && !message.sticker) return false;
                break;
            case 'superchat':
                if (!prefs.showSuperchat || !message.text) return false;
                break;
            case 'enter':
                if (!prefs.showEnter || !message.user) return false;
                break;
            case 'gift':
                if (!prefs.showGift || !message.text) return false;
                break;
            default:
                return false;
        }

        const haystack = messageText(message);
        const keyword = String(prefs.keyword || '').trim().toLowerCase();
        if (keyword && !haystack.includes(keyword)) return false;

        const blocked = splitKeywords(prefs.blocked);
        if (blocked.some(word => haystack.includes(word))) return false;
        return true;
    }

    function formatClock(timestamp) {
        const date = new Date(timestamp || Date.now());
        const pad = value => String(value).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // 导出为纯文本：保留时间、身份与金额信息，表情占位符原样保留
    function messageToLine(message) {
        const time = formatClock(message?._at);
        const user = message?.user || '神秘用户';
        if (message?.type === 'superchat') {
            return `[${time}] 【醒目留言 ￥${Number(message.price) || 0}】${user}: ${message.text || ''}`;
        }
        if (message?.type === 'gift' || message?.type === 'enter') {
            return `[${time}] ${message.text || ''}`;
        }
        const medal = message?.medalName ? `[${message.medalName} ${message.medalLevel || 0}] ` : '';
        return `[${time}] ${medal}${user}: ${message?.text || '[表情]'}`;
    }

    // 只保留调用方明确给出的字段，便于与已有记录合并时不覆盖旧值
    function normalizeRoom(room) {
        const roomId = Number(room?.roomId);
        if (!Number.isFinite(roomId) || roomId <= 0) return null;
        const result = { roomId };
        if (room.shortId !== undefined) result.shortId = Number(room.shortId) || 0;
        if (room.title !== undefined && String(room.title).trim()) result.title = String(room.title);
        if (room.anchorName !== undefined && String(room.anchorName).trim()) result.anchorName = String(room.anchorName);
        if (room.liveStatus !== undefined) result.liveStatus = Number(room.liveStatus) || 0;
        return result;
    }

    function withRoomDefaults(room) {
        return {
            shortId: 0,
            title: `直播间 ${room.roomId}`,
            anchorName: '',
            liveStatus: 0,
            ...room,
        };
    }

    // 同一房间只保留一列；重复添加时移到最前并刷新标题等信息
    function upsertRoom(rooms, room, max = MAX_ROOMS) {
        const normalized = normalizeRoom(room);
        if (!normalized) return { rooms: rooms.slice(0, max), added: false, room: null };
        const rest = rooms.filter(item => item.roomId !== normalized.roomId);
        const merged = withRoomDefaults({ ...(rooms.find(item => item.roomId === normalized.roomId) || {}), ...normalized });
        return {
            rooms: [merged, ...rest].slice(0, max),
            added: rest.length === rooms.length,
            room: merged,
        };
    }

    function moveRoom(rooms, from, to) {
        if (from === to || from < 0 || to < 0 || from >= rooms.length || to >= rooms.length) {
            return rooms.slice();
        }
        const next = rooms.slice();
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return next;
    }

    function rememberRecent(recent, room, max = MAX_RECENT) {
        const normalized = normalizeRoom(room);
        if (!normalized) return recent.slice(0, max);
        const full = withRoomDefaults(normalized);
        return [
            { roomId: full.roomId, title: full.title, anchorName: full.anchorName },
            ...recent.filter(item => item.roomId !== normalized.roomId),
        ].slice(0, max);
    }

    function removeRecent(recent, roomId) {
        const targetId = Number(roomId);
        if (!Array.isArray(recent)) return [];
        if (!Number.isFinite(targetId) || targetId <= 0) return recent.slice();
        return recent.filter(item => Number(item?.roomId) !== targetId);
    }

    // 滚动窗口内的弹幕速率（条/分），timestamps 为入列时间数组
    function formatRate(timestamps, now = Date.now(), windowMs = RATE_WINDOW) {
        const from = now - windowMs;
        let count = 0;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] < from) break;
            count++;
        }
        const elapsed = Math.min(windowMs, Math.max(1000, now - (timestamps[0] ?? now)));
        const rate = count / (elapsed / 60000);
        if (rate >= 100) return String(Math.round(rate));
        return rate.toFixed(1);
    }

    const api = {
        DEFAULT_SETTINGS,
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
        MAX_ROOMS,
        MAX_RECENT,
        RATE_WINDOW,
        normalizeSettings,
        densityGap,
        parseRoomInput,
        splitKeywords,
        shouldShowMessage,
        formatClock,
        messageToLine,
        normalizeRoom,
        upsertRoom,
        moveRoom,
        rememberRecent,
        removeRecent,
        formatRate,
    };

    global.DanmakujiShared = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);