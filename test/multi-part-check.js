const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveBvid, buildTimeline } = require('../modules/multi_part');

test('解析 BV 号和 B站链接，并拒绝非 B站地址', async () => {
    assert.equal(await resolveBvid('BV1xx411c7mD'), 'BV1xx411c7mD');
    assert.equal(await resolveBvid('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'), 'BV1xx411c7mD');
    await assert.rejects(resolveBvid('https://example.com/video/BV1xx411c7mD'), /仅支持/);
    await assert.rejects(resolveBvid('https://www.bilibili.com/video/not-a-bvid'), /没有有效/);
    await assert.rejects(resolveBvid('BV123'), /有效/);
});

test('短链接只跟随 B站域名并限制重定向', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'multi_part.js'), 'utf8');
    let response = { statusCode: 302, headers: { location: 'https://www.bilibili.com/video/BV1xx411c7mD' } };
    const sandbox = { module: { exports: {} }, require: () => async () => response, URL, Set };
    vm.runInNewContext(source, sandbox);
    const resolve = sandbox.module.exports.resolveBvid;
    assert.equal(await resolve('https://b23.tv/example'), 'BV1xx411c7mD');
    response = { statusCode: 302, headers: { location: 'http://127.0.0.1/video/BV1xx411c7mD' } };
    await assert.rejects(resolve('https://b23.tv/example'), /仅支持/);
    response = { statusCode: 302, headers: { location: 'https://b23.tv/example' } };
    await assert.rejects(resolve('https://b23.tv/example'), /没有有效/);
    response = { statusCode: 200, headers: {} };
    await assert.rejects(resolve('https://b23.tv/example'), /无法解析/);
});

test('后端按分P顺序计算累计时间并拒绝无效数据', () => {
    const data = buildTimeline({
        bvid: 'BV1xx411c7mD', title: '测试', pages: [
            { cid: 11, duration: 30, part: '第一话' },
            { cid: 12, duration: 45, part: '第二话' },
            { cid: 13, duration: 60, part: '第三话' },
        ],
    });
    assert.equal(data.duration, 135);
    assert.deepEqual(data.parts.map(part => part.start), [0, 30, 75]);
    assert.throws(() => buildTimeline({ pages: [{ cid: 1, duration: 0 }] }), /无效/);
    assert.throws(() => buildTimeline({ pages: [] }), /分P/);
});

// 极简 XML 桩：只解析测试里用到的 <d p="...">text</d> 结构
function fakeDomParser(xml) {
    const nodes = [];
    const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
    let match;
    while ((match = re.exec(xml))) {
        const p = match[1];
        const text = match[2];
        nodes.push({ getAttribute: name => (name === 'p' ? p : null), textContent: text });
    }
    return { querySelector: () => null, querySelectorAll: () => nodes };
}

class Element {
    constructor() {
        this.listeners = {};
        this.value = '';
        this.textContent = '';
        this.disabled = false;
        this.hidden = false;
        this.checked = true;
        this.dataset = {};
        this.className = '';
        const style = {};
        style.setProperty = (name, value) => { style[name] = value; };
        this.style = style;
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !classes.has(name) : !!force;
                if (on) classes.add(name); else classes.delete(name);
            },
        };
        this._classes = classes;
        this.readyState = 4;
        this.paused = true;
        this.currentTime = 0;
        this.clientHeight = 500;
        this.clientWidth = 800;
        this.offsetWidth = 100;
        this.children = [];
        this.parentNode = null;
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }
    dispatch(name, event = {}) { return Promise.all((this.listeners[name] || []).map(fn => fn(event))); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() {}
    removeAttribute() {}
    appendChild(child) { this.children.push(child); child.parentNode = this; }
    replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
    // 桩里只有分P胶囊需要 closest('.part-chip')
    closest(selector) { return selector === '.part-chip' && this.className === 'part-chip' ? this : null; }
}

// 弹幕桩里每个 <d> 需要一个可读取 offsetWidth 的 span；harness 的 createElement 已返回带 offsetWidth 的 Element

