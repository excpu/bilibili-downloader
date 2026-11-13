// 弹幕姬列表渲染器：动态行高虚拟滚动，单房间独立窗口与多房间控制台共用。
// 每条弹幕按实际内容（换行、表情、贴纸、SC）自适应高度；前缀和 + 二分定位可视区间，
// 并复用视口内 DOM 节点，避免表情图片在滚动时反复重新加载。
(function (global) {
    const Shared = global.DanmakujiShared;

    const OVERSCAN = 6;
    const MAX_HISTORY = 10000;
    const AUTO_SCROLL_GAP = 28;
    const LIST_VERTICAL_PADDING = 16;
    const BASE_FONT_SIZE = 13;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const GUARD_ICONS = {
        1: 'https://i0.hdslb.com/bfs/live/ffcd832b5d7b84ea851cb8156ec0a71940439511.png',
        2: 'https://i0.hdslb.com/bfs/live/98a201c14a64e860a758f089144dcf3f42e7038c.png',
        3: 'https://i0.hdslb.com/bfs/live/143f5ec3003b4080d1b5f817a9efdca46d631945.png',
    };
    // 这些设置决定一条弹幕是否入列，改动后需要清理已有历史
    const FILTER_KEYS = ['keyword', 'blocked', 'superchatOnly', 'showSuperchat', 'showEnter', 'showGift'];

    const SC_FALLBACK_TIERS = [
        { min: 1000, head: '#ab1a32', body: '#fff0f2' },
        { min: 500, head: '#e09443', body: '#fff6eb' },
        { min: 100, head: '#e2b52b', body: '#fffbe8' },
        { min: 50, head: '#427d9e', body: '#eef6fa' },
        { min: 0, head: '#2a60b2', body: '#edf5ff' },
    ];

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
        const icon = document.createElement('img');
        icon.className = 'hj-guard-icon';
        icon.src = GUARD_ICONS[guardLevel];
        icon.alt = ['', '总督', '提督', '舰长'][guardLevel];
        icon.addEventListener('error', () => {
            console.warn('大航海图标加载失败:', icon.src);
            icon.replaceWith(createGuardFallback(guardLevel));
        }, { once: true });
        return icon;
    }

    function createGuardFallback(guardLevel) {
        const emblem = document.createElement('span');
        emblem.className = `hj-guard-emblem guard-${guardLevel}`;
        // 总督使用皇冠纹章，提督 / 舰长使用船锚纹章
        const pathData = guardLevel === 1
            ? 'M1.6 3.5L4.1 5.5L6 2.5L7.9 5.5L10.4 3.5L9.4 9H2.6Z'
            : 'M6 1.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM5.3 4h1.4v1.1h1.7v1.1H6.7v2.4c1-.2 1.8-.9 2.2-1.8l1 .5C9.3 9 7.8 10.1 6 10.2 4.2 10.1 2.7 9 2.1 7.3l1-.5c.4.9 1.2 1.6 2.2 1.8V6.2H3.6V5.1h1.7Z';
        emblem.appendChild(createSvgIcon(pathData));
        return emblem;
    }

    function fallbackMedalColor(level, isLight) {
        if (isLight === false) return '#919298cc';
        if (level >= 51) return '#eb5370';
        if (level >= 41) return '#9660e5';
        if (level >= 31) return '#4775ef';
        if (level >= 21) return '#3ea6ed';
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
            el.style.background = message.medalColorStart;
        } else {
            el.style.background = fallbackMedalColor(message.medalLevel || 1, message.medalLight);
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

    class DanmakujiList {
        constructor(options = {}) {
            this.viewportEl = options.viewport;
            this.roomId = Number(options.roomId) || 0;
            this.settings = Shared.normalizeSettings(options.settings);
            this.onFollowChange = options.onFollowChange || (() => { });
            this.onPendingChange = options.onPendingChange || (() => { });
            this.onCountChange = options.onCountChange || (() => { });
            // 合并时间线模式下用于给每条弹幕标注来源直播间
            this.roomTagFor = options.roomTagFor || null;
            this.linePrefixFor = options.linePrefixFor || null;

            this.spacerEl = document.createElement('div');
            this.spacerEl.className = 'hj-spacer';
            this.rowsEl = document.createElement('div');
            this.rowsEl.className = 'hj-rows';
            this.spacerEl.appendChild(this.rowsEl);
            this.viewportEl.appendChild(this.spacerEl);
            this.viewportEl.classList.add('hj-viewport');

            this.nextId = 0;
            this.latestId = 0;
            this.history = [];
            this.sourceHistory = [];
            this.heights = [];
            this.offsets = [0];
            this.dirtyFrom = 0;
            this.timestamps = [];
            this.pending = [];
            this.sourcePending = [];

            this.autoScroll = this.settings.autoScroll;
            this.paused = false;
            this.renderQueued = false;
            this.renderedNodes = new Map();
            this.currentStart = 0;
            this.currentEnd = 0;
            this.followRaf = null;
            this.lastProgrammaticTop = -1;
            this.destroyed = false;

            this.applySettingsVars();
            this.bindEvents();
        }

        // ---------------- 设置 ----------------
        applySettingsVars() {
            const scale = this.settings.fontSize / BASE_FONT_SIZE;
            this.viewportEl.style.setProperty('--hj-font-size', `${this.settings.fontSize}px`);
            this.viewportEl.style.setProperty('--hj-line-height', `${Math.round(20 * scale)}px`);
            this.viewportEl.style.setProperty('--hj-item-gap', `${Shared.densityGap(this.settings.density)}px`);
            this.viewportEl.style.setProperty('--hj-emote-size', `${Math.round(20 * scale)}px`);
            this.viewportEl.style.setProperty('--hj-sticker-size', `${Math.round(46 * scale)}px`);
            this.viewportEl.classList.toggle('hj-hide-time', !this.settings.showTimestamp);
        }

        setSettings(settings) {
            const next = Shared.normalizeSettings(settings);
            const prev = this.settings;
            const structural = JSON.stringify(next) !== JSON.stringify(prev);
            const followChanged = next.autoScroll !== prev.autoScroll;
            const filterChanged = FILTER_KEYS.some(key => next[key] !== prev[key]);
            this.settings = next;
            this.applySettingsVars();
            if (followChanged) this.setFollow(next.autoScroll);
            if (filterChanged) {
                this.purge();
            } else if (structural) {
                // 字号 / 徽章 / 时间戳都会改变行高，已缓存的高度与节点必须整体失效
                this.invalidate();
            }
        }

        // 只看 SC 是临时视图；其他过滤仍剔除缓存中不匹配的消息。
        purge() {
            const sourceSettings = { ...this.settings, superchatOnly: false };
            this.sourceHistory = this.sourceHistory.filter(message => Shared.shouldShowMessage(message, sourceSettings));
            this.sourcePending = this.sourcePending.filter(message => Shared.shouldShowMessage(message, sourceSettings));
            this.history = this.sourceHistory.filter(message => Shared.shouldShowMessage(message, this.settings));
            this.pending = this.sourcePending.filter(message => Shared.shouldShowMessage(message, this.settings));
            this.latestId = this.history.at(-1)?._id || 0;
            this.onPendingChange(this.pending.length);
            this.onCountChange(this.count);
            this.invalidate();
        }

        setRoomId(roomId) {
            const next = Number(roomId) || 0;
            if (next === this.roomId) return;
            this.roomId = next;
            this.clear();
        }

        invalidate() {
            this.renderedNodes.clear();
            this.rowsEl.textContent = '';
            this.heights = this.history.map(message => this.estimateHeight(message));
            this.dirtyFrom = 0;
            this.offsets = [0];
            this.currentStart = 0;
            this.currentEnd = 0;
            if (this.autoScroll) this.startFollow();
            this.scheduleRender();
        }

        estimateHeight(message) {
            const scale = this.settings.fontSize / BASE_FONT_SIZE;
            const gap = Shared.densityGap(this.settings.density) + 2;
            if (message.type === 'superchat') return Math.round(68 * scale) + gap;
            if (message.sticker) return Math.round(56 * scale) + gap;
            return Math.round(28 * scale) + gap;
        }

        // ---------------- 前缀和与定位 ----------------
        ensureOffsets() {
            const n = this.history.length;
            if (this.dirtyFrom > n) this.dirtyFrom = n;
            for (let i = this.dirtyFrom; i < n; i++) {
                this.offsets[i + 1] = this.offsets[i] + this.heights[i];
            }
            this.offsets.length = n + 1;
            this.dirtyFrom = n;
        }

        getTotalHeight() {
            this.ensureOffsets();
            const contentHeight = this.offsets[this.history.length] || 0;
            return contentHeight > 0 ? contentHeight + LIST_VERTICAL_PADDING : 0;
        }

        findIndexAtOffset(y) {
            const n = this.history.length;
            if (n === 0 || y <= 0) return 0;
            this.ensureOffsets();
            if (y >= this.offsets[n]) return n - 1;
            let lo = 0;
            let hi = n - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (this.offsets[mid] <= y) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        }

        // ---------------- 条目构建 ----------------
        resolveRoomGuard(message) {
            if (message.guardLevel >= 1 && message.guardLevel <= 3) return message.guardLevel;
            if (
                this.roomId
                && message.medalRoom === this.roomId
                && message.medalGuardLevel >= 1
                && message.medalGuardLevel <= 3
            ) {
                return message.medalGuardLevel;
            }
            return 0;
        }

        appendRoomTag(container, message) {
            if (!this.roomTagFor) return;
            const info = this.roomTagFor(message);
            if (!info?.label) return;
            const tag = document.createElement('span');
            tag.className = 'hj-room-tag';
            tag.textContent = info.label;
            tag.title = info.title || info.label;
            if (info.color) tag.style.setProperty('--room-hue', info.color);
            container.appendChild(tag);
        }

        appendTime(container, message) {
            if (!this.settings.showTimestamp) return;
            const time = document.createElement('span');
            time.className = 'hj-time';
            time.textContent = Shared.formatClock(message._at);
            container.appendChild(time);
        }

        buildSuperChatItem(message) {
            const item = document.createElement('div');
            item.className = this.itemClass(message);

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
            this.appendRoomTag(userWrap, message);
            this.appendTime(userWrap, message);
            if (this.settings.showMedal && message.medalName) {
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

        buildNoticeItem(message) {
            const item = document.createElement('div');
            item.className = this.itemClass(message);
            const row = document.createElement('div');
            row.className = 'hj-row hj-notice';
            this.appendRoomTag(row, message);
            this.appendTime(row, message);

            const tag = document.createElement('span');
            tag.className = `hj-tag ${message.type === 'gift' ? 'is-gift' : 'is-enter'}`;
            tag.textContent = message.type === 'gift' ? '礼物' : '进场';
            row.appendChild(tag);

            const text = document.createElement('span');
            text.className = 'hj-text';
            text.textContent = message.text || '';
            row.appendChild(text);

            item.appendChild(row);
            return item;
        }

        // 只有最新入列的一条播放进场动画，滚动时重建的旧节点不重复闪动
        itemClass(message) {
            return message._id === this.latestId ? 'hj-item is-new' : 'hj-item';
        }

        buildItem(message) {
            if (message.type === 'superchat') return this.buildSuperChatItem(message);
            if (message.type === 'gift' || message.type === 'enter') return this.buildNoticeItem(message);

            const item = document.createElement('div');
            item.className = this.itemClass(message);

            const row = document.createElement('div');
            row.className = 'hj-row';

            const roomGuard = this.settings.highlightGuard ? this.resolveRoomGuard(message) : 0;
            if (roomGuard >= 1 && roomGuard <= 3) {
                row.classList.add('is-guard', `guard-${roomGuard}`);
            }

            this.appendRoomTag(row, message);
            this.appendTime(row, message);

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

            if (this.settings.showWealth && message.wealthLevel > 0) {
                row.appendChild(createWealthBadge(message.wealthLevel));
            }

            if (this.settings.showMedal && message.medalName) {
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
                    this.scheduleRender();
                });
                sticker.addEventListener('load', () => this.measureRenderedRows());
                textEl.appendChild(sticker);
            } else {
                this.appendRichText(textEl, message.text, message.emotes);
            }
            row.appendChild(textEl);

            item.appendChild(row);
            return item;
        }

        // 把文本中的表情占位符（如 [热] / [2233娘_疑惑]）替换为表情包图片
        appendRichText(container, text, emotes) {
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
                    this.scheduleRender();
                });
                container.appendChild(img);
                last = regex.lastIndex;
            }
            if (last < text.length) {
                container.appendChild(document.createTextNode(text.slice(last)));
            }
        }

        // ---------------- 渲染 ----------------
        measureRenderedRows() {
            if (!this.history.length || this.currentEnd <= this.currentStart) return false;
            this.ensureOffsets();

            const prevScrollTop = this.viewportEl.scrollTop;
            let firstChanged = -1;
            let deltaAbove = 0;
            let child = this.rowsEl.firstElementChild;

            for (let i = this.currentStart; i < this.currentEnd && child; i++, child = child.nextElementSibling) {
                const h = child.offsetHeight;
                if (h > 0 && h !== this.heights[i]) {
                    if (firstChanged === -1) firstChanged = i;
                    if (this.offsets[i] < prevScrollTop) {
                        deltaAbove += h - this.heights[i];
                    }
                    this.heights[i] = h;
                }
            }

            if (firstChanged === -1) return false;

            this.dirtyFrom = Math.min(this.dirtyFrom, firstChanged);
            this.spacerEl.style.height = `${this.getTotalHeight()}px`;
            this.rowsEl.style.transform = `translateY(${this.offsets[this.currentStart]}px)`;

            if (this.autoScroll) {
                this.startFollow();
            } else if (deltaAbove !== 0) {
                this.setScrollTop(Math.max(0, prevScrollTop + deltaAbove));
            }
            return true;
        }

        renderPass() {
            const total = this.history.length;
            this.spacerEl.style.height = `${this.getTotalHeight()}px`;

            if (total === 0) {
                this.rowsEl.textContent = '';
                this.renderedNodes.clear();
                this.currentStart = 0;
                this.currentEnd = 0;
                return false;
            }

            // 视口尚未布局（隐藏 / 刚创建）时先渲染尾部一小段，等 ResizeObserver 触发后再精确渲染
            const clientHeight = this.viewportEl.clientHeight;
            const scrollTop = this.viewportEl.scrollTop;
            let start;
            let end;
            if (clientHeight <= 0) {
                start = Math.max(0, total - OVERSCAN * 2);
                end = total;
            } else {
                const viewBottom = scrollTop + clientHeight - 1;
                start = Math.max(0, this.findIndexAtOffset(scrollTop) - OVERSCAN);
                end = Math.min(total, this.findIndexAtOffset(viewBottom) + 1 + OVERSCAN);
            }

            this.currentStart = start;
            this.currentEnd = end;

            const nextNodes = new Map();
            for (let i = start; i < end; i++) {
                const msg = this.history[i];
                let el = this.renderedNodes.get(msg._id);
                if (!el) el = this.buildItem(msg);
                nextNodes.set(msg._id, el);
            }

            const retainedNodes = new Set(nextNodes.values());
            // 先移除窗口外节点，避免把仍可见的复用行反复插回 DOM 并重启动画。
            let cursor = this.rowsEl.firstElementChild;
            while (cursor) {
                const next = cursor.nextElementSibling;
                if (!retainedNodes.has(cursor)) cursor.remove();
                cursor = next;
            }

            cursor = this.rowsEl.firstElementChild;
            for (const el of nextNodes.values()) {
                if (cursor === el) {
                    cursor = cursor.nextElementSibling;
                } else {
                    this.rowsEl.insertBefore(el, cursor);
                }
            }
            this.renderedNodes = nextNodes;

            this.rowsEl.style.transform = `translateY(${this.offsets[start]}px)`;
            return this.measureRenderedRows();
        }

        render() {
            this.renderQueued = false;
            if (this.destroyed) return;
            // 首次挂载新行后真实高度可能与预估值不同，补跑几轮直到高度稳定
            for (let i = 0; i < 4; i++) {
                if (!this.renderPass()) break;
            }
        }

        scheduleRender() {
            if (this.renderQueued || this.destroyed) return;
            this.renderQueued = true;
            requestAnimationFrame(() => this.render());
        }

        setScrollTop(value) {
            this.lastProgrammaticTop = value;
            this.viewportEl.scrollTop = value;
        }

        // 贴底必须基于真实 DOM 高度：spacer 的高度只在渲染帧里更新，
        // 同一帧内连续入列多条时 getTotalHeight() 会领先于 DOM，直接用它贴底会被浏览器截断并误判为用户上滚
        scrollToBottom() {
            const totalHeight = this.getTotalHeight();
            this.spacerEl.style.height = `${totalHeight}px`;
            this.setScrollTop(Math.max(0, totalHeight - this.viewportEl.clientHeight));
            this.scheduleRender();
        }

        // 平滑跟随：每帧向底部推进一段距离，新弹幕到来时目标随之更新
        startFollow() {
            if (this.followRaf !== null || this.destroyed || this.paused) return;
            const step = () => {
                this.followRaf = null;
                if (!this.autoScroll || this.paused || this.destroyed) return;
                const totalHeight = this.getTotalHeight();
                if (this.spacerEl.offsetHeight !== totalHeight) {
                    this.spacerEl.style.height = `${totalHeight}px`;
                }
                const target = Math.max(0, totalHeight - this.viewportEl.clientHeight);
                const dist = target - this.viewportEl.scrollTop;
                if (Math.abs(dist) < 0.5) {
                    if (dist !== 0) this.setScrollTop(target);
                    return;
                }
                // 距离超过两屏（如初始加载）直接贴底，仅小步差值走缓动
                if (dist > this.viewportEl.clientHeight * 2) {
                    this.setScrollTop(target);
                    this.scheduleRender();
                    return;
                }
                this.setScrollTop(this.viewportEl.scrollTop + dist * 0.3);
                this.scheduleRender();
                this.followRaf = requestAnimationFrame(step);
            };
            this.followRaf = requestAnimationFrame(step);
        }

        setFollow(enabled) {
            const next = !!enabled;
            if (this.autoScroll === next) return;
            this.autoScroll = next;
            if (next) {
                // 用户主动点「回到最新」时直接贴底，不再缓动
                this.scrollToBottom();
            }
            this.onFollowChange(next);
        }

        // ---------------- 消息 ----------------
        push(message) {
            if (this.destroyed || !Shared.shouldShowMessage(message, { ...this.settings, superchatOnly: false })) return false;
            const entry = { ...message, _id: ++this.nextId, _at: Date.now() };
            const visible = Shared.shouldShowMessage(entry, this.settings);
            if (visible) {
                this.timestamps.push(entry._at);
                if (this.timestamps.length > 4000) this.timestamps.splice(0, this.timestamps.length - 4000);
            }

            if (this.paused) {
                this.sourcePending.push(entry);
                if (this.sourcePending.length > MAX_HISTORY) this.sourcePending.splice(0, this.sourcePending.length - MAX_HISTORY);
                if (visible) this.pending.push(entry);
                const firstId = this.sourcePending[0]._id;
                let excess = 0;
                while (excess < this.pending.length && this.pending[excess]._id < firstId) excess++;
                if (excess) this.pending.splice(0, excess);
                this.onPendingChange(this.pending.length);
                return visible;
            }
            this.append(entry);
            return visible;
        }

        append(entry) {
            this.sourceHistory.push(entry);
            if (this.sourceHistory.length > MAX_HISTORY) {
                this.sourceHistory.splice(0, this.sourceHistory.length - MAX_HISTORY);
                const firstId = this.sourceHistory[0]._id;
                let excess = 0;
                while (excess < this.history.length && this.history[excess]._id < firstId) excess++;
                if (excess) {
                    this.ensureOffsets();
                    const removedHeight = this.offsets[excess];
                    this.history.splice(0, excess);
                    this.heights.splice(0, excess);
                    this.dirtyFrom = 0;
                    if (!this.autoScroll) {
                        this.setScrollTop(Math.max(0, this.viewportEl.scrollTop - removedHeight));
                    }
                    this.scheduleRender();
                    this.onCountChange(this.count);
                }
            }
            if (!Shared.shouldShowMessage(entry, this.settings)) return;
            this.latestId = entry._id;
            const idx = this.history.length;
            const est = this.estimateHeight(entry);
            this.history.push(entry);
            this.heights.push(est);
            if (this.dirtyFrom === idx) {
                this.offsets[idx + 1] = this.offsets[idx] + est;
                this.dirtyFrom = idx + 1;
            }

            if (this.autoScroll) this.startFollow();
            this.scheduleRender();
            this.onCountChange(this.history.length);
        }

        setPaused(paused) {
            const next = !!paused;
            if (this.paused === next) return;
            this.paused = next;
            if (!next) {
                const buffered = this.sourcePending;
                this.pending = [];
                this.sourcePending = [];
                this.onPendingChange(0);
                for (const entry of buffered) this.append(entry);
                if (this.autoScroll) this.startFollow();
            }
        }

        clear() {
            this.history = [];
            this.sourceHistory = [];
            this.heights = [];
            this.offsets = [0];
            this.dirtyFrom = 0;
            this.timestamps = [];
            this.pending = [];
            this.sourcePending = [];
            this.renderedNodes.clear();
            this.rowsEl.textContent = '';
            this.currentStart = 0;
            this.currentEnd = 0;
            this.spacerEl.style.height = '0px';
            this.setScrollTop(0);
            this.onPendingChange(0);
            this.onCountChange(0);
        }

        exportText() {
            const entries = [...this.history, ...this.pending];
            return entries.map((message) => {
                const line = Shared.messageToLine(message);
                const prefix = this.linePrefixFor?.(message);
                return prefix ? `${prefix}${line}` : line;
            }).join('\n');
        }

        rateText(now = Date.now()) {
            return Shared.formatRate(this.timestamps, now);
        }

        get count() {
            return this.history.length + this.pending.length;
        }

        // ---------------- 事件 ----------------
        bindEvents() {
            // 平滑跟随期间的程序化滚动不触发「用户上滚」判定，避免动画自锁
            this.onScroll = () => {
                if (Math.abs(this.viewportEl.scrollTop - this.lastProgrammaticTop) <= 1) {
                    this.scheduleRender();
                    return;
                }
                // 浏览器把程序化贴底截断到 DOM 最大高度时，差值等于尚未渲染的高度，仍视为跟随
                const domMax = Math.max(0, this.spacerEl.offsetHeight - this.viewportEl.clientHeight);
                if (this.autoScroll && Math.abs(this.viewportEl.scrollTop - domMax) <= 1) {
                    this.scheduleRender();
                    return;
                }
                const gap = Math.max(this.spacerEl.offsetHeight, this.getTotalHeight()) - this.viewportEl.scrollTop - this.viewportEl.clientHeight;
                const follow = gap <= AUTO_SCROLL_GAP;
                if (follow !== this.autoScroll) {
                    this.autoScroll = follow;
                    this.onFollowChange(follow);
                }
                if (this.autoScroll) this.startFollow();
                this.scheduleRender();
            };
            this.viewportEl.addEventListener('scroll', this.onScroll);

            this.viewportObserver = new ResizeObserver(() => {
                // 视口尺寸变化后先按当前高度重算可视区间，再决定是否贴底；
                // 否则隐藏期间渲染的少量节点会在新尺寸下被误判为「已到底」而提前停止跟随
                const changed = this.measureRenderedRows();
                if (this.autoScroll && this.viewportEl.clientHeight > 0) this.scrollToBottom();
                this.scheduleRender();
                if (changed) this.scheduleRender();
            });
            this.viewportObserver.observe(this.viewportEl);

            this.rowsObserver = new ResizeObserver(() => {
                if (this.measureRenderedRows()) this.scheduleRender();
            });
            this.rowsObserver.observe(this.rowsEl);

            // 视口从隐藏变为可见时 ResizeObserver 不一定触发（尺寸未变），用可见性检查兜底
            this.wasVisible = this.viewportEl.clientHeight > 0;
            this.visibilityTimer = setInterval(() => {
                if (this.destroyed || !this.viewportEl.isConnected) return;
                const visible = this.viewportEl.clientHeight > 0 && this.viewportEl.clientWidth > 0;
                if (visible && !this.wasVisible) {
                    if (this.autoScroll) this.scrollToBottom();
                    this.scheduleRender();
                }
                this.wasVisible = visible;
            }, 200);
        }

        destroy() {
            this.destroyed = true;
            if (this.followRaf !== null) cancelAnimationFrame(this.followRaf);
            this.followRaf = null;
            this.viewportEl.removeEventListener('scroll', this.onScroll);
            this.viewportObserver?.disconnect();
            this.rowsObserver?.disconnect();
            clearInterval(this.visibilityTimer);
            this.renderedNodes.clear();
            this.spacerEl.remove();
        }
    }

    DanmakujiList.MAX_HISTORY = MAX_HISTORY;
    global.DanmakujiList = DanmakujiList;
    if (typeof module !== 'undefined' && module.exports) module.exports = DanmakujiList;
})(typeof window !== 'undefined' ? window : globalThis);