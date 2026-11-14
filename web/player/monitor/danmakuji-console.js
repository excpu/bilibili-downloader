// 弹幕姬 · 多房间控制台渲染进程
// 每个直播间独占一栏（虚拟滚动列表），另有一条按接收时间合并的时间线；
// 右侧调节面板即时作用于全部列表，房间列表 / 设置 / 最近接入持久化在本地。
const { invoke, on } = window.electronAPI;
const Shared = window.DanmakujiShared;
const DanmakujiList = window.DanmakujiList;
const SettingsPanel = window.DanmakujiSettingsPanel;

const STORAGE_KEY = 'danmakuji-console-v1';
const ROOM_HUES = 8;
const UNDO_MS = 6000;
const FAVORITE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/></svg>';

const $ = id => document.getElementById(id);
const els = {
    addForm: $('addForm'),
    roomInput: $('roomInput'),
    addBtn: $('addBtn'),
    addError: $('addError'),
    globalPulse: $('globalPulse'),
    globalRate: $('globalRate'),
    togglePause: $('togglePause'),
    exportAll: $('exportAll'),
    toggleRail: $('toggleRail'),
    roomStrip: $('roomStrip'),
    roomChips: $('roomChips'),
    clearRooms: $('clearRooms'),
    roomGrid: $('roomGrid'),
    stage: $('stage'),
    mergedPanel: $('mergedPanel'),
    mergedMeta: $('mergedMeta'),
    mergedCount: $('mergedCount'),
    mergedClear: $('mergedClear'),
    mergedViewport: $('mergedViewport'),
    emptyState: $('emptyState'),
    emptyRecent: $('emptyRecent'),
    rail: $('rail'),
    settingsPanel: $('settingsPanel'),
    recentList: $('recentList'),
    favoriteList: $('favoriteList'),
    statRooms: $('statRooms'),
    statOpen: $('statOpen'),
    statTotal: $('statTotal'),
    statSc: $('statSc'),
    toasts: $('toasts'),
};

const state = {
    rooms: [],
    recent: [],
    favorites: [],
    settings: Shared.normalizeSettings(null),
    view: 'columns',
    paused: false,
    railOpen: true,
};

// roomId -> { room, el, list, chip, status, counts, refs }
const columns = new Map();
let mergedList = null;
let dragRoomId = null;
let adding = false;
let statsTimer = null;
let errorTimer = null;

// ---------------- 本地状态 ----------------
function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!saved) return;
        if (Array.isArray(saved.rooms)) {
            for (const room of saved.rooms) {
                const result = Shared.upsertRoom(state.rooms, room);
                state.rooms = result.rooms;
            }
        }
        if (Array.isArray(saved.recent)) {
            state.recent = saved.recent.filter(item => item && Number(item.roomId) > 0).slice(0, Shared.MAX_RECENT);
        }
        if (Array.isArray(saved.favorites)) {
            const favorites = new Map();
            for (const item of saved.favorites) {
                const room = Shared.normalizeRoom(item);
                if (room && !favorites.has(room.roomId)) favorites.set(room.roomId, room);
            }
            state.favorites = [...favorites.values()];
        }
        state.settings = Shared.normalizeSettings(saved.settings);
        if (saved.view === 'merged' || saved.view === 'columns') state.view = saved.view;
        if (typeof saved.railOpen === 'boolean') state.railOpen = saved.railOpen;
    } catch (error) {
        console.warn('读取弹幕姬控制台配置失败:', error);
    }
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            rooms: state.rooms,
            recent: state.recent,
            favorites: state.favorites,
            settings: state.settings,
            view: state.view,
            railOpen: state.railOpen,
        }));
    } catch (error) {
        console.warn('保存弹幕姬控制台配置失败:', error);
    }
}

// ---------------- 提示 ----------------
function toast(message, options = {}) {
    const node = document.createElement('div');
    node.className = `dc-toast${options.kind ? ` is-${options.kind}` : ''}`;
    const text = document.createElement('span');
    text.textContent = message;
    node.appendChild(text);

    let timer = null;
    const dismiss = () => {
        clearTimeout(timer);
        if (!node.isConnected) return;
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), 200);
    };
    if (options.action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = options.action.label;
        button.addEventListener('click', () => {
            dismiss();
            options.action.onClick();
        });
        node.appendChild(button);
    }
    els.toasts.appendChild(node);
    timer = setTimeout(dismiss, options.duration || (options.action ? UNDO_MS : 3200));
    while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
    return dismiss;
}