function playerHarness(dash, pages = [
    { cid: 11, duration: 30 }, { cid: 12, duration: 45 }, { cid: 13, duration: 60 },
], danmuXml = '<i/>') {
    const ids = ['form', 'input', 'submit', 'title', 'stage', 'placeholder', 'placeholderText', 'spinner',
        'play', 'seek', 'current', 'duration', 'part', 'status', 'volume', 'mute', 'danmaku',
        'showDanmaku', 'fullscreen', 'player', 'hud', 'partList'];
    const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
    const videos = [new Element(), new Element()];
    elements.stage.querySelectorAll = () => videos;
    elements.volume.value = '0.8';
    const timeline = buildTimeline({ bvid: 'BV1xx411c7mD', title: '测试', pages });
    const context = vm.createContext({
        document: { getElementById: id => elements[id], createElement: () => new Element(),
            addEventListener() {}, fullscreenElement: null },
        Audio: Element,
        DOMParser: class { parseFromString(text) { return fakeDomParser(text); } },
        window: { electronAPI: { invoke: async (method, payload) => {
            if (method === 'resolveMultiPartVideo') return { success: true, data: timeline };
            if (method === 'getPreviewDanmu') return { success: true, data: danmuXml };
            return dash(payload.cid);
        } } },
        requestAnimationFrame() {},
        AbortController, setTimeout, clearTimeout, console,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'player', 'multi-player.js'), 'utf8'), context);
    return { context, elements, videos, timeline };
}

function stream(cid) {
    return { success: true, data: { defaultVideo: { url: `video-${cid}` }, defaultAudioUrl: `audio-${cid}` } };
}

// 让 startSeam / switchTo 这类异步流程里的 microtask 全部跑完
const settle = () => new Promise(resolve => setImmediate(resolve));

test('播放器预缓冲下一P，按总进度跳转并在分P结束后切换', async () => {
    const requested = [];
    const h = playerHarness(async cid => { requested.push(cid); return stream(cid); });
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    assert.equal(h.elements.duration.textContent, '02:15');
    assert.deepEqual(requested, [11, 12]);
    assert.equal(h.elements.part.textContent, 'P1/3 · P1');
    await vm.runInContext('switchTo(45, false)', h.context);
    assert.equal(h.elements.part.textContent, 'P2/3 · P2');
    assert.equal(vm.runInContext('active.video.currentTime', h.context), 15);
    assert.equal(vm.runInContext('active.audio.currentTime', h.context), 15);
    assert.equal(h.elements.current.textContent, '00:45');
    await vm.runInContext('active.video.dispatch("ended")', h.context);
    await settle();
    assert.equal(h.elements.part.textContent, 'P3/3 · P3');
    assert.equal(h.elements.current.textContent, '01:15');
    await vm.runInContext('switchTo(135, false)', h.context);
    assert.equal(vm.runInContext('active.video.currentTime', h.context), 60);
});

test('过期预缓冲结果不会覆盖新的跳转', async () => {
    let resolveSecond;
    let secondCalls = 0;
    const h = playerHarness(cid => {
        if (cid === 12 && ++secondCalls === 1) return new Promise(resolve => { resolveSecond = resolve; });
        return Promise.resolve(stream(cid));
    });
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    const firstSeek = vm.runInContext('switchTo(35, true)', h.context);
    await vm.runInContext('switchTo(80, false)', h.context);
    resolveSecond(stream(12));
    await firstSeek;
    assert.equal(h.elements.part.textContent, 'P3/3 · P3');
    assert.equal(vm.runInContext('active.video.currentTime', h.context), 5);
    await vm.runInContext('switchTo(35, false)', h.context);
    assert.equal(h.elements.part.textContent, 'P2/3 · P2');
    assert.equal(secondCalls, 2);
});

test('预缓冲失败会提示，并在跳转时重新请求', async () => {
    let attempts = 0;
    const h = playerHarness(async cid => {
        if (cid === 12 && ++attempts === 1) return { success: false, message: '网络故障' };
        return stream(cid);
    });

    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    assert.match(h.elements.status.textContent, /预缓冲失败.*网络故障/);
    await vm.runInContext('switchTo(35, true)', h.context);
    assert.equal(h.elements.part.textContent, 'P2/3 · P2');
    assert.equal(attempts, 2);
});

