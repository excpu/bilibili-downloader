process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"; // 禁用安全警告，开发阶段使用
// 多连接下载的文件写入与 DNS 都走 libuv 线程池，默认 4 个线程容易排队；必须在线程池首次使用前设置
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';
// main.js
const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('path');
const registerIpc = require('./ipc');
const { hasActiveDownloads } = require('./ipc/download');
const theme = require('./modules/theme');
const Setting = require('./modules/config_setting');

// // 禁用 User-Agent Client Hints，防止部分请求被拒绝
// app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint');

// 下载与音视频转封装全部由纯 JS 实现（Node.js HTTP 多连接下载 + js-media 封装），
// 不再启动 aria2 子进程，也不再调用 ffmpeg。

app.commandLine.appendSwitch('log-level', '3') // 只输出错误日志，减少控制台噪音

// 系统外观变化或 themeSource 改变时，同步所有跟随主题的窗口的原生外观
theme.watchThemeChange();

function createWindow() {
    let allowClose = false;
    // 先按已保存的偏好确定主题，窗口才能用正确的底色和标题栏符号色创建
    theme.applyThemePreference(new Setting().getTheme());
    const titleBarOverlay = process.platform === 'win32' ? {
        color: '#00000000',
        symbolColor: theme.isDark() ? '#ffffff' : '#333333',
        height: 52
    } : null;
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 730,
        minHeight: 520,
        icon: path.join(__dirname, 'assets/icon/icon.png'),
        backgroundColor: theme.windowBackgroundColor(),
        ...(process.platform === 'linux' ? {} : {
            titleBarStyle: 'hidden',
            ...(titleBarOverlay ? { titleBarOverlay } : {})
        }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false
        },
    });
    // 主窗口的 CSS 已支持深浅两套配色，因此让它的原生标题栏与底色跟随主题
    theme.registerThemeAwareWindow(win, titleBarOverlay || {});
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

    win.on('close', (event) => {
        if (allowClose || !hasActiveDownloads()) {
            return;
        }

        event.preventDefault();
        const response = dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ['取消', '仍然关闭'],
            defaultId: 0,
            cancelId: 0,
            title: '下载正在进行',
            message: '当前有正在下载的任务',
            detail: '现在关闭将中断下载，是否仍然关闭？'
        });

        if (response === 1) {
            allowClose = true;
            win.close();
        }
    });

    // 拦截全局 Chromium 网络栈的 TLS 握手校验
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
        const { hostname, certificate } = request;

        // 如果握手阶段未收到有效证书，直接回退 Chromium 默认处理
        if (!certificate) {
            callback(-3);
            return;
        }

        // 受损证书的特征关键词
        const BLOCKED_ISSUERS = [
            'EM DV TLS CA - G3B',
            'EM DV TLS CA - G3C',
            'EM OV TLS CA - G3B',
            'EM OV TLS CA - G3C',
            'EM EV TLS CA - G3B',
            'EM EV TLS CA - G3C',
            'emSign Root TLS CA - G3',
            'AAA Certificate Services'
        ];

        // 沿证书链逐级向上遍历核查
        let isCompromised = false;
        let currentCert = certificate;

        while (currentCert) {
            const issuer = currentCert.issuerName || currentCert.issuer?.commonName || '';
            if (BLOCKED_ISSUERS.some(blocked => issuer.includes(blocked))) {
                isCompromised = true;
                break;
            }
            currentCert = currentCert.issuerCert;
        }

        if (isCompromised) {
            console.warn(`[Security] 成功拦截受损 eMudhra 证书连接: ${hostname}`);
            // -202 映射至 Chromium 的 net::ERR_CERT_REVOKED (证书已吊销)
            callback(-202);
            return;
        }

        // -3 代表委托 Chromium 内置校验逻辑处理后续结果
        callback(-3);
    });
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

