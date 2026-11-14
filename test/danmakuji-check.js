const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const monitorDir = path.join(root, 'web', 'player', 'monitor');

function loadShared() {
    // 不注入宿主全局：脚本在独立 realm 中运行，返回值也来自该 realm
    const context = vm.createContext({ module: { exports: {} }, console });
    vm.runInContext(fs.readFileSync(path.join(monitorDir, 'danmakuji-shared.js'), 'utf8'), context);
    return context.module.exports;
}

function loadList(document) {
    const context = vm.createContext({ module: { exports: {} }, console, DanmakujiShared: Shared, document });
    vm.runInContext(fs.readFileSync(path.join(monitorDir, 'danmakuji-list.js'), 'utf8'), context);
    return context.module.exports;
}

// vm realm 中的数组 / 对象与宿主原型不同，deepStrictEqual 会判定不等，先做结构化拷贝
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

const Shared = loadShared();
const DanmakujiList = loadList();

class FakeListNode {
    constructor(id) {
        this.id = id;
        this.parentNode = null;
        this.children = [];
        this.style = {};
        this.moves = 0;
    }

    get firstElementChild() {
        return this.children[0] || null;
    }

    get nextElementSibling() {
        if (!this.parentNode) return null;
        return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
    }

    insertBefore(node, reference) {
        if (reference !== null && !this.children.includes(reference)) throw new Error('reference is not a child');
        if (node.parentNode) {
            const previousParent = node.parentNode;
            const previousIndex = previousParent.children.indexOf(node);
            if (previousParent === this) this.moves++;
            previousParent.children.splice(previousIndex, 1);
        }
        const index = reference === null ? this.children.length : this.children.indexOf(reference);
        this.children.splice(index, 0, node);
        node.parentNode = this;
        return node;
    }

    remove() {
        if (!this.parentNode) return;
        const parent = this.parentNode;
        parent.children.splice(parent.children.indexOf(this), 1);
        this.parentNode = null;
    }
}

// ---------------- 共享纯函数 ----------------
test('房间输入解析：房间号、短号、链接与非法输入', () => {
    assert.equal(Shared.parseRoomInput('14047'), 14047);
    assert.equal(Shared.parseRoomInput('  https://live.bilibili.com/14047?spm_id_from=1 '), 14047);
    assert.equal(Shared.parseRoomInput('https://live.bilibili.com/h5/21452505'), 21452505);
    assert.equal(Shared.parseRoomInput('live.bilibili.com/6'), 6);
    assert.equal(Shared.parseRoomInput('abc'), null);
    assert.equal(Shared.parseRoomInput(''), null);
    assert.equal(Shared.parseRoomInput(null), null);
});

test('设置归一化：越界字号、非法枚举与类型错误回落到默认值', () => {
    const defaults = Shared.normalizeSettings(null);
    assert.equal(defaults.fontSize, 13);
    assert.equal(defaults.columns, 'auto');
    assert.equal(defaults.showMedal, true);
    assert.equal(defaults.showEnter, false);

    const clamped = Shared.normalizeSettings({ fontSize: 99, columns: 7, density: 'huge', showMedal: 'yes', keyword: 3 });
    assert.equal(clamped.fontSize, Shared.FONT_SIZE_MAX);
    assert.equal(clamped.columns, 'auto');
    assert.equal(clamped.density, 'normal');
    assert.equal(clamped.showMedal, true);
    assert.equal(clamped.keyword, '');

    const kept = Shared.normalizeSettings({ fontSize: '16', columns: 3, density: 'compact', showGift: true, blocked: 'a,b' });
    assert.equal(kept.fontSize, 16);
    assert.equal(kept.columns, 3);
    assert.equal(kept.density, 'compact');
    assert.equal(kept.showGift, true);
    assert.equal(kept.blocked, 'a,b');
    assert.equal(Shared.densityGap('compact'), 0);
    assert.equal(Shared.densityGap('loose'), 7);
});

test('消息过滤：类型开关、只看 SC、关键词与屏蔽词', () => {
    const danmaku = { type: 'danmaku', text: '今天唱歌吗', user: '小明' };
    const sc = { type: 'superchat', text: '加油', user: '老板', price: 30 };
    const enter = { type: 'enter', text: '小红 进入直播间', user: '小红' };
    const gift = { type: 'gift', text: '小红 赠送 辣条 ×1', user: '小红' };
    const defaults = Shared.normalizeSettings(null);

    assert.equal(Shared.shouldShowMessage(danmaku, defaults), true);
    assert.equal(Shared.shouldShowMessage(sc, defaults), true);
    assert.equal(Shared.shouldShowMessage(enter, defaults), false);
    assert.equal(Shared.shouldShowMessage(gift, defaults), false);
    assert.equal(Shared.shouldShowMessage({ type: 'online', value: 1 }, defaults), false);
    assert.equal(Shared.shouldShowMessage({ type: 'danmaku', text: '' }, defaults), false);
    assert.equal(Shared.shouldShowMessage({ type: 'danmaku', text: '', sticker: { url: 'x' } }, defaults), true);

    const onlySc = Shared.normalizeSettings({ superchatOnly: true });
    assert.equal(Shared.shouldShowMessage(danmaku, onlySc), false);
    assert.equal(Shared.shouldShowMessage(sc, onlySc), true);

    const filtered = Shared.normalizeSettings({ showEnter: true, showGift: true, keyword: '红', blocked: '辣条, 广告' });
    assert.equal(Shared.shouldShowMessage(enter, filtered), true);
    assert.equal(Shared.shouldShowMessage(gift, filtered), false);
    assert.equal(Shared.shouldShowMessage(danmaku, filtered), false);
    assert.equal(Shared.shouldShowMessage({ type: 'danmaku', text: '小红来了', user: 'x' }, filtered), true);
    assert.equal(Shared.shouldShowMessage({ type: 'danmaku', text: '广告', user: '小红' }, filtered), false);
    assert.equal(Shared.shouldShowMessage({ type: 'superchat', text: 'x', user: 'y', price: 1 }, Shared.normalizeSettings({ showSuperchat: false })), false);
    assert.deepEqual(plain(Shared.splitKeywords('a，b、c d,,e')), ['a', 'b', 'c', 'd', 'e']);
});

