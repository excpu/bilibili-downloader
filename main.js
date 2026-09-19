process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"; // 禁用安全警告，开发阶段使用
// main.js
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const registerIpc = require('./ipc');
const { getAriaBinaryPath } = require('./modules/bin_path');

// // 禁用 User-Agent Client Hints，防止部分请求被拒绝
// app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');

// 启动 aria2
let aria2Process = null;
const aria2args = [
    '--enable-rpc',               // 启用 RPC
    '--rpc-listen-all=false',      // 仅允许本地访问 (安全)
    '--rpc-listen-port=6818',      // 端口 6818
    '--rpc-allow-origin-all',      // 允许跨域 (方便渲染进程调用)
    '--max-connection-per-server=8', // 最大连接数
    '--split=8',
    '--min-split-size=8M',
    '--quiet=true',                // 静默模式，减少日志输出
    '--continue=true',             // 断点续传
    '--check-certificate=false',
    // 额外速度配置
    '--timeout=10',
    '--connect-timeout=10',
    '--max-tries=0',
    '--retry-wait=10',
    '--http-accept-gzip=true',
    '--content-disposition-default-utf8=true',
    // 磁盘配置
    '--disk-cache=64M',
    '--file-allocation=falloc',
    '--no-file-allocation-limit=64M',
];
const aria2BinaryPath = getAriaBinaryPath();
// const { chmodSync } = require('fs');
const { spawn } = require('child_process');

// if (process.platform === 'darwin' || process.platform === 'linux') {
//     try {
//         chmodSync(aria2BinaryPath, 0o755);
//     } catch (err) {
//         // 即使 chmod 失败（比如只读文件系统或权限不足），也只打日志，不阻断后续执行
//         console.warn('[Aria2] 尝试赋予执行权限失败 (可能已具备权限或目录只读):', err.message);
//     }
// }

aria2Process = spawn(aria2BinaryPath, aria2args);

// 监听启动错误 (比如文件没权限、路径不对)
aria2Process.on('error', (err) => {
    console.error('无法启动 Aria2:', err);
});

// 监听标准输出 (用于调试)
aria2Process.stdout.on('data', (data) => {
    console.log(`Aria2 Log: ${data}`);
});

// 监听进程退出
aria2Process.on('close', (code) => {
    console.log(`Aria2 进程已退出，状态码: ${code}`);
});

if (aria2Process && aria2Process.pid) {
    console.log(`✅ Aria2 正在运行，进程 PID: ${aria2Process.pid}`);
} else {
    console.log('❌ Aria2 进程未启动');
}


app.commandLine.appendSwitch('log-level', '3') // 只输出错误日志，减少控制台噪音

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 900,
        minWidth: 730,
        minHeight: 520,
        icon: path.join(__dirname, 'assets/icon/icon.png'),
        ...(process.platform === 'linux' ? {} : {
            titleBarStyle: 'hidden',
            ...(process.platform === 'win32' ? {
                titleBarOverlay: {
                    color: '#00000000',
                    symbolColor: '#333333',
                    height: 52
                }
            } : {})
        }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false
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
        details.requestHeaders['Origin'] = 'https://www.bilibili.com/';
        callback({ requestHeaders: details.requestHeaders });
    });
});

