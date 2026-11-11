// 独立窗口弹幕姬（虚拟滚动版）
// 历史消息只存在 JS 数组中，DOM 里只保留视口附近的少量行，整层用 translateY 定位，
// 思路与 VSCode 的可滚动列表一致：无论弹幕多快、历史多长，节点数量都恒定。
const { invoke, on } = window.electronAPI;

const viewportEl = document.getElementById('hjViewport');
const spacerEl = document.getElementById('hjSpacer');
const rowsEl = document.getElementById('hjRows');
const titleEl = document.getElementById('hjTitle');
const statusEl = document.getElementById('hjStatus');
const closeBtn = document.getElementById('hjClose');

// 行高必须与 CSS 中的 .hj-row 完全一致，虚拟滚动依赖等高行做数学定位
const ROW_HEIGHT = 42;
const OVERSCAN = 4;
const MAX_HISTORY = 10000;

let roomId = 0;
let history = [];
let autoScroll = true;
// 已渲染区间 [renderStart, renderEnd)，滚动时区间不变就不重建 DOM
let renderStart = -1;
let renderEnd = -1;
let renderQueued = false;

const GUARD_NAMES = { 1: '总督', 2: '提督', 3: '舰长' };

function badge(text, className) {
    const el = document.createElement('span');
    el.className = className;
    if (className.includes('hj-badge')) {
        const name = document.createElement('span');
        name.className = 'hj-badge-name';
        name.textContent = text;
        el.appendChild(name);
    } else {
        el.textContent = text;
    }
    return el;
}

// 单行 DOM 构建，只在行进入视口时执行
function buildRow(message) {
    const row = document.createElement('div');
    row.className = 'hj-row';
    if (message.type === 'superchat') row.classList.add('is-sc');

    if (message.level) {
        row.appendChild(badge(`V${message.level}`, 'hj-level'));
    }
    // 官方样式：粉丝勋章与大航海徽章可同时出现
    if (message.medalName) {
        row.appendChild(badge(`${message.medalName}${message.medalLevel || ''}`, 'hj-badge medal'));
    }
    if (message.guardLevel >= 1 && message.guardLevel <= 3) {
        row.appendChild(badge(GUARD_NAMES[message.guardLevel], `hj-badge guard-${message.guardLevel}`));
    }

    const body = document.createElement('div');
    body.className = 'hj-body';
    const name = document.createElement('span');
    name.className = 'hj-name';
    if (message.guardLevel >= 1 && message.guardLevel <= 3) {
        name.classList.add(`guard-${message.guardLevel}`);
    }
    name.textContent = `${message.user || '神秘用户'}:`;
    body.appendChild(name);
    body.appendChild(document.createTextNode(` ${message.text}`));
    row.appendChild(body);
    return row;
}

function render() {
    renderQueued = false;

    const total = history.length;
    // 撑出完整滚动高度，让滚动条比例与真实历史一致
    spacerEl.style.height = `${total * ROW_HEIGHT}px`;

    const scrollTop = viewportEl.scrollTop;
    let start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    let end = Math.min(total, Math.ceil((scrollTop + viewportEl.clientHeight) / ROW_HEIGHT) + OVERSCAN);

    if (start === renderStart && end === renderEnd) return;
    renderStart = start;
    renderEnd = end;

    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        fragment.appendChild(buildRow(history[i]));
    }
    rowsEl.textContent = '';
    rowsEl.appendChild(fragment);
    // 整层平移到窗口起点，行按流式布局堆叠，等价于 VSCode 的 translateY 方案
    rowsEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
}

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
}

function scrollToBottom() {
    // 先把撑高层同步到最新高度，再设置 scrollTop；
    // 否则 spacer 还是旧高度时赋值会被浏览器截断，导致贴不住底部
    spacerEl.style.height = `${history.length * ROW_HEIGHT}px`;
    viewportEl.scrollTop = Math.max(0, history.length * ROW_HEIGHT - viewportEl.clientHeight);
}

function pushMessage(message) {
    history.push(message);
    if (history.length > MAX_HISTORY) {
        const excess = history.length - MAX_HISTORY;
        history.splice(0, excess);
        if (autoScroll) {
            scrollToBottom();
        } else {
            // 上滚翻阅时裁掉头部要补偿滚动量，避免画面跳动
            viewportEl.scrollTop = Math.max(0, viewportEl.scrollTop - excess * ROW_HEIGHT);
            renderStart = -1;
            renderEnd = -1;
        }
    } else if (autoScroll) {
        scrollToBottom();
    }
    scheduleRender();
}

// 用户手动上滚时暂停跟随，回到底部附近自动恢复
viewportEl.addEventListener('scroll', () => {
    const gap = history.length * ROW_HEIGHT - viewportEl.scrollTop - viewportEl.clientHeight;
    autoScroll = gap < ROW_HEIGHT;
    scheduleRender();
});

// 窗口尺寸变化时可视行数会变，需要重新计算渲染区间并重新贴底
new ResizeObserver(() => {
    renderStart = -1;
    renderEnd = -1;
    if (autoScroll) scrollToBottom();
    scheduleRender();
}).observe(viewportEl);

on('danmakuji:init', (payload) => {
    roomId = Number(payload?.roomId) || 0;
    titleEl.textContent = payload?.title || `直播间 ${roomId}`;
    titleEl.title = titleEl.textContent;
    scheduleRender();
});

on('monitor:danmaku', (payload) => {
    if (!roomId || payload?.roomId !== roomId) return;
    const message = payload.message || {};
    if (message.type !== 'danmaku' && message.type !== 'superchat') return;
    if (!message.text) return;
    pushMessage(message);
});

on('monitor:danmaku-status', (payload) => {
    if (!roomId || payload?.roomId !== roomId) return;
    const status = payload.status || {};
    if (status.state === 'open') statusEl.textContent = '已连接';
    else if (status.state === 'connecting') statusEl.textContent = '连接中';
    else statusEl.textContent = status.message || status.state || '已断开';
});

closeBtn.addEventListener('click', () => {
    if (roomId) invoke('monitor:closeDanmakuji', { roomId });
    window.close();
});
