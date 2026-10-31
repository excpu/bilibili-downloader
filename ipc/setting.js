const { ipcMain, dialog, BrowserWindow } = require('electron');
const Setting = require('../modules/config_setting');
const { fetchCdnList } = require('../modules/cdn_source');
const theme = require('../modules/theme');

const setting = new Setting();
setting.load(); // 加载设置数据

module.exports = function registerSettingIpc(mainWindow) {
    ipcMain.handle('getTheme', () => setting.getTheme());

    ipcMain.handle('setTheme', (event, pref) => {
        // 写盘后交给 nativeTheme，渲染进程的 light-dark() 会自动重新取色
        const saved = setting.updateTheme(pref);
        theme.applyThemePreference(saved);
        return saved;
    });

    ipcMain.handle('getDownloadEngine', () => {
        return setting.getDownloadEngine();
    });

    ipcMain.handle('setDownloadEngine', (event, engine) => {
        setting.updateDownloadEngine(engine);
    });

    ipcMain.handle('getOutputFormat', () => setting.getOutputFormat());

    ipcMain.handle('setOutputFormat', (event, format) => setting.updateOutputFormat(format));

    ipcMain.handle('getExperimentalMergeEnabled', () => setting.getExperimentalMergeEnabled());

    ipcMain.handle('setExperimentalMergeEnabled', (event, enabled) =>
        setting.updateExperimentalMergeEnabled(enabled)
    );

        ipcMain.handle('getMp4AllowNonStandardAudio', () => setting.getMp4AllowNonStandardAudio());

        ipcMain.handle('setMp4AllowNonStandardAudio', (event, enabled) =>
            setting.updateMp4AllowNonStandardAudio(enabled)
        );

    ipcMain.handle('getNodeResumeEnabled', () => setting.getNodeResumeEnabled());
    ipcMain.handle('setNodeResumeEnabled', (event, enabled) => {
        setting.updateNodeResumeEnabled(enabled);
    });
    ipcMain.handle('getAria2Concurrency', () => {
        return setting.getAria2Concurrency();
    });

    ipcMain.handle('setAria2Concurrency', (event, concurrency) => {
        setting.updateAria2Concurrency(concurrency);
    });

    ipcMain.handle('getDanmuDownloadMethod', () => {
        return setting.getDanmuDownloadMethod();
    });

    ipcMain.handle('setDanmuDownloadMethod', (event, method) => {
        setting.updateDanmuDownloadMethod(method);
    });

    ipcMain.handle('getDownloadPath', () => {
        return setting.getDownloadPath();
    });

    ipcMain.handle('setDownloadPath', (event, downloadPath) => {
        setting.updateDownloadPath(downloadPath);
        return setting.getDownloadPath();
    });

    ipcMain.handle('getDownloadInFolder', () => setting.getDownloadInFolder());
    ipcMain.handle('setDownloadInFolder', (event, enabled) => {
        setting.updateDownloadInFolder(enabled);
    });

    ipcMain.handle('getDownloadFolderNesting', () => setting.getDownloadFolderNesting());
    ipcMain.handle('setDownloadFolderNesting', (event, enabled) => {
        setting.updateDownloadFolderNesting(enabled);
    });

    ipcMain.handle('selectDownloadPath', async (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showOpenDialog(senderWindow, {
            properties: ['openDirectory'],
            title: '请选择下载目录',
            defaultPath: setting.getDownloadPath(),
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        const selectedPath = result.filePaths[0];
        setting.updateDownloadPath(selectedPath);
        return selectedPath;
    });

    ipcMain.handle('getCdnList', async () => {
        return fetchCdnList();
    });

    ipcMain.handle('getCdnHost', () => {
        return setting.getCdnHost();
    });

    ipcMain.handle('setCdnHost', (event, cdnHost) => {
        setting.updateCdnHost(cdnHost);
    });

    ipcMain.handle('getSubtitleSettings', () => setting.getSubtitleSettings());

    ipcMain.handle('setSubtitleSettings', (event, subtitleSettings) =>
        setting.updateSubtitleSettings(subtitleSettings)
    );

    ipcMain.handle('getDanmakuSettings', () => setting.getDanmakuSettings());

    ipcMain.handle('setDanmakuSettings', (event, danmakuSettings) =>
        setting.updateDanmakuSettings(danmakuSettings)
    );
}