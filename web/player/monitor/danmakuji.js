// 独立窗口弹幕姬（动态行高虚拟滚动版）
// 每条弹幕按实际内容（单行、多行换行、大表情贴纸、SC）自适应高度；
// 通过前缀和数组 + 二分查找定位可视区间，并复用视口内 DOM 节点避免表情闪烁。
const { invoke, on } = window.electronAPI;

const viewportEl = document.getElementById('hjViewport');
const spacerEl = document.getElementById('hjSpacer');
const rowsEl = document.getElementById('hjRows');
const titleEl = document.getElementById('hjTitle');
const statusEl = document.getElementById('hjStatus');
const closeBtn = document.getElementById('hjClose');

const OVERSCAN = 6;
const MAX_HISTORY = 10000;
const AUTO_SCROLL_GAP = 28;
const LIST_VERTICAL_PADDING = 8;

const SC_FALLBACK_TIERS = [
    { min: 1000, head: '#ab1a32', body: '#fff0f2' },
    { min: 500, head: '#e09443', body: '#fff6eb' },
    { min: 100, head: '#e2b52b', body: '#fffbe8' },
    { min: 50, head: '#427d9e', body: '#eef6fa' },
    { min: 0, head: '#2a60b2', body: '#edf5ff' },
];

const SVG_NS = 'http://www.w3.org/2000/svg';

let roomId = 0;
let nextId = 0;
let history = [];
let heights = [];
// offsets[i] 为第 i 条消息的起始 Y 偏移，offsets[history.length] 为全部行的累计高度
let offsets = [0];
let dirtyFrom = 0;

let autoScroll = true;
let renderQueued = false;
let renderedNodes = new Map();
let currentStart = 0;
let currentEnd = 0;

function estimateHeight(message) {
    if (message.type === 'superchat') return 68;
    if (message.sticker) return 56;
    return 28;
}

function ensureOffsets() {
    const n = history.length;
    if (dirtyFrom > n) dirtyFrom = n;
    for (let i = dirtyFrom; i < n; i++) {
        offsets[i + 1] = offsets[i] + heights[i];
    }
    offsets.length = n + 1;
    dirtyFrom = n;
}

function getTotalHeight() {
    ensureOffsets();
    const contentHeight = offsets[history.length] || 0;
    return contentHeight > 0 ? contentHeight + LIST_VERTICAL_PADDING : 0;
}