function showAddError(message) {
    clearTimeout(errorTimer);
    if (!message) {
        els.addError.classList.add('hidden');
        return;
    }
    els.addError.textContent = message;
    els.addError.classList.remove('hidden');
    errorTimer = setTimeout(() => els.addError.classList.add('hidden'), 6000);
}

// ---------------- 房间标识 ----------------
function hueFor(roomId) {
    const index = state.rooms.findIndex(room => room.roomId === roomId);
    return `var(--room-${(index < 0 ? 0 : index) % ROOM_HUES + 1})`;
}

function labelFor(room) {
    return room.anchorName || room.title || `#${room.roomId}`;
}

function roomTagFor(message) {
    const room = state.rooms.find(item => item.roomId === message._roomId);
    if (!room) return null;
    return { label: labelFor(room), title: `${room.title} · #${room.roomId}`, color: hueFor(room.roomId) };
}

// ---------------- 房间栏 ----------------
function buildColumn(room) {
    const el = document.createElement('article');
    el.className = 'dc-room';
    el.dataset.roomId = String(room.roomId);
    el.draggable = true;
    el.innerHTML = `
        <header class="dc-room-head" title="拖动可调整顺序">
            <span class="dc-room-handle" aria-hidden="true">⋮⋮</span>
            <div class="dc-room-title"></div>
            <div class="dc-room-metrics">
                <span class="dc-room-rate">0.0</span>
                <span class="dc-room-count">0 条</span>
            </div>
            <div class="dc-room-sub">
                <span class="dc-room-anchor"></span>
                <span class="dc-room-status">连接中</span>
            </div>
            <div class="dc-room-actions">
                <button type="button" class="dc-room-btn dc-favorite-btn" data-action="favorite" title="收藏直播间" aria-label="收藏直播间" aria-pressed="false">${FAVORITE_ICON}</button>
                <button type="button" class="dc-room-btn" data-action="pause" title="暂停这一栏" aria-label="暂停这一栏" aria-pressed="false">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path class="dc-icon-pause" d="M9 5v14M15 5v14"/><path class="dc-icon-play" d="m9 5 10 7-10 7Z"/></svg>
                </button>
                <button type="button" class="dc-room-btn" data-action="popout" title="弹出为独立窗口" aria-label="弹出为独立窗口" aria-pressed="false">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button type="button" class="dc-room-btn" data-action="open" title="在浏览器中打开直播间" aria-label="在浏览器中打开直播间">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
                </button>
                <button type="button" class="dc-room-btn" data-action="clear" title="清空这一栏" aria-label="清空这一栏">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 7 7-9 9H7l-4-4ZM8 11l7 7M12 20h9"/></svg>
                </button>
                <button type="button" class="dc-room-btn" data-action="remove" title="移除直播间" aria-label="移除直播间">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
                </button>
            </div>
        </header>
        <div class="dc-room-offline hidden">主播尚未开播，弹幕连接保持中</div>
        <div class="dc-room-popout-note">弹幕已在独立窗口显示</div>
        <div class="hj-viewport dc-room-list"></div>
        <footer class="dc-room-foot">
            <span class="dc-room-foot-text"></span>
            <span class="dc-room-pending hidden"></span>
            <button type="button" class="dc-room-follow hidden">↓ 回到最新</button>
        </footer>
    `;

    const refs = {
        title: el.querySelector('.dc-room-title'),
        anchor: el.querySelector('.dc-room-anchor'),
        status: el.querySelector('.dc-room-status'),
        rate: el.querySelector('.dc-room-rate'),
        count: el.querySelector('.dc-room-count'),
        foot: el.querySelector('.dc-room-foot-text'),
        pending: el.querySelector('.dc-room-pending'),
        follow: el.querySelector('.dc-room-follow'),
        offline: el.querySelector('.dc-room-offline'),
        pauseBtn: el.querySelector('[data-action="pause"]'),
        popoutBtn: el.querySelector('[data-action="popout"]'),
        favoriteBtn: el.querySelector('[data-action="favorite"]'),
    };

    const column = {
        roomId: room.roomId,
        room,
        el,
        refs,
        status: { state: 'connecting' },
        counts: { total: 0, sc: 0 },
        popout: false,
        list: null,
        // 主进程订阅前的消息先缓存，订阅确认后按序补入，避免漏掉开头几条
        pendingIpc: [],
        watching: false,
    };

    column.list = new DanmakujiList({
        viewport: el.querySelector('.dc-room-list'),
        roomId: room.roomId,
        settings: state.settings,
        onFollowChange: (following) => refs.follow.classList.toggle('hidden', following),
        onPendingChange: (pending) => {
            refs.pending.classList.toggle('hidden', pending === 0);
            refs.pending.textContent = pending ? `+${pending} 条待显示` : '';
        },
        onCountChange: (count) => { refs.count.textContent = `${count} 条`; },
    });

    refs.follow.addEventListener('click', () => column.list.setFollow(true));
    el.querySelector('.dc-room-actions').addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        handleColumnAction(column, button.dataset.action);
    });

    el.addEventListener('dragstart', (event) => {
        if (event.target.closest('button')) {
            event.preventDefault();
            return;
        }
        dragRoomId = room.roomId;
        el.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(room.roomId));
    });
    el.addEventListener('dragend', () => {
        dragRoomId = null;
        el.classList.remove('is-dragging');
        columns.forEach(col => col.el.classList.remove('is-drop-target'));
    });
    el.addEventListener('dragover', (event) => {
        if (!dragRoomId || dragRoomId === room.roomId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (event) => {
        event.preventDefault();
        el.classList.remove('is-drop-target');
        const from = state.rooms.findIndex(item => item.roomId === dragRoomId);
        const to = state.rooms.findIndex(item => item.roomId === room.roomId);
        if (from < 0 || to < 0 || from === to) return;
        state.rooms = Shared.moveRoom(state.rooms, from, to);
        reorderColumns();
        saveState();
    });

    updateColumnMeta(column);
    return column;
}

function updateColumnMeta(column) {
    const { room, refs } = column;
    updateFavoriteButton(refs.favoriteBtn, room.roomId);
    refs.title.textContent = room.title;
    refs.title.title = room.title;
    refs.anchor.textContent = [room.anchorName, `#${room.roomId}`].filter(Boolean).join(' · ');
    refs.offline.classList.toggle('hidden', room.liveStatus == null || Number(room.liveStatus) === 1);
    column.el.style.setProperty('--room-hue', hueFor(room.roomId));
    updateColumnStatus(column);
}

function updateColumnStatus(column) {
    const { status, refs } = column;
    refs.status.classList.remove('is-open', 'is-connecting', 'is-error');
    let text = '连接中';
    if (status.state === 'open') {
        text = '已连接';
        refs.status.classList.add('is-open');
    } else if (status.state === 'connecting') {
        refs.status.classList.add('is-connecting');
    } else {
        text = status.state === 'closed' ? '重连中' : '连接失败';
        refs.status.classList.add('is-error');
    }
    refs.status.textContent = text;
    refs.status.title = status.message || text;
    refs.foot.textContent = status.message && status.state !== 'open'
        ? status.message
        : (column.room.liveStatus == null ? (column.liveStatusError ? '直播状态获取失败' : '直播状态获取中') : Number(column.room.liveStatus) === 1 ? `开播中 · ${column.room.title}` : '等待开播');
    refs.foot.title = refs.foot.textContent;
}

function updatePauseButton(column, paused) {
    const button = column.refs.pauseBtn;
    button.classList.toggle('is-active', paused);
    button.title = paused ? '继续这一栏' : '暂停这一栏';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(paused));
}

