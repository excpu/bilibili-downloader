const { ipcMain, app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

let playerWindow = null; // 持有引用，防止重复打开
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
}