test('房间列表：去重、置顶、上限与拖动排序', () => {
    let rooms = [];
    const a = Shared.upsertRoom(rooms, { roomId: 1, title: 'A', anchorName: '甲' });
    assert.equal(a.added, true);
    rooms = a.rooms;
    rooms = Shared.upsertRoom(rooms, { roomId: 2, title: 'B' }).rooms;
    const again = Shared.upsertRoom(rooms, { roomId: 1, title: 'A2', liveStatus: 1 });
    assert.equal(again.added, false);
    assert.deepEqual(plain(again.rooms.map(r => r.roomId)), [1, 2]);
    assert.equal(again.rooms[0].title, 'A2');
    assert.equal(again.rooms[0].anchorName, '甲');
    assert.equal(again.rooms[0].liveStatus, 1);

    assert.deepEqual(plain(Shared.moveRoom(again.rooms, 0, 1).map(r => r.roomId)), [2, 1]);
    assert.deepEqual(plain(Shared.moveRoom(again.rooms, 1, 1)), plain(again.rooms));
    assert.deepEqual(plain(Shared.moveRoom(again.rooms, -1, 0)), plain(again.rooms));

    const many = Array.from({ length: 14 }, (_, i) => ({ roomId: i + 1 }));
    assert.equal(Shared.upsertRoom([], { roomId: 1 }, 12).rooms.length, 1);
    assert.equal(Shared.normalizeRoom({ roomId: 0 }), null);
    assert.equal(Shared.upsertRoom(many, { roomId: 99 }).rooms.length, 12);

    const recent = Shared.rememberRecent([{ roomId: 1, title: 'A' }], { roomId: 2, title: 'B', anchorName: '乙' });
    assert.deepEqual(plain(recent.map(r => r.roomId)), [2, 1]);
    assert.equal(Shared.rememberRecent(recent, { roomId: 1 })[0].roomId, 1);
    assert.equal(Shared.rememberRecent(recent, { roomId: 1 }).length, 2);
    assert.deepEqual(plain(Shared.removeRecent(recent, 2).map(r => r.roomId)), [1]);
    assert.deepEqual(plain(Shared.removeRecent(recent, '1').map(r => r.roomId)), [2]);
    assert.deepEqual(plain(Shared.removeRecent(recent, 0).map(r => r.roomId)), [2, 1]);
    assert.deepEqual(plain(Shared.removeRecent(null, 1)), []);
});

test('速率与导出文本', () => {
    const now = 1_000_000;
    const stamps = Array.from({ length: 30 }, (_, i) => now - 30_000 + i * 1000);
    assert.equal(Shared.formatRate(stamps, now), '60.0');
    assert.equal(Shared.formatRate([], now), '0.0');
    assert.equal(Shared.formatRate([now - 120_000, now - 90_000], now), '0.0');
    assert.match(Shared.messageToLine({ type: 'danmaku', user: '小明', text: '你好', medalName: '粉丝', medalLevel: 12, _at: now }), /^\[\d{2}:\d{2}:\d{2}\] \[粉丝 12\] 小明: 你好$/);
    assert.match(Shared.messageToLine({ type: 'superchat', user: '老板', text: '加油', price: 30, _at: now }), /【醒目留言 ￥30】老板: 加油/);
    assert.match(Shared.messageToLine({ type: 'gift', text: '小红 赠送 辣条 ×1', _at: now }), /小红 赠送 辣条 ×1/);
});

test('虚拟列表滚动时保留重叠行，不反复移动 DOM 节点', () => {
    const list = Object.create(DanmakujiList.prototype);
    list.history = Array.from({ length: 100 }, (_, i) => ({ _id: i + 1 }));
    list.heights = Array(100).fill(20);
    list.offsets = Array.from({ length: 101 }, (_, i) => i * 20);
    list.dirtyFrom = 100;
    list.viewportEl = { clientHeight: 100, scrollTop: 100 };
    list.spacerEl = { style: {} };
    list.rowsEl = new FakeListNode('rows');
    list.renderedNodes = new Map();
    list.buildItem = message => new FakeListNode(message._id);
    list.measureRenderedRows = () => false;

    list.renderPass();
    const retained = new Map(list.renderedNodes);

    list.viewportEl.scrollTop = 180;
    list.renderPass();

    assert.equal(list.rowsEl.moves, 0);
    for (const [id, node] of retained) {
        if (list.renderedNodes.has(id)) assert.equal(list.renderedNodes.get(id), node);
    }
    assert.deepEqual(list.rowsEl.children.map(node => node.id), [...list.renderedNodes.keys()]);
});

test('醒目留言粉丝牌缺少图标地址时使用原版大航海图标', () => {
    const Renderer = loadList({
        createElement(tag) {
            const node = new FakeListNode(tag);
            node.classList = { add: name => { node.className += ` ${name}`; } };
            node.style.setProperty = (name, value) => { node.style[name] = value; };
            node.appendChild = child => node.insertBefore(child, null);
            node.addEventListener = () => {};
            return node;
        },
    });
    const list = Object.create(Renderer.prototype);
    list.settings = Shared.normalizeSettings(null);
    const icons = [
        'ffcd832b5d7b84ea851cb8156ec0a71940439511',
        '98a201c14a64e860a758f089144dcf3f42e7038c',
        '143f5ec3003b4080d1b5f817a9efdca46d631945',
    ];
    for (const level of [1, 2, 3]) {
        const item = list.buildSuperChatItem({
            type: 'superchat', text: '加油', user: '观众',
            medalName: '粉丝牌', medalLevel: 39, medalGuardLevel: level,
        });
        const medal = item.children[0].children[0].children[0].children[0];
        assert.equal(medal.children[0].id, 'img');
        assert.equal(medal.children[0].src, `https://i0.hdslb.com/bfs/live/${icons[level - 1]}.png`);
        assert.equal(medal.children[0].alt, ['总督', '提督', '舰长'][level - 1]);
    }
});

