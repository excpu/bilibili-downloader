// DD 监控室渲染进程：多路直播流 + 实时弹幕
const { invoke, on } = window.electronAPI;

const LAYOUTS = [2, 4, 6, 9];
const MAX_SLOTS = 9;
const MAX_RECENT = 8;
const MAX_DANMAKU_LINES = 14;
const MAX_SCROLL_DANMAKU = 40;
const MAX_SUPERCHAT_CARDS = 3;
const STORAGE_KEY = 'dd-monitor-state-v1';
const STREAM_ERROR_RETRY_DELAY = 3000;

// artplayer 双击默认全屏，监控室里双击用于放大单格；右键菜单改由本页自行实现
if (window.Artplayer) {
    window.Artplayer.DBCLICK_FULLSCREEN = false;
    // 关闭内置右键菜单，改用监控室自定义菜单
    window.Artplayer.CONTEXTMENU = false;
}

const gridEl = document.getElementById('grid');
const hintEl = document.getElementById('hint');

const state = {
    layout: 4,
    muted: true,
    danmaku: true,
    // 固定保留 9 个槽位，切换布局时不会丢失已分配的房间
    slots: new Array(MAX_SLOTS).fill(null),
    recent: [],
};

// 每个画面的弹幕显示偏好：是否显示、滚动或底部样式
const tilePrefs = new Array(MAX_SLOTS).fill(null).map(() => ({
    danmaku: true,
    style: 'bottom',
    superchat: true,
    danmakuji: false,
}));

// SC 卡片按金额分档取色，与官方上房区配色一致（接口 price 单位为元，10 电池 = 1 元）
const SC_TIERS = [
    { min: 2000, name: 'tier-20000' },
    { min: 1000, name: 'tier-10000' },
    { min: 500, name: 'tier-5000' },
    { min: 100, name: 'tier-1000' },
    { min: 50, name: 'tier-500' },
    { min: 0, name: 'tier-300' },
];

const tiles = [];

// ---------------- 本地状态 ----------------
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (LAYOUTS.includes(saved.layout)) state.layout = saved.layout;
        if (typeof saved.muted === 'boolean') state.muted = saved.muted;
        if (typeof saved.danmaku === 'boolean') state.danmaku = saved.danmaku;
        if (Array.isArray(saved.slots)) {
            saved.slots.slice(0, MAX_SLOTS).forEach((room, index) => {
                if (room && room.roomId) state.slots[index] = room;
            });
        }
        if (Array.isArray(saved.recent)) {
            state.recent = saved.recent.filter(item => item && item.roomId).slice(0, MAX_RECENT);
        }
        if (Array.isArray(saved.tilePrefs)) {
            saved.tilePrefs.slice(0, MAX_SLOTS).forEach((pref, index) => {
                if (!pref) return;
                if (typeof pref.danmaku === 'boolean') tilePrefs[index].danmaku = pref.danmaku;
                if (pref.style === 'scroll' || pref.style === 'bottom') tilePrefs[index].style = pref.style;
                if (typeof pref.superchat === 'boolean') tilePrefs[index].superchat = pref.superchat;
                if (typeof pref.danmakuji === 'boolean') tilePrefs[index].danmakuji = pref.danmakuji;
            });
        }
    } catch (error) {
        console.warn('读取监控室本地配置失败:', error);
    }
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            layout: state.layout,
            muted: state.muted,
            danmaku: state.danmaku,
            slots: state.slots,
            recent: state.recent,
            tilePrefs,
        }));
    } catch (error) {
        console.warn('保存监控室配置失败:', error);
    }
}

function rememberRoom(room) {
    state.recent = [
        { roomId: room.roomId, title: room.title, anchorName: room.anchorName },
        ...state.recent.filter(item => item.roomId !== room.roomId),
    ].slice(0, MAX_RECENT);
}

function formatCount(value) {
    const num = Number(value) || 0;
    if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
    return String(num);
}

