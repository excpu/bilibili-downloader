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

// 弹幕服务器心跳间隔，B 站要求约 30 秒，超过 60 秒未收到心跳会断开连接
const HEARTBEAT_INTERVAL = 30 * 1000;
const HEARTBEAT_TIMEOUT = 70 * 1000;
// 认证包必须在连接后 5 秒内发出，这里留出重连后的余量
const AUTH_TIMEOUT = 8 * 1000;
const CONNECT_TIMEOUT = 10 * 1000;
const DEFAULT_FALLBACK_HOST = { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };

const baseHeaders = {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function formatRequestError(error, fallback) {
    if (!error) return fallback;
    if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
        return `${fallback}（请求超时）`;
    }
    const status = error.response?.statusCode;
    if (status) return `${fallback} (HTTP ${status})`;
    const code = error.code || error.cause?.code;
    const detail = error.message || error.cause?.message;
    if (code && detail && !detail.includes(code)) return `${fallback} (${code}: ${detail})`;
    return detail || fallback;
}

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
        timeout: {
            lookup: 5000,
            connect: 8000,
            secureConnect: 8000,
            response: 12000,
            request: 15000,
        },
    });
    return res.body;
}

// 支持纯房间号、短号、直播间链接，例如 14047 / https://live.bilibili.com/14047
function parseRoomId(input) {
    const str = String(input ?? '').trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) return Number(str);
    const liveMatch = str.match(/live\.bilibili\.com\/(?:[a-z0-9]+\/)?(\d+)/i);
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
    if (Number(json.data.live_status) !== 1) {
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

function extractCookieField(cookie, name) {
    if (typeof cookie !== 'string' || !cookie) return '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
    return match ? match[1] : '';
}

function normalizeHostList(rawList) {
    const seen = new Set();
    const result = [];
    for (const item of rawList || []) {
        if (!item || !item.host) continue;
        const port = Number(item.wss_port) || 443;
        const key = `${item.host}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ...item, wss_port: port });
    }
    const fallbackKey = `${DEFAULT_FALLBACK_HOST.host}:${DEFAULT_FALLBACK_HOST.wss_port}`;
    if (result.length > 0 && !seen.has(fallbackKey)) {
        result.push({ ...DEFAULT_FALLBACK_HOST });
    }
    return result;
}

function extractSocketError(event) {
    if (!event) return '';
    const err = event.error;
    const parts = [];
    const code = err?.code || err?.cause?.code;
    if (code) parts.push(code);
    const msg = err?.cause?.message || err?.message || event.message;
    if (msg && msg !== 'WebSocket error') {
        if (!code || !msg.includes(code)) parts.push(msg);
    }
    return parts.join(': ');
}

function defaultCreateWebSocket(url) {
    const headers = {
        'User-Agent': BROWSER_UA,
        'Origin': 'https://live.bilibili.com',
    };
    try {
        return new WebSocket(url, { headers });
    } catch (error) {
        if (error?.name === 'SyntaxError' || error instanceof TypeError) {
            return new WebSocket(url);
        }
        throw error;
    }
}

async function fetchDanmuConfig(roomId) {
    const authData = await auth.ensureBuvidCredentials().catch(() => auth.load?.() || {});
    let cookie = auth.getConstructedCookie() || '';
    let buvid3 = extractCookieField(cookie, 'buvid3');
    // 接口要求 Cookie 中的 buvid3 不为空；若 b_nut 等尚未就绪也应补齐已有 buvid3
    if (!buvid3 && authData?.buvid3 && authData.buvid3 !== 'undefined') {
        buvid3 = authData.buvid3;
        cookie = cookie ? `${cookie}; buvid3=${buvid3}` : `buvid3=${buvid3}`;
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
    let keys;
    try {
        keys = await getWbiKeys(controller?.signal);
    } catch (error) {
        if (error?.name === 'AbortError' && controller?.signal.aborted) {
            throw new Error('获取 WBI 签名密钥超时');
        }
        throw new Error(formatRequestError(error, '获取 WBI 签名密钥失败'));
    } finally {
        if (timer) clearTimeout(timer);
    }

    const query = encWbi({ id: roomId, type: 0, web_location: '444.8' }, keys.img_key, keys.sub_key);
    let json;
    try {
        json = await requestJson(
            `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
            { cookie, referer: `https://live.bilibili.com/${roomId}` }
        );
    } catch (error) {
        throw new Error(formatRequestError(error, '获取弹幕服务器失败'));
    }

    if (json?.code !== 0 || !json?.data) {
        const codeText = json?.code !== undefined ? ` (${json.code})` : '';
        const extra = json?.code === -352 && !buvid3 ? '：缺少 buvid3 凭据或触发风控' : (json?.message ? `: ${json.message}` : '');
        throw new Error(`获取弹幕服务器失败${codeText}${extra}`);
    }

    // 鉴权包的 uid 必须与 getDanmuInfo 所使用的登录态 mid 一致，否则会被服务器强制断开
    const data = authData || auth.load?.() || {};
    const uid = typeof keys?.isLogin === 'boolean'
        ? (keys.isLogin && keys.mid ? Number(keys.mid) : 0)
        : (data.loginStatus && data.DedeUserID ? Number(data.DedeUserID) : 0);

    return {
        ...json.data,
        host_list: normalizeHostList(json.data.host_list),
        buvid: buvid3 || '',
        uid,
    };
}