function handleColumnAction(column, action) {
    switch (action) {
        case 'favorite':
            toggleFavorite(column.room);
            break;
        case 'pause': {
            const paused = !column.list.paused;
            column.list.setPaused(paused);
            updatePauseButton(column, paused);
            break;
        }
        case 'popout':
            togglePopout(column);
            break;
        case 'open':
            invoke('danmakuji:openRoomPage', column.roomId);
            break;
        case 'clear':
            column.list.clear();
            column.counts = { total: 0, sc: 0 };
            toast(`已清空「${labelFor(column.room)}」的弹幕`, { kind: 'ok' });
            break;
        case 'remove':
            removeRoom(column.roomId, { undo: true });
            break;
        default:
            break;
    }
}

async function togglePopout(column) {
    if (column.popout) {
        await invoke('danmakuji:closeRoomWindow', { roomId: column.roomId });
        return;
    }
    const res = await invoke('danmakuji:openRoomWindow', { roomId: column.roomId, title: column.room.title });
    if (res?.success === false) toast(res.message || '打开独立窗口失败', { kind: 'error' });
}

function setPopoutState(roomId, opened) {
    const column = columns.get(roomId);
    if (!column) return;
    column.popout = opened;
    column.el.classList.toggle('is-popout', opened);
    column.refs.popoutBtn.classList.toggle('is-popout', opened);
    column.refs.popoutBtn.title = opened ? '关闭独立窗口' : '弹出为独立窗口';
    column.refs.popoutBtn.setAttribute('aria-label', column.refs.popoutBtn.title);
    column.refs.popoutBtn.setAttribute('aria-pressed', String(opened));
}

