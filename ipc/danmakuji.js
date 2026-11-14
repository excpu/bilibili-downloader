// 弹幕姬：多房间控制台窗口 + 单房间独立窗口 + OBS 本地透明弹幕服务。
// 弹幕连接统一交给 live_room_hub 按房间复用，这里只负责窗口生命周期、OBS 服务与 IPC。
const { ipcMain, BrowserWindow, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const theme = require('../modules/theme');
const hub = require('../modules/live_room_hub');
const Setting = require('../modules/config_setting');
const { resolveRoom } = require('../modules/bilibili_live');
const { sanitizePath } = require('../modules/sanitize_path');
const { DanmakujiObsServer, validatePort } = require('../modules/danmakuji_obs_server');

// 与 danmakuji-console.css 中的顶栏高度、页面底色保持一致
const CONSOLE_THEME = {
    height: 48,
    background: { light: '#eef1f7', dark: '#0b0d14' },
};

// 独立窗口自绘顶栏，不使用原生 titleBarOverlay
const ROOM_WINDOW_THEME = {
    height: 0,
    background: { light: '#f8f8f8', dark: '#17181c' },
};

const CONSOLE_CHANNELS = {
    message: 'danmakuji:room-message',
    status: 'danmakuji:room-status',
};

const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_ROOMS = 12;

let consoleWindow = null;
// roomId -> BrowserWindow
const roomWindows = new Map();
// 房间独立窗口开关的观察者（DD 监控室据此恢复内嵌弹幕）
const roomWindowObservers = new Set();

let settingStore = null;
let obsServer = null;
let themeWatcherBound = false;

function getSettingStore() {
    if (!settingStore) settingStore = new Setting();
    return settingStore;
}

function notifyObsStatus(status) {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
        try { consoleWindow.webContents.send('danmakuji:obs-status', status); } catch { }
    }
}

function getObsServer() {
    if (!obsServer) {
        const saved = getSettingStore().getDanmakujiObsSettings();
        obsServer = new DanmakujiObsServer({
            hub,
            resolveRoom,
            port: saved.port,
            autoStart: saved.autoStart,
            themeMode: saved.themeMode,
            systemDark: theme.isDark?.() ?? true,
            displaySettings: saved.displaySettings,
            onStatusChange: notifyObsStatus,
        });
    }
    if (!themeWatcherBound && nativeTheme && typeof nativeTheme.on === 'function') {
        themeWatcherBound = true;
        nativeTheme.on('updated', () => {
            obsServer?.updateTheme({ systemDark: theme.isDark?.() ?? true });
        });
    }
    return obsServer;
}

async function initObsServer() {
    const server = getObsServer();
    const saved = getSettingStore().getDanmakujiObsSettings();
    if (!saved.autoStart || server.running) return server.getStatus();
    try {
        return await server.start(saved.port);
    } catch (error) {
        console.warn('自动启动 OBS 透明弹幕服务失败:', error.message);
        return server.getStatus();
    }
}

async function stopObsServer() {
    if (!obsServer) return;
    try {
        await obsServer.stop();
    } catch (error) {
        console.warn('停止 OBS 透明弹幕服务失败:', error.message);
    }
}

function notifyRoomWindow(roomId, opened) {
    const channel = opened ? 'danmakuji:window-opened' : 'danmakuji:window-closed';
    if (consoleWindow && !consoleWindow.isDestroyed()) {
        try { consoleWindow.webContents.send(channel, { roomId }); } catch { }
    }
    for (const observer of roomWindowObservers) {
        try { observer(roomId, opened); } catch { }
    }
}

function onRoomWindowChanged(callback) {
    roomWindowObservers.add(callback);
    return () => roomWindowObservers.delete(callback);
}

function focusWindow(win) {
    if (win.isMinimized()) win.restore();
    win.focus();
}

// ---------------- 多房间控制台 ----------------
function openConsoleWindow() {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
        focusWindow(consoleWindow);
        return { success: true, focused: true };
    }

    consoleWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 860,
        minHeight: 540,
        icon: path.join(__dirname, '../assets/icon/player.png'),
        ...theme.windowChromeOptions(CONSOLE_THEME),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            // 控制台常驻后台接收弹幕，最小化时也要继续渲染与计数
            backgroundThrottling: false,
        },
    });

    consoleWindow.setMenu(null);
    theme.registerThemeAwareWindow(consoleWindow, CONSOLE_THEME);
    consoleWindow.loadFile(path.join(__dirname, '../web/player/monitor/danmakuji-console.html'));

    const contentsId = consoleWindow.webContents.id;
    consoleWindow.on('closed', () => {
        consoleWindow = null;
        hub.releaseContents(contentsId);
    });

    return { success: true };
}

