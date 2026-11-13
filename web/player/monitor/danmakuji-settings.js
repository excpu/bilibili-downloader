// 弹幕姬显示设置面板：独立窗口与多房间控制台共用同一套控件与取值。
// 所有控件即时生效，不做「保存」按钮；sync 只更新值，避免打断正在输入的焦点。
(function (global) {
    const Shared = global.DanmakujiShared;

    const TOGGLES = [
        { key: 'showMedal', label: '粉丝勋章', hint: '显示用户名前的粉丝勋章胶囊' },
        { key: 'showWealth', label: '荣耀等级', hint: '显示荣耀等级徽章' },
        { key: 'showSuperchat', label: '醒目留言', hint: '显示 SC 卡片' },
        { key: 'showEnter', label: '进场消息', hint: '显示「xxx 进入直播间」' },
        { key: 'showGift', label: '礼物消息', hint: '显示赠送礼物提示' },
        { key: 'showTimestamp', label: '时间戳', hint: '每条弹幕前显示接收时间' },
        { key: 'highlightGuard', label: '大航海高亮', hint: '总督 / 提督 / 舰长弹幕使用色卡' },
        { key: 'autoScroll', label: '自动跟随', hint: '新弹幕到来时自动滚到底部' },
    ];

    const DENSITIES = [
        { value: 'compact', label: '紧凑' },
        { value: 'normal', label: '标准' },
        { value: 'loose', label: '宽松' },
    ];

    const COLUMNS = [
        { value: 'auto', label: '自动' },
        { value: '1', label: '1 栏' },
        { value: '2', label: '2 栏' },
        { value: '3', label: '3 栏' },
        { value: '4', label: '4 栏' },
    ];

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function buildRow(labelText, control, hint) {
        const row = el('div', 'dms-row');
        const label = el('span', 'dms-label', labelText);
        if (hint) label.title = hint;
        row.appendChild(label);
        row.appendChild(control);
        return row;
    }

    function buildSwitch(key, label, hint) {
        const wrap = el('label', 'dms-switch');
        wrap.title = hint || '';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.setting = key;
        const track = el('span', 'dms-switch-track');
        track.appendChild(el('span', 'dms-switch-thumb'));
        wrap.appendChild(input);
        wrap.appendChild(track);
        wrap.appendChild(el('span', 'dms-switch-label', label));
        return wrap;
    }

    function buildSegment(key, values) {
        const group = el('div', 'dms-segment');
        group.dataset.setting = key;
        group.setAttribute('role', 'group');
        for (const item of values) {
            const button = el('button', 'dms-segment-btn', item.label);
            button.type = 'button';
            button.dataset.value = item.value;
            group.appendChild(button);
        }
        return group;
    }

    function mount(container, initial, options = {}) {
        const settings = Shared.normalizeSettings(initial);
        const onChange = options.onChange || (() => { });
        const showColumns = options.showColumns !== false;
        let current = { ...settings };
        let textTimer = null;

        container.textContent = '';
        container.classList.add('dms');

        const emit = (patch) => {
            current = Shared.normalizeSettings({ ...current, ...patch });
            onChange(current);
        };

        // ---- 字号 ----
        const fontWrap = el('div', 'dms-slider');
        const fontInput = document.createElement('input');
        fontInput.type = 'range';
        fontInput.min = String(Shared.FONT_SIZE_MIN);
        fontInput.max = String(Shared.FONT_SIZE_MAX);
        fontInput.step = '1';
        fontInput.dataset.setting = 'fontSize';
        const fontValue = el('span', 'dms-slider-value');
        fontValue.dataset.readout = 'fontSize';
        fontWrap.appendChild(fontInput);
        fontWrap.appendChild(fontValue);
        container.appendChild(buildRow('字号', fontWrap, '弹幕正文字号，徽章与表情按比例缩放'));

        // ---- 行距 ----
        container.appendChild(buildRow('行距', buildSegment('density', DENSITIES), '弹幕之间的垂直间距'));

        // ---- 分栏 ----
        if (showColumns) {
            container.appendChild(buildRow('分栏', buildSegment('columns', COLUMNS), '分栏模式下每行显示的直播间数量'));
        }

        // ---- 显示开关 ----
        const toggleBlock = el('div', 'dms-toggles');
        for (const item of TOGGLES) {
            toggleBlock.appendChild(buildSwitch(item.key, item.label, item.hint));
        }
        container.appendChild(toggleBlock);

        // ---- 过滤 ----
        const filterBlock = el('div', 'dms-filters');

        const onlySc = buildSwitch('superchatOnly', '只看醒目留言', '临时隐藏非 SC 消息，关闭后恢复最近缓存的消息');
        onlySc.classList.add('dms-switch-wide');
        filterBlock.appendChild(onlySc);

        const keywordInput = document.createElement('input');
        keywordInput.type = 'search';
        keywordInput.className = 'dms-input';
        keywordInput.placeholder = '只看包含…（用户名或内容）';
        keywordInput.dataset.setting = 'keyword';
        keywordInput.autocomplete = 'off';
        filterBlock.appendChild(buildRow('关键词', keywordInput, '只保留包含该词的弹幕，留空表示不过滤'));

        const blockedInput = document.createElement('input');
        blockedInput.type = 'search';
        blockedInput.className = 'dms-input';
        blockedInput.placeholder = '屏蔽词，用空格或逗号分隔';
        blockedInput.dataset.setting = 'blocked';
        blockedInput.autocomplete = 'off';
        filterBlock.appendChild(buildRow('屏蔽词', blockedInput, '命中任意一个词的弹幕会被丢弃'));

        filterBlock.appendChild(el('p', 'dms-hint', '过滤条件修改后会立即清理列表中不匹配的弹幕。'));
        container.appendChild(filterBlock);

        // ---- 重置 ----
        if (options.showReset !== false) {
            const resetBtn = el('button', 'dms-reset', '恢复默认显示');
            resetBtn.type = 'button';
            resetBtn.addEventListener('click', () => {
                current = Shared.normalizeSettings(null);
                sync(container, current);
                onChange(current);
            });
            container.appendChild(resetBtn);
        }

        // ---- 事件 ----
        container.addEventListener('input', (event) => {
            const target = event.target;
            const key = target?.dataset?.setting;
            if (!key) return;
            if (target.type === 'range') {
                emit({ [key]: Number(target.value) });
                fontValue.textContent = `${current.fontSize}px`;
                return;
            }
            if (target.type === 'checkbox') {
                emit({ [key]: target.checked });
                return;
            }
            clearTimeout(textTimer);
            const value = target.value;
            textTimer = setTimeout(() => emit({ [key]: value }), 160);
        });

        container.addEventListener('click', (event) => {
            const button = event.target.closest?.('.dms-segment-btn');
            if (!button) return;
            const group = button.parentElement;
            const key = group.dataset.setting;
            const raw = button.dataset.value;
            const value = key === 'columns' && raw !== 'auto' ? Number(raw) : raw;
            emit({ [key]: value });
            sync(container, current);
        });

        sync(container, current);
        return { sync: () => sync(container, current) };
    }

    function sync(container, settings) {
        const values = Shared.normalizeSettings(settings);
        container.querySelectorAll('[data-setting]').forEach((node) => {
            const key = node.dataset.setting;
            if (!(key in values)) return;
            if (node.classList.contains('dms-segment')) {
                node.querySelectorAll('.dms-segment-btn').forEach((button) => {
                    button.classList.toggle('is-active', button.dataset.value === String(values[key]));
                });
                return;
            }
            if (node.type === 'checkbox') {
                node.checked = !!values[key];
                return;
            }
            // 正在输入的文本框不回填，否则光标会跳到末尾
            if (node === document.activeElement && node.type !== 'range') return;
            node.value = String(values[key]);
        });
        const readout = container.querySelector('[data-readout="fontSize"]');
        if (readout) readout.textContent = `${values.fontSize}px`;
    }

    global.DanmakujiSettingsPanel = { mount, sync, TOGGLES };
    if (typeof module !== 'undefined' && module.exports) module.exports = { mount, sync, TOGGLES };
})(typeof window !== 'undefined' ? window : globalThis);