function reorderColumns() {
    // 按新顺序重排 DOM：已在正确位置的栏目不重新挂载，避免滚动位置与动画被重置
    let anchor = null;
    for (const room of state.rooms) {
        const column = columns.get(room.roomId);
        if (!column) continue;
        const expected = anchor ? anchor.nextElementSibling : els.roomGrid.firstElementChild;
        if (expected !== column.el) els.roomGrid.insertBefore(column.el, expected);
        updateColumnMeta(column);
        anchor = column.el;
    }
    renderChips();
}

// ---------------- 房间增删 ----------------
function addRoom(room, { silent = false, refreshStatus = false } = {}) {
    const result = Shared.upsertRoom(state.rooms, room);
    const normalized = result.room;
    if (!normalized) return false;
    if (refreshStatus) normalized.liveStatus = null;

    // 已存在的房间只刷新信息并高亮，不重建列表
    if (columns.has(normalized.roomId)) {
        const column = columns.get(normalized.roomId);
        if (column) {
            column.room = normalized;
            column.liveStatusVersion = (column.liveStatusVersion || 0) + 1;
            updateColumnMeta(column);
            column.el.classList.remove('is-flash');
            void column.el.offsetWidth;
            column.el.classList.add('is-flash');
            column.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        state.rooms = result.rooms;
        reorderColumns();
        state.recent = Shared.rememberRecent(state.recent, normalized);
        saveState();
        renderRecent();
        if (!silent) toast(`「${labelFor(normalized)}」已在列表中`, { kind: 'ok' });
        return false;
    }

    state.rooms = result.rooms;
    const column = buildColumn(normalized);
    columns.set(normalized.roomId, column);
    els.roomGrid.appendChild(column.el);
    column.list.setPaused(state.paused);
    updatePauseButton(column, state.paused);
    invoke('danmakuji:watch', { roomId: normalized.roomId }).then((res) => {
        if (!columns.has(normalized.roomId)) return;
        column.watching = true;
        if (res?.success === false) toast(res.message || '连接弹幕失败', { kind: 'error' });
        const buffered = column.pendingIpc;
        column.pendingIpc = [];
        for (const message of buffered) handleRoomMessage(normalized.roomId, message);
    }).catch(() => { column.watching = true; });
    if (refreshStatus) refreshRoomStatus(column);

    state.recent = Shared.rememberRecent(state.recent, normalized);
    reorderColumns();
    applyColumns();
    saveState();
    renderRecent();
    updateEmptyState();
    if (!silent) toast(`已接入「${labelFor(normalized)}」`, { kind: 'ok' });
    return true;
}

function removeRoom(roomId, { undo = false } = {}) {
    const index = state.rooms.findIndex(room => room.roomId === roomId);
    if (index < 0) return;
    const room = state.rooms[index];
    const column = columns.get(roomId);

    state.rooms.splice(index, 1);
    if (column) {
        column.list.destroy();
        column.el.remove();
        columns.delete(roomId);
    }
    invoke('danmakuji:unwatch', { roomId });
    if (column?.popout) invoke('danmakuji:closeRoomWindow', { roomId });

    reorderColumns();
    applyColumns();
    saveState();
    updateEmptyState();
    renderRecent();

    if (undo) {
        toast(`已移除「${labelFor(room)}」`, {
            action: {
                label: '撤销',
                onClick: () => {
                    const restored = addRoom(room, { silent: true, refreshStatus: true });
                    if (!restored) return;
                    const from = state.rooms.findIndex(item => item.roomId === roomId);
                    state.rooms = Shared.moveRoom(state.rooms, from, Math.min(index, state.rooms.length - 1));
                    reorderColumns();
                    saveState();
                },
            },
        });
    }
}

async function refreshRoomStatus(column) {
    const version = column.liveStatusVersion || 0;
    try {
        const res = await invoke('danmakuji:resolveRoom', String(column.roomId));
        if (columns.get(column.roomId) !== column || (column.liveStatusVersion || 0) !== version) return;
        if (!res?.success || !res.data || res.data.liveStatus == null || !Number.isFinite(Number(res.data.liveStatus))) {
            throw new Error(res?.message || '获取直播状态失败');
        }
        column.room.liveStatus = Number(res.data.liveStatus);
        column.liveStatusError = false;
        updateColumnMeta(column);
        renderChips();
        saveState();
    } catch (error) {
        if (columns.get(column.roomId) !== column || (column.liveStatusVersion || 0) !== version) return;
        console.warn(`获取直播间 ${column.roomId} 的直播状态失败:`, error);
        toast(`直播间 #${column.roomId}：${error.message || '获取直播状态失败'}`, { kind: 'error' });
        column.liveStatusError = true;
        updateColumnStatus(column);
    }
}

async function submitRooms(raw) {
    if (adding) return;
    const tokens = String(raw || '').split(/[\s,，、;；]+/).map(item => item.trim()).filter(Boolean);
    if (!tokens.length) {
        showAddError('请输入直播间号、短号或直播间链接');
        els.roomInput.focus();
        return;
    }

    const ids = [];
    const invalid = [];
    for (const token of tokens) {
        const id = Shared.parseRoomInput(token);
        if (id && !ids.includes(id)) ids.push(id);
        else if (!id) invalid.push(token);
    }
    if (!ids.length) {
        showAddError(`无法识别：${invalid.slice(0, 3).join('、')}`);
        return;
    }

    const fresh = ids.filter(id => !columns.has(id));
    const available = Math.max(0, Shared.MAX_ROOMS - columns.size);
    const overflow = fresh.length > available;

    adding = true;
    els.addBtn.disabled = true;
    els.addBtn.textContent = '接入中…';
    let added = 0;
    let skipped = 0;
    const failures = [];
    try {
        for (const id of ids.slice(0, Shared.MAX_ROOMS)) {
            if (!columns.has(id) && columns.size >= Shared.MAX_ROOMS) {
                skipped++;
                continue;
            }
            try {
                const res = await invoke('danmakuji:resolveRoom', String(id));
                if (res?.success && res.data) {
                    if (addRoom(res.data, { silent: true })) added++;
                } else {
                    failures.push(`#${id}：${res?.message || '获取失败'}`);
                }
            } catch (error) {
                failures.push(`#${id}：${error.message || '网络错误'}`);
            }
        }
    } finally {
        adding = false;
        els.addBtn.disabled = false;
        els.addBtn.textContent = '接入';
    }

    if (added || !failures.length) {
        els.roomInput.value = '';
    }
    if (added) toast(`已接入 ${added} 个直播间`, { kind: 'ok' });
    const problems = [...failures, ...invalid.map(item => `无法识别：${item}`)];
    if (overflow || skipped) problems.unshift(`最多同时接入 ${Shared.MAX_ROOMS} 个直播间，${skipped || fresh.length - available} 个新房间未接入`);
    showAddError(problems.length ? problems.slice(0, 4).join('；') : '');
    updateEmptyState();
}

// ---------------- 视图 ----------------
function applyView(view) {
    state.view = view === 'merged' ? 'merged' : 'columns';
    document.querySelectorAll('.dc-view-btn').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.view === state.view);
    });
    const merged = state.view === 'merged';
    updateEmptyState();
    applyColumns();
    // 隐藏的列表在重新显示时按真实视口重新定位（两帧后布局已稳定）
    const relayout = () => {
        const lists = merged ? [mergedList] : [...columns.values()].map(column => column.list);
        for (const list of lists) {
            if (list.autoScroll) list.scrollToBottom();
            list.scheduleRender();
        }
    };
    requestAnimationFrame(() => requestAnimationFrame(relayout));
    saveState();
}

