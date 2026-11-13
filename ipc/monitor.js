// DD 监控室：独立的窗口、IPC 与直播画面通道，不与下载 / 主界面逻辑耦合。
// 弹幕长连接由 live_room_hub 统一复用，独立弹幕姬窗口由 ipc/danmakuji 管理。
const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');

const theme = require('../modules/theme');
const hub = require('../modules/live_room_hub');
const danmakuji = require('./danmakuji');
const { resolveRoom, fetchPlayUrl } = require('../modules/bilibili_live');

// 顶栏与页面底色，与 monitor.css 中的取值保持一致
const MONITOR_THEME = {
    height: 44,
    background: { light: '#f5f6f8', dark: '#0e0e10' },
};

let monitorWindow = null;
let unsubscribeDanmakujiEvents = null;

function openMonitorWindow() {
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

    const contentsId = monitorWindow.webContents.id;
    // 弹幕姬窗口关闭后通知监控室恢复内嵌弹幕；弹幕姬本身不随监控室关闭
    unsubscribeDanmakujiEvents = danmakuji.onRoomWindowChanged((roomId, opened) => {
        if (opened || !monitorWindow || monitorWindow.isDestroyed()) return;
        try {
            monitorWindow.webContents.send('monitor:danmakuji-closed', { roomId });
        } catch { }
    });

    monitorWindow.on('closed', () => {
        monitorWindow = null;
        // 只释放监控室自己的订阅，弹幕姬控制台与独立窗口继续接收
        hub.releaseContents(contentsId);
        unsubscribeDanmakujiEvents?.();
        unsubscribeDanmakujiEvents = null;
    });

    return { success: true };
}

module.exports = function registerMonitorIpc() {
    ipcMain.handle('openMonitor', () => {
        try {
            return openMonitorWindow();
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
        if (!Number.isFinite(roomId) || roomId <= 0) return { success: false, message: '缺少直播间号' };
        try {
            hub.subscribe(roomId, event.sender.id, payload.tile ?? 'default');
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message || '连接弹幕失败' };
        }
    });

    ipcMain.handle('monitor:unwatchDanmaku', (event, payload = {}) => {
        const roomId = Number(payload.roomId);
        if (Number.isFinite(roomId) && roomId > 0) {
            hub.unsubscribe(roomId, event.sender.id, payload.tile ?? 'default');
        }
        return { success: true };
    });

    // 独立窗口弹幕姬：开启后该房间弹幕同时转发到弹幕姬窗口，监控室内嵌弹幕由渲染层关闭
    ipcMain.handle('monitor:openDanmakuji', (event, payload = {}) => {
        try {
            return danmakuji.openRoomWindow(payload.roomId, payload.title);
        } catch (error) {
            return { success: false, message: error.message || '打开弹幕姬失败' };
        }
    });

    ipcMain.handle('monitor:closeDanmakuji', (event, payload = {}) => danmakuji.closeRoomWindow(payload.roomId));
};