function createMessageList() {
    const list = Object.create(DanmakujiList.prototype);
    Object.assign(list, {
        settings: Shared.normalizeSettings(null),
        history: [], sourceHistory: [], pending: [], sourcePending: [],
        heights: [], offsets: [0], dirtyFrom: 0, timestamps: [],
        nextId: 0, latestId: 0, paused: false, autoScroll: false,
        renderedNodes: new Map(), rowsEl: { textContent: '' },
        spacerEl: { style: {} }, viewportEl: { scrollTop: 0 },
        onPendingChange() {}, onCountChange() {},
        onFollowChange() {}, applySettingsVars() {},
        scheduleRender() {}, startFollow() {},
    });
    return list;
}

test('只看 SC 关闭后恢复已有弹幕和开启期间收到的弹幕，顺序不重复', () => {
    const list = createMessageList();
    list.push({ type: 'danmaku', text: 'before', user: 'A' });
    list.push({ type: 'superchat', text: 'SC', user: 'B' });
    list.setSettings({ ...list.settings, superchatOnly: true });
    assert.deepEqual(plain(list.history.map(message => message.text)), ['SC']);
    assert.equal(list.push({ type: 'danmaku', text: 'during', user: 'C' }), false);
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.deepEqual(plain(list.history.map(message => message.text)), ['before', 'SC', 'during']);
    assert.equal(list.heights.length, 3);
    list.setSettings({ ...list.settings, superchatOnly: true });
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.equal(list.count, 3);
    assert.equal(new Set(list.history.map(message => message._id)).size, 3);
});

test('暂停期间切换只看 SC 不丢失待显示消息，恢复和清空正常', () => {
    const list = createMessageList();
    list.push({ type: 'danmaku', text: 'history', user: 'A' });
    list.setPaused(true);
    list.push({ type: 'danmaku', text: 'pending', user: 'A' });
    list.push({ type: 'superchat', text: 'SC', user: 'B' });
    list.setSettings({ ...list.settings, superchatOnly: true });
    assert.equal(list.history.length, 0);
    assert.deepEqual(plain(list.pending.map(message => message.text)), ['SC']);
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.deepEqual(plain(list.pending.map(message => message.text)), ['pending', 'SC']);
    list.setSettings({ ...list.settings, superchatOnly: true });
    list.setPaused(false);
    assert.equal(list.count, 1);
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.deepEqual(plain(list.history.map(message => message.text)), ['history', 'pending', 'SC']);
    assert.equal(list.pending.length, 0);
    list.setSettings({ ...list.settings, superchatOnly: true });
    list.clear();
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.equal(list.count, 0);
    assert.equal(list.sourceHistory.length, 0);
});

test('SC 隐藏缓存遵守历史上限，关键词过滤仍剔除不匹配消息', () => {
    const list = createMessageList();
    list.push({ type: 'superchat', text: 'old', user: 'A' });
    list.setSettings({ ...list.settings, superchatOnly: true });
    for (let i = 0; i < DanmakujiList.MAX_HISTORY + 2; i++) {
        list.push({ type: 'danmaku', text: `message-${i}`, user: 'A' });
    }
    assert.equal(list.count, 0);
    assert.equal(list.sourceHistory.length, DanmakujiList.MAX_HISTORY);
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.equal(list.count, DanmakujiList.MAX_HISTORY);
    assert.equal(list.history[0].text, 'message-2');
    list.setSettings({ ...list.settings, superchatOnly: true, keyword: 'message-10001' });
    list.setSettings({ ...list.settings, superchatOnly: false });
    assert.deepEqual(plain(list.history.map(message => message.text)), ['message-10001']);
});

function loadConsoleState(saved, invoke) {
    const storage = new Map(saved ? [['danmakuji-console-v1', JSON.stringify(saved)]] : []);
    const context = vm.createContext({
        console,
        window: { electronAPI: { invoke }, DanmakujiShared: Shared },
        document: { getElementById: () => null },
        localStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
    });
    const source = fs.readFileSync(path.join(monitorDir, 'danmakuji-console.js'), 'utf8');
    vm.runInContext(source.replace(/\ninit\(\);\s*$/, '\n'), context);
    vm.runInContext('renderRecent = () => {}; loadState();', context);
    return { context, storage };
}

test('恢复房间时刷新直播状态，实时状态优先于较晚返回的查询', async () => {
    let resolveRequest;
    const { context } = loadConsoleState(null, () => new Promise(resolve => { resolveRequest = resolve; }));
    vm.runInContext(`
        updateColumnMeta = () => {};
        renderChips = () => {};
        const room = { roomId: 101, title: 'A', liveStatus: null };
        state.rooms = [room];
        const column = { roomId: 101, room };
        columns.set(101, column);
        globalThis.refresh = () => refreshRoomStatus(column);
    `, context);

    let pending = context.refresh();
    resolveRequest({ success: true, data: { liveStatus: 0 } });
    await pending;
    assert.equal(vm.runInContext('state.rooms[0].liveStatus', context), 0);

    pending = context.refresh();
    vm.runInContext("handleRoomMessage(101, { type: 'live_status', value: 1 });", context);
    resolveRequest({ success: true, data: { liveStatus: 0 } });
    await pending;
    assert.equal(vm.runInContext('state.rooms[0].liveStatus', context), 1);
});