// ---------------- 画面卡片 ----------------
function buildTile(index) {
    const tile = document.createElement('div');
    tile.className = 'tile is-empty';
    tile.dataset.index = String(index);
    tile.innerHTML = `
        <div class="tile-player"></div>
        <div class="tile-danmaku"></div>
        <div class="tile-superchat"></div>
        <div class="tile-overlay">
            <div class="spinner"></div>
            <div class="overlay-text"></div>
            <button type="button" class="overlay-retry hidden">重新加载</button>
        </div>
        <div class="tile-empty">
            <div class="tile-empty-icon">＋</div>
            <div class="tile-empty-text">分配直播间</div>
        </div>
        <div class="tile-top">
            <div class="tile-meta">
                <span class="tile-room-title"></span>
                <span class="tile-room-sub"></span>
            </div>
            <div class="tile-status">空位</div>
            <div class="tile-actions">
                <button type="button" class="tile-action" data-action="switch" title="更换直播间">⇄</button>
                <button type="button" class="tile-action" data-action="refresh" title="重新加载">⟳</button>
                <button type="button" class="tile-action" data-action="remove" title="移除">✕</button>
            </div>
        </div>
    `;

    const controller = new MonitorTile(index, tile);
    tile.addEventListener('click', (event) => {
        if (event.target.closest('.tile-action') || event.target.closest('.overlay-retry')) return;
        if (tile.classList.contains('is-empty')) {
            openPicker(index);
        }
    });
    tile.addEventListener('dblclick', (event) => {
        if (event.target.closest('.tile-action') || event.target.closest('.overlay-retry')) return;
        if (tile.classList.contains('is-empty')) return;
        toggleZoom(index);
    });

    // 自定义右键菜单，替代 artplayer 内置菜单
    tile.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openContextMenu(event.clientX, event.clientY, controller);
    });

    tile.querySelectorAll('.tile-action').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const action = button.dataset.action;
            if (action === 'switch') openPicker(index);
            if (action === 'refresh') controller.reload();
            if (action === 'remove') assignRoom(index, null);
        });
    });

    tile.querySelector('.overlay-retry').addEventListener('click', (event) => {
        event.stopPropagation();
        controller.reload();
    });

    return controller;
}

class MonitorTile {
    constructor(index, el) {
        this.index = index;
        this.el = el;
        this.playerEl = el.querySelector('.tile-player');
        this.danmakuEl = el.querySelector('.tile-danmaku');
        this.superchatEl = el.querySelector('.tile-superchat');
        this.overlayEl = el.querySelector('.tile-overlay');
        this.overlayTextEl = el.querySelector('.overlay-text');
        this.retryBtn = el.querySelector('.overlay-retry');
        this.metaTitleEl = el.querySelector('.tile-room-title');
        this.metaSubEl = el.querySelector('.tile-room-sub');
        this.statusEl = el.querySelector('.tile-status');
        this.emptyEl = el.querySelector('.tile-empty');

        this.room = null;
        this.art = null;
        this.flvPlayer = null;
        this.visible = true;
        this.loadToken = 0;
        this.retryTimer = null;
        this.pendingDanmaku = [];
        this.danmakuTimer = null;
        this.laneReadyAt = [];
        this.statusKind = 'empty';
        this.onlineCount = 0;
        this.resizeObserver = new ResizeObserver(() => {
            if (this.art) this.art.resize();
            this.syncDanmakuMetrics();
        });
        this.resizeObserver.observe(el);
        this.syncDanmakuMetrics();
    }

    // 滚动弹幕字号随画面高度缩放并设置下限，避免 9 宫格时文字过小；底部列表不受影响
    syncDanmakuMetrics() {
        const fontSize = Math.max(14, Math.min(22, Math.round(this.el.clientHeight * 0.055)));
        this.danmakuFontSize = fontSize;
        this.danmakuEl.style.setProperty('--scroll-font-size', `${fontSize}px`);
    }

    get roomId() {
        return this.room?.roomId || null;
    }

    setVisible(visible) {
        if (this.visible === visible) return;
        this.visible = visible;
        if (!visible) {
            this.teardownPlayer();
            this.stopDanmaku();
        } else if (this.room) {
            this.load();
            this.startDanmaku();
        }
    }

    setRoom(room) {
        // 先按旧房间号退订弹幕，再替换为新房间
        const oldRoomId = this.roomId;
        this.stopDanmaku();
        this.room = room;
        this.loadToken += 1;
        this.onlineCount = 0;
        this.teardownPlayer();
        this.danmakuEl.innerHTML = '';
        this.superchatEl.innerHTML = '';

        if (!room) {
            this.el.classList.add('is-empty');
            this.el.classList.remove('is-loading', 'is-error', 'is-offline');
            this.metaTitleEl.textContent = '';
            this.metaSubEl.textContent = '';
            this.statusKind = 'empty';
            this.renderStatus();
            this.danmakuEl.classList.add('is-off');
            return;
        }

        this.el.classList.remove('is-empty');
        this.metaTitleEl.textContent = room.title || `直播间 ${room.roomId}`;
        this.metaSubEl.textContent = [room.anchorName, `#${room.roomId}`].filter(Boolean).join(' · ');
        this.setStatus(room.liveStatus ? 'live' : 'offline');
        this.applyDanmakuStyle();

        if (this.visible) {
            this.load();
            this.startDanmaku();
        }
        // 弹幕姬开启时换房间，需要同步切到新房间的弹幕姬
        if (tilePrefs[this.index].danmakuji) {
            if (room) {
                invoke('monitor:openDanmakuji', { roomId: room.roomId, title: room.title });
            } else {
                invoke('monitor:closeDanmakuji', { roomId: oldRoomId });
                tilePrefs[this.index].danmakuji = false;
                saveState();
            }
        }
    }