test('拖动进度条后在浏览器完成 seek 前不回跳', async () => {
    const h = playerHarness(async cid => stream(cid));
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 10', h.context);
    h.elements.seek.value = '45';
    await h.elements.seek.dispatch('input');
    await h.elements.seek.dispatch('change');
    await settle();
    // 模拟浏览器尚未完成 seek：currentTime 还停留在旧位置，此时 timeupdate 不能把进度条拽回去
    vm.runInContext('active.video.currentTime = 0.5', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    assert.equal(h.elements.seek.value, 45);
    assert.equal(h.elements.current.textContent, '00:45');
    // seek 完成，进度条恢复跟随真实播放位置
    vm.runInContext('active.video.currentTime = 15', h.context);
    await vm.runInContext('active.video.dispatch("seeked")', h.context);
    vm.runInContext('active.video.currentTime = 15.5', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    assert.equal(h.elements.seek.value, 45.5);
});

test('seeked 未触发时 timeupdate 兜底解除进度条钉住', async () => {
    const h = playerHarness(async cid => stream(cid));
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    await vm.runInContext('switchTo(12, false)', h.context);
    vm.runInContext('active.video.currentTime = 12.1', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    vm.runInContext('active.video.currentTime = 12.5', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    assert.equal(h.elements.seek.value, 12.5);
});

test('视频尚在 seek 时不提前解除等待或回拨音频，连续拖动不丢失目标', async () => {
    const h = playerHarness(async cid => stream(cid));
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    await vm.runInContext('switchTo(12, true)', h.context);
    const slot = vm.runInContext('active', h.context);
    slot.video.seeking = true;
    slot.audio.currentTime = 12.4;
    await slot.video.dispatch('timeupdate');
    await slot.video.dispatch('seeked');
    assert.equal(vm.runInContext('seekPending', h.context), true);
    assert.equal(slot.audio.currentTime, 12.4, '视频 seek 未完成时不应回拨音频');

    h.elements.seek.value = '20';
    await h.elements.seek.dispatch('input');
    slot.video.seeking = false;
    await slot.video.dispatch('seeked');
    slot.video.currentTime = 12.6;
    await slot.video.dispatch('timeupdate');
    assert.equal(h.elements.seek.value, '20', '拖动期间旧 seek 结束不应覆盖新的目标');
    await h.elements.seek.dispatch('change');
    await settle();
    assert.equal(slot.video.currentTime, 20);
    assert.equal(slot.audio.currentTime, 20);
});

test('拖动后等待音视频均完成 seek 才恢复播放', async () => {
    const h = playerHarness(async cid => stream(cid));
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    const slot = vm.runInContext('active', h.context);
    for (const media of [slot.video, slot.audio]) {
        let time = media.currentTime;
        Object.defineProperty(media, 'currentTime', {
            get: () => time,
            set: value => { time = value; media.seeking = true; },
        });
    }
    const jump = vm.runInContext('switchTo(12, true)', h.context);
    await settle();
    assert.equal(slot.video.paused, true);
    assert.equal(slot.audio.paused, true);
    slot.video.seeking = false;
    await slot.video.dispatch('seeked');
    assert.equal(slot.video.paused, true, '音频尚未完成 seek');
    slot.audio.seeking = false;
    await slot.audio.dispatch('seeked');
    await jump;
    assert.equal(slot.video.paused, false);
    assert.equal(slot.audio.paused, false);
});

test('重复跳到当前目标时仍需等待正在进行的 seek', async () => {
    const h = playerHarness(async cid => stream(cid));
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    const slot = vm.runInContext('active', h.context);
    slot.video.currentTime = 12;
    slot.audio.currentTime = 12;
    slot.video.seeking = true;
    const jump = vm.runInContext('switchTo(12, true)', h.context);
    await settle();
    assert.equal(slot.video.paused, true);
    slot.video.seeking = false;
    await slot.video.dispatch('seeked');
    await jump;
    assert.equal(slot.video.paused, false);
});

test('零星弹幕优先占用最上方轨道，密集时自上而下错开且不重叠', async () => {
    // 5 条滚动 + 2 条顶部 + 2 条底部，间隔 0.1s；宽度 100/800 屏宽 → 单条轨道占用约 1.29s
    const d = (t, mode) => `<d p="${t},${mode},25,16777215,0,0,0,1">弹幕${t}</d>`;
    const xml = `<i>${[0, 0.1, 0.2, 0.3, 0.4].map(t => d(t, 1)).join('')}${d(0, 5)}${d(0.1, 5)}${d(0, 4)}${d(0.1, 4)}</i>`;
    const h = playerHarness(async cid => stream(cid), undefined, xml);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 0.45', h.context);
    await vm.runInContext('renderDanmaku()', h.context);
    // vm 上下文返回的数组原型与宿主不同，统一用 Array.from 转为宿主数组再断言
    const run = expr => Array.from(vm.runInContext(expr, h.context));
    // 解析后按时间排序，同刻按原始顺序：scroll0,top0,bottom0,scroll1,top1,bottom1,scroll2,scroll3,scroll4
    const lanes = run('active.danmaku.map(item => item.lane)');
    const laneOf = mode => run(`active.danmaku.filter(i => i.mode === ${mode}).map(i => i.lane)`);
    // 同速滚动弹幕逐条错开轨道（追尾会碰撞），且从最上方 0 开始自上而下
    assert.deepEqual(laneOf(1), [0, 1, 2, 3, 4]);
    // 顶部/底部各自独立编号，同样从各自优先轨道开始
    assert.deepEqual(laneOf(5), [0, 1]);
    assert.deepEqual(laneOf(4), [0, 1]);
    assert.equal(lanes.length, 9);
    // 顶部弹幕 lane*30 向下堆叠；底部弹幕 lane 越大越往上
    const topsOf = mode => run(`active.danmaku.filter(i => i.mode === ${mode}).map(i => visibleDanmaku.get(i).style.top)`);
    assert.deepEqual(topsOf(1), ['0px', '30px', '60px', '90px', '120px']);
    assert.deepEqual(topsOf(5), ['0px', '30px']);
    assert.deepEqual(topsOf(4), ['460px', '430px']);
});

test('稀疏弹幕始终落在最上方轨道', async () => {
    const d = t => `<d p="${t},1,25,16777215,0,0,0,1">文字</d>`;
    const xml = `<i>${[0, 2, 4, 6].map(d).join('')}</i>`;
    const h = playerHarness(async cid => stream(cid), undefined, xml);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 6.1', h.context);
    await vm.runInContext('renderDanmaku()', h.context);
    // 间隔 2s > 单条占用 1.29s，轨道 0 已空出，四条全应落在最上方
    assert.deepEqual(Array.from(vm.runInContext('active.danmaku.map(item => item.lane)', h.context)), [0, 0, 0, 0]);
});

test('轨道全占时新弹幕选最快空出的轨道', async () => {
    // 舞台高 500px → 滚动轨道数 = floor(500*0.75/30) = 12；单条占用 8*100/900+0.2≈1.09s，
    // 用 0.05s 间隔发 13 条：前 12 条自上而下占满全部轨道
    const xml = `<i>${Array.from({ length: 13 }, (_, i) => `<d p="${(i * 0.05).toFixed(2)},1,25,16777215,0,0,0,1">字</d>`).join('')}</i>`;
    const h = playerHarness(async cid => stream(cid), undefined, xml);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 0.65', h.context);
    await vm.runInContext('renderDanmaku()', h.context);
    const lanes = Array.from(vm.runInContext('active.danmaku.map(item => item.lane)', h.context));
    assert.deepEqual(lanes.slice(0, 12), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // 第 13 条（t=0.6）：所有轨道都被占，最早空出的是 lane 0 → 落到 lane 0
    assert.equal(lanes[12], 0);
});

test('较长分P接近结束时才预缓冲，避免流地址过期', async () => {
    const requested = [];
    const h = playerHarness(async cid => { requested.push(cid); return stream(cid); }, [
        { cid: 11, duration: 120 }, { cid: 12, duration: 120 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    assert.deepEqual(requested, [11]);
    await vm.runInContext('switchTo(61, true)', h.context);
    await settle();
    assert.deepEqual(requested, [11, 12]);
});

test('边界前隐藏预起播下一P，到界直接交接不再重新准备', async () => {
    const requested = [];
    const h = playerHarness(async cid => { requested.push(cid); return stream(cid); }, [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    // 剩余 2s（< SEAM_LEAD_SECONDS）时触发隐藏预起播
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    assert.equal(vm.runInContext('seam !== null', h.context), true);
    assert.equal(next.video.paused, false, '下一P视频应在后台播放');
    assert.equal(next.audio.paused, false, '下一P音频应在后台播放');
    assert.equal(vm.runInContext('slots.find(s => s === active).video.classList.contains("active")', h.context), true);
    assert.equal(next.video.classList.contains('active'), false, '交接前不应显示下一P');
    assert.equal(next.audio.muted, true, '交接前下一P音频必须静音');

    // 接近边界：tickSeam 完成交接，不应再发起任何取流请求
    vm.runInContext('active.video.currentTime = 9.99', h.context);
    await vm.runInContext('tickSeam()', h.context);
    assert.deepEqual(requested, [11, 12], '交接不应触发新的取流');
    assert.equal(vm.runInContext('active', h.context), next);
    assert.equal(next.video.classList.contains('active'), true);
    assert.equal(next.audio.muted, false, '交接后应恢复音频');
    assert.equal(h.elements.part.textContent, 'P2/2 · P2');
});

test('交接时把下一P回到起点，不跳过它的片头', async () => {
    const h = playerHarness(async cid => stream(cid), [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    // 隐藏预起播已经跑出一帧多，交接时应回到 0，而不是从中间继续
    next.video.currentTime = 0.05;
    next.audio.currentTime = 0.05;
    vm.runInContext('active.video.currentTime = 9.99', h.context);
    await vm.runInContext('tickSeam()', h.context);
    assert.equal(next.video.currentTime, 0, '交接后下一P应严格从 0 开始');
    assert.equal(next.audio.currentTime, 0);
});

test('隐藏预起播的下一P跑过头时钉回开头', async () => {
    const h = playerHarness(async cid => stream(cid), [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    next.video.currentTime = 1.5;
    vm.runInContext('active.video.currentTime = 9.5', h.context);
    await vm.runInContext('tickSeam()', h.context);
    assert.equal(next.video.currentTime, 0, '超出钉位窗口应回绕到起点');
    assert.equal(vm.runInContext('seam !== null', h.context), true, '未到边界不应交接');
});

test('窗口被遮挡（rAF 不回调）时仍能靠 timeupdate 在边界交接', async () => {
    // harness 里 requestAnimationFrame 是空实现，等价于窗口不可见时 rAF 被完全节流
    const h = playerHarness(async cid => stream(cid), [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    assert.equal(vm.runInContext('seam !== null', h.context), true);

    // 推进到边界后只发 timeupdate：交接必须发生，否则切走窗口就会失步到媒体真正结束
    vm.runInContext('active.video.currentTime = 9.99', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    assert.equal(vm.runInContext('active', h.context), next, '仅靠 timeupdate 也应完成交接');
    assert.equal(h.elements.part.textContent, 'P2/2 · P2');
});

test('进度条按分P时长钳制，媒体比 API 时长长时不越过边界回跳', async () => {
    const h = playerHarness(async cid => stream(cid), [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    // 先让首次 seek 落位，解除 seekPending，进度条才会跟随播放位置
    vm.runInContext('active.video.currentTime = 0.2', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    // 媒体实际时长比 API 报的分P时长长，且交接检查还没来得及生效
    vm.runInContext('active.video.duration = 12', h.context);
    vm.runInContext('active.video.currentTime = 10.8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    assert.equal(h.elements.seek.value, 10, '进度不应超过该分P的累计边界');
    assert.equal(h.elements.current.textContent, '00:10');
});

test('下一P未就绪时在分P边界等待缓冲，不等原媒体结束', async () => {
    const requested = [];
    const h = playerHarness(async cid => { requested.push(cid); return stream(cid); }, [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    assert.equal(vm.runInContext('seam !== null', h.context), true);

    // 原媒体比分P标称时长长，下一P仍未就绪时也必须在标称边界停下
    vm.runInContext('active.video.duration = 20', h.context);
    const previous = vm.runInContext('active', h.context);
    next.video.readyState = 0;
    vm.runInContext('active.video.currentTime = 9.99', h.context);
    await vm.runInContext('tickSeam()', h.context);
    await settle();
    assert.equal(previous.video.paused, true, '应在分P边界暂停原视频');
    assert.equal(vm.runInContext('active', h.context), previous, '不应切到未就绪的槽');
    assert.equal(h.elements.spinner.hidden, false);
    next.video.readyState = 4;
    await next.video.dispatch('canplay');
    await settle();
    assert.deepEqual(requested, [11, 12], '回退切换不应重复取流');
    assert.equal(vm.runInContext('active', h.context), next);
    assert.equal(next.video.classList.contains('active'), true);
    assert.equal(h.elements.part.textContent, 'P2/2 · P2');
});

test('预缓冲尚未完成时也在分P边界等待而不是播过头', async () => {
    let resolveNext;
    const h = playerHarness(cid => cid === 12
        ? new Promise(resolve => { resolveNext = resolve; })
        : Promise.resolve(stream(cid)), [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    const previous = vm.runInContext('active', h.context);
    previous.video.duration = 20;
    previous.video.currentTime = 10.1;
    await previous.video.dispatch('timeupdate');
    assert.equal(previous.video.paused, true);
    assert.equal(h.elements.spinner.hidden, false);
    resolveNext(stream(12));
    await settle();
    assert.equal(h.elements.part.textContent, 'P2/2 · P2');
});

test('衔接期间暂停会放弃预起播并保留缓冲，恢复后不重复取流', async () => {
    const requested = [];
    const h = playerHarness(async cid => { requested.push(cid); return stream(cid); }, [
        { cid: 11, duration: 10 }, { cid: 12, duration: 10 }, { cid: 13, duration: 10 },
    ]);
    await h.elements.form.dispatch('submit', { preventDefault() {} });
    await settle();
    vm.runInContext('active.video.currentTime = 8', h.context);
    await vm.runInContext('active.video.dispatch("timeupdate")', h.context);
    await settle();
    assert.equal(vm.runInContext('seam !== null', h.context), true);
    assert.deepEqual(requested, [11, 12]);

    // 暂停：放弃预起播，但保留下一P已缓冲的内容与取流结果
    await vm.runInContext('playButton.dispatch("click")', h.context);
    await settle();
    assert.equal(vm.runInContext('seam', h.context), null);
    const next = vm.runInContext('slots.find(s => s !== active)', h.context);
    assert.equal(next.video.paused, true);
    assert.equal(next.index, 1, '不应丢弃已缓冲的下一P');

    // 恢复播放：仍在 P1 内，重新建立衔接，不应重复取流
    await vm.runInContext('playButton.dispatch("click")', h.context);
    await settle();
    assert.equal(vm.runInContext('seam !== null', h.context), true, '恢复后应重新预起播');
    assert.deepEqual(requested, [11, 12], '恢复播放不应重新取流');

    // 播到边界零成本交接进 P2，并为 P3 预取
    vm.runInContext('active.video.currentTime = 9.99', h.context);
    await vm.runInContext('tickSeam()', h.context);
    assert.equal(vm.runInContext('active', h.context), next);
    assert.equal(h.elements.part.textContent, 'P2/3 · P2');
    assert.deepEqual(requested, [11, 12, 13], '交接后应继续为 P3 预取');
});