function updateEmptyState() {
    const empty = columns.size === 0;
    els.emptyState.classList.toggle('hidden', !empty);
    els.roomStrip.classList.toggle('hidden', empty);
    els.roomGrid.classList.toggle('hidden', empty || state.view === 'merged');
    els.mergedPanel.classList.toggle('hidden', empty || state.view !== 'merged');
    els.mergedMeta.textContent = `${state.rooms.length} 个直播间 · 按接收时间排列`;
    els.mergedCount.textContent = `${mergedList.count} 条`;
}

function applyPaused(paused, { silent = false } = {}) {
    state.paused = !!paused;
    els.togglePause.textContent = state.paused ? '继续' : '暂停';
    els.togglePause.classList.toggle('is-active', state.paused);
    els.togglePause.title = state.paused ? '继续全部弹幕滚动（空格）' : '暂停全部弹幕滚动（空格）';
    columns.forEach((column) => {
        column.list.setPaused(state.paused);
        updatePauseButton(column, state.paused);
    });
    mergedList.setPaused(state.paused);
    if (!silent) toast(state.paused ? '已暂停全部滚动，新弹幕会在继续后补上' : '已继续接收', { kind: 'ok' });
}

function applyRail(open) {
    state.railOpen = !!open;
    document.body.classList.toggle('rail-collapsed', !state.railOpen);
    els.toggleRail.classList.toggle('is-active', state.railOpen);
    els.toggleRail.setAttribute('aria-expanded', String(state.railOpen));
    saveState();
}

