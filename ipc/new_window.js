const { ipcMain, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const theme = require('../modules/theme');

// 播放器 / 合并工具窗口的原生外观配置，色值与各自 CSS 里 light-dark() 的取值一一对应，
// 避免调整大小或加载时露出白边、标题栏与顶栏出现色差
const PLAYER_THEME = {
    height: 48,
    background: { light: '#f6f7fb', dark: '#141414' },
};

// 合并工具的顶栏是不透明的品牌蓝，标题栏底色要跟随它一起切换，符号色恒为白色
const MERGE_THEME = {
    height: 40,
    background: { light: '#f0f0f0', dark: '#181818' },
    overlayColor: { light: '#3c78d8', dark: '#2b5da8' },
    symbolColor: '#ffffff',
};

// 持有引用，防止重复打开
let playerWindow = null; // 持有引用，防止重复打开
let mergeWindow = null;
let multiPlayerWindow = null;

const playerTemplate = [
    {
        label: '其他', // 一级菜单名称
        submenu: [
            {
                label: '使用网页版',
                // 打开网页版，获取最新更新
                click: () => { shell.openExternal('https://tools.5share.site/xml-player/'); }
            }
        ]
    }
]

module.exports = function registerNewWindowIpc(mainWindow) {
    ipcMain.handle('openMultiPlayer', () => {
        if (multiPlayerWindow && !multiPlayerWindow.isDestroyed()) {
            if (multiPlayerWindow.isMinimized()) multiPlayerWindow.restore();
            multiPlayerWindow.focus();
            return;
        }
        multiPlayerWindow = new BrowserWindow({
            width: 1000,
            height: 720,
            minWidth: 640,
            minHeight: 480,
            icon: path.join(__dirname, '../assets/icon/player.png'),
            ...theme.windowChromeOptions(PLAYER_THEME),
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        multiPlayerWindow.setMenu(null);
        theme.registerThemeAwareWindow(multiPlayerWindow, PLAYER_THEME);
        multiPlayerWindow.loadFile(path.join(__dirname, '../web/player/multi-player.html'));
        multiPlayerWindow.on('closed', () => { multiPlayerWindow = null; });
    });
    // 打开播放器
    ipcMain.handle('openPlayer', async () => {
        // electron 新窗口打开html
        if (playerWindow) {
            if (playerWindow.isMinimized()) playerWindow.restore();
            playerWindow.focus();
            return;
        }

        playerWindow = new BrowserWindow({
            width: 900,
            height: 640,
            icon: path.join(__dirname, '../assets/icon/player.png'),
            ...theme.windowChromeOptions(PLAYER_THEME),
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        playerWindow.loadFile(path.join(__dirname, '../web/player/index.html'));
        // 播放器 CSS 已支持深浅两套配色，跟随主界面的主题设置
        theme.registerThemeAwareWindow(playerWindow, PLAYER_THEME);

        playerWindow.on('closed', () => {
            playerWindow = null;
        });

        playerWindow.setMenu(null);

    });

    // 打开外部链接
    ipcMain.handle('openExternalUrl', (event, url) => {
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            shell.openExternal(url);
        }
    });

    // 打开缓存合并工具
    ipcMain.handle('openMergeTool', async () => {
        // electron 新窗口打开html
        if (mergeWindow) {
            if (mergeWindow.isMinimized()) mergeWindow.restore();
            mergeWindow.focus();
            return;
        }

        mergeWindow = new BrowserWindow({
            width: 924,
            height: 650,
            icon: path.join(__dirname, '../assets/icon/player.png'),
            ...theme.windowChromeOptions(MERGE_THEME),
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        mergeWindow.loadFile(path.join(__dirname, '../web/merge/index.html'));
        // 合并工具 CSS 已支持深浅两套配色，跟随主界面的主题设置
        theme.registerThemeAwareWindow(mergeWindow, MERGE_THEME);

        mergeWindow.on('closed', () => {
            mergeWindow = null;
        });

        mergeWindow.setMenu(null);

    });
}