// ---------------- 单房间独立窗口 ----------------
function openRoomWindow(roomId, title) {
    const room = Number(roomId);
    if (!Number.isFinite(room) || room <= 0) return { success: false, message: '缺少直播间号' };

    const existing = roomWindows.get(room);
    if (existing && !existing.isDestroyed()) {
        focusWindow(existing);
        return { success: true, focused: true };
    }

    const win = new BrowserWindow({
        width: 340,
        height: 580,
        minWidth: 240,
        minHeight: 320,
        frame: false,
        icon: path.join(__dirname, '../assets/icon/player.png'),
        ...theme.windowChromeOptions(ROOM_WINDOW_THEME),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });
    win.setMenu(null);
    win.loadFile(path.join(__dirname, '../web/player/monitor/danmakuji.html'));

    const contentsId = win.webContents.id;
    win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed()) return;
        win.webContents.send('danmakuji:init', { roomId: room, title: title || `直播间 ${room}` });
        // 等页面注册好 IPC 监听后再订阅，刷新页面时也能补发当前连接状态
        hub.subscribe(room, contentsId, 'danmakuji');
    });
    win.on('closed', () => {
        roomWindows.delete(room);
        hub.releaseContents(contentsId);
        notifyRoomWindow(room, false);
    });

    roomWindows.set(room, win);
    notifyRoomWindow(room, true);
    return { success: true };
}

function closeRoomWindow(roomId) {
    const win = roomWindows.get(Number(roomId));
    if (win && !win.isDestroyed()) win.close();
    return { success: true };
}

function isRoomWindowOpen(roomId) {
    const win = roomWindows.get(Number(roomId));
    return !!(win && !win.isDestroyed());
}

function closeAllRoomWindows() {
    for (const [roomId, win] of [...roomWindows]) {
        if (!win.isDestroyed()) win.close();
        roomWindows.delete(roomId);
    }
}