// ---------------- 设置 ----------------
function applySettings(next, { persist = true } = {}) {
    state.settings = Shared.normalizeSettings(next);
    columns.forEach(column => column.list.setSettings(state.settings));
    mergedList.setSettings(state.settings);
    applyColumns();
    SettingsPanel.sync(els.settingsPanel, state.settings);
    if (persist) saveState();
}

// 自动分栏：按舞台宽度容纳尽可能多的 ≥300px 栏目；固定分栏则直接使用设定值
function resolveColumnCount() {
    const setting = state.settings.columns;
    if (setting !== 'auto') return Math.max(1, Number(setting) || 1);
    const width = els.stage?.clientWidth || els.roomGrid.clientWidth || 900;
    const fit = Math.floor((width + 10) / 310);
    return Math.max(1, Math.min(columns.size || 1, fit || 1));
}

function applyColumns() {
    const cols = resolveColumnCount();
    const rows = Math.max(1, Math.ceil(columns.size / cols));
    els.roomGrid.dataset.columns = String(state.settings.columns);
    els.roomGrid.style.setProperty('--cols', String(cols));
    els.roomGrid.style.setProperty('--rows', String(rows));
}

// ---------------- 芯片 / 最近 / 统计 ----------------
function renderChips() {
    els.roomChips.textContent = '';
    for (const room of state.rooms) {
        const column = columns.get(room.roomId);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `dc-chip${Number(room.liveStatus) === 1 ? '' : ' is-offline'}`;
        chip.style.setProperty('--room-hue', hueFor(room.roomId));
        chip.title = `${room.title} · #${room.roomId}`;
        chip.innerHTML = '<span class="dc-chip-dot"></span><span class="dc-chip-name"></span><span class="dc-chip-rate">0.0</span>';
        chip.querySelector('.dc-chip-name').textContent = labelFor(room);
        chip.addEventListener('click', () => {
            if (state.view !== 'columns') applyView('columns');
            column?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            if (column) {
                column.el.classList.remove('is-flash');
                void column.el.offsetWidth;
                column.el.classList.add('is-flash');
            }
        });
        els.roomChips.appendChild(chip);
        if (column) column.refs.chipRate = chip.querySelector('.dc-chip-rate');
    }
}

function updateFavoriteButton(button, roomId) {
    const saved = state.favorites.some(room => room.roomId === roomId);
    button.classList.toggle('is-favorite', saved);
    button.title = saved ? '取消收藏' : '收藏直播间';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(saved));
}