    setStatus(kind, text) {
        this.statusKind = kind;
        this.el.classList.remove('is-loading', 'is-error', 'is-offline');

        if (kind === 'loading') {
            this.el.classList.add('is-loading');
            this.overlayTextEl.textContent = text || '正在获取直播流...';
            this.retryBtn.classList.add('hidden');
        } else if (kind === 'error') {
            this.el.classList.add('is-error');
            this.overlayTextEl.textContent = text || '播放失败';
            this.retryBtn.classList.remove('hidden');
        } else if (kind === 'offline') {
            this.el.classList.add('is-offline');
            this.overlayTextEl.textContent = text || '主播尚未开播，等待中...';
            this.retryBtn.classList.add('hidden');
        } else {
            this.overlayTextEl.textContent = '';
            this.retryBtn.classList.add('hidden');
        }
        this.renderStatus(text);
    }

    // 状态文字统一在这里生成，方便叠加实时人气值
    renderStatus(errorText) {
        const labels = { empty: '空位', loading: '加载中', error: '出错', offline: '未开播', live: '直播中' };
        this.statusEl.classList.remove('is-live');
        let label = labels[this.statusKind] || '';
        if (this.statusKind === 'live' && this.onlineCount) {
            label = `直播中 · ${formatCount(this.onlineCount)}人气`;
        }
        if (this.statusKind === 'error' && errorText) label = '出错';
        this.statusEl.textContent = label;
        if (this.statusKind === 'live') this.statusEl.classList.add('is-live');
    }

    async load() {
        if (!this.room || !this.visible) return;
        const token = ++this.loadToken;
        this.teardownPlayer();
        this.setStatus('loading');

        try {
            const playRes = await invoke('monitor:getPlayUrl', { roomId: this.room.roomId, qn: 10000 });
            if (token !== this.loadToken) return;
            if (!playRes?.success) throw new Error(playRes?.message || '获取直播流失败');

            if (!playRes.data.live) {
                this.setStatus('offline');
                // 未开播时低频轮询，开播后自动接入
                this.scheduleRetry(20000);
                return;
            }

            const url = playRes.data.urls?.[0];
            if (!url) throw new Error('直播流地址为空');

            this.createPlayer(url, playRes.data);
        } catch (error) {
            if (token !== this.loadToken) return;
            this.setStatus('error', error.message || '获取直播流失败');
            this.scheduleRetry(STREAM_ERROR_RETRY_DELAY * 2);
        }
    }