// ---------------- 导出 ----------------
async function exportTranscript(win, payload = {}) {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return { success: false, message: '当前没有可导出的弹幕' };
    if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_BYTES) {
        return { success: false, message: '弹幕内容过大，请先清空部分列表再导出' };
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const base = sanitizePath(String(payload.defaultName || '').trim()) || `弹幕姬-${stamp}`;
    const target = win && !win.isDestroyed() ? win : consoleWindow;
    const result = await dialog.showSaveDialog(target, {
        title: '导出弹幕记录',
        defaultPath: `${base}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { success: true, canceled: true };

    // 带 BOM，Windows 记事本打开中文不乱码
    fs.writeFileSync(result.filePath, `\ufeff${text}`, 'utf8');
    return { success: true, path: result.filePath };
}

module.exports = function registerDanmakujiIpc() {
    ipcMain.handle('openDanmakujiConsole', () => {
        try {
            return openConsoleWindow();
        } catch (error) {
            console.error('打开弹幕姬控制台失败:', error);
            return { success: false, message: error.message || '打开弹幕姬失败' };
        }
    });

    ipcMain.handle('danmakuji:resolveRoom', async (event, input) => {
        try {
            const room = await resolveRoom(input);
            return { success: true, data: room };
        } catch (error) {
            return { success: false, message: error.message || '获取直播间信息失败' };
        }
    });

    ipcMain.handle('danmakuji:watch', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (!Number.isFinite(roomId) || roomId <= 0) return { success: false, message: '缺少直播间号' };
        try {
            const status = hub.subscribe(roomId, event.sender.id, payload.tile ?? roomId, CONSOLE_CHANNELS);
            return { success: true, status };
        } catch (error) {
            return { success: false, message: error.message || '连接弹幕失败' };
        }
    });

    ipcMain.handle('danmakuji:unwatch', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (Number.isFinite(roomId) && roomId > 0) {
            hub.unsubscribe(roomId, event.sender.id, payload.tile ?? roomId);
        }
        return { success: true };
    });

    ipcMain.handle('danmakuji:openRoomWindow', (event, payload = {}) => {
        try {
            return openRoomWindow(payload.roomId, payload.title);
        } catch (error) {
            return { success: false, message: error.message || '打开弹幕姬窗口失败' };
        }
    });

    ipcMain.handle('danmakuji:closeRoomWindow', (event, payload = {}) => closeRoomWindow(payload.roomId));

    ipcMain.handle('danmakuji:roomWindowState', () => ({
        success: true,
        rooms: [...roomWindows.keys()].filter(roomId => isRoomWindowOpen(roomId)),
    }));

    ipcMain.handle('danmakuji:export', async (event, payload = {}) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender);
            return await exportTranscript(win, payload);
        } catch (error) {
            console.error('导出弹幕记录失败:', error);
            return { success: false, message: error.message || '导出失败' };
        }
    });

    ipcMain.handle('danmakuji:openRoomPage', (event, roomId) => {
        const room = Number(roomId);
        if (Number.isFinite(room) && room > 0) shell.openExternal(`https://live.bilibili.com/${room}`);
        return { success: true };
    });

    // ---------------- OBS 本地透明弹幕服务 ----------------
    ipcMain.handle('danmakuji:obsStatus', () => ({
        success: true,
        data: getObsServer().getStatus(),
    }));

    ipcMain.handle('danmakuji:obsStart', async (event, payload = {}) => {
        try {
            const server = getObsServer();
            const patch = {};
            if (payload.port !== undefined) patch.port = validatePort(payload.port);
            if (payload.themeMode !== undefined) patch.themeMode = payload.themeMode;
            if (typeof payload.autoStart === 'boolean') patch.autoStart = payload.autoStart;
            const saved = Object.keys(patch).length
                ? getSettingStore().updateDanmakujiObsSettings(patch)
                : getSettingStore().getDanmakujiObsSettings();
            server.configure({ ...saved, systemDark: theme.isDark?.() ?? true });
            const status = await server.start(saved.port);
            return { success: true, data: status };
        } catch (error) {
            return {
                success: false,
                message: error.message || '启动 OBS 服务失败',
                data: getObsServer().getStatus(),
            };
        }
    });

    ipcMain.handle('danmakuji:obsStop', async () => {
        try {
            const status = await getObsServer().stop();
            return { success: true, data: status };
        } catch (error) {
            return { success: false, message: error.message || '停止 OBS 服务失败' };
        }
    });

    ipcMain.handle('danmakuji:obsConfig', async (event, payload = {}) => {
        const server = getObsServer();
        const prev = getSettingStore().getDanmakujiObsSettings();
        try {
            const patch = {};
            if (payload.port !== undefined) patch.port = validatePort(payload.port);
            if (payload.themeMode !== undefined) patch.themeMode = payload.themeMode;
            if (typeof payload.autoStart === 'boolean') patch.autoStart = payload.autoStart;
            const next = getSettingStore().updateDanmakujiObsSettings(patch);
            const portChanged = next.port !== prev.port;

            server.configure({ autoStart: next.autoStart, systemDark: theme.isDark?.() ?? true });
            if (payload.themeMode !== undefined) {
                server.updateTheme({ themeMode: next.themeMode, systemDark: theme.isDark?.() ?? true });
            }
            if (server.running && portChanged) {
                await server.start(next.port);
            } else {
                server.configure({ port: next.port });
                notifyObsStatus(server.getStatus());
            }
            return { success: true, data: server.getStatus() };
        } catch (error) {
            // 切换端口失败时回滚端口配置，保持服务与持久化一致
            if (server.running) {
                getSettingStore().updateDanmakujiObsSettings({ port: server.port });
            } else {
                getSettingStore().updateDanmakujiObsSettings({ port: prev.port });
            }
            return {
                success: false,
                message: error.message || '更新 OBS 配置失败',
                data: server.getStatus(),
            };
        }
    });

    ipcMain.handle('danmakuji:obsSyncState', (event, payload = {}) => {
        const server = getObsServer();
        if (payload.settings && typeof payload.settings === 'object') {
            const normalized = server.updateSettings(payload.settings);
            getSettingStore().updateDanmakujiObsSettings({ displaySettings: normalized });
        }
        if (Array.isArray(payload.rooms)) {
            server.updateConsoleRooms(payload.rooms);
        }
        return { success: true };
    });

    ipcMain.handle('danmakuji:openObsPreview', (event, rawUrl) => {
        const status = getObsServer().getStatus();
        if (!status.running) return { success: false, message: '请先启动 OBS 本地服务' };
        const url = String(rawUrl || '').trim();
        if (!url.startsWith(`${status.baseUrl}/`)) {
            return { success: false, message: '无效的 OBS 预览地址' };
        }
        shell.openExternal(url);
        return { success: true };
    });
};

module.exports.openRoomWindow = openRoomWindow;
module.exports.closeRoomWindow = closeRoomWindow;
module.exports.closeAllRoomWindows = closeAllRoomWindows;
module.exports.isRoomWindowOpen = isRoomWindowOpen;
module.exports.onRoomWindowChanged = onRoomWindowChanged;
module.exports.initObsServer = initObsServer;
module.exports.stopObsServer = stopObsServer;
module.exports.MAX_BATCH_ROOMS = MAX_BATCH_ROOMS;