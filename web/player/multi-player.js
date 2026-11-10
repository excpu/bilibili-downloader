const form = document.getElementById('form');
const input = document.getElementById('input');
const submit = document.getElementById('submit');
const title = document.getElementById('title');
const stage = document.getElementById('stage');
const placeholder = document.getElementById('placeholder');
const placeholderText = document.getElementById('placeholderText');
const spinner = document.getElementById('spinner');
const playButton = document.getElementById('play');
const seek = document.getElementById('seek');
const current = document.getElementById('current');
const duration = document.getElementById('duration');
const partLabel = document.getElementById('part');
const status = document.getElementById('status');
const volume = document.getElementById('volume');
const muteButton = document.getElementById('mute');
const danmakuLayer = document.getElementById('danmaku');
const showDanmaku = document.getElementById('showDanmaku');
const partList = document.getElementById('partList');

const slots = Array.from(stage.querySelectorAll('video'), video => ({
    video, audio: new Audio(), index: -1, token: 0, promise: null, danmaku: [], controller: null,
}));
let timeline = null;
let active = null;
let operation = 0;
let request = 0;
let seeking = false;          // 用户正在拖动进度条
let dragging = false;
let seekPending = false;      // 已提交跳转，但媒体元素尚未真正 seek 到目标位置
let seekPendingOffset = 0;    // 该次跳转在目标分P内的偏移
let desiredPlaying = false;
let switching = false;
let starting = false;
let prefetchedIndex = -1;
let lastVolume = 0.8;
// 分P衔接：{ prev, next, duration }，next 已在本帧前预起播，边界处只做可见性与音频交接
let seam = null;

function message(text) {
    status.textContent = text;
}

// range 控件的已填充部分靠 --fill 自定义属性驱动（CSS 里用 linear-gradient 画进度）
function updateFill(range, value, max) {
    const percent = max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : 0;
    range.style.setProperty('--fill', `${percent}%`);
}

// 播放/暂停按钮用字形切换，配 title 提示
function setPlayLabel(playing) {
    playButton.textContent = playing ? '❚❚' : '▶';
    playButton.title = playing ? '暂停' : '播放';
}

// 分P跳转列表：每个分P一枚胶囊，点击跳到该P起点，当前P高亮
function renderPartList() {
    partList.replaceChildren(...timeline.parts.map((part, index) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'part-chip';
        chip.dataset.index = String(index);
        chip.title = part.title;
        chip.textContent = `P${index + 1}`;
        const time = document.createElement('span');
        time.className = 'chip-time';
        time.textContent = formatTime(part.duration);
        chip.appendChild(time);
        return chip;
    }));
}

function updatePartListHighlight() {
    if (!timeline) return;
    for (const chip of partList.children) {
        chip.classList.toggle('current', Number(chip.dataset.index) === (active ? active.index : -1));
    }
}