test('恢复已保存房间时不展示旧的开播状态，并更新为查询结果', async () => {
    let resolveRequest;
    const saved = { rooms: [{ roomId: 101, title: 'A', liveStatus: 1 }] };
    const { context } = loadConsoleState(saved, name => {
        if (name === 'danmakuji:watch') return Promise.resolve({ success: true });
        if (name === 'danmakuji:resolveRoom') return new Promise(resolve => { resolveRequest = resolve; });
        throw new Error(`unexpected IPC ${name}`);
    });
    vm.runInContext(`
        buildColumn = room => ({
            roomId: room.roomId, room, el: {}, pendingIpc: [],
            list: { setPaused() {} }
        });
        els.roomGrid = { appendChild() {} };
        updatePauseButton = reorderColumns = applyColumns = renderRecent = updateEmptyState = () => {};
        updateColumnMeta = renderChips = () => {};
        addRoom(state.rooms[0], { silent: true, refreshStatus: true });
    `, context);
    assert.equal(vm.runInContext('state.rooms[0].liveStatus', context), null);
    resolveRequest({ success: true, data: { liveStatus: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('state.rooms[0].liveStatus', context), 0);
});

test('控制台只将直播状态 1 显示为开播', () => {
    const { context } = loadConsoleState();
    vm.runInContext(`
        updateFavoriteButton = () => {};
        const room = { roomId: 1, title: 'A', liveStatus: 2 };
        const refs = {
            favoriteBtn: {}, title: {}, anchor: {}, foot: {},
            offline: { classList: { toggle: (_, value) => { globalThis.offlineHidden = value; } } },
            status: { classList: { remove() {}, add() {} } }
        };
        const column = { room, refs, status: { state: 'open' }, el: { style: { setProperty() {} } } };
        globalThis.renderRoom = value => { room.liveStatus = value; updateColumnMeta(column); return refs.foot.textContent; };
    `, context);
    assert.equal(context.renderRoom(2), '等待开播');
    assert.equal(context.offlineHidden, false);
    assert.equal(context.renderRoom(0), '等待开播');
    assert.equal(context.renderRoom(1), '开播中 · A');
    assert.equal(context.offlineHidden, true);
    assert.equal(context.renderRoom(null), '直播状态获取中');
});

test('播放接口只将状态 1 当作直播流', async () => {
    let liveStatus = 0;
    const playurl = {
        stream: [{ protocol_name: 'http_stream', format: [{ codec: [{
            codec_name: 'avc', current_qn: 10000, base_url: '/stream',
            url_info: [{ host: 'https://example.test' }],
        }] }] }],
    };
    const requireStub = name => {
        if (name === 'got') return async () => ({ body: { code: 0, data: { live_status: liveStatus, playurl_info: { playurl } } } });
        if (name === './auth') return class { async ensureBuvidCredentials() {} getConstructedCookie() { return ''; } };
        if (name === './wbi' || name === './live_danmaku_protocol') return {};
        throw new Error(`unexpected module ${name}`);
    };
    const context = vm.createContext({ require: requireStub, module: { exports: {} }, console });
    vm.runInContext(fs.readFileSync(path.join(root, 'modules', 'bilibili_live.js'), 'utf8'), context);
    const { fetchPlayUrl } = context.module.exports;
    assert.equal((await fetchPlayUrl(1)).live, false);
    liveStatus = 2;
    assert.equal((await fetchPlayUrl(1)).live, false);
    liveStatus = 1;
    const live = await fetchPlayUrl(1);
    assert.equal(live.live, true);
    assert.equal(live.urls[0], 'https://example.test/stream');
});

test('收到下播消息时取消未完成的直播流请求并保持轮询', async () => {
    let resolveRequest;
    const context = vm.createContext({
        invoke: () => new Promise(resolve => { resolveRequest = resolve; }),
        console,
    });
    const source = fs.readFileSync(path.join(monitorDir, 'monitor.js'), 'utf8');
    const classSource = source.slice(source.indexOf('class MonitorTile {'), source.indexOf('// ---------------- 布局 ----------------'));
    vm.runInContext(`${classSource}\nglobalThis.MonitorTile = MonitorTile;`, context);
    const tile = Object.create(context.MonitorTile.prototype);
    tile.room = { roomId: 1 };
    tile.visible = true;
    tile.loadToken = 0;
    tile.teardownPlayer = () => {};
    tile.setStatus = status => { tile.status = status; };
    tile.scheduleRetry = delay => { tile.retryDelay = delay; };
    tile.createPlayer = () => { tile.playerCreated = true; };

    const pending = tile.load();
    tile.pushDanmaku({ type: 'live_status', value: 0 });
    resolveRequest({ success: true, data: { live: true, urls: ['https://example.test/stream'] } });
    await pending;
    assert.equal(tile.status, 'offline');
    assert.equal(tile.retryDelay, 20000);
    assert.equal(tile.playerCreated, undefined);
});

test('收藏单独持久化，不随已接入和最近接入列表清空，支持取消收藏', () => {
    const { context, storage } = loadConsoleState();
    vm.runInContext(`
        toggleFavorite({ roomId: 101, title: 'A', anchorName: '主播' });
        state.rooms = [];
        state.recent = [];
        saveState();
    `, context);
    const saved = JSON.parse(storage.get('danmakuji-console-v1'));
    assert.equal(saved.favorites.length, 1);
    assert.equal(saved.favorites[0].roomId, 101);
    const restored = loadConsoleState(saved);
    assert.equal(vm.runInContext('state.favorites[0].anchorName', restored.context), '主播');
    vm.runInContext('toggleFavorite({ roomId: 101 });', restored.context);
    assert.equal(JSON.parse(restored.storage.get('danmakuji-console-v1')).favorites.length, 0);
});

test('收藏读取兼容旧配置，并按房间号去重、剔除非法记录', () => {
    const old = loadConsoleState({ rooms: [], recent: [] });
    assert.equal(vm.runInContext('state.favorites.length', old.context), 0);
    const { context } = loadConsoleState({
        favorites: [{ roomId: 101, title: 'A' }, { roomId: '101' }, null, { roomId: -1 }, { roomId: 102 }],
    });
    assert.deepEqual(plain(vm.runInContext('state.favorites.map(room => room.roomId)', context)), [101, 102]);
});

test('最近接入支持删除单个项目并持久化，撤销可按原位置恢复', () => {
    const saved = {
        rooms: [{ roomId: 101, title: 'A' }],
        favorites: [{ roomId: 102, title: 'B', anchorName: '乙' }],
        recent: [
            { roomId: 101, title: 'A', anchorName: '甲' },
            { roomId: 102, title: 'B', anchorName: '乙' },
            { roomId: 103, title: 'C', anchorName: '丙' },
        ],
    };
    const { context, storage } = loadConsoleState(saved);
    vm.runInContext(`
        globalThis.lastToast = null;
        toast = (message, options) => { globalThis.lastToast = { message, options }; };
        deleteRecentRoom(102);
    `, context);

    assert.deepEqual(plain(vm.runInContext('state.recent.map(r => r.roomId)', context)), [101, 103]);
    assert.deepEqual(plain(vm.runInContext('state.favorites.map(r => r.roomId)', context)), [102]);
    assert.deepEqual(plain(vm.runInContext('state.rooms.map(r => r.roomId)', context)), [101]);
    assert.deepEqual(
        JSON.parse(storage.get('danmakuji-console-v1')).recent.map(r => r.roomId),
        [101, 103]
    );
    assert.match(vm.runInContext('lastToast.message', context), /乙/);

    vm.runInContext('lastToast.options.action.onClick()', context);
    assert.deepEqual(plain(vm.runInContext('state.recent.map(r => r.roomId)', context)), [101, 102, 103]);
    assert.deepEqual(
        JSON.parse(storage.get('danmakuji-console-v1')).recent.map(r => r.roomId),
        [101, 102, 103]
    );
});

// ---------------- 订阅中心 ----------------
function loadHub() {
    const sent = [];
    const destroyedHandlers = new Map();
    const contents = new Map();
    const clients = [];

    class FakeClient {
        constructor(roomId, handlers) {
            this.roomId = roomId;
            this.handlers = handlers;
            this.started = false;
            this.stopped = false;
            clients.push(this);
        }
        start() { this.started = true; }
        stop() { this.stopped = true; }
    }

    const requireStub = (name) => {
        if (name === 'electron') {
            return {
                webContents: {
                    fromId: (id) => contents.get(id) || null,
                },
            };
        }
        if (name === './bilibili_live') return { LiveDanmakuClient: FakeClient };
        throw new Error(`unexpected module ${name}`);
    };

    const addContents = (id) => {
        const wc = {
            id,
            destroyed: false,
            isDestroyed() { return this.destroyed; },
            send(channel, payload) { sent.push({ id, channel, payload }); },
            once(event, handler) { this.on(event, handler); },
            on(event, handler) { if (event === 'destroyed') destroyedHandlers.set(id, handler); },
            removeListener(event, handler) { if (event === 'destroyed' && destroyedHandlers.get(id) === handler) destroyedHandlers.delete(id); },
            removeAllListeners(event) { if (event === 'destroyed') destroyedHandlers.delete(id); },
            destroy() {
                this.destroyed = true;
                destroyedHandlers.get(id)?.();
            },
        };
        contents.set(id, wc);
        return wc;
    };

    const context = vm.createContext({ require: requireStub, module: { exports: {} }, console });
    vm.runInContext(fs.readFileSync(path.join(root, 'modules', 'live_room_hub.js'), 'utf8'), context);
    return { hub: context.module.exports, sent, clients, addContents, destroyedHandlers };
}

test('订阅中心按房间复用连接，按订阅位引用计数，最后一个退订才断开', () => {
    const { hub, sent, clients, addContents } = loadHub();
    const monitor = addContents(1);
    const consoleWc = addContents(2);

    hub.subscribe(100, monitor.id, 0);
    hub.subscribe(100, monitor.id, 1);
    hub.subscribe(100, consoleWc.id, 100, { message: 'danmakuji:room-message', status: 'danmakuji:room-status' });
    assert.equal(clients.length, 1);
    assert.equal(clients[0].started, true);
    assert.equal(hub.activeRoomCount(), 1);

    // 后加入的订阅者收到补发的当前状态
    assert.deepEqual(plain(sent.at(-1)), { id: 2, channel: 'danmakuji:room-status', payload: { roomId: 100, status: { state: 'connecting' } } });

    clients[0].handlers.onStatus({ state: 'open' });
    clients[0].handlers.onMessage({ type: 'danmaku', text: 'hi' });
    const messages = sent.filter(item => item.payload.message);
    // 监控室两个画面只收到一份，控制台走自己的频道
    assert.equal(messages.filter(item => item.id === 1 && item.channel === 'monitor:danmaku').length, 1);
    assert.equal(messages.filter(item => item.id === 2 && item.channel === 'danmakuji:room-message').length, 1);

    hub.unsubscribe(100, monitor.id, 0);
    assert.equal(clients[0].stopped, false);
    hub.unsubscribe(100, monitor.id, 1);
    assert.equal(clients[0].stopped, false);
    hub.unsubscribe(100, consoleWc.id, 100);
    assert.equal(clients[0].stopped, true);
    assert.equal(hub.activeRoomCount(), 0);
});

test('窗口销毁只释放自己的订阅，不影响其它窗口；重复释放安全', () => {
    const { hub, clients, addContents } = loadHub();
    const monitor = addContents(1);
    const consoleWc = addContents(2);
    hub.subscribe(7, monitor.id, 0);
    hub.subscribe(7, consoleWc.id, 7);
    hub.subscribe(8, consoleWc.id, 8);
    assert.equal(clients.length, 2);

    monitor.destroy();
    // 房间 7 仍被控制台订阅，连接保持；房间 8 只有控制台订阅，同样保持
    assert.equal(clients[0].stopped, false);
    assert.equal(clients[1].stopped, false);
    assert.equal(hub.activeRoomCount(), 2);
    hub.releaseContents(monitor.id);
    assert.equal(hub.activeRoomCount(), 2);
    hub.unsubscribe(7, consoleWc.id, 7);
    assert.equal(clients[0].stopped, true);
    assert.equal(hub.activeRoomCount(), 1);

    hub.releaseContents(consoleWc.id);
    assert.equal(clients[1].stopped, true);
    assert.equal(hub.activeRoomCount(), 0);
    hub.disposeAll();
    assert.equal(hub.activeRoomCount(), 0);
});

test('订阅中心拒绝非法房间号，并向新订阅者补发最新状态', () => {
    const { hub, clients, addContents } = loadHub();
    const wc = addContents(1);
    assert.throws(() => hub.subscribe(0, wc.id), /直播间号/);
    assert.throws(() => hub.subscribe('abc', wc.id), /直播间号/);
    hub.subscribe(9, wc.id);
    clients[0].handlers.onStatus({ state: 'open' });
    const late = addContents(2);
    const status = hub.subscribe(9, late.id);
    assert.deepEqual(plain(status), { state: 'open' });
    assert.deepEqual(plain(hub.statusOf(9)), { state: 'open' });
    assert.equal(hub.statusOf(404), null);
});

// ---------------- IPC 注册 ----------------
function loadDanmakujiIpc() {
    const handlers = {};
    const windows = [];
    const hubCalls = [];
    const events = [];
    const dialogs = [];
    const written = [];
    const opened = [];

    class FakeWindow {
        constructor(options) {
            this.options = options;
            this.destroyed = false;
            this.minimized = false;
            this.focused = false;
            this.listeners = {};
            this.webContents = {
                id: windows.length + 1,
                listeners: {},
                send: (channel, payload) => events.push({ id: this.webContents.id, channel, payload }),
                on: (event, handler) => { this.webContents.listeners[event] = handler; },
            };
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isMinimized() { return this.minimized; }
        restore() { this.minimized = false; }
        focus() { this.focused = true; }
        setMenu() { }
        loadFile(file) { this.file = file; }
        on(event, handler) { this.listeners[event] = handler; }
        close() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.listeners.closed?.();
        }
    }

    const requireStub = (name) => {
        if (name === 'electron') {
            return {
                ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
                BrowserWindow: Object.assign(FakeWindow, { fromWebContents: (sender) => windows.find(w => w.webContents === sender) || null }),
                dialog: { showSaveDialog: async (win, options) => { dialogs.push(options); return { canceled: false, filePath: 'C:\\tmp\\out.txt' }; } },
                shell: { openExternal: (url) => opened.push(url) },
            };
        }
        if (name === 'path') return path;
        if (name === 'fs') return { writeFileSync: (file, text, enc) => written.push({ file, text, enc }) };
        if (name === '../modules/theme') return { windowChromeOptions: () => ({}), registerThemeAwareWindow: () => { } };
        if (name === '../modules/live_room_hub') {
            return {
                subscribe: (...args) => { hubCalls.push(['subscribe', ...args]); return { state: 'connecting' }; },
                unsubscribe: (...args) => hubCalls.push(['unsubscribe', ...args]),
                releaseContents: (...args) => hubCalls.push(['release', ...args]),
            };
        }
        if (name === '../modules/bilibili_live') return { resolveRoom: async (input) => ({ roomId: Number(input), title: `房间 ${input}` }) };
        if (name === '../modules/sanitize_path') return require(path.join(root, 'modules', 'sanitize_path.js'));
        throw new Error(`unexpected module ${name}`);
    };

    const context = vm.createContext({
        require: requireStub,
        module: { exports: {} },
        console,
        Buffer,
        __dirname: path.join(root, 'ipc'),
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'ipc', 'danmakuji.js'), 'utf8'), context);
    context.module.exports();
    return { api: context.module.exports, handlers, windows, hubCalls, events, dialogs, written, opened };
}

test('控制台与独立窗口 IPC：复用窗口、订阅频道、关闭释放、开关通知', async () => {
    const { api, handlers, windows, hubCalls, events } = loadDanmakujiIpc();

    const first = handlers.openDanmakujiConsole();
    assert.equal(first.success, true);
    const second = handlers.openDanmakujiConsole();
    assert.equal(second.focused, true);
    assert.equal(windows.length, 1);
    assert.match(windows[0].file, /danmakuji-console\.html$/);

    const changes = [];
    api.onRoomWindowChanged((roomId, open) => changes.push([roomId, open]));
    const room = handlers['danmakuji:openRoomWindow'](null, { roomId: 14047, title: '测试' });
    assert.equal(room.success, true);
    assert.equal(handlers['danmakuji:openRoomWindow'](null, { roomId: 14047 }).focused, true);
    assert.equal(windows.length, 2);
    assert.deepEqual(plain(changes), [[14047, true]]);
    assert.equal(api.isRoomWindowOpen(14047), true);

    const hj = windows[1];
    hj.webContents.listeners['did-finish-load']();
    assert.deepEqual(plain(events.filter(e => e.channel === 'danmakuji:init').at(-1).payload), { roomId: 14047, title: '测试' });
    assert.deepEqual(plain(hubCalls.at(-1)), ['subscribe', 14047, hj.webContents.id, 'danmakuji']);

    const watch = handlers['danmakuji:watch']({ sender: windows[0].webContents }, { roomId: 14047 });
    assert.equal(watch.success, true);
    assert.deepEqual(plain(hubCalls.at(-1)), ['subscribe', 14047, 1, 14047, { message: 'danmakuji:room-message', status: 'danmakuji:room-status' }]);
    const badWatch = handlers['danmakuji:watch']({ sender: windows[0].webContents }, {});
    assert.equal(badWatch.success, false);
    assert.match(badWatch.message, /直播间号/);

    assert.deepEqual(plain(handlers['danmakuji:roomWindowState']().rooms), [14047]);
    handlers['danmakuji:closeRoomWindow'](null, { roomId: 14047 });
    assert.deepEqual(plain(changes.at(-1)), [14047, false]);
    assert.deepEqual(plain(hubCalls.at(-1)), ['release', hj.webContents.id]);
    assert.equal(api.isRoomWindowOpen(14047), false);
    // 控制台收到窗口开关通知
    assert.deepEqual(plain(events.filter(e => e.id === 1 && e.channel === 'danmakuji:window-closed').at(-1).payload), { roomId: 14047 });

    windows[0].close();
    assert.deepEqual(plain(hubCalls.at(-1)), ['release', 1]);
    assert.equal(handlers.openDanmakujiConsole().focused, undefined);
    assert.equal(windows.length, 3);

    assert.equal(handlers['danmakuji:openRoomWindow'](null, { roomId: 0 }).success, false);
    const resolved = await handlers['danmakuji:resolveRoom'](null, '123');
    assert.equal(resolved.data.roomId, 123);
    handlers['danmakuji:openRoomPage'](null, 123);
});

test('导出弹幕：空内容拒绝、过大拒绝、写入带 BOM 的 UTF-8', async () => {
    const { handlers, written, dialogs, opened } = loadDanmakujiIpc();
    handlers.openDanmakujiConsole();
    const empty = await handlers['danmakuji:export']({ sender: null }, { text: '   ' });
    assert.equal(empty.success, false);
    const huge = await handlers['danmakuji:export']({ sender: null }, { text: 'a'.repeat(21 * 1024 * 1024) });
    assert.equal(huge.success, false);
    const ok = await handlers['danmakuji:export']({ sender: null }, { text: '你好', defaultName: 'a/b:c' });
    assert.equal(ok.success, true);
    assert.equal(ok.path, 'C:\\tmp\\out.txt');
    assert.equal(written[0].text, '\ufeff你好');
    assert.equal(written[0].enc, 'utf8');
    assert.equal(dialogs[0].defaultPath, 'a_b_c.txt');
    handlers['danmakuji:openRoomPage'](null, 14047);
    assert.deepEqual(plain(opened), ['https://live.bilibili.com/14047']);
});

// ---------------- 页面接线 ----------------
test('工具箱包含弹幕姬入口，页面脚本与 IPC 频道一一对应', () => {
    const ui = fs.readFileSync(path.join(root, 'web', 'ui_detail.js'), 'utf8');
    assert.match(ui, /key: 'danmakuji'/);
    assert.match(ui, /invoke\('openDanmakujiConsole'\)/);

    const ipcIndex = fs.readFileSync(path.join(root, 'ipc', 'index.js'), 'utf8');
    assert.match(ipcIndex, /registerDanmakujiIpc\(\)/);

    const consoleHtml = fs.readFileSync(path.join(monitorDir, 'danmakuji-console.html'), 'utf8');
    const consoleJs = fs.readFileSync(path.join(monitorDir, 'danmakuji-console.js'), 'utf8');
    const ids = new Set([...consoleHtml.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    for (const match of consoleJs.matchAll(/\$\('([^']+)'\)/g)) {
        assert.ok(ids.has(match[1]), `控制台缺少元素 #${match[1]}`);
    }
    for (const match of consoleJs.matchAll(/invoke\('([^']+)'/g)) {
        assert.ok(match[1].startsWith('danmakuji:'), `未知 IPC ${match[1]}`);
    }
    assert.match(consoleJs, /openRecentContextMenu/);
    assert.match(consoleJs, /deleteRecentRoom/);

    const hjHtml = fs.readFileSync(path.join(monitorDir, 'danmakuji.html'), 'utf8');
    const hjJs = fs.readFileSync(path.join(monitorDir, 'danmakuji.js'), 'utf8');
    const hjIds = new Set([...hjHtml.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    for (const match of hjJs.matchAll(/getElementById\('([^']+)'\)/g)) {
        assert.ok(hjIds.has(match[1]), `独立窗口缺少元素 #${match[1]}`);
    }

    // 所有页面引用的脚本与样式都存在
    for (const html of [consoleHtml, hjHtml]) {
        for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
            assert.ok(fs.existsSync(path.join(monitorDir, match[1])), `缺少资源 ${match[1]}`);
        }
    }
});

// ---------------- 直播弹幕长连接与错误透传 ----------------
function loadBilibiliLive({ gotImpl, authData = {}, wbiResult = { img_key: 'a', sub_key: 'b', isLogin: false, mid: 0 } } = {}) {
    const sentCookies = [];
    const requireStub = name => {
        if (name === 'got') {
            return async (url, options) => {
                sentCookies.push({ url, cookie: options?.headers?.Cookie || '' });
                return gotImpl(url, options);
            };
        }
        if (name === './auth') {
            return class {
                load() { return authData; }
                async ensureBuvidCredentials() { return authData; }
                getConstructedCookie() { return authData.cookie || ''; }
            };
        }
        if (name === './wbi') {
            return {
                encWbi: (params) => `id=${params.id}&wts=1&w_rid=test`,
                getWbiKeys: async () => wbiResult,
            };
        }
        if (name === './live_danmaku_protocol') {
            return require(path.join(root, 'modules', 'live_danmaku_protocol.js'));
        }
        throw new Error(`unexpected module ${name}`);
    };
    const context = vm.createContext({
        require: requireStub,
        module: { exports: {} },
        console,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        AbortController,
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'modules', 'bilibili_live.js'), 'utf8'), context);
    return { ...context.module.exports, sentCookies };
}

function makePacket(op, body) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
    const header = Buffer.alloc(16);
    header.writeUInt32BE(16 + payload.length, 0);
    header.writeUInt16BE(16, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt32BE(op, 8);
    header.writeUInt32BE(1, 12);
    return Buffer.concat([header, payload]);
}

test('fetchDanmuConfig 补齐 buvid3 且使鉴权 uid 与 nav 登录态一致', async () => {
    const { fetchDanmuConfig, sentCookies } = loadBilibiliLive({
        authData: { loginStatus: true, DedeUserID: '99999', buvid3: 'B3_TEST', cookie: 'SESSDATA=expired' },
        wbiResult: { img_key: 'img', sub_key: 'sub', isLogin: false, mid: 0 },
        gotImpl: async () => ({
            body: {
                code: 0,
                data: {
                    token: 'tok-1',
                    host_list: [
                        { host: 'a.chat.bilibili.com', wss_port: 2245 },
                        { host: 'a.chat.bilibili.com', wss_port: 2245 },
                    ],
                },
            },
        }),
    });
    const config = await fetchDanmuConfig(1017);
    assert.match(sentCookies[0].cookie, /buvid3=B3_TEST/);
    assert.equal(config.uid, 0);
    assert.equal(config.buvid, 'B3_TEST');
    // 去重并追加 broadcastlv 备用节点
    assert.deepEqual(plain(config.host_list.map(h => `${h.host}:${h.wss_port}`)), [
        'a.chat.bilibili.com:2245',
        'broadcastlv.chat.bilibili.com:443',
    ]);
});

test('LiveDanmakuClient 连接超时时不等待 hang 住的 close()，立即切换下一节点并保留失败原因', async () => {
    const statuses = [];
    const urls = [];
    const sockets = [];
    const { LiveDanmakuClient } = loadBilibiliLive({
        authData: { buvid3: 'B3_OK', cookie: 'buvid3=B3_OK' },
        gotImpl: async () => ({
            body: {
                code: 0,
                data: {
                    token: 'tok-2',
                    host_list: [
                        { host: 'hang.example.test', wss_port: 2245 },
                        { host: 'ok.example.test', wss_port: 443 },
                    ],
                },
            },
        }),
    });

    const client = new LiveDanmakuClient(1017, {
        connectTimeoutMs: 30,
        authTimeoutMs: 100,
        heartbeatIntervalMs: 5000,
        onStatus: (status) => statuses.push(status),
        createWebSocket: (url) => {
            urls.push(url);
            const ws = {
                readyState: 0,
                sent: [],
                closed: false,
                close() {
                    this.closed = true;
                    // 故意不触发 onclose，模拟 Node/undici 在 CONNECTING 期间 close 卡死
                },
                send(buf) { this.sent.push(buf); },
            };
            sockets.push(ws);
            if (url.includes('ok.example.test')) {
                setTimeout(() => {
                    ws.readyState = 1;
                    ws.onopen?.();
                    setTimeout(() => {
                        ws.onmessage?.({ data: makePacket(8, JSON.stringify({ code: 0 })) });
                    }, 10);
                }, 10);
            }
            return ws;
        },
    });

    client.start();
    await new Promise(resolve => setTimeout(resolve, 750));
    client.stop();

    assert.equal(urls[0], 'wss://hang.example.test:2245/sub');
    assert.equal(urls[1], 'wss://ok.example.test:443/sub');
    assert.equal(sockets[0].closed, true);
    const timeoutErr = statuses.find(s => s.state === 'error' && /连接弹幕服务器超时.*hang\.example\.test:2245/.test(s.message));
    assert.ok(timeoutErr, `应报告连接超时原因，实际状态: ${JSON.stringify(statuses)}`);
    const retrying = statuses.find(s => s.state === 'connecting' && s.reconnecting && /连接弹幕服务器超时/.test(s.message));
    assert.ok(retrying, '重连期间应保留上一次失败原因');
    assert.equal(statuses.at(-1).state, 'open');
});

test('LiveDanmakuClient 鉴权超时和 socket 错误都会把具体原因传递到状态', async () => {
    const statuses = [];
    let attempt = 0;
    const { LiveDanmakuClient } = loadBilibiliLive({
        authData: { buvid3: 'B3_OK', cookie: 'buvid3=B3_OK' },
        gotImpl: async () => ({
            body: {
                code: 0,
                data: {
                    token: 'tok-3',
                    host_list: [{ host: 'auth-hang.example.test', wss_port: 2245 }],
                },
            },
        }),
    });

    const client = new LiveDanmakuClient(6, {
        connectTimeoutMs: 100,
        authTimeoutMs: 30,
        onStatus: (status) => statuses.push(status),
        createWebSocket: () => {
            attempt += 1;
            const ws = {
                readyState: 0,
                close() {},
                send() {},
            };
            if (attempt === 1) {
                setTimeout(() => {
                    ws.readyState = 1;
                    ws.onopen?.();
                    // 故意不回 op=8，触发鉴权超时
                }, 5);
            } else if (attempt === 2) {
                setTimeout(() => {
                    ws.onerror?.({ error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
                    ws.onclose?.({ code: 1006, reason: '' });
                }, 5);
            }
            return ws;
        },
    });

    client.start();
    await new Promise(resolve => setTimeout(resolve, 650));
    client.stop();

    assert.ok(statuses.some(s => s.state === 'error' && /弹幕服务器鉴权超时.*auth-hang\.example\.test:2245/.test(s.message)));
    assert.ok(statuses.some(s => s.state === 'closed' && /ECONNREFUSED/.test(s.message)));
});

test('控制台前端在连接失败与重连中保留并展示错误横幅，连接成功后清除', () => {
    const { context } = loadConsoleState();
    vm.runInContext(`
        updateFavoriteButton = () => {};
        const createEl = () => {
            const el = {
                textContent: '',
                title: '',
                classes: new Set(['hidden']),
            };
            el.classList = {
                add(...names) { names.forEach(n => el.classes.add(n)); },
                remove(...names) { names.forEach(n => el.classes.delete(n)); },
                toggle(name, force) {
                    const next = force === undefined ? !el.classes.has(name) : !!force;
                    if (next) el.classes.add(name);
                    else el.classes.delete(name);
                },
            };
            return el;
        };
        const refs = {
            favoriteBtn: {}, title: {}, anchor: {}, foot: createEl(),
            offline: createEl(),
            error: createEl(),
            status: createEl(),
        };
        const column = { room: { roomId: 1, title: 'A', liveStatus: 1 }, refs, status: { state: 'connecting' }, el: { style: { setProperty() {} } } };
        globalThis.setStatus = (status) => { column.status = status; updateColumnStatus(column); return refs; };
    `, context);

    const afterErr = context.setStatus({ state: 'error', message: '连接弹幕服务器超时 (a.chat.bilibili.com:2245)' });
    assert.equal(afterErr.status.textContent, '连接失败');
    assert.equal(afterErr.error.textContent, '连接弹幕服务器超时 (a.chat.bilibili.com:2245)');
    assert.equal(afterErr.error.classes.has('hidden'), false);
    assert.equal(afterErr.foot.classes.has('is-error'), true);

    const afterRetry = context.setStatus({ state: 'connecting', reconnecting: true, message: '连接弹幕服务器超时 (a.chat.bilibili.com:2245)' });
    assert.equal(afterRetry.status.textContent, '重连中');
    assert.equal(afterRetry.error.classes.has('hidden'), false);
    assert.equal(afterRetry.error.textContent, '连接弹幕服务器超时 (a.chat.bilibili.com:2245)');

    const afterOpen = context.setStatus({ state: 'open' });
    assert.equal(afterOpen.status.textContent, '已连接');
    assert.equal(afterOpen.error.classes.has('hidden'), true);
    assert.equal(afterOpen.foot.classes.has('is-error'), false);
    assert.equal(afterOpen.foot.textContent, '开播中 · A');
});