// 弹幕姬 OBS 本地透明背景 HTTP/SSE 服务。
// 复用 live_room_hub 的房间长连接与 web/player/monitor/ 下的弹幕列表渲染代码，
// 供 OBS 浏览器源以透明背景接入，并实时同步控制台的显示设置、房间列表与配色。
const http = require('http');
const fs = require('fs');
const path = require('path');
const Shared = require('../web/player/monitor/danmakuji-shared');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 18390;
const HEARTBEAT_MS = 25000;
const THEME_MODES = ['dark', 'light', 'system'];

const STATIC_FILES = {
    '/': { file: 'danmakuji-obs.html', type: 'text/html; charset=utf-8' },
    '/overlay': { file: 'danmakuji-obs.html', type: 'text/html; charset=utf-8' },
    '/danmakuji-obs.html': { file: 'danmakuji-obs.html', type: 'text/html; charset=utf-8' },
    '/danmakuji.css': { file: 'danmakuji.css', type: 'text/css; charset=utf-8' },
    '/danmakuji-obs.css': { file: 'danmakuji-obs.css', type: 'text/css; charset=utf-8' },
    '/danmakuji-shared.js': { file: 'danmakuji-shared.js', type: 'application/javascript; charset=utf-8' },
    '/danmakuji-list.js': { file: 'danmakuji-list.js', type: 'application/javascript; charset=utf-8' },
    '/danmakuji-obs.js': { file: 'danmakuji-obs.js', type: 'application/javascript; charset=utf-8' },
};

function validatePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('端口号需为 1024 ~ 65535 之间的整数');
    }
    return port;
}

function normalizeThemeMode(mode) {
    return THEME_MODES.includes(mode) ? mode : 'dark';
}

function normalizeRoomMeta(room) {
    const roomId = Number(room?.roomId);
    if (!Number.isFinite(roomId) || roomId <= 0) return null;
    const title = typeof room?.title === 'string' && room.title.trim()
        ? room.title.trim()
        : `直播间 ${roomId}`;
    const anchorName = typeof room?.anchorName === 'string' ? room.anchorName.trim() : '';
    return { roomId, title, anchorName };
}

function parseRoomListParam(raw) {
    if (!raw) return [];
    const ids = [];
    for (const part of String(raw).split(/[\s,，]+/)) {
        const id = Number(part.trim());
        if (Number.isInteger(id) && id > 0 && !ids.includes(id)) {
            ids.push(id);
            if (ids.length >= Shared.MAX_ROOMS) break;
        }
    }
    return ids;
}

function formatStartError(error, port) {
    if (error?.code === 'EADDRINUSE') {
        return new Error(`端口 ${port} 已被其他程序占用，请更换端口后重试`);
    }
    if (error?.code === 'EACCES') {
        return new Error(`端口 ${port} 没有监听权限，请尝试更换端口`);
    }
    return new Error(error?.message || `启动 OBS 本地服务失败 (${port})`);
}

class DanmakujiObsServer {
    constructor(options = {}) {
        this.hub = options.hub;
        this.resolveRoom = options.resolveRoom || null;
        this.monitorDir = options.monitorDir || path.join(__dirname, '../web/player/monitor');
        this.onStatusChange = options.onStatusChange || (() => { });

        this.server = null;
        this.running = false;
        this.port = DEFAULT_PORT;
        this.autoStart = false;
        this.themeMode = 'dark';
        this.systemDark = options.systemDark !== false;
        this.displaySettings = Shared.normalizeSettings(options.displaySettings);

        this.consoleRooms = [];
        this.resolvedRooms = new Map();
        // clientId -> { id, res, mode, roomIds: Set<number>, themeOverride: 'dark'|'light'|null }
        this.clients = new Map();
        this.nextClientId = 0;
        this.heartbeatTimer = null;

        this.configure(options);
    }

