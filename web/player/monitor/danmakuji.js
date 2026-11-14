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
const settingsMount = document.getElementById('hjSettingsMount');
const obsCopyBtn = document.getElementById('hjObsCopy');
const obsHintEl = document.getElementById('hjObsHint');
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
    window.DanmakujiSettingsPanel.sync(settingsMount, settings);
    invoke('danmakuji:obsSyncState', { settings }).catch(() => { });
}

window.DanmakujiSettingsPanel.mount(settingsMount, list.settings, {
    onChange: applySettings,
    showColumns: false,
});

async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch { }
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch { }
    input.remove();
    return ok;
}

let obsHintTimer = null;
function setObsHint(text) {
    if (!obsHintEl) return;
    clearTimeout(obsHintTimer);
    obsHintEl.textContent = text || '';
    if (text) obsHintTimer = setTimeout(() => { obsHintEl.textContent = ''; }, 3200);
}

obsCopyBtn?.addEventListener('click', async () => {
    if (!roomId) {
        setObsHint('缺少直播间号');
        return;
    }
    const res = await invoke('danmakuji:obsStart', {});
    if (!res?.success || !res.data?.baseUrl) {
        setObsHint(res?.message || '启动服务失败');
        return;
    }
    await invoke('danmakuji:obsSyncState', { settings: list.settings }).catch(() => { });
    const url = `${res.data.baseUrl}/?room=${roomId}`;
    await copyText(url);
    setObsHint(`已复制 ${url}`);
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