function formatTime(seconds) {
    const n = Math.floor(Math.max(0, seconds));
    const h = Math.floor(n / 3600);
    const m = Math.floor(n / 60) % 60;
    const s = n % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function locate(time) {
    const parts = timeline.parts;
    const bounded = Math.max(0, Math.min(time, timeline.duration));
    let index = parts.length - 1;
    for (let i = 0; i < parts.length - 1; i++) {
        if (bounded < parts[i + 1].start) { index = i; break; }
    }
    return { index, offset: bounded - parts[index].start };
}

function parseDanmaku(xml) {
    const documentXml = new DOMParser().parseFromString(xml, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('弹幕数据格式错误');
    return Array.from(documentXml.querySelectorAll('d')).map(node => {
        const fields = (node.getAttribute('p') || '').split(',');
        return { time: Number(fields[0]), mode: Number(fields[1]), size: Number(fields[2]), color: Number(fields[3]), text: node.textContent, lane: -1, width: 0 };
    }).filter(item => Number.isFinite(item.time) && item.time >= 0 && [1, 2, 3, 4, 5].includes(item.mode) && item.text)
        .sort((a, b) => a.time - b.time);
}

function ready(media, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('缓冲已取消')); return; }
        if (media.readyState >= 3) { resolve(); return; }
        const timer = setTimeout(() => finish(new Error('媒体缓冲超时，请重试')), 30000);
        function finish(error) {
            clearTimeout(timer);
            media.removeEventListener('canplay', onReady);
            media.removeEventListener('error', onError);
            signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve();
        }
        function onReady() { finish(); }
        function onError() { finish(new Error('媒体加载失败，请检查网络或视频权限')); }
        function onAbort() { finish(new Error('缓冲已取消')); }
        media.addEventListener('canplay', onReady, { once: true });
        media.addEventListener('error', onError, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function waitForSeek(media, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('跳转已取消')); return; }
        if (!media.seeking) { resolve(); return; }
        const timer = setTimeout(() => finish(new Error('媒体跳转超时，请重试')), 30000);
        function finish(error) {
            clearTimeout(timer);
            media.removeEventListener('seeked', onSeeked);
            media.removeEventListener('error', onError);
            signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve();
        }
        function onSeeked() { if (!media.seeking) finish(); }
        function onError() { finish(new Error('媒体跳转失败')); }
        function onAbort() { finish(new Error('跳转已取消')); }
        media.addEventListener('seeked', onSeeked);
        media.addEventListener('error', onError, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function clearSlot(slot) {
    slot.token++;
    if (slot.controller) slot.controller.abort();
    slot.controller = null;
    slot.video.pause();
    slot.audio.pause();
    slot.video.removeAttribute('src');
    slot.audio.removeAttribute('src');
    slot.video.load();
    slot.audio.load();
    slot.index = -1;
    slot.promise = null;
    slot.danmaku = [];
}

function prepare(slot, index) {
    if (slot.index === index && slot.promise) return slot.promise;
    clearSlot(slot);
    slot.index = index;
    slot.controller = new AbortController();
    const signal = slot.controller.signal;
    const token = slot.token;
    const video = timeline.parts[index];
    const bvid = timeline.bvid;
    slot.promise = (async () => {
        const dash = await window.electronAPI.invoke('getPreviewDash', { bvid, cid: video.cid });
        if (slot.token !== token) return;
        if (!dash.success || !dash.data?.defaultVideo?.url || !dash.data.defaultAudioUrl) {
            throw new Error(dash.message || `P${index + 1} 没有可播放的音视频流`);
        }
        slot.video.src = dash.data.defaultVideo.url;
        slot.video.muted = true;
        slot.audio.preload = 'auto';
        slot.audio.volume = Number(volume.value);
        slot.audio.muted = muted;
        slot.audio.src = dash.data.defaultAudioUrl;
        slot.video.load();
        slot.audio.load();
        await Promise.all([ready(slot.video, signal), ready(slot.audio, signal)]);
    })().catch(error => {
        if (slot.token !== token) return;
        slot.promise = null;
        throw error;
    });
    window.electronAPI.invoke('getPreviewDanmu', { cid: video.cid }).then(result => {
        if (slot.token !== token) return;
        if (!result.success) throw new Error(result.message || '获取弹幕失败');
        slot.danmaku = parseDanmaku(result.data);
    }).catch(error => {
        if (slot.token === token) message(`P${index + 1} 弹幕加载失败：${error.message}`);
    });
    return slot.promise;
}

async function switchTo(time, shouldPlay) {
    if (!timeline) return;
    const target = locate(time);
    const serial = ++operation;
    cancelSeam();
    desiredPlaying = shouldPlay;
    switching = true;
    starting = false;
    spinner.hidden = false;
    let slot = slots.find(item => item.index === target.index);
    if (!slot) slot = slots.find(item => item !== active);
    // 浏览器完成 seek 前 video.currentTime 仍是旧值，若此时刷新进度条就会「回跳」。
    // 先把进度条钉在用户选择的位置，等到 seeked 事件到来再恢复跟随真实播放位置。
    const samePosition = active === slot && !slot.video.seeking && !slot.audio.seeking
        && Math.abs(slot.video.currentTime - target.offset) < 0.05;
    seekPending = !samePosition;
    seekPendingOffset = target.offset;
    if (slot === active) {
        seek.value = time;
        current.textContent = formatTime(time);
    }
    if (samePosition) seeking = false;
    if (active) { active.video.pause(); active.audio.pause(); }
    message('');
    try {
        await prepare(slot, target.index);
        if (serial !== operation) return;
        await Promise.all([ready(slot.video, slot.controller.signal), ready(slot.audio, slot.controller.signal)]);
        if (serial !== operation) return;
        if (active && active !== slot) active.video.classList.remove('active');
        active = slot;
        prefetchedIndex = -1;
        slot.video.classList.add('active');
        placeholder.hidden = true;
        if (!samePosition) {
            slot.video.currentTime = target.offset;
            slot.audio.currentTime = target.offset;
        }
        partLabel.textContent = `P${target.index + 1}/${timeline.parts.length} · ${timeline.parts[target.index].title}`;
        playButton.disabled = false;
        seek.disabled = false;
        updatePartListHighlight();
        // 跨分P跳转时上面的钉住逻辑发生在旧 active 上，切换完成后补一次
        if (!dragging) {
            seek.value = time;
            current.textContent = formatTime(time);
            updateFill(seek, time, timeline.duration);
        }
        if (!samePosition) {
            await Promise.all([waitForSeek(slot.video, slot.controller.signal), waitForSeek(slot.audio, slot.controller.signal)]);
            if (serial !== operation) return;
        }
        switching = false;
        if (desiredPlaying) await startMedia(slot, serial);
        else { spinner.hidden = true; setPlayLabel(false); }
        if (serial !== operation) return;
        prefetchNext(slot);
    } catch (error) {
        if (serial === operation) {
            switching = false;
            seekPending = false;
            seeking = false;
            desiredPlaying = false;
            spinner.hidden = true;
            setPlayLabel(false);
            message(`播放失败：${error.message}`);
        }
    }
}

// 分P边界前 SEAM_LEAD_SECONDS 秒把下一P「隐藏预起播」：画面不显示、音频静音，
// 但解码器、渲染管线和播放时钟都已就位，并被钉在下一P开头附近。
// 到边界时交换可见性与音频归属，并将下一P调整到开头。
const SEAM_LEAD_SECONDS = 3;
// 下一P被「钉」在起点：隐藏播放超出 SEAM_HOLD_SECONDS 就回绕到 0（回绕发生在不可见的槽位上，
// 使其尽量保持在开头附近，减少交接时的等待）。
const SEAM_HOLD_SECONDS = 0.06;
const SEAM_CUT_SECONDS = 0.02;   // 提前交接的量：既不会停在最后一帧，最多也只跳过上一P约 1 帧

async function startSeam(prev, next) {
    if (seam && seam.next === next) return;
    seam = { prev, next, prevDuration: timeline.parts[prev.index].duration };
    try {
        await next.promise;
    } catch {
        if (seam && seam.next === next) seam = null;
        return;
    }
    // 等待缓冲期间状态可能已变（用户 seek / 暂停 / 又切换），此时放弃这次预起播
    if (!seam || seam.next !== next || prev !== active || !desiredPlaying || switching) {
        if (seam && seam.next === next) seam = null;
        return;
    }
    next.audio.muted = true;
    try {
        await Promise.all([next.video.play(), next.audio.play()]);
    } catch {
        if (seam && seam.next === next) seam = null;
        next.video.pause();
        next.audio.pause();
    }
}

function completeSeam() {
    if (!seam) return;
    const { prev, next } = seam;
    seam = null;
    if (prev !== active) return;
    next.audio.muted = muted;
    next.audio.volume = Number(volume.value);
    // 回到开头以保留片头；浏览器仍可能需要异步完成这次 seek。
    if (next.video.currentTime > 0.001) next.video.currentTime = 0;
    if (Math.abs(next.audio.currentTime - next.video.currentTime) > 0.005) next.audio.currentTime = next.video.currentTime;
    active = next;
    prefetchedIndex = -1;
    next.video.classList.add('active');
    prev.video.classList.remove('active');
    clearSlot(prev);
    partLabel.textContent = `P${next.index + 1}/${timeline.parts.length} · ${timeline.parts[next.index].title}`;
    updatePartListHighlight();
    spinner.hidden = true;
    setPlayLabel(desiredPlaying);
    updateProgress();
    // 极短的分P可能在预起播期间就已经播完，此时继续往后衔接
    if (next.video.ended && desiredPlaying && next.index + 1 < timeline.parts.length) {
        switchTo(timeline.parts[next.index + 1].start, true);
        return;
    }
    prefetchNext(next);
}

// 放弃预起播：只把下一P停回待命状态并保留已缓冲内容，
// 后续走常规切换时可以直接复用，不必重新取流。
function cancelSeam() {
    if (!seam) return;
    const { next } = seam;
    seam = null;
    next.audio.muted = muted;
    next.video.pause();
    next.audio.pause();
    prefetchedIndex = -1;   // 允许恢复播放后重新预取下一P
}

// 在渲染帧和 timeupdate 中维护隐藏播放位置，并检查分P边界。
function tickSeam() {
    if (!timeline || !active || !desiredPlaying || switching) return;
    if (!seam) {
        const index = active.index;
        if (index + 1 < timeline.parts.length && active.video.currentTime >= timeline.parts[index].duration) {
            switchTo(timeline.parts[index + 1].start, true);
        }
        return;
    }
    const { prev, next } = seam;
    if (prev !== active || !desiredPlaying || switching) { cancelSeam(); return; }
    if (next.video.currentTime > SEAM_HOLD_SECONDS) {
        next.video.currentTime = 0;
        next.audio.currentTime = 0;
    }
    // API 报告时长与媒体实际时长可能有零点几秒出入，取两者中更早到头的作为边界
    const mediaDuration = Number.isFinite(prev.video.duration) && prev.video.duration > 0
        ? prev.video.duration : seam.prevDuration;
    const remaining = Math.min(seam.prevDuration, mediaDuration) - prev.video.currentTime;
    if (!(prev.video.ended || remaining <= SEAM_CUT_SECONDS)) return;
    // 未就绪时在边界暂停并等待缓冲，不依赖原媒体的 ended。
    if (next.video.readyState < 2 || next.video.paused || next.audio.readyState < 2 || next.audio.paused) {
        const nextStart = timeline.parts[next.index].start;
        cancelSeam();
        switchTo(nextStart, true);
        return;
    }
    completeSeam();
}

function prefetchNext(slot) {
    if (!timeline || slot !== active || switching || seam) return;
    const next = slot.index + 1;
    if (next >= timeline.parts.length) return;
    const spare = slots.find(item => item !== slot);
    const remaining = timeline.parts[slot.index].duration - slot.video.currentTime;
    if (prefetchedIndex !== next) {
        if (remaining > 60) return;
        prefetchedIndex = next;
        prepare(spare, next).catch(error => {
            if (active === slot && spare.index === next) message(`P${next + 1} 预缓冲失败：${error.message}；切换时将重试`);
        });
    }
    if (spare.index === next && spare.promise && remaining <= SEAM_LEAD_SECONDS && desiredPlaying) {
        startSeam(slot, spare);
    }
}

async function startMedia(slot, serial) {
    starting = true;
    try {
        await Promise.all([slot.video.play(), slot.audio.play()]);
        if (serial !== operation) return;
        starting = false;
        if (slot !== active || !desiredPlaying) {
            slot.video.pause();
            slot.audio.pause();
            return;
        }
        if (!seekPending && Math.abs(slot.audio.currentTime - slot.video.currentTime) > 0.2) {
            slot.audio.currentTime = slot.video.currentTime;
        }
        spinner.hidden = true;
        setPlayLabel(true);
    } catch (error) {
        if (serial !== operation) return;
        starting = false;
        slot.video.pause();
        slot.audio.pause();
        throw new Error(`无法开始播放：${error.message}`);
    }
}

function updateProgress() {
    // 拖动中或 seek 未完成时，video.currentTime 还停留在旧位置，直接回写进度条就会「回跳」
    if (!active || !timeline || seeking || seekPending || switching) return;
    // 交接检查最多隔一个 timeupdate 周期才生效，媒体实际时长又常比 API 报的分P时长长，
    // 这里按分P时长钳制，进度条才不会越过边界再回跳
    const offset = Math.min(active.video.currentTime, timeline.parts[active.index].duration);
    const time = Math.min(timeline.duration, timeline.parts[active.index].start + offset);
    seek.value = time;
    current.textContent = formatTime(time);
    updateFill(seek, time, timeline.duration);
}

function failPlayback(slot, text) {
    if (slot !== active) return;
    desiredPlaying = false;
    seekPending = false;
    seeking = false;
    slot.video.pause();
    slot.audio.pause();
    spinner.hidden = true;
    setPlayLabel(false);
    message(text);
}

for (const slot of slots) {
    slot.video.addEventListener('seeked', () => {
        if (slot !== active) return;
        if (seekPending && !dragging && !slot.video.seeking && Math.abs(slot.video.currentTime - seekPendingOffset) < 0.5) {
            seekPending = false;
            seeking = false;
            updateProgress();
        }
    });
    slot.video.addEventListener('timeupdate', () => {
        if (slot !== active) return;
        // seeked 事件在部分情况下不会触发（如目标位置与当前位置相同），用 timeupdate 兜底解除钉住
        if (seekPending && !dragging && !slot.video.seeking && Math.abs(slot.video.currentTime - seekPendingOffset) < 0.5) {
            seekPending = false;
            seeking = false;
        }
        updateProgress();
        if (!seekPending && !switching && !slot.video.seeking && Math.abs(slot.audio.currentTime - slot.video.currentTime) > 0.2) slot.audio.currentTime = slot.video.currentTime;
        // 窗口被遮挡时 requestAnimationFrame 会被节流甚至暂停，
        // 衔接检查必须同时挂在 timeupdate 上，否则切走窗口会导致交接严重滞后
        tickSeam();
        prefetchNext(slot);
    });
    slot.video.addEventListener('waiting', () => {
        if (slot === active && !switching && !starting) { slot.audio.pause(); spinner.hidden = false; }
    });
    slot.video.addEventListener('playing', () => {
        if (slot === active) spinner.hidden = true;
        if (slot === active && desiredPlaying && !switching && !starting && !seekPending && slot.audio.paused) {
            slot.audio.currentTime = slot.video.currentTime;
            slot.audio.play().catch(error => failPlayback(slot, `音频播放失败：${error.message}`));
        }
    });
    slot.audio.addEventListener('waiting', () => {
        if (slot === active && desiredPlaying && !switching && !starting && !seekPending) { slot.video.pause(); spinner.hidden = false; }
    });
    slot.audio.addEventListener('canplay', () => {
        if (slot === active && desiredPlaying && !switching && !starting && !seekPending && slot.video.paused && !slot.video.ended) {
            slot.video.play().catch(error => failPlayback(slot, `视频播放失败：${error.message}`));
        }
    });
    slot.video.addEventListener('ended', () => {
        if (slot !== active) return;
        if (slot.index + 1 < timeline.parts.length) {
            tickSeam();
            if (slot === active && !switching) switchTo(timeline.parts[slot.index + 1].start, true);
        }
        else { desiredPlaying = false; slot.audio.pause(); setPlayLabel(false); updateProgress(); }
    });
    for (const media of [slot.video, slot.audio]) {
        media.addEventListener('error', () => {
            if (slot === active && media.error) failPlayback(slot, `P${slot.index + 1} 播放出错（${media.error.code}）：${media.error.message || '媒体不可用'}`);
        });
    }
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    const serial = ++request;
    ++operation;
    desiredPlaying = false;
    switching = false;
    starting = false;
    seeking = false;
    dragging = false;
    seekPending = false;
    cancelSeam();
    for (const slot of slots) { clearSlot(slot); slot.video.classList.remove('active'); }
    active = null;
    timeline = null;
    prefetchedIndex = -1;
    spinner.hidden = true;
    playButton.disabled = true;
    seek.disabled = true;
    setPlayLabel(false);
    placeholder.hidden = false;
    placeholderText.textContent = '正在解析视频…';
    title.textContent = '';
    partLabel.textContent = '';
    partList.replaceChildren();
    submit.disabled = true;
    message('');
    try {
        const result = await window.electronAPI.invoke('resolveMultiPartVideo', input.value);
        if (serial !== request) return;
        if (!result.success) throw new Error(result.message);
        timeline = result.data;
        title.textContent = timeline.title;
        duration.textContent = formatTime(timeline.duration);
        seek.max = timeline.duration;
        seek.value = 0;
        current.textContent = '00:00';
        updateFill(seek, 0, timeline.duration);
        placeholderText.textContent = '正在缓冲…';
        renderPartList();
        await switchTo(0, true);
    } catch (error) {
        if (serial === request) { placeholderText.textContent = '无法加载视频'; message(error.message); }
    } finally {
        if (serial === request) submit.disabled = false;
    }
});

playButton.addEventListener('click', () => {
    if (!active) return;
    if (desiredPlaying) {
        desiredPlaying = false;
        ++operation;
        switching = false;
        starting = false;
        spinner.hidden = true;
        cancelSeam();
        active.video.pause();
        active.audio.pause();
        setPlayLabel(false);
    } else {
        const position = timeline.parts[active.index].start + active.video.currentTime;
        switchTo(position >= timeline.duration ? 0 : position, true);
    }
});
seek.addEventListener('input', () => {
    dragging = true;
    seeking = true;
    current.textContent = formatTime(Number(seek.value));
    updateFill(seek, Number(seek.value), timeline ? timeline.duration : 0);
});
seek.addEventListener('change', () => { dragging = false; switchTo(Number(seek.value), desiredPlaying); });

// 音量与静音：静音只改 audio.muted，滑条保留用户设置的音量值
let muted = false;
function applyVolume() {
    const value = Number(volume.value);
    if (value > 0) lastVolume = value;
    for (const slot of slots) {
        // 衔接中隐藏预起播的槽位要保持静音，否则用户调音量会提前听到下一P
        if (seam && seam.next === slot) continue;
        slot.audio.volume = value;
        slot.audio.muted = muted;
    }
    updateFill(volume, muted ? 0 : value, 1);
    muteButton.textContent = muted || value === 0 ? '🔇' : value < 0.5 ? '🔈' : '🔊';
}
volume.addEventListener('input', applyVolume);
muteButton.addEventListener('click', () => {
    muted = !muted;
    if (!muted && Number(volume.value) === 0) {
        volume.value = String(lastVolume);
    }
    applyVolume();
});

// 分P胶囊：点击跳到该P起点，并保持当前播放/暂停状态
partList.addEventListener('click', event => {
    const chip = event.target.closest('.part-chip');
    if (!chip || !timeline) return;
    switchTo(timeline.parts[Number(chip.dataset.index)].start, desiredPlaying);
});

// 全屏：画面铺满窗口，控制栏变成浮层，闲置几秒后自动收起（暂停时保持可见）
const playerElement = document.getElementById('player');
const hud = document.getElementById('hud');
const fullscreenButton = document.getElementById('fullscreen');
const HUD_IDLE_MS = 3000;
let hudTimer = null;

function isFullscreen() {
    return document.fullscreenElement === playerElement;
}

function wakeHud() {
    hud.classList.remove('hidden');
    playerElement.classList.remove('cursor-idle');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(hideHudWhenIdle, HUD_IDLE_MS);
}

function hideHudWhenIdle() {
    if (!isFullscreen()) return;
    // 暂停/缓冲时不收控件栏，避免用户找不到按钮；恢复播放后重新计时
    if (!desiredPlaying) {
        hudTimer = setTimeout(hideHudWhenIdle, HUD_IDLE_MS);
        return;
    }
    hud.classList.add('hidden');
    playerElement.classList.add('cursor-idle');
}

function syncFullscreenUi() {
    fullscreenButton.textContent = isFullscreen() ? '🗗' : '⛶';
    fullscreenButton.title = isFullscreen() ? '退出全屏' : '全屏';
    clearTimeout(hudTimer);
    hudTimer = null;
    if (isFullscreen()) {
        wakeHud();
    } else {
        hud.classList.remove('hidden');
        playerElement.classList.remove('cursor-idle');
    }
}

fullscreenButton.addEventListener('click', () => {
    const action = isFullscreen() ? document.exitFullscreen() : playerElement.requestFullscreen();
    Promise.resolve(action).catch(error => message(`全屏失败：${error.message}`));
});

document.addEventListener('fullscreenchange', syncFullscreenUi);
for (const type of ['mousemove', 'pointerdown', 'keydown', 'wheel']) {
    playerElement.addEventListener(type, wakeHud);
}

const visibleDanmaku = new Map();
const DANMAKU_TRAVEL_SECONDS = 8;   // 滚动弹幕横穿屏幕的时间，与窗口过滤的 8 秒一致
const DANMAKU_PIN_SECONDS = 5;      // 顶部/底部弹幕的停留时间
const DANMAKU_LANE_HEIGHT = 30;

// 弹幕轨道分配：按出现时间从最上方（底部弹幕则从最下方）轨道开始，
// 找第一条不会被已有弹幕阻挡的轨道；全部被占时选最快空出来的轨道。
// 占用以弹幕自身的出现时间为准，这样快进/拖动后同一批弹幕也能逐条错开轨道。
// 各数组记录对应轨道预计空出的时间点。
function danmakuReleaseTime(item, stageWidth) {
    if (item.mode === 4 || item.mode === 5) return item.time + DANMAKU_PIN_SECONDS;
    // 滚动弹幕：尾部（x + width）离开屏幕右缘后，同速跟进的新弹幕才不会追尾
    return item.time + DANMAKU_TRAVEL_SECONDS * (item.width || 0) / Math.max(1, stageWidth + (item.width || 0)) + 0.2;
}

function allocateDanmakuLane(item, laneCount, stageWidth, pools) {
    const pinned = item.mode === 4 || item.mode === 5;
    const pool = pinned ? (item.mode === 5 ? pools.pinTop : pools.pinBottom) : pools.scroll;
    const release = danmakuReleaseTime(item, stageWidth);
    // lane 0 即各模式的优先轨道：滚动/顶部为最上方，底部为最下方，占满时依次向对面堆叠
    let chosen = 0;
    let earliest = Infinity;
    for (let lane = 0; lane < laneCount; lane++) {
        if (pool[lane] <= item.time) { chosen = lane; break; }
        if (pool[lane] < earliest) { earliest = pool[lane]; chosen = lane; }
    }
    pool[chosen] = Math.max(pool[chosen], release);
    return chosen;
}

function renderDanmaku() {
    tickSeam();
    const wanted = new Set();
    if (active && showDanmaku.checked) {
        const time = active.video.currentTime;
        const items = active.danmaku;
        let low = 0;
        let high = items.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (items[middle].time <= time) low = middle + 1; else high = middle;
        }
        const end = low;
        while (low > 0 && items[low - 1].time > time - 8 && end - low < 80) low--;
        const laneCount = Math.max(1, Math.floor(stage.clientHeight * 0.75 / DANMAKU_LANE_HEIGHT));
        const pools = {
            scroll: new Array(laneCount).fill(-Infinity),
            pinTop: new Array(laneCount).fill(-Infinity),
            pinBottom: new Array(laneCount).fill(-Infinity),
        };
        const poolFor = item => pools[item.mode === 5 ? 'pinTop' : item.mode === 4 ? 'pinBottom' : 'scroll'];
        // 第一遍：用已定轨的弹幕重建各轨道的占用，新出现的在第二遍按时间序补占
        for (let i = low; i < end; i++) {
            const item = items[i];
            if (item.lane < 0 || item.lane >= laneCount) continue;
            const pool = poolFor(item);
            pool[item.lane] = Math.max(pool[item.lane], danmakuReleaseTime(item, stage.clientWidth));
        }
        for (let i = low; i < end; i++) {
            const item = items[i];
            wanted.add(item);
            let span = visibleDanmaku.get(item);
            if (!span) {
                span = document.createElement('span');
                span.textContent = item.text;
                const color = Number.isFinite(item.color) ? Math.max(0, Math.min(0xffffff, Math.floor(item.color))) : 0xffffff;
                span.style.color = `#${color.toString(16).padStart(6, '0')}`;
                if (Number.isFinite(item.size)) span.style.fontSize = `${Math.max(12, Math.min(36, item.size))}px`;
                danmakuLayer.appendChild(span);
                visibleDanmaku.set(item, span);
                item.width = span.offsetWidth;
            }
            // 轨道在弹幕出现时一次性确定并保持不变；画面变矮导致轨道越界时重新分配
            if (item.lane < 0 || item.lane >= laneCount) {
                item.lane = allocateDanmakuLane(item, laneCount, stage.clientWidth, pools);
            }
            if (item.mode === 4 || item.mode === 5) {
                span.style.left = '50%';
                span.style.transform = 'translateX(-50%)';
                span.style.top = item.mode === 5
                    ? `${item.lane * DANMAKU_LANE_HEIGHT}px`
                    : `${Math.max(0, stage.clientHeight - 40 - item.lane * DANMAKU_LANE_HEIGHT)}px`;
            } else {
                span.style.top = `${item.lane * DANMAKU_LANE_HEIGHT}px`;
                span.style.left = `${stage.clientWidth - (stage.clientWidth + span.offsetWidth) * ((time - item.time) / DANMAKU_TRAVEL_SECONDS)}px`;
            }
        }
    }
    for (const [item, span] of visibleDanmaku) {
        if (!wanted.has(item)) { span.remove(); visibleDanmaku.delete(item); }
    }
    requestAnimationFrame(renderDanmaku);
}
requestAnimationFrame(renderDanmaku);