// 直播间弹幕长连接：负责鉴权、心跳、解包（含 zlib / brotli）与断线重连
class LiveDanmakuClient {
    constructor(roomId, handlers = {}) {
        this.roomId = roomId;
        this.onMessage = handlers.onMessage || (() => { });
        this.onStatus = handlers.onStatus || (() => { });
        this.createWebSocket = handlers.createWebSocket || defaultCreateWebSocket;
        this.connectTimeoutMs = handlers.connectTimeoutMs || CONNECT_TIMEOUT;
        this.authTimeoutMs = handlers.authTimeoutMs || AUTH_TIMEOUT;
        this.heartbeatIntervalMs = handlers.heartbeatIntervalMs || HEARTBEAT_INTERVAL;
        this.heartbeatTimeoutMs = handlers.heartbeatTimeoutMs || HEARTBEAT_TIMEOUT;

        this.ws = null;
        this.stopped = false;
        this.authed = false;
        this.attempts = 0;
        this.connectSeq = 0;
        this.hostList = [];
        this.hostIndex = 0;
        this.token = '';
        this.uid = null;
        this.buvid = '';
        this.lastError = '';
        this.lastPacketAt = 0;
        this.heartbeatTimer = null;
        this.heartbeatTimeoutTimer = null;
        this.connectTimer = null;
        this.authTimer = null;
        this.reconnectTimer = null;
    }