function findIndexAtOffset(y) {
    const n = history.length;
    if (n === 0 || y <= 0) return 0;
    ensureOffsets();
    if (y >= offsets[n]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= y) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function createSvgIcon(pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
}

function createWealthBadge(level) {
    const el = document.createElement('span');
    let tier = 'tier-1';
    // 不同阶段荣耀等级对应不同底色与纹章造型
    let iconPath = 'M2 3.5L6 8.8L10 3.5L8.3 3.5L6 6.6L3.7 3.5Z';
    if (level >= 50) {
        tier = 'tier-4';
        iconPath = 'M1.4 3.4L3.9 5.3L6 2.3L8.1 5.3L10.6 3.4L9.6 8.8H2.4Z';
    } else if (level >= 40) {
        tier = 'tier-3';
        iconPath = 'M6 1.8L9.8 5.2L6 10.2L2.2 5.2ZM1.2 3.5L3.2 5.2L1.8 7.5ZM10.8 3.5L10.2 7.5L8.8 5.2Z';
    } else if (level >= 20) {
        tier = 'tier-2';
        iconPath = 'M1.4 3.2L4.6 5.6L6 3.5L7.4 5.6L10.6 3.2L9.2 8.6L6 10L2.8 8.6Z';
    }
    el.className = `hj-wealth ${tier}`;
    el.appendChild(createSvgIcon(iconPath));
    const num = document.createElement('span');
    num.textContent = String(level);
    el.appendChild(num);
    return el;
}

function createGuardEmblem(guardLevel) {
    const emblem = document.createElement('span');
    emblem.className = `hj-guard-emblem guard-${guardLevel}`;
    // 总督使用皇冠纹章，提督 / 舰长使用船锚纹章
    const pathData = guardLevel === 1
        ? 'M1.6 3.5L4.1 5.5L6 2.5L7.9 5.5L10.4 3.5L9.4 9H2.6Z'
        : 'M6 1.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM5.3 4h1.4v1.1h1.7v1.1H6.7v2.4c1-.2 1.8-.9 2.2-1.8l1 .5C9.3 9 7.8 10.1 6 10.2 4.2 10.1 2.7 9 2.1 7.3l1-.5c.4.9 1.2 1.6 2.2 1.8V6.2H3.6V5.1h1.7Z';
    emblem.appendChild(createSvgIcon(pathData));
    return emblem;
}

function fallbackMedalGradient(level, isLight) {
    if (isLight === false) return '#919298cc';
    if (level >= 51) return 'linear-gradient(90deg, #eb5370, #ff758f)';
    if (level >= 41) return 'linear-gradient(90deg, #9660e5, #b074f8)';
    if (level >= 31) return 'linear-gradient(90deg, #4775ef, #5b93f7)';
    if (level >= 21) return 'linear-gradient(90deg, #3ea6ed, #5cc0f5)';
    if (level >= 17) return '#c79d27cc';
    if (level >= 13) return '#be6686cc';
    if (level >= 9) return '#8d7ca6cc';
    if (level >= 5) return '#5d7b9ecc';
    return '#5c968ecc';
}

function isVeryDarkHex(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 42;
}

function createMedalBadge(message) {
    const el = document.createElement('span');
    el.className = 'hj-medal';

    const medalGuard = message.medalGuardLevel >= 1 && message.medalGuardLevel <= 3
        ? message.medalGuardLevel
        : 0;
    if (medalGuard) {
        el.classList.add('has-guard');
        if (message.medalGuardIcon) {
            const icon = document.createElement('img');
            icon.className = 'hj-guard-icon';
            icon.src = message.medalGuardIcon;
            icon.alt = '';
            icon.addEventListener('error', () => {
                icon.replaceWith(createGuardEmblem(medalGuard));
            });
            el.appendChild(icon);
        } else {
            el.appendChild(createGuardEmblem(medalGuard));
        }
    }

    if (message.medalLight === false) {
        el.style.background = '#919298cc';
    } else if (message.medalColorStart && !isVeryDarkHex(message.medalColorStart)) {
        const start = message.medalColorStart;
        const end = message.medalColorEnd && !isVeryDarkHex(message.medalColorEnd)
            ? message.medalColorEnd
            : start;
        el.style.background = start === end ? start : `linear-gradient(90deg, ${start}, ${end})`;
    } else {
        el.style.background = fallbackMedalGradient(message.medalLevel || 1, message.medalLight);
    }

    const name = document.createElement('span');
    name.className = 'hj-medal-name';
    name.textContent = message.medalName;
    el.appendChild(name);

    if (message.medalLevel) {
        const lv = document.createElement('span');
        lv.className = 'hj-medal-level';
        lv.textContent = String(message.medalLevel);
        el.appendChild(lv);
    }
    return el;
}

function resolveRoomGuard(message) {
    if (message.guardLevel >= 1 && message.guardLevel <= 3) return message.guardLevel;
    if (
        roomId
        && message.medalRoom === roomId
        && message.medalGuardLevel >= 1
        && message.medalGuardLevel <= 3
    ) {
        return message.medalGuardLevel;
    }
    return 0;
}

function buildSuperChatItem(message) {
    const item = document.createElement('div');
    item.className = 'hj-item';

    const price = Number(message.price) || 0;
    const tier = SC_FALLBACK_TIERS.find(t => price >= t.min) || SC_FALLBACK_TIERS[SC_FALLBACK_TIERS.length - 1];
    const card = document.createElement('div');
    card.className = 'hj-sc';
    card.style.setProperty('--sc-head', message.headerBg || tier.head);
    card.style.setProperty('--sc-body', message.bodyBg || tier.body);

    const head = document.createElement('div');
    head.className = 'hj-sc-head';
    const userWrap = document.createElement('div');
    userWrap.className = 'hj-sc-user';
    if (message.medalName) {
        userWrap.appendChild(createMedalBadge(message));
    }
    const name = document.createElement('span');
    name.className = 'hj-sc-name';
    name.textContent = message.user || '神秘用户';
    userWrap.appendChild(name);
    head.appendChild(userWrap);

    if (price > 0) {
        const priceEl = document.createElement('span');
        priceEl.className = 'hj-sc-price';
        priceEl.textContent = `￥${price}`;
        head.appendChild(priceEl);
    }

    const body = document.createElement('div');
    body.className = 'hj-sc-body';
    body.textContent = message.text;

    card.appendChild(head);
    card.appendChild(body);
    item.appendChild(card);
    return item;
}

function buildItem(message) {
    if (message.type === 'superchat') return buildSuperChatItem(message);

    const item = document.createElement('div');
    item.className = 'hj-item';

    const row = document.createElement('div');
    row.className = 'hj-row';

    const roomGuard = resolveRoomGuard(message);
    if (roomGuard >= 1 && roomGuard <= 3) {
        row.classList.add('is-guard', `guard-${roomGuard}`);
    }

    if (message.rank >= 1 && message.rank <= 3) {
        const rank = document.createElement('span');
        rank.className = `hj-rank rank-${message.rank}`;
        rank.textContent = `榜${message.rank}`;
        row.appendChild(rank);
    }

    if (message.isAdmin) {
        const admin = document.createElement('span');
        admin.className = 'hj-admin';
        admin.textContent = '房';
        row.appendChild(admin);
    }

    if (message.wealthLevel > 0) {
        row.appendChild(createWealthBadge(message.wealthLevel));
    }

    if (message.medalName) {
        row.appendChild(createMedalBadge(message));
    } else if (roomGuard >= 1 && roomGuard <= 3) {
        const standalone = document.createElement('span');
        standalone.className = 'hj-guard-standalone';
        standalone.appendChild(createGuardEmblem(roomGuard));
        row.appendChild(standalone);
    }

    const name = document.createElement('span');
    name.className = 'hj-name';
    if (message.nameColor) name.style.color = message.nameColor;
    name.textContent = `${message.user || '神秘用户'} :`;
    row.appendChild(name);

    const textEl = document.createElement('span');
    textEl.className = 'hj-text';
    if (message.sticker?.url) {
        const sticker = document.createElement('img');
        sticker.className = 'hj-sticker';
        sticker.src = message.sticker.url;
        sticker.alt = message.text || '';
        sticker.title = message.text || '';
        if (message.sticker.width > 0 && message.sticker.height > 0) {
            sticker.style.aspectRatio = `${message.sticker.width} / ${message.sticker.height}`;
        }
        sticker.addEventListener('error', () => {
            sticker.replaceWith(document.createTextNode(message.text || '[表情]'));
            scheduleRender();
        });
        sticker.addEventListener('load', () => measureRenderedRows());
        textEl.appendChild(sticker);
    } else {
        appendRichText(textEl, message.text, message.emotes);
    }
    row.appendChild(textEl);

    item.appendChild(row);
    return item;
}

// 把文本中的表情占位符（如 [热] / [2233娘_疑惑]）替换为表情包图片
function appendRichText(container, text, emotes) {
    if (!emotes || !Object.keys(emotes).length) {
        container.appendChild(document.createTextNode(text));
        return;
    }

    const keys = Object.keys(emotes).sort((a, b) => b.length - a.length);
    const pattern = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const regex = new RegExp(`(${pattern})`, 'g');

    let last = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > last) {
            container.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        const label = match[0];
        const emote = emotes[label];
        const img = document.createElement('img');
        img.className = 'hj-emote';
        img.src = emote.url;
        img.alt = label;
        img.title = label;
        if (emote.width > 0 && emote.height > 0) {
            img.style.aspectRatio = `${emote.width} / ${emote.height}`;
        }
        img.addEventListener('error', () => {
            img.replaceWith(document.createTextNode(label));
            scheduleRender();
        });
        container.appendChild(img);
        last = regex.lastIndex;
    }
    if (last < text.length) {
        container.appendChild(document.createTextNode(text.slice(last)));
    }
}

