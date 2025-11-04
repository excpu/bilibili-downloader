// main.js
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const registerIpc = require('./ipc');

// // 禁用 User-Agent Client Hints，防止部分请求被拒绝
// app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');

// aria2c 相关模块动态加载

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 900,
        icon: path.join(__dirname, 'assets/icon/icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
    });
    win.setMenuBarVisibility(false);
    // 设置用户代理以防止头像屏蔽
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0');
    win.loadFile('./web/index.html');
    // 开发环境打开检查器
    if (!app.isPackaged) {
        win.webContents.openDevTools();
    }

    // 注册 IPC 处理器
    registerIpc(win);
}

app.whenReady().then(createWindow);

// Referrer 防护，防止部分请求被拒绝
app.on('ready', () => {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Referer'] = 'https://www.bilibili.com/';
        callback({ requestHeaders: details.requestHeaders });
    });
});

