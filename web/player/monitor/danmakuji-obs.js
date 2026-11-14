// 弹幕姬 · OBS 透明背景页面：通过 SSE 接收主进程转发的直播弹幕与控制台实时设置
(function () {
    const Shared = window.DanmakujiShared;
    const DanmakujiList = window.DanmakujiList;
    const viewportEl = document.getElementById('obsViewport');
    const ROOM_HUES = 8;

    const params = new URLSearchParams(window.location.search);
    const singleRoom = Number(params.get('room'));
    const roomsParam = params.get('rooms') || '';
    const explicitTheme = params.get('theme');
    const hasFixedTheme = explicitTheme === 'dark' || explicitTheme === 'light';

    let mode = Number.isInteger(singleRoom) && singleRoom > 0
        ? 'single'
        : (roomsParam.trim() ? 'multi' : 'follow');
    let activeRooms = [];
    let showRoomTag = mode === 'multi';
    let pausedForAutoScroll = false;

    function applyTheme(theme) {
        const resolved = hasFixedTheme ? explicitTheme : (theme === 'light' ? 'light' : 'dark');
        document.documentElement.dataset.theme = resolved;
    }

    function roomLabel(room) {
        return room.anchorName || room.title || `#${room.roomId}`;
    }

    function roomTagFor(message) {
        if (!showRoomTag) return null;
        const index = activeRooms.findIndex(item => item.roomId === message?._roomId);
        if (index < 0) return null;
        const room = activeRooms[index];
        return {
            label: roomLabel(room),
            title: `${room.title || ''} · #${room.roomId}`,
            color: `var(--room-${(index % ROOM_HUES) + 1})`,
        };
    }

    const list = new DanmakujiList({
        viewport: viewportEl,
        roomId: mode === 'single' ? singleRoom : 0,
        settings: Shared.normalizeSettings(null),
        roomTagFor,
    });

    function updateRooms(nextRooms) {
        activeRooms = Array.isArray(nextRooms) ? nextRooms.slice() : [];
        const nextShowTag = mode === 'multi' || (mode === 'follow' && activeRooms.length > 1);
        const tagVisibilityChanged = nextShowTag !== showRoomTag;
        showRoomTag = nextShowTag;

        if (mode === 'single') {
            const target = activeRooms[0];
            document.title = target ? `${roomLabel(target)} · OBS 弹幕` : `直播间 ${singleRoom} · OBS 弹幕`;
        } else if (activeRooms.length > 0) {
            document.title = `${activeRooms.map(roomLabel).join(' / ')} · OBS 弹幕`;
        } else {
            document.title = '弹幕姬 · OBS 透明弹幕';
        }

        if (tagVisibilityChanged || showRoomTag) {
            list.invalidate();
        }
    }

    function buildEventUrl() {
        const query = new URLSearchParams();
        if (mode === 'single') {
            query.set('room', String(singleRoom));
        } else if (mode === 'multi') {
            query.set('rooms', roomsParam);
        }
        if (hasFixedTheme) {
            query.set('theme', explicitTheme);
        }
        const qs = query.toString();
        return qs ? `/events?${qs}` : '/events';
    }

    function applyServerSettings(raw) {
        const normalized = Shared.normalizeSettings(raw);
        list.setSettings(normalized);
        // OBS 覆层不显示「回到最新」按钮，保持跟随设定即可
        if (normalized.autoScroll && !pausedForAutoScroll) {
            list.setFollow(true);
        }
    }

    applyTheme(hasFixedTheme ? explicitTheme : 'dark');

    const source = new EventSource(buildEventUrl());

    source.addEventListener('init', (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            if (payload.mode) mode = payload.mode;
            if (payload.theme) applyTheme(payload.theme);
            if (payload.settings) applyServerSettings(payload.settings);
            if (Array.isArray(payload.rooms)) updateRooms(payload.rooms);
        } catch (error) {
            console.warn('解析 OBS 初始化数据失败:', error);
        }
    });

    source.addEventListener('message', (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            const roomId = Number(payload.roomId);
            const message = payload.message;
            if (!message || message.type === 'live_status') return;
            if (mode === 'follow' && activeRooms.length > 0 && !activeRooms.some(r => r.roomId === roomId)) {
                return;
            }
            list.push({ ...message, _roomId: roomId });
        } catch (error) {
            console.warn('解析 OBS 弹幕消息失败:', error);
        }
    });

    source.addEventListener('settings', (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            if (payload.settings) applyServerSettings(payload.settings);
        } catch (error) {
            console.warn('解析 OBS 设置更新失败:', error);
        }
    });

    source.addEventListener('theme', (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            if (payload.theme) applyTheme(payload.theme);
        } catch (error) {
            console.warn('解析 OBS 主题更新失败:', error);
        }
    });

    source.addEventListener('rooms', (event) => {
        try {
            const payload = JSON.parse(event.data || '{}');
            if (Array.isArray(payload.rooms)) updateRooms(payload.rooms);
        } catch (error) {
            console.warn('解析 OBS 房间更新失败:', error);
        }
    });

    window.addEventListener('beforeunload', () => {
        pausedForAutoScroll = true;
        source.close();
    });
})();