function measureRenderedRows() {
    if (!history.length || currentEnd <= currentStart) return false;
    ensureOffsets();

    const prevScrollTop = viewportEl.scrollTop;
    let firstChanged = -1;
    let deltaAbove = 0;
    let child = rowsEl.firstElementChild;

    for (let i = currentStart; i < currentEnd && child; i++, child = child.nextElementSibling) {
        const h = child.offsetHeight;
        if (h > 0 && h !== heights[i]) {
            if (firstChanged === -1) firstChanged = i;
            if (offsets[i] < prevScrollTop) {
                deltaAbove += h - heights[i];
            }
            heights[i] = h;
        }
    }

    if (firstChanged === -1) return false;

    dirtyFrom = Math.min(dirtyFrom, firstChanged);
    const totalPx = getTotalHeight();
    spacerEl.style.height = `${totalPx}px`;
    rowsEl.style.transform = `translateY(${offsets[currentStart]}px)`;

    if (autoScroll) {
        viewportEl.scrollTop = Math.max(0, totalPx - viewportEl.clientHeight);
    } else if (deltaAbove !== 0) {
        viewportEl.scrollTop = Math.max(0, prevScrollTop + deltaAbove);
    }
    return true;
}

function renderPass() {
    const total = history.length;
    const totalPx = getTotalHeight();
    spacerEl.style.height = `${totalPx}px`;

    if (total === 0) {
        rowsEl.textContent = '';
        renderedNodes.clear();
        currentStart = 0;
        currentEnd = 0;
        return false;
    }

    if (autoScroll) {
        viewportEl.scrollTop = Math.max(0, totalPx - viewportEl.clientHeight);
    }

    const scrollTop = viewportEl.scrollTop;
    const viewBottom = scrollTop + Math.max(0, viewportEl.clientHeight - 1);
    const start = Math.max(0, findIndexAtOffset(scrollTop) - OVERSCAN);
    const end = Math.min(total, findIndexAtOffset(viewBottom) + 1 + OVERSCAN);

    currentStart = start;
    currentEnd = end;

    const nextNodes = new Map();
    let cursor = rowsEl.firstElementChild;
    for (let i = start; i < end; i++) {
        const msg = history[i];
        let el = renderedNodes.get(msg._id);
        if (!el) el = buildItem(msg);
        nextNodes.set(msg._id, el);
        if (cursor === el) {
            cursor = cursor.nextElementSibling;
        } else {
            rowsEl.insertBefore(el, cursor);
        }
    }
    while (cursor) {
        const next = cursor.nextElementSibling;
        cursor.remove();
        cursor = next;
    }
    renderedNodes = nextNodes;

    rowsEl.style.transform = `translateY(${offsets[start]}px)`;
    return measureRenderedRows();
}

