const { app } = require('electron');
const path = require('path');

function getAriaBinaryPath() {
    const platform = process.platform;
    const arch = process.arch;
    const binName = platform === 'win32' ? 'aria2c.exe' : 'aria2c';

    // 1. 判断是否已打包
    const isPackaged = app.isPackaged;

    let baseDir;

    if (!isPackaged) {
        // 开发环境：二进制文件在项目根目录的 assets/bin 下
        // app.getAppPath() 在开发时通常指向项目根目录
        baseDir = path.join(app.getAppPath(), 'assets', 'bin');
    } else {
        // 生产环境：二进制文件在 resourcesPath（安装目录/resources）下
        // 注意：这里路径取决于你 electron-builder 的 to 配置
        baseDir = path.join(process.resourcesPath, 'bin');
    }

    // 2. 根据你的目录结构拼接
    // 考虑到 win32 目前没有 arch 层级，而 darwin/linux 有
    if (platform === 'win32') {
        return path.join(baseDir, 'win32', binName);
    } else {
        // 对应 assets/bin/darwin/arm64/aria2c 等
        return path.join(baseDir, platform, arch, binName);
    }
}

module.exports = {
    getAriaBinaryPath
};