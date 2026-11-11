// DD 监控室：独立的窗口、IPC 与直播间数据通道，不与下载 / 主界面逻辑耦合
const { ipcMain, BrowserWindow, webContents } = require('electron');
const path = require('path');

const theme = require('../modules/theme');
const {
    resolveRoom,
    fetchPlayUrl,
    LiveDanmakuClient,
} = require('../modules/bilibili_live');

// 顶栏与页面底色，与 monitor.css 中的取值保持一致
const MONITOR_THEME = {
    height: 44,
    background: { light: '#f5f6f8', dark: '#0e0e10' },
};

let monitorWindow = null;
// 每个直播间一条弹幕连接：roomId -> { client, subscribers:Map<webContentsId, Set<tileIndex>> }
const roomClients = new Map();
// 独立窗口弹幕姬：roomId -> BrowserWindow
const danmakujiWindows = new Map();

function resolveWebContents(id) {
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() ? wc : null;
}

function broadcast(roomId, channel, payload) {
    for (const id of roomClients.get(roomId)?.subscribers.keys() || []) {
        const wc = resolveWebContents(id);
        if (!wc) continue;
        try {
            wc.send(channel, { roomId, ...payload });
        } catch (error) {
            console.warn('发送监控室弹幕到渲染进程失败:', error.message);
        }
    }
}

function startRoomClient(roomId, webContentsId, tileIndex) {
    let entry = roomClients.get(roomId);
    if (!entry) {
        const client = new LiveDanmakuClient(roomId, {
            onMessage: (message) => broadcast(roomId, 'monitor:danmaku', { message }),
            onStatus: (status) => {
                entry.lastStatus = status;
                broadcast(roomId, 'monitor:danmaku-status', { status });
            },
        });
        entry = { client, subscribers: new Map(), lastStatus: { state: 'connecting' } };
        roomClients.set(roomId, entry);
        client.start();
    }
    let tiles = entry.subscribers.get(webContentsId);
    if (!tiles) {
        tiles = new Set();
        entry.subscribers.set(webContentsId, tiles);
    }
    tiles.add(tileIndex);

    // 状态变化只在连接时广播一次，后加入的订阅者需要补发当前状态，否则会一直停在「连接中」
    const wc = resolveWebContents(webContentsId);
    if (wc) {
        try {
            wc.send('monitor:danmaku-status', { roomId, status: entry.lastStatus });
        } catch (error) {
            console.warn('补发弹幕连接状态失败:', error.message);
        }
    }
}

// 同一房间可以被多个画面同时观看，按订阅者分别退订，最后一个退订时才断开连接
function stopRoomClient(roomId, webContentsId, tileIndex) {
    const entry = roomClients.get(roomId);
    if (!entry) return;
    const tiles = entry.subscribers.get(webContentsId);
    if (tiles) {
        tiles.delete(tileIndex);
        if (!tiles.size) entry.subscribers.delete(webContentsId);
    }
    if (!entry.subscribers.size) {
        entry.client.stop();
        roomClients.delete(roomId);
    }
}

// 窗口关闭时清空全部弹幕连接，避免残留心跳
function disposeAllClients() {
    for (const [roomId, entry] of roomClients) {
        entry.client.stop();
        roomClients.delete(roomId);
    }
    for (const [roomId, hj] of danmakujiWindows) {
        if (!hj.isDestroyed()) hj.close();
        danmakujiWindows.delete(roomId);
    }
}

function openMonitorWindow(parentWindow) {
    if (monitorWindow && !monitorWindow.isDestroyed()) {
        if (monitorWindow.isMinimized()) monitorWindow.restore();
        monitorWindow.focus();
        return { success: true, focused: true };
    }

    monitorWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 720,
        minHeight: 520,
        icon: path.join(__dirname, '../assets/icon/player.png'),
        ...theme.windowChromeOptions(MONITOR_THEME),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            // 监控窗口需要多路常驻播放，最小化时也保持解码与弹幕接收
            backgroundThrottling: false,
        },
    });

    monitorWindow.setMenu(null);
    theme.registerThemeAwareWindow(monitorWindow, MONITOR_THEME);
    monitorWindow.loadFile(path.join(__dirname, '../web/player/monitor/monitor.html'));
    monitorWindow.on('closed', () => {
        monitorWindow = null;
        disposeAllClients();
    });

    return { success: true };
}