    scheduleRetry(delay) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.visible && this.room) this.load();
        }, delay);
    }

    reload() {
        if (!this.room) {
            openPicker(this.index);
            return;
        }
        this.load();
    }

    createPlayer(url, streamInfo) {
        const isFlv = streamInfo.format === 'flv';
        const type = isFlv ? 'flv' : 'm3u8';

        this.art = new window.Artplayer({
            container: this.playerEl,
            url,
            type,
            isLive: true,
            autoplay: true,
            muted: state.muted,
            volume: 0.7,
            pip: false,
            fullscreen: false,
            fullscreenWeb: false,
            setting: false,
            playbackRate: false,
            aspectRatio: false,
            screenshot: false,
            hotkey: false,
            lock: false,
            gesture: false,
            autoPlayback: false,
            miniProgressBar: false,
            theme: '#23ade5',
            // 右键菜单由监控室统一实现，避免内置菜单与多画面操作冲突
            contextmenu: [],
            moreVideoAttr: { playsInline: true, preload: 'auto' },
            customType: {
                flv: (video, target, art) => {
                    if (!window.mpegts || !window.mpegts.isSupported()) {
                        art.notice.show = '当前内核不支持 FLV 播放';
                        return;
                    }
                    const flv = window.mpegts.createPlayer(
                        {
                            type: 'flv',
                            isLive: true,
                            url: target,
                            cors: true,
                            hasAudio: true,
                            hasVideo: true,
                        },
                        {
                            enableWorker: true,
                            lazyLoad: false,
                            autoCleanupSourceBuffer: true,
                            liveBufferLatencyChasing: true,
                            liveBufferLatencyMaxLatency: 3.5,
                            liveBufferLatencyMinRemain: 0.4,
                        }
                    );
                    this.flvPlayer = flv;
                    flv.on(window.mpegts.Events.ERROR, (errorType, detail) => {
                        console.warn('直播流异常:', errorType, detail);
                        if (!this.visible) return;
                        this.setStatus('error', '直播流中断，正在重连...');
                        this.scheduleRetry(STREAM_ERROR_RETRY_DELAY);
                        this.teardownPlayer();
                    });
                    flv.attachMediaElement(video);
                    flv.load();
                    video.play().catch(() => { });
                    art.once('destroy', () => {
                        try { flv.destroy(); } catch { }
                        if (this.flvPlayer === flv) this.flvPlayer = null;
                    });
                },
            },
        });

        this.art.on('ready', () => {
            this.setStatus('live');
            if (streamInfo.qnName) {
                this.metaSubEl.textContent = [
                    this.room?.anchorName,
                    `#${this.room?.roomId}`,
                    streamInfo.qnName,
                ].filter(Boolean).join(' · ');
            }
        });

        this.art.on('video:error', () => {
            if (!this.visible) return;
            this.setStatus('error', '播放出错，正在重连...');
            this.scheduleRetry(STREAM_ERROR_RETRY_DELAY);
        });
    }

    teardownPlayer() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        clearTimeout(this.danmakuTimer);
        this.danmakuTimer = null;
        if (this.art) {
            try { this.art.destroy(false); } catch { }
            this.art = null;
        }
        if (this.flvPlayer) {
            try { this.flvPlayer.destroy(); } catch { }
            this.flvPlayer = null;
        }
        this.playerEl.innerHTML = '';
        this.pendingDanmaku = [];
    }

    setMuted(muted) {
        if (this.art) this.art.muted = muted;
    }

    // 全局开关优先，关闭时所有画面都不显示；单画面开关只影响自己；
    // 弹幕姬开启时内嵌弹幕强制关闭
    get danmakuEnabled() {
        const pref = tilePrefs[this.index];
        return state.danmaku && pref.danmaku && !pref.danmakuji;
    }

    setDanmakujiEnabled(enabled) {
        tilePrefs[this.index].danmakuji = enabled;
        this.applyDanmakuStyle();
        saveState();
        if (enabled) {
            invoke('monitor:openDanmakuji', {
                roomId: this.room?.roomId,
                title: this.room?.title,
            });
        }
    }

    setDanmakuEnabled(enabled) {
        tilePrefs[this.index].danmaku = enabled;
        this.applyDanmakuStyle();
        saveState();
    }

    setDanmakuStyle(style) {
        tilePrefs[this.index].style = style === 'bottom' ? 'bottom' : 'scroll';
        this.applyDanmakuStyle();
        saveState();
    }

    applyDanmakuStyle() {
        const enabled = this.danmakuEnabled;
        this.danmakuEl.classList.toggle('is-off', !enabled);
        this.danmakuEl.classList.toggle('is-scroll', tilePrefs[this.index].style === 'scroll');
        // 切换开关或样式时清空旧节点，避免两种渲染方式混排
        this.danmakuEl.innerHTML = '';
        this.pendingDanmaku = [];
        this.laneReadyAt = [];
    }

    setSuperChatEnabled(enabled) {
        tilePrefs[this.index].superchat = enabled;
        this.superchatEl.innerHTML = '';
        saveState();
    }

    startDanmaku() {
        if (!this.room) return;
        invoke('monitor:watchDanmaku', { roomId: this.room.roomId, tile: this.index }).catch(() => { });
    }

    stopDanmaku() {
        if (!this.roomId) return;
        invoke('monitor:unwatchDanmaku', { roomId: this.roomId, tile: this.index }).catch(() => { });
    }

    pushDanmaku(message) {
        if (message.type === 'live_status') {
            this.setStatus(message.value ? 'live' : 'offline');
            if (message.value) this.load();
            return;
        }
        if (message.type === 'online') {
            this.onlineCount = Number(message.value) || 0;
            this.renderStatus();
            return;
        }
        if (message.type === 'superchat') {
            if (tilePrefs[this.index].superchat) this.renderSuperChat(message);
            return;
        }
        if (message.type === 'watched' || message.type === 'room_fans' || message.type === 'enter') return;
        if (!this.danmakuEnabled || !message.text) return;

        // 弹幕量大时合并刷新，避免逐条操作 DOM
        this.pendingDanmaku.push(message);
        if (this.pendingDanmaku.length > 60) this.pendingDanmaku.splice(0, this.pendingDanmaku.length - 60);
        if (this.danmakuTimer) return;
        this.danmakuTimer = setTimeout(() => {
            this.danmakuTimer = null;
            this.flushDanmaku();
        }, 120);
    }

    buildLine(item, className) {
        const line = document.createElement('div');
        line.className = className;
        if (item.type === 'gift') line.classList.add('is-gift');
        if (item.type === 'superchat') line.classList.add('is-superchat');

        if (item.user) {
            const user = document.createElement('span');
            user.className = 'danmaku-user';
            user.textContent = `${item.user}:`;
            line.appendChild(user);
        }
        line.appendChild(document.createTextNode(item.text));
        if (item.color && /^#[0-9a-f]{6}$/i.test(item.color) && item.color !== '#ffffff') {
            line.style.color = item.color;
        }
        return line;
    }

    flushDanmaku() {
        const items = this.pendingDanmaku.splice(0, this.pendingDanmaku.length);
        if (!items.length || !this.danmakuEnabled) return;

        if (tilePrefs[this.index].style === 'scroll') {
            items.forEach(item => this.renderScrollDanmaku(item));
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach(item => fragment.appendChild(this.buildLine(item, 'danmaku-line')));
        this.danmakuEl.appendChild(fragment);

        while (this.danmakuEl.childElementCount > MAX_DANMAKU_LINES) {
            this.danmakuEl.firstElementChild.remove();
        }
    }

    // SC 付费留言卡片：贴左上角，按金额分档配色，多条时顶掉最早的
    renderSuperChat(item) {
        const tier = SC_TIERS.find(t => item.price >= t.min) || SC_TIERS[SC_TIERS.length - 1];

        const card = document.createElement('div');
        card.className = `sc-card ${tier.name}`;

        const head = document.createElement('div');
        head.className = 'sc-head';
        const badge = document.createElement('span');
        badge.className = 'sc-badge';
        badge.textContent = 'SC';
        head.appendChild(badge);
        const name = document.createElement('span');
        name.className = 'sc-name';
        name.textContent = item.user || '用户';
        head.appendChild(name);
        const price = document.createElement('span');
        price.className = 'sc-price';
        // 官方界面按电池展示（1 元 = 10 电池）
        price.textContent = `⚡${item.price * 10}`;
        head.appendChild(price);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'sc-close';
        close.textContent = '✕';
        close.title = '关闭';
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            card.remove();
        });
        head.appendChild(close);

        const body = document.createElement('div');
        body.className = 'sc-body';
        body.textContent = item.text;

        card.appendChild(head);
        card.appendChild(body);
        this.superchatEl.appendChild(card);

        // 短时间多条时顶掉最早的卡片
        while (this.superchatEl.childElementCount > MAX_SUPERCHAT_CARDS) {
            this.superchatEl.firstElementChild.remove();
        }

        // 官方带展示时长，这里封顶 2 分钟，超时自动消失
        const seconds = Math.min(Math.max(Number(item.duration) || 30, 30), 120);
        setTimeout(() => card.remove(), seconds * 1000);
    }

    // 横向滚动弹幕：优先占用上方空闲轨道，动画结束后立即移除节点
    renderScrollDanmaku(item) {
        const laneHeight = Math.round((this.danmakuFontSize || 12) * 1.5);
        const lanes = Math.max(1, Math.floor(this.danmakuEl.clientHeight / laneHeight) - 1);

        // laneReadyAt[lane] 记录该轨道上一条弹幕尾部完全进入画面的时刻
        if (!this.laneReadyAt || this.laneReadyAt.length !== lanes) {
            const ready = new Array(lanes).fill(0);
            if (this.laneReadyAt) {
                this.laneReadyAt.slice(0, lanes).forEach((value, index) => { ready[index] = value; });
            }
            this.laneReadyAt = ready;
        }

        const now = performance.now();
        let lane = this.laneReadyAt.findIndex(readyAt => readyAt <= now);
        if (lane === -1) {
            // 全部轨道都被占用时，选择最早空闲的轨道排队，保持上层优先
            lane = this.laneReadyAt.reduce((best, value, index) => (value < this.laneReadyAt[best] ? index : best), 0);
        }

        const line = this.buildLine(item, 'danmaku-scroll');
        line.style.top = `${lane * laneHeight}px`;
        this.danmakuEl.appendChild(line);

        const travel = this.danmakuEl.clientWidth + line.offsetWidth + 8;
        const durationMs = Math.min(12, Math.max(4, travel / 90)) * 1000;
        line.style.setProperty('--travel', `-${Math.round(travel)}px`);
        line.style.animationDuration = `${durationMs / 1000}s`;
        line.addEventListener('animationend', () => line.remove(), { once: true });

        // 下一条可以从同轨道出发之前，需等待本条尾部越过画面右缘
        this.laneReadyAt[lane] = now + durationMs * ((line.offsetWidth + 8) / travel);

        // 弹幕爆发时优先淘汰最早的滚动节点，避免堆积
        const scrollLines = this.danmakuEl.querySelectorAll('.danmaku-scroll');
        if (scrollLines.length > MAX_SCROLL_DANMAKU) {
            scrollLines[0].remove();
        }
    }
}

