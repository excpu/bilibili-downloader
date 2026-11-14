// 直播弹幕订阅中心：按房间复用一条长连接，按「渲染进程 + 订阅位」引用计数。
// DD 监控室与弹幕姬控制台共用，任一窗口关闭只释放自己的订阅，不影响其它窗口。
const { webContents } = require('electron');
const { LiveDanmakuClient } = require('./bilibili_live');

const DEFAULT_CHANNELS = {
    message: 'monitor:danmaku',
    status: 'monitor:danmaku-status',
};

// roomId -> { client, lastStatus, subscribers: Map<webContentsId, Map<tile, channels>>, listeners: Map<listenerId, { onMessage, onStatus }> }
const rooms = new Map();
// 已挂载 destroyed 监听的渲染进程，避免重复注册
const watchedContents = new Set();

function resolveWebContents(id) {
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() ? wc : null;
}

function sendTo(webContentsId, channel, payload) {
    const wc = resolveWebContents(webContentsId);
    if (!wc) return false;
    try {
        wc.send(channel, payload);
        return true;
    } catch (error) {
        console.warn('发送直播弹幕到渲染进程失败:', error.message);
        return false;
    }
}

function broadcast(roomId, kind, payload) {
    const entry = rooms.get(roomId);
    if (!entry) return;
    for (const [id, tiles] of entry.subscribers) {
        // 同一渲染进程可能用不同订阅位订阅同一房间，按频道去重后只发一次
        const channels = new Set();
        for (const channelsOfTile of tiles.values()) {
            channels.add(channelsOfTile[kind]);
        }
        for (const channel of channels) {
            if (!sendTo(id, channel, { roomId, ...payload })) {
                releaseContents(id);
                break;
            }
        }
    }
    for (const listener of entry.listeners.values()) {
        try {
            if (kind === 'message') listener.onMessage?.({ roomId, ...payload });
            else if (kind === 'status') listener.onStatus?.({ roomId, ...payload });
        } catch (error) {
            console.warn('分发直播弹幕到监听器失败:', error.message);
        }
    }
}

function ensureRoom(roomId) {
    const room = Number(roomId);
    if (!Number.isFinite(room) || room <= 0) throw new Error('缺少直播间号');
    let entry = rooms.get(room);
    let fresh = false;
    if (!entry) {
        entry = {
            client: null,
            lastStatus: { state: 'connecting' },
            subscribers: new Map(),
            listeners: new Map(),
        };
        entry.client = new LiveDanmakuClient(room, {
            onMessage: (message) => broadcast(room, 'message', { message }),
            onStatus: (status) => {
                entry.lastStatus = status;
                broadcast(room, 'status', { status });
            },
        });
        rooms.set(room, entry);
        fresh = true;
    }
    return { room, entry, fresh };
}

function cleanupRoom(roomId, entry) {
    if (!entry.subscribers.size && !entry.listeners.size) {
        entry.client.stop();
        rooms.delete(roomId);
    }
}

function watchContents(id) {
    if (watchedContents.has(id)) return;
    const wc = resolveWebContents(id);
    if (!wc) return;
    watchedContents.add(id);
    const onDestroyed = () => {
        wc.removeListener('destroyed', onDestroyed);
        releaseContents(id);
    };
    wc.on('destroyed', onDestroyed);
}

// 订阅一个房间；tile 用于区分同一窗口内的多个画面 / 多列
function subscribe(roomId, webContentsId, tile = 'default', channels = {}) {
    const merged = { ...DEFAULT_CHANNELS, ...channels };
    const { room, entry, fresh } = ensureRoom(roomId);

    let tiles = entry.subscribers.get(webContentsId);
    if (!tiles) {
        tiles = new Map();
        entry.subscribers.set(webContentsId, tiles);
        watchContents(webContentsId);
    }
    tiles.set(String(tile), merged);

    // 先登记订阅再启动：start() 可能同步回调状态，此时订阅者必须已经就位
    if (fresh) entry.client.start();

    // 状态只在变化时广播，后加入的订阅者需要补发，否则会一直停在「连接中」
    sendTo(webContentsId, merged.status, { roomId: room, status: entry.lastStatus });
    return entry.lastStatus;
}

function unsubscribe(roomId, webContentsId, tile = 'default') {
    const room = Number(roomId);
    const entry = rooms.get(room);
    if (!entry) return;
    const tiles = entry.subscribers.get(webContentsId);
    if (tiles) {
        tiles.delete(String(tile));
        if (!tiles.size) entry.subscribers.delete(webContentsId);
    }
    cleanupRoom(room, entry);
}

// 注册主进程内监听器（供本地 OBS HTTP/SSE 服务等非渲染进程订阅复用连接）
function addListener(roomId, listenerId, handlers = {}) {
    const { room, entry, fresh } = ensureRoom(roomId);
    entry.listeners.set(String(listenerId), {
        onMessage: handlers.onMessage,
        onStatus: handlers.onStatus,
    });
    if (fresh) entry.client.start();
    try {
        handlers.onStatus?.({ roomId: room, status: entry.lastStatus });
    } catch { }
    return entry.lastStatus;
}

function removeListener(roomId, listenerId) {
    const room = Number(roomId);
    const entry = rooms.get(room);
    if (!entry) return;
    entry.listeners.delete(String(listenerId));
    cleanupRoom(room, entry);
}

function releaseListener(listenerId) {
    const key = String(listenerId);
    for (const [roomId, entry] of [...rooms]) {
        if (!entry.listeners.delete(key)) continue;
        cleanupRoom(roomId, entry);
    }
}

// 释放某个渲染进程的全部订阅（窗口关闭 / 销毁时调用，可重复调用）
function releaseContents(webContentsId) {
    watchedContents.delete(webContentsId);
    for (const [roomId, entry] of [...rooms]) {
        if (!entry.subscribers.delete(webContentsId)) continue;
        cleanupRoom(roomId, entry);
    }
}

function statusOf(roomId) {
    return rooms.get(Number(roomId))?.lastStatus || null;
}

function activeRoomCount() {
    return rooms.size;
}

function disposeAll() {
    for (const [roomId, entry] of [...rooms]) {
        entry.client.stop();
        rooms.delete(roomId);
    }
    watchedContents.clear();
}

module.exports = {
    DEFAULT_CHANNELS,
    subscribe,
    unsubscribe,
    addListener,
    removeListener,
    releaseListener,
    releaseContents,
    statusOf,
    activeRoomCount,
    disposeAll,
};