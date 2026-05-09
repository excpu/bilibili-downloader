const { ipcMain, app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// 持有引用，防止重复打开
let playerWindow = null; // 持有引用，防止重复打开
let mergeWindow = null;

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
    // 打开播放器
    ipcMain.handle('openPlayer', async () => {
        // electron 新窗口打开html
        if (playerWindow) {
            if (playerWindow.isMinimized()) playerWindow.restore();
            playerWindow.focus();
            return;
        }

        playerWindow = new BrowserWindow({
            width: 800,
            height: 600,
            icon: path.join(__dirname, '../assets/icon/player.png'),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        playerWindow.loadFile(path.join(__dirname, '../web/player/index.html'));

        playerWindow.on('closed', () => {
            playerWindow = null;
        });

        const menu = Menu.buildFromTemplate(playerTemplate);
        Menu.setApplicationMenu(menu);

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
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
            },
        });
        mergeWindow.loadFile(path.join(__dirname, '../web/merge/index.html'));

        mergeWindow.on('closed', () => {
            mergeWindow = null;
        });

        Menu.setApplicationMenu(null); // 合并工具不需要菜单

    });
}