// ---------------- 布局 ----------------
function applyLayout(layout) {
    state.layout = LAYOUTS.includes(Number(layout)) ? Number(layout) : 4;
    gridEl.dataset.layout = String(state.layout);
    document.querySelectorAll('.layout-btn').forEach((button) => {
        button.classList.toggle('is-active', Number(button.dataset.layout) === state.layout);
    });

    tiles.forEach((tile) => {
        const visible = tile.index < state.layout;
        tile.el.classList.toggle('hidden', !visible);
        tile.setVisible(visible);
    });

    updateHint();
    saveState();
}

function updateHint() {
    const used = state.slots.slice(0, state.layout).filter(Boolean).length;
    hintEl.textContent = `${state.layout} 宫格 · 已分配 ${used}/${state.layout} · 双击画面临时放大，再次双击或按 Esc 还原`;
}

function toggleZoom(index) {
    const tile = tiles[index];
    if (!tile) return;
    const zoomed = tile.el.classList.contains('is-zoomed');
    tiles.forEach((item) => item.el.classList.remove('is-zoomed'));
    gridEl.classList.toggle('has-zoom', !zoomed);
    if (!zoomed) tile.el.classList.add('is-zoomed');
}

function clearZoom() {
    gridEl.classList.remove('has-zoom');
    tiles.forEach((item) => item.el.classList.remove('is-zoomed'));
}

