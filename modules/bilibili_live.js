// 直播相关接口与弹幕长连接：供「DD 监控室」使用，与下载 / 预览逻辑相互独立
const got = require('got');

const Auth = require('./auth');
const { encWbi, getWbiKeys } = require('./wbi');
const {
    decodeSocketData,
    decodeFrames,
    normalizeCommand,
    parseCommandBody,
} = require('./live_danmaku_protocol');

const auth = new Auth();

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0';

// 弹幕服务器心跳间隔，B 站要求约 30 秒
const HEARTBEAT_INTERVAL = 30 * 1000;
// 认证包必须在连接后 5 秒内发出，这里留出重连后的余量
const AUTH_TIMEOUT = 8 * 1000;
const CONNECT_TIMEOUT = 10 * 1000;

const baseHeaders = {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function requestJson(url, { referer = 'https://live.bilibili.com/', cookie } = {}) {
    const res = await got(url, {
        headers: {
            ...baseHeaders,
            'Referer': referer,
            'Origin': 'https://live.bilibili.com',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        responseType: 'json',
        http2: true,
        retry: { limit: 1 },
        timeout: { response: 15000 },
    });
    return res.body;
}

// 支持纯房间号、短号、直播间链接，例如 14047 / https://live.bilibili.com/14047
function parseRoomId(input) {
    const str = String(input ?? '').trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) return Number(str);
    const liveMatch = str.match(/live\.bilibili\.com\/(?:[a-z]+\/)?(\d+)/i);
    if (liveMatch) return Number(liveMatch[1]);
    const digits = str.match(/(\d{2,})/);
    return digits ? Number(digits[1]) : null;
}

// 短号需要先通过 room_init 换成真实房间号
async function resolveRoom(input) {
    const roomId = parseRoomId(input);
    if (!roomId) throw new Error('无法识别的直播间号');

    await auth.ensureBuvidCredentials().catch(() => { });
    const cookie = auth.getConstructedCookie();

    const init = await requestJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, { cookie });
    if (init.code !== 0 || !init.data) {
        throw new Error(init.message || `直播间 ${roomId} 不存在`);
    }
    const realRoomId = init.data.room_id;

    const info = await requestJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realRoomId}`, {
        cookie,
        referer: `https://live.bilibili.com/${realRoomId}`,
    });
    if (info.code !== 0 || !info.data) {
        throw new Error(info.message || '获取直播间信息失败');
    }

    const data = info.data;
    let anchor = { name: '', face: '', follower: 0 };
    if (data.uid) {
        try {
            const master = await requestJson(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${data.uid}`, {
                cookie,
                referer: `https://live.bilibili.com/${realRoomId}`,
            });
            if (master.code === 0 && master.data?.info) {
                anchor = {
                    name: master.data.info.uname || '',
                    face: master.data.info.face || '',
                    follower: master.data.follower_num || 0,
                };
            }
        } catch {
            // 主播资料属于可选信息，失败不影响播放
        }
    }

    return {
        roomId: realRoomId,
        shortId: init.data.short_id || 0,
        uid: data.uid,
        title: data.title || `直播间 ${realRoomId}`,
        cover: data.user_cover || data.keyframe || '',
        keyframe: data.keyframe || '',
        liveStatus: data.live_status,
        liveTime: data.live_time || '',
        online: data.online || 0,
        attention: data.attention || 0,
        areaName: data.area_name || '',
        parentAreaName: data.parent_area_name || '',
        description: data.description || '',
        anchorName: anchor.name,
        anchorFace: anchor.face,
        url: `https://live.bilibili.com/${realRoomId}`,
    };
}