function render() {
    renderQueued = false;
    // 首次挂载新行后真实高度可能与预估值不同，最多补跑一轮即可稳定收敛
    if (renderPass()) {
        renderPass();
    }
}

function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
}

function scrollToBottom() {
    const totalPx = getTotalHeight();
    spacerEl.style.height = `${totalPx}px`;
    viewportEl.scrollTop = Math.max(0, totalPx - viewportEl.clientHeight);
}

function pushMessage(message) {
    message._id = ++nextId;
    const idx = history.length;
    const est = estimateHeight(message);
    history.push(message);
    heights.push(est);
    if (dirtyFrom === idx) {
        offsets[idx + 1] = offsets[idx] + est;
        dirtyFrom = idx + 1;
    }

    if (history.length > MAX_HISTORY) {
        const excess = history.length - MAX_HISTORY;
        ensureOffsets();
        const removedHeight = offsets[excess];
        history.splice(0, excess);
        heights.splice(0, excess);
        dirtyFrom = 0;
        if (!autoScroll) {
            viewportEl.scrollTop = Math.max(0, viewportEl.scrollTop - removedHeight);
        }
    }

    if (autoScroll) {
        scrollToBottom();
    }
    scheduleRender();
}

viewportEl.addEventListener('scroll', () => {
    const gap = getTotalHeight() - viewportEl.scrollTop - viewportEl.clientHeight;
    autoScroll = gap <= AUTO_SCROLL_GAP;
    scheduleRender();
});

new ResizeObserver(() => {
    if (autoScroll) scrollToBottom();
    scheduleRender();
}).observe(viewportEl);

new ResizeObserver(() => {
    if (measureRenderedRows()) {
        scheduleRender();
    }
}).observe(rowsEl);

on('danmakuji:init', (payload) => {
    const nextRoomId = Number(payload?.roomId) || 0;
    if (nextRoomId && nextRoomId !== roomId) {
        roomId = nextRoomId;
        renderedNodes.clear();
        rowsEl.textContent = '';
    } else if (nextRoomId) {
        roomId = nextRoomId;
    }
    titleEl.textContent = payload?.title || `直播间 ${roomId}`;
    titleEl.title = titleEl.textContent;
    scheduleRender();
});

on('monitor:danmaku', (payload) => {
    if (!roomId || payload?.roomId !== roomId) return;
    const message = payload.message || {};
    if (message.type !== 'danmaku' && message.type !== 'superchat') return;
    if (!message.text && !message.sticker) return;
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