// ---------------- 分配房间 ----------------
const pickerModal = document.getElementById('pickerModal');
const pickerTitle = document.getElementById('pickerTitle');
const pickerInput = document.getElementById('pickerInput');
const pickerError = document.getElementById('pickerError');
const pickerConfirm = document.getElementById('pickerConfirm');
const pickerRemove = document.getElementById('pickerRemove');
const recentList = document.getElementById('recentList');

let pickerTarget = null;

function openPicker(index) {
    pickerTarget = index;
    const room = state.slots[index];
    pickerTitle.textContent = room ? `更换画面 ${index + 1} 的直播间` : `分配画面 ${index + 1}`;
    pickerInput.value = room ? String(room.roomId) : '';
    pickerError.classList.add('hidden');
    pickerConfirm.disabled = false;
    pickerRemove.disabled = !room;
    pickerRemove.classList.toggle('hidden', !room);
    renderRecent();
    pickerModal.classList.remove('hidden');
    setTimeout(() => pickerInput.focus(), 0);
}

function closePicker() {
    pickerModal.classList.add('hidden');
    pickerTarget = null;
}

function renderRecent() {
    recentList.innerHTML = '';
    if (!state.recent.length) {
        const empty = document.createElement('span');
        empty.className = 'recent-empty';
        empty.textContent = '暂无记录';
        recentList.appendChild(empty);
        return;
    }
    state.recent.forEach((item) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'recent-chip';
        chip.title = [item.title, `#${item.roomId}`].filter(Boolean).join(' · ');
        const label = document.createElement('span');
        label.textContent = `${item.anchorName || item.title || '直播间'} (${item.roomId})`;
        chip.appendChild(label);
        chip.addEventListener('click', () => {
            pickerInput.value = String(item.roomId);
            pickerInput.focus();
        });
        recentList.appendChild(chip);
    });
}

async function confirmPicker() {
    const value = pickerInput.value.trim();
    if (!value) {
        pickerError.textContent = '请输入直播间号或链接';
        pickerError.classList.remove('hidden');
        return;
    }
    if (pickerTarget === null) return;

    pickerConfirm.disabled = true;
    pickerError.classList.add('hidden');
    try {
        const res = await invoke('monitor:resolveRoom', value);
        if (!res?.success) throw new Error(res?.message || '获取直播间信息失败');
        assignRoom(pickerTarget, res.data);
        closePicker();
    } catch (error) {
        pickerError.textContent = error.message || '获取直播间信息失败';
        pickerError.classList.remove('hidden');
    } finally {
        pickerConfirm.disabled = false;
    }
}

function assignRoom(index, room) {
    const tile = tiles[index];
    if (!tile) return;
    state.slots[index] = room ? {
        roomId: room.roomId,
        title: room.title,
        anchorName: room.anchorName,
        liveStatus: room.liveStatus,
        cover: room.cover,
    } : null;
    if (room) rememberRoom(room);
    tile.setRoom(room);
    saveState();
    updateHint();
}

// ---------------- 批量编辑 ----------------
const editorModal = document.getElementById('editorModal');
const editorList = document.getElementById('editorList');
const editorError = document.getElementById('editorError');

function openEditor() {
    editorList.innerHTML = '';
    for (let index = 0; index < state.layout; index++) {
        const item = document.createElement('label');
        item.className = 'editor-item';

        const labelIndex = document.createElement('span');
        labelIndex.className = 'editor-index';
        labelIndex.textContent = String(index + 1);

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '留空为空位';
        input.value = state.slots[index] ? String(state.slots[index].roomId) : '';
        input.dataset.index = String(index);

        item.appendChild(labelIndex);
        item.appendChild(input);
        editorList.appendChild(item);
    }
    editorError.classList.add('hidden');
    editorModal.classList.remove('hidden');
    setTimeout(() => editorList.querySelector('input')?.focus(), 0);
}

