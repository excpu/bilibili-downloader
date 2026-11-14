// 独立窗口弹幕姬：单房间，列表渲染与显示设置与多房间控制台共用同一套实现
const { invoke, on } = window.electronAPI;
const Shared = window.DanmakujiShared;

const titleEl = document.getElementById('hjTitle');
const statusEl = document.getElementById('hjStatus');
const errorEl = document.getElementById('hjError');
const closeBtn = document.getElementById('hjClose');
const viewportEl = document.getElementById('hjViewport');
const settingsBtn = document.getElementById('hjSettings');
const settingsPanel = document.getElementById('hjSettingsPanel');
const countEl = document.getElementById('hjCount');

const SETTINGS_KEY = 'danmakuji-settings-v1';

let roomId = 0;

function loadSettings() {
    try {
        return Shared.normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
    } catch {
        return Shared.normalizeSettings(null);
    }
}

function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
        console.warn('保存弹幕姬设置失败:', error);
    }
}

const list = new window.DanmakujiList({
    viewport: viewportEl,
    settings: loadSettings(),
    onCountChange: (count) => { countEl.textContent = String(count); },
});

function applySettings(next) {
    const settings = Shared.normalizeSettings(next);
    list.setSettings(settings);
    saveSettings(settings);
    window.DanmakujiSettingsPanel.sync(settingsPanel, settings);
}

window.DanmakujiSettingsPanel.mount(settingsPanel, list.settings, {
    onChange: applySettings,
    showColumns: false,
});

function toggleSettings(force) {
    const open = force ?? settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', !open);
    settingsBtn.classList.toggle('is-active', open);
    settingsBtn.setAttribute('aria-expanded', String(open));
}

settingsBtn.addEventListener('click', () => toggleSettings());
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleSettings(false);
});

on('danmakuji:init', (payload) => {
    const nextRoomId = Number(payload?.roomId) || 0;
    list.setRoomId(nextRoomId);
    roomId = nextRoomId;
    titleEl.textContent = payload?.title || `直播间 ${roomId}`;
    titleEl.title = titleEl.textContent;
});

on('monitor:danmaku', (payload) => {
    if (!roomId || payload?.roomId !== roomId) return;
    list.push(payload.message || {});
});

on('monitor:danmaku-status', (payload) => {
    if (!roomId || payload?.roomId !== roomId) return;
    const status = payload.status || {};
    const hasError = status.state !== 'open' && !!status.message;
    statusEl.classList.remove('is-open', 'is-error');
    if (status.state === 'open') {
        statusEl.textContent = '已连接';
        statusEl.classList.add('is-open');
    } else if (status.state === 'connecting') {
        statusEl.textContent = status.reconnecting || hasError ? '重连中' : '连接中';
        if (hasError) statusEl.classList.add('is-error');
    } else {
        statusEl.textContent = status.state === 'closed' ? '重连中' : '连接失败';
        statusEl.classList.add('is-error');
    }
    statusEl.title = status.message || statusEl.textContent;
    if (errorEl) {
        errorEl.textContent = hasError ? status.message : '';
        errorEl.title = hasError ? status.message : '';
        errorEl.classList.toggle('hidden', !hasError);
    }
});

closeBtn.addEventListener('click', () => {
    if (roomId) invoke('danmakuji:closeRoomWindow', { roomId });
    window.close();
});