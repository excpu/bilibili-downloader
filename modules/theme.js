// 界面主题的主进程逻辑：把用户偏好交给 nativeTheme，并据此给出原生标题栏与窗口底色。
//
// 关键点：nativeTheme.themeSource 决定渲染进程里 prefers-color-scheme 的结果，
// 而 index-dark.css 用 `color-scheme: light dark` + light-dark() 取色，
// 因此主题切换完全由主进程驱动 —— 渲染进程不需要主题 JS，也不会有加载白闪。
// 'system' 跟随系统；'light' / 'dark' 为强制覆盖。
const { nativeTheme } = require('electron');

const THEME_VALUES = ['system', 'light', 'dark'];

// 与 index-dark.css 的 --bg 保持一致，用于窗口底色，避免调整大小时露出白边
const WINDOW_BACKGROUND = {
    light: '#f8fafc',
    dark: '#141414',
};

// 只有登记过的窗口才跟随主题更新原生外观；播放器/合并工具窗口的 CSS 仍是固定浅色，
// 视频预览窗口固定黑底，都不应被改写。
// Map 的值为该窗口创建时的 titleBarOverlay 配置：setTitleBarOverlay 是整体替换，
// 更新颜色时必须把 height 一并回传，否则标题栏高度会被重置为默认值。
const themeAwareWindows = new Map();

// 当前正显示模态框的窗口：遮罩会盖住顶栏，此时两种主题下都要用浅色符号按钮
const modalWindows = new Set();

function normalizeTheme(pref) {
    return THEME_VALUES.includes(pref) ? pref : 'system';
}

function isDark() {
    return nativeTheme.shouldUseDarkColors;
}

function windowBackgroundColor() {
    return isDark() ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function symbolColor(win) {
    return (modalWindows.has(win) || isDark()) ? '#ffffff' : '#333333';
}

function applyThemePreference(pref) {
    nativeTheme.themeSource = normalizeTheme(pref);
    return nativeTheme.themeSource;
}

function syncWindow(win) {
    const baseOverlay = themeAwareWindows.get(win) || {};
    // titleBarOverlay 仅 Windows 支持，调用可能抛错，单独 try 以免影响底色更新
    try {
        if (process.platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
            win.setTitleBarOverlay({
                ...baseOverlay,
                color: '#00000000',
                symbolColor: symbolColor(win),
            });
        }
    } catch {
        // 忽略：非 Windows 或该窗口未启用 titleBarOverlay
    }
    try {
        win.setBackgroundColor(windowBackgroundColor());
    } catch {
        // 忽略底色设置失败
    }
}

// 窗口创建后登记，并立刻按当前主题同步一次原生外观
function registerThemeAwareWindow(win, baseOverlay = {}) {
    themeAwareWindows.set(win, baseOverlay);
    syncWindow(win);
    win.once('closed', () => {
        themeAwareWindows.delete(win);
        modalWindows.delete(win);
    });
}

function isThemeAware(win) {
    return themeAwareWindows.has(win);
}

// 渲染进程开关模态框时调用；未登记的窗口返回 false，由调用方退回原来的直接设置
function setModalState(win, modal) {
    if (!win || win.isDestroyed()) return false;
    if (!isThemeAware(win)) return false;
    if (modal) modalWindows.add(win);
    else modalWindows.delete(win);
    syncWindow(win);
    return true;
}

function syncThemeAwareWindows() {
    for (const win of [...themeAwareWindows.keys()]) {
        // 仅更新原生部分，主题色值由 CSS 的 light-dark() 自行响应
        if (win.isDestroyed()) {
            themeAwareWindows.delete(win);
            modalWindows.delete(win);
            continue;
        }
        syncWindow(win);
    }
}

// 系统外观变化或 themeSource 改变时都会触发
function watchThemeChange() {
    nativeTheme.on('updated', () => syncThemeAwareWindows());
}

module.exports = {
    THEME_VALUES,
    normalizeTheme,
    isDark,
    applyThemePreference,
    windowBackgroundColor,
    registerThemeAwareWindow,
    isThemeAware,
    setModalState,
    syncThemeAwareWindows,
    watchThemeChange,
};