async function saveEditor() {
    if (!editorList.querySelector('input')) {
        editorModal.classList.add('hidden');
        return;
    }
    const values = [...editorList.querySelectorAll('input')].map(input => input.value.trim());
    const saveButton = document.getElementById('editorSave');
    saveButton.disabled = true;
    editorError.classList.add('hidden');

    try {
        const resolved = await Promise.all(values.map(async (value) => {
            if (!value) return null;
            const existing = state.slots.find(room => room && String(room.roomId) === value);
            if (existing) return existing;
            const res = await invoke('monitor:resolveRoom', value);
            if (!res?.success) throw new Error(`画面 ${values.indexOf(value) + 1}：${res?.message || '获取直播间信息失败'}`);
            return res.data;
        }));

        resolved.forEach((room, index) => {
            const changedId = (state.slots[index]?.roomId || null) !== (room?.roomId || null);
            state.slots[index] = room ? {
                roomId: room.roomId,
                title: room.title,
                anchorName: room.anchorName,
                liveStatus: room.liveStatus,
                cover: room.cover,
            } : null;
            if (room) rememberRoom(room);
            if (changedId) tiles[index]?.setRoom(room);
        });
        // 超出当前布局的槽位清空，避免编辑后再切回大布局出现旧房间
        for (let index = state.layout; index < MAX_SLOTS; index++) {
            state.slots[index] = null;
            tiles[index]?.setRoom(null);
        }

        saveState();
        updateHint();
        editorModal.classList.add('hidden');
    } catch (error) {
        editorError.textContent = error.message || '保存失败';
        editorError.classList.remove('hidden');
    } finally {
        saveButton.disabled = false;
    }
}

// ---------------- 顶栏控制 ----------------
function updateTopbar() {
    document.getElementById('toggleDanmaku').textContent = `弹幕：${state.danmaku ? '开' : '关'}`;
    document.getElementById('toggleMute').textContent = `声音：${state.muted ? '关' : '开'}`;
}

function applyGlobalMute(muted) {
    state.muted = muted;
    tiles.forEach(tile => tile.setMuted(muted));
    updateTopbar();
    saveState();
}

function applyGlobalDanmaku(enabled) {
    state.danmaku = enabled;
    tiles.forEach(tile => tile.applyDanmakuStyle());
    updateTopbar();
    saveState();
}

function bindUi() {
    document.querySelectorAll('.layout-btn').forEach((button) => {
        button.addEventListener('click', () => {
            clearZoom();
            applyLayout(button.dataset.layout);
        });
    });

    document.getElementById('toggleDanmaku').addEventListener('click', () => {
        applyGlobalDanmaku(!state.danmaku);
    });

    document.getElementById('toggleMute').addEventListener('click', () => {
        applyGlobalMute(!state.muted);
    });

    document.getElementById('openEditor').addEventListener('click', openEditor);
    document.getElementById('refreshAll').addEventListener('click', () => {
        tiles.forEach((tile) => {
            if (tile.room && tile.index < state.layout) tile.load();
        });
    });

    pickerConfirm.addEventListener('click', confirmPicker);
    pickerInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            confirmPicker();
        }
    });
    pickerRemove.addEventListener('click', () => {
        if (pickerTarget === null) return;
        assignRoom(pickerTarget, null);
        closePicker();
    });
    document.getElementById('clearRecent').addEventListener('click', () => {
        state.recent = [];
        saveState();
        renderRecent();
    });

    document.getElementById('editorSave').addEventListener('click', saveEditor);
    document.getElementById('editorClear').addEventListener('click', () => {
        editorList.querySelectorAll('input').forEach(input => { input.value = ''; });
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => {
            const id = button.dataset.close;
            if (id === 'pickerModal') closePicker();
            if (id === 'editorModal') editorModal.classList.add('hidden');
        });
    });

    [pickerModal, editorModal].forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target !== modal) return;
            if (modal === pickerModal) closePicker();
            else modal.classList.add('hidden');
        });
    });

    document.addEventListener('click', () => closeContextMenu());
    window.addEventListener('blur', () => closeContextMenu());
    window.addEventListener('resize', () => closeContextMenu());

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!contextMenuEl.classList.contains('hidden')) {
            closeContextMenu();
            return;
        }
        if (!pickerModal.classList.contains('hidden')) {
            closePicker();
            return;
        }
        if (!editorModal.classList.contains('hidden')) {
            editorModal.classList.add('hidden');
            return;
        }
        clearZoom();
    });
}

// ---------------- 自定义右键菜单 ----------------
const contextMenuEl = document.getElementById('contextMenu');
let contextMenuTile = null;

function closeContextMenu() {
    contextMenuEl.classList.add('hidden');
    contextMenuTile = null;
}

function menuItem(label, onClick, options = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'context-item';
    item.setAttribute('role', 'menuitem');
    if (options.checked !== undefined) {
        const dot = document.createElement('span');
        dot.className = 'context-check';
        dot.textContent = options.checked ? '✓' : '';
        item.appendChild(dot);
    }
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeContextMenu();
        onClick();
    });
    return item;
}