    start() {
        this.stopped = false;
        this.lastError = '';
        this.clearTimers();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            this.detachSocket(ws);
        }
        this.connect();
    }

    stop() {
        this.stopped = true;
        this.connectSeq += 1;
        this.lastError = '';
        this.clearTimers();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            this.detachSocket(ws);
        }
    }

    clearTimers() {
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.heartbeatTimeoutTimer);
        clearTimeout(this.connectTimer);
        clearTimeout(this.authTimer);
        clearTimeout(this.reconnectTimer);
        this.heartbeatTimer = null;
        this.heartbeatTimeoutTimer = null;
        this.connectTimer = null;
        this.authTimer = null;
        this.reconnectTimer = null;
    }

    detachSocket(ws) {
        if (!ws) return;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(); } catch { }
    }

    failAndReconnect(reason, { clearConfig = false, state = 'error' } = {}) {
        if (this.stopped) return;
        this.lastError = reason;
        if (clearConfig) {
            this.token = '';
            this.hostList = [];
        }
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            this.detachSocket(ws);
        }
        this.clearTimers();
        this.onStatus({ state, message: reason });
        this.scheduleReconnect();
    }

    async ensureConfig() {
        if (this.hostList.length && this.token) return;
        const info = await fetchDanmuConfig(this.roomId);
        this.token = info.token || '';
        this.hostList = normalizeHostList(info.host_list);
        this.uid = info.uid !== undefined ? info.uid : null;
        this.buvid = info.buvid || '';
        if (!this.hostList.length) throw new Error('没有可用的弹幕服务器节点');
        if (!this.token) throw new Error('获取弹幕鉴权 token 为空');
    }

    async connect() {
        if (this.stopped) return;
        const seq = ++this.connectSeq;
        this.onStatus(this.lastError
            ? { state: 'connecting', message: this.lastError, reconnecting: true }
            : { state: 'connecting' });

        try {
            await this.ensureConfig();
        } catch (error) {
            if (this.stopped || seq !== this.connectSeq) return;
            const reason = error?.message || '获取弹幕服务器失败';
            this.lastError = reason;
            this.onStatus({ state: 'error', message: reason });
            this.scheduleReconnect();
            return;
        }
        if (this.stopped || seq !== this.connectSeq) return;

        const host = this.hostList[this.hostIndex % this.hostList.length];
        const port = host.wss_port || 443;
        const hostLabel = `${host.host}:${port}`;
        const url = `wss://${hostLabel}/sub`;
        let ws;
        try {
            ws = this.createWebSocket(url);
        } catch (error) {
            const reason = formatRequestError(error, `创建 WebSocket 连接失败 (${hostLabel})`);
            this.lastError = reason;
            this.onStatus({ state: 'error', message: reason });
            this.scheduleReconnect();
            return;
        }

        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.authed = false;
        let socketError = '';

        // Node/undici 的 WebSocket.close() 在 CONNECTING 或对方不回 Close 帧时不会立即触发 onclose，
        // 必须主动摘除回调并触发重连，否则重连会一直卡死。
        this.connectTimer = setTimeout(() => {
            if (this.ws !== ws || this.stopped) return;
            this.failAndReconnect(`连接弹幕服务器超时 (${hostLabel})`);
        }, this.connectTimeoutMs);

        ws.onopen = () => {
            if (this.ws !== ws || this.stopped) return;
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
            this.sendAuth();
            this.authTimer = setTimeout(() => {
                if (this.ws !== ws || this.stopped || this.authed) return;
                this.failAndReconnect(`弹幕服务器鉴权超时 (${hostLabel})`);
            }, this.authTimeoutMs);
        };

        ws.onmessage = (event) => {
            if (this.ws !== ws || this.stopped) return;
            this.decodeMessage(event.data)
                .then((buffer) => {
                    if (!buffer || this.ws !== ws || this.stopped) return;
                    try {
                        this.handleBuffer(buffer, hostLabel);
                    } catch (error) {
                        console.warn('解析直播弹幕失败:', error.message);
                    }
                })
                .catch((error) => {
                    console.warn('读取直播弹幕数据失败:', error.message);
                });
        };

        ws.onerror = (event) => {
            if (this.ws !== ws || this.stopped) return;
            const detail = extractSocketError(event);
            if (detail) socketError = detail;
        };

        ws.onclose = (event) => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.clearTimers();
            if (this.stopped) return;
            let reason;
            if (socketError) {
                reason = `${this.authed ? '弹幕连接中断' : '连接弹幕服务器失败'} (${hostLabel}): ${socketError}`;
            } else if (event?.reason) {
                reason = `弹幕服务器断开连接 (${hostLabel}): ${event.reason}`;
            } else if (event?.code) {
                reason = `${this.authed ? '弹幕连接已断开' : '弹幕服务器拒绝或关闭连接'} (${hostLabel}, code=${event.code})`;
            } else {
                reason = `弹幕连接已断开 (${hostLabel})`;
            }
            this.lastError = reason;
            this.onStatus({ state: 'closed', message: reason });
            this.scheduleReconnect();
        };
    }

    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) return;
        this.hostIndex += 1;
        this.attempts += 1;
        // 当前 hostList 内还有未尝试的节点时快速切换，全部节点试过一轮后再清空 token 并指数退避
        const hostCount = this.hostList.length;
        const hasMoreHosts = hostCount > 0 && this.attempts < hostCount;
        if (!hasMoreHosts) {
            this.token = '';
            this.hostList = [];
        }
        const roundAttempt = Math.max(1, this.attempts - Math.max(0, hostCount - 1));
        const delay = hasMoreHosts
            ? 500
            : Math.min(1000 * 2 ** Math.min(roundAttempt, 4), 15000);
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
        const uid = this.uid != null ? this.uid : (data.loginStatus && data.DedeUserID ? Number(data.DedeUserID) : 0);
        const buvid = this.buvid || data.buvid3 || '';
        this.send(7, JSON.stringify({
            uid,
            roomid: this.roomId,
            protover: 3,
            platform: 'web',
            type: 2,
            key: this.token,
            buvid,
        }));
    }

    handleBuffer(buffer, hostLabel = '') {
        for (const packet of decodeFrames(buffer)) {
            if (this.stopped) return;
            this.handlePacket(packet.operation, packet.version, packet.body, hostLabel);
        }
    }

    handlePacket(op, version, body, hostLabel = '') {
        this.lastPacketAt = Date.now();
        if (op === 8) {
            const text = body.toString('utf8');
            let code = 0;
            let msg = '';
            try {
                const parsed = JSON.parse(text);
                code = parsed.code ?? 0;
                msg = parsed.message || parsed.msg || '';
            } catch { }
            if (code === 0) {
                this.authed = true;
                this.attempts = 0;
                this.lastError = '';
                this.clearTimers();
                this.startHeartbeat(hostLabel);
                this.onStatus({ state: 'open' });
            } else {
                const reason = `弹幕服务器拒绝连接 (${code}${msg ? `: ${msg}` : ''})`;
                this.failAndReconnect(reason, { clearConfig: true });
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

    startHeartbeat(hostLabel = '') {
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.heartbeatTimeoutTimer);
        const scheduleWatchdog = () => {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = setTimeout(() => {
                if (this.stopped || !this.ws || !this.authed) return;
                if (Date.now() - this.lastPacketAt >= this.heartbeatTimeoutMs) {
                    const suffix = hostLabel ? ` (${hostLabel})` : '';
                    this.failAndReconnect(`弹幕服务器心跳超时${suffix}`);
                    return;
                }
                scheduleWatchdog();
            }, this.heartbeatTimeoutMs);
        };
        this.send(2, '');
        scheduleWatchdog();
        this.heartbeatTimer = setInterval(() => {
            this.send(2, '');
        }, this.heartbeatIntervalMs);
    }
}

module.exports = {
    parseRoomId,
    resolveRoom,
    fetchPlayUrl,
    fetchDanmuConfig,
    LiveDanmakuClient,
};