    configure(config = {}) {
        if (config.port !== undefined) {
            const parsed = Number(config.port);
            if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
                this.port = parsed;
            }
        }
        if (typeof config.autoStart === 'boolean') {
            this.autoStart = config.autoStart;
        }
        if (config.themeMode !== undefined) {
            this.themeMode = normalizeThemeMode(config.themeMode);
        }
        if (typeof config.systemDark === 'boolean') {
            this.systemDark = config.systemDark;
        }
        if (config.displaySettings && typeof config.displaySettings === 'object') {
            this.displaySettings = Shared.normalizeSettings(config.displaySettings);
        }
    }

    effectiveTheme(override = null) {
        const mode = THEME_MODES.includes(override) ? override : this.themeMode;
        if (mode === 'light') return 'light';
        if (mode === 'dark') return 'dark';
        return this.systemDark ? 'dark' : 'light';
    }

    getStatus() {
        return {
            running: this.running,
            host: HOST,
            port: this.port,
            baseUrl: `http://${HOST}:${this.port}`,
            autoStart: this.autoStart,
            themeMode: this.themeMode,
            effectiveTheme: this.effectiveTheme(),
            clientCount: this.clients.size,
        };
    }

    emitStatus() {
        try {
            this.onStatusChange(this.getStatus());
        } catch (error) {
            console.warn('通知 OBS 服务状态失败:', error.message);
        }
    }

    roomMetaFor(roomId) {
        const id = Number(roomId);
        return this.consoleRooms.find(item => item.roomId === id)
            || this.resolvedRooms.get(id)
            || { roomId: id, title: `直播间 ${id}`, anchorName: '' };
    }

    roomsForClient(client) {
        if (client.mode === 'follow') return this.consoleRooms.map(item => ({ ...item }));
        return [...client.roomIds].map(id => ({ ...this.roomMetaFor(id) }));
    }

    sendSse(client, event, data) {
        if (!client?.res || client.res.writableEnded || client.res.destroyed) return false;
        try {
            client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
        } catch {
            this.removeClient(client.id);
            return false;
        }
    }

    subscribeClientRoom(client, roomId) {
        if (!this.hub || client.roomIds.has(roomId)) return;
        client.roomIds.add(roomId);
        this.hub.addListener(roomId, client.id, {
            onMessage: ({ roomId: msgRoomId, message }) => {
                if (!message || message.type === 'live_status') return;
                this.sendSse(client, 'message', { roomId: msgRoomId, message });
            },
            onStatus: ({ roomId: statusRoomId, status }) => {
                this.sendSse(client, 'status', { roomId: statusRoomId, status });
            },
        });
    }

    unsubscribeClientRoom(client, roomId) {
        if (!client.roomIds.has(roomId)) return;
        client.roomIds.delete(roomId);
        this.hub?.removeListener(roomId, client.id);
    }

    removeClient(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;
        this.clients.delete(clientId);
        client.roomIds.clear();
        this.hub?.releaseListener(clientId);
        try {
            if (!client.res.writableEnded) client.res.end();
        } catch { }
        this.emitStatus();
    }

    async resolveMissingRoomMeta(roomIds) {
        if (typeof this.resolveRoom !== 'function') return;
        const targets = roomIds.filter((id) => {
            const inConsole = this.consoleRooms.some(r => r.roomId === id && (r.anchorName || r.title));
            return !inConsole && !this.resolvedRooms.has(id);
        });
        if (!targets.length) return;

        let changed = false;
        await Promise.all(targets.map(async (id) => {
            try {
                const info = normalizeRoomMeta(await this.resolveRoom(String(id)));
                if (info) {
                    this.resolvedRooms.set(id, info);
                    changed = true;
                }
            } catch {
                // 解析失败时保留默认直播间名称，不阻塞弹幕接收
            }
        }));

        if (!changed || !this.running) return;
        for (const client of [...this.clients.values()]) {
            if (client.mode !== 'follow') {
                this.sendSse(client, 'rooms', { rooms: this.roomsForClient(client) });
            }
        }
    }

    handleSse(req, res, searchParams) {
        const singleRoom = Number(searchParams.get('room'));
        const multiRooms = parseRoomListParam(searchParams.get('rooms'));
        const rawTheme = searchParams.get('theme');
        const themeOverride = THEME_MODES.includes(rawTheme) ? rawTheme : null;

        let mode = 'follow';
        let targetRoomIds = this.consoleRooms.map(item => item.roomId);
        if (Number.isInteger(singleRoom) && singleRoom > 0) {
            mode = 'single';
            targetRoomIds = [singleRoom];
        } else if (multiRooms.length > 0) {
            mode = 'multi';
            targetRoomIds = multiRooms;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'X-Content-Type-Options': 'nosniff',
        });
        res.write('retry: 3000\n\n');

        const clientId = `obs-${++this.nextClientId}`;
        const client = {
            id: clientId,
            res,
            mode,
            roomIds: new Set(),
            themeOverride,
        };
        this.clients.set(clientId, client);

        const cleanup = () => this.removeClient(clientId);
        req.on('close', cleanup);
        res.on('close', cleanup);

        // 先下发初始配置，再订阅房间并回放连接状态
        this.sendSse(client, 'init', {
            mode,
            rooms: mode === 'follow'
                ? this.consoleRooms.map(item => ({ ...item }))
                : targetRoomIds.map(id => ({ ...this.roomMetaFor(id) })),
            settings: this.displaySettings,
            theme: this.effectiveTheme(themeOverride),
        });

        for (const roomId of targetRoomIds) {
            this.subscribeClientRoom(client, roomId);
        }

        if (mode !== 'follow') {
            this.resolveMissingRoomMeta(targetRoomIds);
        }

        this.emitStatus();
    }

    handleStatic(res, entry) {
        const filePath = path.join(this.monitorDir, entry.file);
        fs.readFile(filePath, (error, content) => {
            if (error) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': entry.type,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(content);
        });
    }

    handleRequest(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Method Not Allowed');
            return;
        }

        let parsed;
        try {
            parsed = new URL(req.url || '/', `http://${HOST}:${this.port}`);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Bad Request');
            return;
        }

        const pathname = parsed.pathname;
        if (pathname === '/events') {
            this.handleSse(req, res, parsed.searchParams);
            return;
        }
        if (pathname === '/api/state') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(JSON.stringify({
                ...this.getStatus(),
                rooms: this.consoleRooms,
                settings: this.displaySettings,
            }));
            return;
        }

        const staticEntry = STATIC_FILES[pathname];
        if (staticEntry) {
            this.handleStatic(res, staticEntry);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }

    async start(requestedPort = this.port) {
        const port = validatePort(requestedPort);
        if (this.running && this.port === port) {
            return this.getStatus();
        }
        if (this.running) {
            await this.stop();
        }

        const server = http.createServer((req, res) => this.handleRequest(req, res));
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.removeListener('listening', onListening);
                reject(formatStartError(error, port));
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, HOST);
        });

        this.server = server;
        this.port = server.address()?.port || port;
        this.running = true;

        this.heartbeatTimer = setInterval(() => {
            for (const client of [...this.clients.values()]) {
                if (client.res.writableEnded || client.res.destroyed) {
                    this.removeClient(client.id);
                    continue;
                }
                try {
                    client.res.write(': ping\n\n');
                } catch {
                    this.removeClient(client.id);
                }
            }
        }, HEARTBEAT_MS);
        this.heartbeatTimer.unref?.();

        this.emitStatus();
        return this.getStatus();
    }

    async stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const clientId of [...this.clients.keys()]) {
            this.removeClient(clientId);
        }

        const server = this.server;
        this.server = null;
        this.running = false;

        if (server) {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        }

        this.emitStatus();
        return this.getStatus();
    }

    updateSettings(settings) {
        this.displaySettings = Shared.normalizeSettings(settings);
        if (!this.running) return this.displaySettings;
        for (const client of [...this.clients.values()]) {
            this.sendSse(client, 'settings', { settings: this.displaySettings });
        }
        return this.displaySettings;
    }

    updateConsoleRooms(rooms = []) {
        const list = [];
        const seen = new Set();
        for (const item of Array.isArray(rooms) ? rooms : []) {
            const meta = normalizeRoomMeta(item);
            if (!meta || seen.has(meta.roomId)) continue;
            seen.add(meta.roomId);
            list.push(meta);
            this.resolvedRooms.set(meta.roomId, meta);
            if (list.length >= Shared.MAX_ROOMS) break;
        }
        this.consoleRooms = list;

        if (!this.running) return this.consoleRooms;

        const nextIds = new Set(list.map(item => item.roomId));
        for (const client of [...this.clients.values()]) {
            if (client.mode === 'follow') {
                for (const id of [...client.roomIds]) {
                    if (!nextIds.has(id)) this.unsubscribeClientRoom(client, id);
                }
                for (const id of nextIds) {
                    if (!client.roomIds.has(id)) this.subscribeClientRoom(client, id);
                }
            }
            this.sendSse(client, 'rooms', { rooms: this.roomsForClient(client) });
        }
        return this.consoleRooms;
    }

    updateTheme({ themeMode, systemDark } = {}) {
        if (themeMode !== undefined) this.themeMode = normalizeThemeMode(themeMode);
        if (typeof systemDark === 'boolean') this.systemDark = systemDark;

        if (this.running) {
            for (const client of [...this.clients.values()]) {
                if (client.themeOverride === 'dark' || client.themeOverride === 'light') continue;
                this.sendSse(client, 'theme', { theme: this.effectiveTheme(client.themeOverride) });
            }
        }
        this.emitStatus();
        return this.getStatus();
    }
}

module.exports = {
    DanmakujiObsServer,
    DEFAULT_PORT,
    HOST,
    THEME_MODES,
    validatePort,
};