function openContextMenu(x, y, tile) {
    contextMenuTile = tile;
    contextMenuEl.innerHTML = '';

    if (tile.room) {
        contextMenuEl.appendChild(menuItem(
            tile.danmakuEnabled ? '关闭本画面弹幕' : '开启本画面弹幕',
            () => tile.setDanmakuEnabled(!tilePrefs[tile.index].danmaku),
            { checked: tile.danmakuEnabled }
        ));
        contextMenuEl.appendChild(menuItem(
            '横向滚动弹幕',
            () => tile.setDanmakuStyle('scroll'),
            { checked: tilePrefs[tile.index].style === 'scroll' }
        ));
        contextMenuEl.appendChild(menuItem(
            '底部列表弹幕',
            () => tile.setDanmakuStyle('bottom'),
            { checked: tilePrefs[tile.index].style === 'bottom' }
        ));
        contextMenuEl.appendChild(menuItem(
            tilePrefs[tile.index].superchat ? '关闭 SC 醒目留言' : '显示 SC 醒目留言',
            () => tile.setSuperChatEnabled(!tilePrefs[tile.index].superchat),
            { checked: tilePrefs[tile.index].superchat }
        ));
        contextMenuEl.appendChild(menuItem(
            tilePrefs[tile.index].danmakuji ? '关闭独立弹幕姬' : '独立窗口弹幕姬',
            () => {
                if (tilePrefs[tile.index].danmakuji) {
                    invoke('monitor:closeDanmakuji', { roomId: tile.roomId });
                    tile.setDanmakujiEnabled(false);
                } else {
                    tile.setDanmakujiEnabled(true);
                }
            },
            { checked: tilePrefs[tile.index].danmakuji }
        ));

        const divider = document.createElement('div');
        divider.className = 'context-divider';
        contextMenuEl.appendChild(divider);

        contextMenuEl.appendChild(menuItem('重新加载', () => tile.reload()));
        contextMenuEl.appendChild(menuItem('更换直播间', () => openPicker(tile.index)));
        contextMenuEl.appendChild(menuItem('放大此画面', () => toggleZoom(tile.index)));
        contextMenuEl.appendChild(menuItem('移除此直播间', () => {
            closeContextMenu();
            assignRoom(tile.index, null);
        }));
    } else {
        contextMenuEl.appendChild(menuItem('分配直播间', () => openPicker(tile.index)));
    }

    contextMenuEl.classList.remove('hidden');
    // 先测量再定位，避免菜单超出窗口
    const rect = contextMenuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 6);
    const top = Math.min(y, window.innerHeight - rect.height - 6);
    contextMenuEl.style.left = `${Math.max(6, left)}px`;
    contextMenuEl.style.top = `${Math.max(6, top)}px`;
}

// ---------------- 主进程推送 ----------------
function bindIpc() {
    // 弹幕姬窗口被关闭后，恢复对应画面的内嵌弹幕
    on('monitor:danmakuji-closed', (payload) => {
        tiles.forEach((tile) => {
            if (tile.roomId === payload?.roomId && tilePrefs[tile.index].danmakuji) {
                tile.setDanmakujiEnabled(false);
            }
        });
    });

    on('monitor:danmaku', (payload) => {
        if (!payload?.roomId) return;
        tiles.forEach((tile) => {
            if (tile.roomId === payload.roomId && tile.visible) {
                tile.pushDanmaku(payload.message || {});
            }
        });
    });

    on('monitor:danmaku-status', (payload) => {
        if (!payload?.roomId) return;
        const status = payload.status || {};
        tiles.forEach((tile) => {
            if (tile.roomId !== payload.roomId) return;
            if (status.state === 'open') tile.statusEl.title = '弹幕已连接';
            else if (status.state === 'error') tile.statusEl.title = status.message || '弹幕连接失败';
            else tile.statusEl.title = `弹幕：${status.state}`;
        });
    });
}

// ---------------- 启动 ----------------
function init() {
    loadState();

    for (let index = 0; index < MAX_SLOTS; index++) {
        const tile = buildTile(index);
        tiles.push(tile);
        gridEl.appendChild(tile.el);
    }

    bindUi();
    bindIpc();

    applyGlobalDanmaku(state.danmaku);
    applyLayout(state.layout);

    // 恢复上次分配的房间
    state.slots.forEach((room, index) => {
        if (room) tiles[index].setRoom(room);
    });

    // 恢复上次开启的独立弹幕姬
    tiles.forEach((tile) => {
        if (tile.room && tilePrefs[tile.index].danmakuji) {
            tile.setDanmakujiEnabled(true);
        }
    });

    applyGlobalMute(state.muted);
    updateHint();
}

init();