// 打开 / 聚焦某个直播间的独立弹幕姬窗口
function openDanmakujiWindow(roomId, title) {
    const existing = danmakujiWindows.get(roomId);
    if (existing && !existing.isDestroyed()) {
        existing.focus();
        return { success: true };
    }

    const hj = new BrowserWindow({
        width: 320,
        height: 560,
        minWidth: 240,
        minHeight: 320,
        frame: false,
        transparent: false,
        icon: path.join(__dirname, '../assets/icon/player.png'),
        ...theme.windowChromeOptions({ height: 0, background: { light: '#ffffff', dark: '#17181c' } }),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    hj.setMenu(null);
    hj.loadFile(path.join(__dirname, '../web/player/monitor/danmakuji.html'));

    const hjContentsId = hj.webContents.id;
    hj.webContents.once('did-finish-load', () => {
        hj.webContents.send('danmakuji:init', { roomId, title: title || `直播间 ${roomId}` });
        // 等页面注册好 IPC 监听后再订阅，保证能收到当前连接状态的补发
        startRoomClient(roomId, hjContentsId, 'danmakuji');
    });
    hj.on('closed', () => {
        danmakujiWindows.delete(roomId);
        // 释放弹幕姬占用的订阅，最后一个订阅者退出时断开房间连接
        stopRoomClient(roomId, hjContentsId, 'danmakuji');
        // 通知监控室：弹幕姬已关闭，可以恢复内嵌弹幕
        if (monitorWindow && !monitorWindow.isDestroyed()) {
            monitorWindow.webContents.send('monitor:danmakuji-closed', { roomId });
        }
    });

    danmakujiWindows.set(roomId, hj);
    return { success: true };
}

module.exports = function registerMonitorIpc(mainWindow) {
    ipcMain.handle('openMonitor', () => {
        try {
            return openMonitorWindow(mainWindow);
        } catch (error) {
            console.error('打开 DD 监控室失败:', error);
            return { success: false, message: error.message || '打开监控室失败' };
        }
    });

    ipcMain.handle('monitor:resolveRoom', async (event, input) => {
        try {
            const room = await resolveRoom(input);
            return { success: true, data: room };
        } catch (error) {
            return { success: false, message: error.message || '获取直播间信息失败' };
        }
    });

    ipcMain.handle('monitor:getPlayUrl', async (event, payload = {}) => {
        try {
            const roomId = Number(payload.roomId);
            if (!roomId) return { success: false, message: '缺少直播间号' };
            const data = await fetchPlayUrl(roomId, Number(payload.qn) || 10000);
            return { success: true, data };
        } catch (error) {
            return { success: false, message: error.message || '获取直播流失败' };
        }
    });

    ipcMain.handle('monitor:watchDanmaku', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (!roomId) return { success: false, message: '缺少直播间号' };
        try {
            startRoomClient(roomId, event.sender.id, payload.tile ?? 'default');
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message || '连接弹幕失败' };
        }
    });

    ipcMain.handle('monitor:unwatchDanmaku', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (roomId) stopRoomClient(roomId, event.sender.id, payload.tile ?? 'default');
        return { success: true };
    });

    // 独立窗口弹幕姬：开启后该房间弹幕转发到弹幕姬窗口，监控室内嵌弹幕由渲染层关闭
    ipcMain.handle('monitor:openDanmakuji', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (!roomId) return { success: false, message: '缺少直播间号' };
        try {
            const result = openDanmakujiWindow(roomId, payload.title);
            return result;
        } catch (error) {
            return { success: false, message: error.message || '打开弹幕姬失败' };
        }
    });

    ipcMain.handle('monitor:closeDanmakuji', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        const hj = roomId && danmakujiWindows.get(roomId);
        if (hj && !hj.isDestroyed()) hj.close();
        return { success: true };
    });
};