// 获取直播流地址，优先返回 HTTP-FLV（可直接交给 mpegts.js 播放）
async function fetchPlayUrl(roomId, qn = 10000) {
    await auth.ensureBuvidCredentials().catch(() => { });
    const cookie = auth.getConstructedCookie();
    const query = [
        `room_id=${roomId}`,
        'protocol=0,1',
        'format=0,1,2',
        'codec=0,1',
        `qn=${qn}`,
        'platform=web',
        'ptype=8',
        'dolby=5',
        'panorama=1',
    ].join('&');

    const json = await requestJson(
        `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${query}`,
        { cookie, referer: `https://live.bilibili.com/${roomId}` }
    );

    if (json.code !== 0 || !json.data) {
        throw new Error(json.message || '获取直播流失败');
    }
    if (!json.data.live_status) {
        return { live: false };
    }

    const playurl = json.data.playurl_info?.playurl;
    if (!playurl) return { live: false };

    const qnDesc = new Map((playurl.g_qn_desc || []).map(item => [item.qn, item.desc]));
    const candidates = [];

    for (const stream of playurl.stream || []) {
        const isFlv = stream.protocol_name === 'http_stream';
        for (const format of stream.format || []) {
            for (const codec of format.codec || []) {
                const urls = (codec.url_info || [])
                    .map(info => (info.host || '') + (codec.base_url || '') + (info.extra || ''))
                    .filter(url => url.startsWith('http'));
                if (!urls.length) continue;
                candidates.push({
                    format: isFlv ? 'flv' : 'hls',
                    qn: codec.current_qn,
                    qnName: qnDesc.get(codec.current_qn) || String(codec.current_qn || ''),
                    codec: codec.codec_name || '',
                    urls,
                    score: (isFlv ? 100 : 0) + (codec.codec_name === 'avc' ? 10 : 0),
                });
            }
        }
    }

    if (!candidates.length) {
        throw new Error('未获取到可播放的直播流');
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    return {
        live: true,
        format: best.format,
        qn: best.qn,
        qnName: best.qnName,
        urls: best.urls,
        acceptQn: (playurl.stream || [])
            .flatMap(stream => (stream.format || []).flatMap(f => (f.codec || []).flatMap(c => c.accept_qn || [])))
            .filter((value, index, arr) => arr.indexOf(value) === index),
    };
}

async function fetchDanmuConfig(roomId) {
    await auth.ensureBuvidCredentials().catch(() => { });
    const keys = await getWbiKeys();
    const query = encWbi({ id: roomId, type: 0, web_location: '444.8' }, keys.img_key, keys.sub_key);
    const json = await requestJson(
        `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
        { cookie: auth.getConstructedCookie(), referer: `https://live.bilibili.com/${roomId}` }
    );
    if (json.code !== 0 || !json.data) {
        throw new Error(json.message || '获取弹幕服务器失败');
    }
    return json.data;
}

// 直播间弹幕长连接：负责鉴权、心跳、解包（含 zlib / brotli）与断线重连
class LiveDanmakuClient {
    constructor(roomId, handlers = {}) {
        this.roomId = roomId;
        this.onMessage = handlers.onMessage || (() => { });
        this.onStatus = handlers.onStatus || (() => { });

        this.ws = null;
        this.stopped = false;
        this.authed = false;
        this.attempts = 0;
        this.hostList = [];
        this.hostIndex = 0;
        this.token = '';
        this.heartbeatTimer = null;
        this.connectTimer = null;
        this.authTimer = null;
        this.reconnectTimer = null;
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        this.clearTimers();
        if (this.ws) {
            try { this.ws.close(); } catch { }
            this.ws = null;
        }
    }

    clearTimers() {
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.connectTimer);
        clearTimeout(this.authTimer);
        clearTimeout(this.reconnectTimer);
        this.heartbeatTimer = null;
        this.connectTimer = null;
        this.authTimer = null;
        this.reconnectTimer = null;
    }

    async ensureConfig() {
        if (this.hostList.length && this.token) return;
        const info = await fetchDanmuConfig(this.roomId);
        this.token = info.token || '';
        this.hostList = (info.host_list || []).filter(host => host && host.host);
        if (!this.hostList.length) throw new Error('没有可用的弹幕服务器节点');
    }

    async connect() {
        if (this.stopped) return;
        this.onStatus({ state: 'connecting' });

        try {
            await this.ensureConfig();
        } catch (error) {
            this.onStatus({ state: 'error', message: error.message });
            this.scheduleReconnect();
            return;
        }

        const host = this.hostList[this.hostIndex % this.hostList.length];
        const url = `wss://${host.host}:${host.wss_port || 443}/sub`;
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (error) {
            this.onStatus({ state: 'error', message: error.message });
            this.scheduleReconnect();
            return;
        }

        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.authed = false;
        this.connectTimer = setTimeout(() => {
            if (this.ws !== ws || this.stopped) return;
            this.connectTimer = null;
            this.onStatus({ state: 'error', message: '连接弹幕服务器超时' });
            try { ws.close(); } catch { }
        }, CONNECT_TIMEOUT);

        ws.onopen = () => {
            if (this.stopped) return;
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
            this.sendAuth();
            this.authTimer = setTimeout(() => {
                if (!this.authed) {
                    this.onStatus({ state: 'error', message: '弹幕服务器鉴权超时' });
                    try { ws.close(); } catch { }
                }
            }, AUTH_TIMEOUT);
        };

        ws.onmessage = (event) => {
            if (this.stopped) return;
            this.decodeMessage(event.data)
                .then((buffer) => {
                    if (!buffer || this.stopped) return;
                    try {
                        this.handleBuffer(buffer);
                    } catch (error) {
                        console.warn('解析直播弹幕失败:', error.message);
                    }
                })
                .catch((error) => {
                    console.warn('读取直播弹幕数据失败:', error.message);
                });
        };

        ws.onerror = () => {
            // 具体原因由 onclose 统一处理，避免重复重连
        };

        ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            this.clearTimers();
            if (this.stopped) return;
            this.onStatus({ state: 'closed' });
            this.scheduleReconnect();
        };
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.hostIndex += 1;
        // 换节点时清空 token，避免拿到已失效的鉴权信息
        if (this.attempts >= this.hostList.length) {
            this.token = '';
            this.hostList = [];
        }
        this.attempts += 1;
        const delay = Math.min(1000 * 2 ** Math.min(this.attempts, 4), 15000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    async decodeMessage(data) {
        return decodeSocketData(data);
    }

    send(op, body) {
        if (!this.ws || this.ws.readyState !== 1) return;
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
        const header = Buffer.alloc(16);
        header.writeUInt32BE(16 + payload.length, 0);
        header.writeUInt16BE(16, 4);
        header.writeUInt16BE(1, 6);
        header.writeUInt32BE(op, 8);
        header.writeUInt32BE(1, 12);
        try {
            this.ws.send(Buffer.concat([header, payload]));
        } catch (error) {
            console.warn('发送弹幕包失败:', error.message);
        }
    }

    sendAuth() {
        const data = auth.load() || {};
        const uid = data.loginStatus && data.DedeUserID ? Number(data.DedeUserID) : 0;
        this.send(7, JSON.stringify({
            uid,
            roomid: this.roomId,
            protover: 3,
            platform: 'web',
            type: 2,
            key: this.token,
            buvid: data.buvid3 || '',
        }));
    }

    handleBuffer(buffer) {
        for (const packet of decodeFrames(buffer)) {
            this.handlePacket(packet.operation, packet.version, packet.body);
        }
    }

    handlePacket(op, version, body) {
        if (op === 8) {
            const text = body.toString('utf8');
            let code = 0;
            try { code = JSON.parse(text).code ?? 0; } catch { }
            if (code === 0) {
                this.authed = true;
                this.attempts = 0;
                this.clearTimers();
                this.startHeartbeat();
                this.onStatus({ state: 'open' });
            } else {
                this.onStatus({ state: 'error', message: `弹幕服务器拒绝连接 (${code})` });
                try { this.ws?.close(); } catch { }
            }
            return;
        }

        if (op === 3) {
            // 心跳回复，部分节点返回纯数字人气值
            return;
        }

        if (op !== 5 || version !== 0) return;
        for (const packet of parseCommandBody(body)) {
            this.emitCommand(packet);
        }
    }

    emitCommand(packet) {
        const message = normalizeCommand(packet);
        if (!message) return;
        if (message.type === 'live_status') this.attempts = 0;
        try {
            this.onMessage(message);
        } catch (error) {
            // 下游 IPC / UI 分发异常不应被误报为 WebSocket 数据包解析失败
            console.error('分发直播弹幕失败:', error.message);
        }
    }

    startHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            this.send(2, '');
        }, HEARTBEAT_INTERVAL);
    }
}

module.exports = {
    parseRoomId,
    resolveRoom,
    fetchPlayUrl,
    fetchDanmuConfig,
    LiveDanmakuClient,
};