function toggleFavorite(room) {
    if (state.favorites.some(item => item.roomId === room.roomId)) {
        state.favorites = state.favorites.filter(item => item.roomId !== room.roomId);
    } else {
        state.favorites = Shared.upsertRoom(state.favorites, room, Infinity).rooms;
    }
    saveState();
    columns.forEach(column => updateFavoriteButton(column.refs.favoriteBtn, column.roomId));
    renderRecent();
}

function renderSavedRooms(container, rooms, emptyText) {
    container.textContent = '';
    if (!rooms.length) {
        const empty = document.createElement('span');
        empty.className = 'dc-recent-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }
    for (const item of rooms) {
        const row = document.createElement('div');
        row.className = 'dc-saved-room';
        const chip = document.createElement('button');
        chip.type = 'button';
        const added = columns.has(item.roomId);
        chip.className = `dc-recent-chip${added ? ' is-added' : ''}`;
        chip.title = added ? '已在列表中' : `接入 #${item.roomId}`;
        chip.innerHTML = '<span></span><small></small>';
        chip.querySelector('span').textContent = item.anchorName || item.title || `#${item.roomId}`;
        chip.querySelector('small').textContent = `#${item.roomId}`;
        if (!added) chip.addEventListener('click', () => submitRooms(String(item.roomId)));
        row.appendChild(chip);
        const favorite = document.createElement('button');
        favorite.type = 'button';
        favorite.className = 'dc-room-btn dc-favorite-btn';
        favorite.innerHTML = FAVORITE_ICON;
        updateFavoriteButton(favorite, item.roomId);
        favorite.addEventListener('click', () => toggleFavorite(item));
        row.appendChild(favorite);
        container.appendChild(row);
    }
}

function renderRecent() {
    renderSavedRooms(els.favoriteList, state.favorites, '点击房间或最近接入记录的星标即可收藏');
    renderSavedRooms(els.recentList, state.recent, '接入过的直播间会出现在这里');
    renderSavedRooms(els.emptyRecent, state.recent, '');
}

function updateStats() {
    const now = Date.now();
    let open = 0;
    let total = 0;
    let sc = 0;
    let rate = 0;
    columns.forEach((column) => {
        if (column.status.state === 'open') open++;
        total += column.counts.total;
        sc += column.counts.sc;
        const text = column.list.rateText(now);
        rate += Number(text) || 0;
        column.refs.rate.textContent = text;
        if (column.refs.chipRate) column.refs.chipRate.textContent = text;
    });
    els.globalRate.textContent = rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
    els.globalPulse.classList.toggle('is-idle', rate === 0);
    els.statRooms.textContent = String(state.rooms.length);
    els.statOpen.textContent = String(open);
    els.statTotal.textContent = total.toLocaleString('zh-CN');
    els.statSc.textContent = String(sc);
    els.mergedCount.textContent = `${mergedList.count} 条`;
}

// ---------------- 导出 ----------------
async function exportAll() {
    if (!state.rooms.length) {
        toast('还没有接入直播间', { kind: 'error' });
        return;
    }
    const sections = [];
    for (const room of state.rooms) {
        const column = columns.get(room.roomId);
        if (!column) continue;
        const text = column.list.exportText();
        sections.push(`===== ${room.title} · ${room.anchorName || ''} · #${room.roomId} =====\n${text || '（无弹幕）'}`);
    }
    const stamp = Shared.formatClock(Date.now()).replace(/:/g, '-');
    const res = await invoke('danmakuji:export', {
        text: sections.join('\n\n'),
        defaultName: `弹幕姬-${state.rooms.length}间-${stamp}`,
    });
    if (res?.success === false) toast(res.message || '导出失败', { kind: 'error' });
    else if (res?.path) toast(`已导出到 ${res.path}`, { kind: 'ok', duration: 5000 });
}

// ---------------- 主进程推送 ----------------
function handleRoomMessage(roomId, message) {
    const column = columns.get(roomId);
    if (!column) return;
    if (message.type === 'live_status') {
        column.liveStatusVersion = (column.liveStatusVersion || 0) + 1;
        column.liveStatusError = false;
        column.room.liveStatus = Number(message.value) || 0;
        const saved = state.rooms.find(room => room.roomId === roomId);
        if (saved) saved.liveStatus = column.room.liveStatus;
        updateColumnMeta(column);
        renderChips();
        saveState();
        return;
    }
    const stamped = { ...message, _roomId: roomId };
    if (column.list.push(stamped)) {
        column.counts.total++;
        if (message.type === 'superchat') column.counts.sc++;
    }
    mergedList.push(stamped);
}

function bindIpc() {
    on('danmakuji:room-message', (payload) => {
        const roomId = Number(payload?.roomId);
        const column = columns.get(roomId);
        if (!column) return;
        const message = payload.message || {};
        if (!column.watching) {
            column.pendingIpc.push(message);
            if (column.pendingIpc.length > 200) column.pendingIpc.shift();
            return;
        }
        handleRoomMessage(roomId, message);
    });

    on('danmakuji:room-status', (payload) => {
        const column = columns.get(Number(payload?.roomId));
        if (!column) return;
        column.status = payload.status || { state: 'connecting' };
        updateColumnStatus(column);
    });

    on('danmakuji:window-opened', (payload) => setPopoutState(Number(payload?.roomId), true));
    on('danmakuji:window-closed', (payload) => setPopoutState(Number(payload?.roomId), false));
}

// ---------------- UI 事件 ----------------
function bindUi() {
    els.addForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitRooms(els.roomInput.value);
    });
    els.roomInput.addEventListener('input', () => showAddError(''));

    document.querySelectorAll('.dc-view-btn').forEach((button) => {
        button.addEventListener('click', () => applyView(button.dataset.view));
    });
    els.togglePause.addEventListener('click', () => applyPaused(!state.paused));
    els.exportAll.addEventListener('click', exportAll);
    els.toggleRail.addEventListener('click', () => applyRail(!state.railOpen));
    els.mergedClear.addEventListener('click', () => {
        mergedList.clear();
        toast('已清空合并时间线', { kind: 'ok' });
    });
    els.clearRooms.addEventListener('click', () => {
        if (!state.rooms.length) return;
        const snapshot = state.rooms.slice();
        for (const room of snapshot) removeRoom(room.roomId);
        toast(`已移除全部 ${snapshot.length} 个直播间`, {
            action: {
                label: '撤销',
                onClick: () => snapshot.forEach(room => addRoom(room, { silent: true })),
            },
        });
    });

    document.addEventListener('keydown', (event) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '');
        if (event.key === 'Escape') {
            showAddError('');
            if (typing) event.target.blur();
            return;
        }
        if (typing) return;
        if (event.key === ' ') {
            event.preventDefault();
            applyPaused(!state.paused);
        } else if (event.key === '/') {
            event.preventDefault();
            els.roomInput.focus();
        }
    });

    // 舞台尺寸变化（窗口缩放 / 折叠调节面板）时重新计算自动分栏
    new ResizeObserver(() => applyColumns()).observe(els.stage);

    window.addEventListener('beforeunload', () => {
        clearInterval(statsTimer);
    });
}

// ---------------- 启动 ----------------
function init() {
    loadState();

    mergedList = new DanmakujiList({
        viewport: els.mergedViewport,
        settings: state.settings,
        roomTagFor,
        linePrefixFor: (message) => {
            const tag = roomTagFor(message);
            return tag ? `【${tag.label}】` : '';
        },
        onCountChange: (count) => { els.mergedCount.textContent = `${count} 条`; },
    });

    SettingsPanel.mount(els.settingsPanel, state.settings, {
        onChange: (next) => applySettings(next),
        showColumns: true,
    });

    bindUi();
    bindIpc();
    applyColumns();
    applyView(state.view);
    applyRail(state.railOpen);

    for (const room of state.rooms.slice()) {
        if (columns.size >= Shared.MAX_ROOMS) break;
        addRoom(room, { silent: true, refreshStatus: true });
    }
    state.rooms = state.rooms.filter(room => columns.has(room.roomId));
    applyPaused(false, { silent: true });
    renderRecent();
    updateEmptyState();
    updateStats();
    statsTimer = setInterval(updateStats, 1000);

    invoke('danmakuji:roomWindowState').then((res) => {
        for (const roomId of res?.rooms || []) setPopoutState(Number(roomId), true);
    }).catch(() => { });
}

init();