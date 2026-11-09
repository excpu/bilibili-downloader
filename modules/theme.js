// 界面主题的主进程逻辑：把用户偏好交给 nativeTheme，并据此给出原生标题栏与窗口底色。
//
// 关键点：nativeTheme.themeSource 决定渲染进程里 prefers-color-scheme 的结果，
// 而各窗口的 CSS 用 `color-scheme: light dark` + light-dark() 取色，
// 因此主题切换完全由主进程驱动 —— 渲染进程不需要主题 JS，也不会有加载白闪。
// 'system' 跟随系统；'light' / 'dark' 为强制覆盖。
const { nativeTheme } = require('electron');

const THEME_VALUES = ['system', 'light', 'dark'];

// 与 index-dark.css 的 --bg 保持一致，用于窗口底色，避免调整大小时露出白边
const WINDOW_BACKGROUND = {
    light: '#f8fafc',
    dark: '#141414',
};

// 只有登记过的窗口才跟随主题更新原生外观；视频预览窗口固定黑底，不应被改写。
// Map 的值为该窗口的登记信息（由 normalizeWindowInfo 从创建参数归一化而来）：
//   overlay          —— { height } 标题栏高度。setTitleBarOverlay 是整体替换，
//                       更新颜色时必须把 height 一并回传，否则高度会被重置为默认值。
//                       没有该字段表示窗口不启用 titleBarOverlay（macOS / Linux）。
//   background       —— { light, dark } 窗口底色；缺省用主界面的 WINDOW_BACKGROUND
//   overlayColor     —— { light, dark } 标题栏底色；缺省透明，让页面的顶栏颜色透出来
//   symbolColor      —— { light, dark } 标题栏按钮颜色；缺省跟随主题，
//                       顶栏自带深色（如合并工具的品牌蓝）的窗口要显式指定为白色
const themeAwareWindows = new Map();

// 当前正显示模态框的窗口：遮罩会盖住顶栏，此时两种主题下都要用浅色符号按钮
const modalWindows = new Set();

function normalizeTheme(pref) {
    return THEME_VALUES.includes(pref) ? pref : 'system';
}

function isDark() {
    return nativeTheme.shouldUseDarkColors;
}

// pair 为 { light, dark } 时按当前主题取值；缺省时用 fallback（同为 { light, dark }）
function pick(pair, fallback) {
    const colors = pair || fallback;
    if (!colors) return null;
    return isDark() ? colors.dark : colors.light;
}

function windowBackgroundColor(win = null) {
    const info = themeAwareWindows.get(win);
    return pick(info?.background, WINDOW_BACKGROUND);
}

function applyThemePreference(pref) {
    nativeTheme.themeSource = normalizeTheme(pref);
    return nativeTheme.themeSource;
}

// 标题栏底色：不透明顶栏的窗口自带深浅两色，其余透明让页面顶栏颜色透出
function overlayColorFor(info) {
    return info.overlayColor ? pick(info.overlayColor) : '#00000000';
}

// 标题栏按钮颜色：固定深浅两色的窗口（顶栏为品牌色）用其自身配置，否则跟随主题
function symbolColorFor(info) {
    if (info.symbolColor) return pick(info.symbolColor);
    return isDark() ? '#ffffff' : '#333333';
}

// 按当前主题算出该窗口应有的 titleBarOverlay 配置
function titleBarOverlayFor(win) {
    const info = themeAwareWindows.get(win);
    if (!info?.overlay) return null;
    return {
        ...info.overlay,
        color: overlayColorFor(info),
        // 模态遮罩盖住顶栏时，两种主题下都用浅色符号按钮
        symbolColor: modalWindows.has(win) ? '#ffffff' : symbolColorFor(info),
    };
}

function syncWindow(win) {
    // titleBarOverlay 仅 Windows 支持，调用可能抛错，单独 try 以免影响底色更新
    try {
        const overlay = process.platform === 'win32' ? titleBarOverlayFor(win) : null;
        if (overlay && typeof win.setTitleBarOverlay === 'function') {
            win.setTitleBarOverlay(overlay);
        }
    } catch {
        // 忽略：该窗口未启用 titleBarOverlay
    }
    try {
        win.setBackgroundColor(windowBackgroundColor(win));
    } catch {
        // 忽略底色设置失败
    }
}

// 供创建窗口时使用：返回应展开进 BrowserWindow 构造参数的原生外观字段。
// options 见 registerThemeAwareWindow；窗口创建后仍需调用它完成登记。
function windowChromeOptions(options = {}) {
    const info = normalizeWindowInfo(options);
    // titleBarOverlay 仅 Windows 支持，macOS / Linux 传了反而会被忽略或报错
    const overlay = process.platform === 'win32' && info.overlay
        ? { ...info.overlay, color: overlayColorFor(info), symbolColor: symbolColorFor(info) }
        : null;
    return {
        backgroundColor: pick(info.background, WINDOW_BACKGROUND),
        ...(process.platform === 'linux' ? {} : {
            titleBarStyle: 'hidden',
            ...(overlay ? { titleBarOverlay: overlay } : {}),
        }),
    };
}

function normalizeWindowInfo(options) {
    // 标题栏高度各窗口不同，必须由调用方给出，否则 setTitleBarOverlay 会重置为默认高度
    const overlay = options.height ? { height: options.height } : null;
    return {
        overlay,
        background: options.background || null,
        overlayColor: options.overlayColor || null,
        // 固定符号色（字符串）与深浅分支（对象）都接受
        symbolColor: typeof options.symbolColor === 'string'
            ? { light: options.symbolColor, dark: options.symbolColor }
            : (options.symbolColor || null),
    };
}

// 窗口创建后登记，并立刻按当前主题同步一次原生外观
function registerThemeAwareWindow(win, options = {}) {
    themeAwareWindows.set(win, normalizeWindowInfo(options));
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
    windowChromeOptions,
    registerThemeAwareWindow,
    isThemeAware,
    setModalState,
    syncThemeAwareWindows,
    watchThemeChange,
};
