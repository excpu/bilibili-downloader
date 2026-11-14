const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const quietConsole = { log() {}, warn() {}, error() {} };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function backendHarness(dir, engine, fetch, send, media = {}, download) {
    const filename = path.join(root, 'ipc', 'download.js');
    const realRequire = createRequire(filename);
    const handlers = {};
    const sandbox = {
        require(name) {
            if (name === 'electron') return { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } };
            if (name === '../modules/auth') return class { getConstructedCookie() { return ''; } };
            if (name === '../modules/wbi') return {
                getWbiKeys: async () => ({ img_key: '', sub_key: '' }),
                encWbi: () => '',
            };
            if (name === '../modules/config_setting') return class {
                load() {}
                resolveDownloadDir() { return dir; }
                getDownloadEngine() { return engine; }
                getNodeResumeEnabled() { return false; }
                getConcurrency() { return 2; }
                getCdnHost() { return ''; }
                resolveOutputFormat() { return 'mp4'; }
            };
            if (download && name === '../modules/stream_download') return { downloadFileWithGot: download };
            if (download && name === '../modules/multi_thread_stream_download') return { downloadFileWithGotMulti: download };
            if (name === '../modules/js-media/media' && media === null) return realRequire(name);
            if (name === '../modules/js-media/media') return {
                mergeBiliM4sToFile: async (video, audio, output) => {
                    fs.writeFileSync(output, Buffer.concat([fs.readFileSync(audio), fs.readFileSync(video)]));
                },
                ...media,
            };
            return realRequire(name);
        },
        module: { exports: {} }, console: quietConsole, fetch, AbortController, URL, setTimeout,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    sandbox.module.exports({ isDestroyed: () => false, webContents: { send } });
    return { invoke: (ch, ...args) => handlers[ch]({}, ...args), hasActive: sandbox.module.exports.hasActiveDownloads };
}

for (const engine of ['node', 'node-multi']) {
    test(`${engine}: 暂停释放请求，更新过期链接并从音频/视频断点恢复（关闭失败续传设置）`, { timeout: 20000 }, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pause-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const audio = Buffer.alloc(8 * 1024 * 1024, 0x37);
        const video = Buffer.alloc(8 * 1024 * 1024, 0x91);
        const requests = [];
        let token = 0;
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.searchParams.get('token') !== String(token)) {
                res.writeHead(403).end();
                return;
            }
            const data = url.pathname === '/audio' ? audio : video;
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            let offset = range ? Number(range[1]) : 0;
            const end = range && range[2] ? Number(range[2]) : data.length - 1;
            requests.push({ stream: url.pathname, start: offset, token, probe: end === 0 });
            if (offset >= data.length) {
                res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
                return;
            }
            res.writeHead(range ? 206 : 200, {
                'Content-Length': end - offset + 1,
                'Accept-Ranges': 'bytes',
                ...(range ? { 'Content-Range': `bytes ${offset}-${end}/${data.length}` } : {}),
            });
            const timer = setInterval(() => {
                const next = Math.min(end + 1, offset + 32768);
                res.write(data.subarray(offset, next));
                offset = next;
                if (offset > end) {
                    clearInterval(timer);
                    res.end();
                }
            }, end === 0 ? 1 : 5);
            res.on('close', () => clearInterval(timer));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        let pauseStream = 'audio';
        let didPause = deferred();
        const makeBackend = () => backendHarness(dir, engine, async () => {
            token += 1;
            return { ok: true, json: async () => ({ code: 0, data: { dash: {
                audio: [{ id: 30280, codecs: 'mp4a.40.2', baseUrl: `${baseUrl}/audio?token=${token}` }],
                video: [{ id: 80, codecs: 'avc1.640028', baseUrl: `${baseUrl}/video?token=${token}` }],
            } } }) };
        }, (ch, data) => {
            if (ch === 'download-progress' && data.avId === pauseStream && data.progress > 0 && data.progress < 100) {
                pauseStream = null;
                backend.invoke('pauseDownload', 'task');
                didPause.resolve();
            }
        });
        let backend = makeBackend();
        const payload = { uid: 'task', title: 'sample', cid: 1, bvid: 'BVtest', videoIndex: 0, audioIndex: 30280 };
        let running = backend.invoke('downloadTarget', payload);
        await didPause.promise;
        assert.equal((await running).paused, true);
        assert.equal(backend.hasActive(), false);
        const partial = path.join(dir, engine === 'node' ? 'sample_audio_task.m4s' : 'sample_audio_task.m4s.tmp');
        assert.ok(fs.statSync(partial).size > 0);
        if (engine === 'node-multi') {
            const state = JSON.parse(fs.readFileSync(path.join(dir, 'sample_audio_task.m4s.dstate.json')));
            assert.ok(state.chunks.some(chunk => chunk.downloaded > 0));
        }

        payload.resume = true;
        backend = makeBackend();
        pauseStream = 'video';
        didPause = deferred();
        running = backend.invoke('downloadTarget', payload);
        await didPause.promise;
        assert.equal((await running).paused, true);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'sample_audio_task.m4s')), audio);
        assert.ok(requests.some(req => req.stream === '/audio' && req.token === 2 && req.start > 0));
        const audioRequests = requests.filter(req => req.stream === '/audio').length;
        backend = makeBackend();
        const result = await backend.invoke('downloadTarget', payload);
        assert.equal(result.success, true);
        assert.equal(token, 3);
        assert.equal(requests.filter(req => req.stream === '/audio').length, audioRequests);
        assert.ok(requests.some(req => req.stream === '/video' && req.token === 3 && req.start > 0));
        assert.deepEqual(fs.readFileSync(path.join(dir, 'sample.mp4')), Buffer.concat([audio, video]));
        assert.equal((await makeBackend().invoke('downloadTarget', payload)).filePath, result.filePath);
        assert.equal(token, 3);
        await backend.invoke('completeDownload', payload);
        assert.deepEqual(fs.readdirSync(dir), ['sample.mp4']);
    });
}

test('多线程链接探测期间暂停不等待网络超时', { timeout: 5000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-probe-pause-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const requested = deferred();
    const server = http.createServer(() => requested.resolve());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const { downloadFileWithGotMulti } = require('../modules/multi_thread_stream_download');
    const controller = new AbortController();
    const download = downloadFileWithGotMulti(
        `http://127.0.0.1:${server.address().port}/slow`, path.join(dir, 'file'),
        {}, null, undefined, 2, controller.signal
    );
    const rejected = assert.rejects(download, { code: 'DOWNLOAD_CANCELLED' });
    await requested.promise;
    controller.abort('pause');
    await rejected;
});

test('资源变化时丢弃旧断点，合并期间暂停保留完整音视频并清理未完成输出', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-pause-merge-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let version = 1;
    let downloading = deferred();
    const merging = deferred();
    const downloads = [];
    let mergeCount = 0;
    const waitForAbort = signal => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const backend = backendHarness(dir, 'node', async () => ({
        ok: true, json: async () => ({ code: 0, data: { dash: {
            audio: [{ id: 30280, baseUrl: `https://cdn.example/audio-v${version}` }],
            video: [{ id: 80, baseUrl: `https://cdn.example/video-v${version}` }],
        } } }),
    }), () => {}, {
        async mergeBiliM4sToFile(video, audio, output, { signal }) {
            mergeCount += 1;
            fs.writeFileSync(output, 'incomplete');
            if (mergeCount === 1) {
                merging.resolve();
                await waitForAbort(signal);
            }
            fs.writeFileSync(output, fs.readFileSync(audio, 'utf8') + fs.readFileSync(video, 'utf8'));
        },
    }, async (url, dest, headers, progress, retries, concurrency, signal) => {
        assert.equal(fs.existsSync(dest), false);
        downloads.push(url);
        fs.writeFileSync(dest, url);
        if (url.endsWith('video-v1')) {
            downloading.resolve();
            await waitForAbort(signal);
        }
    });
    const task = { uid: 'a', title: 'sample', cid: 1, videoIndex: 0 };
    let running = backend.invoke('downloadTarget', task);
    await downloading.promise;
    backend.invoke('pauseDownload', 'a');
    assert.equal((await running).paused, true);
    version = 2;
    task.resume = true;
    running = backend.invoke('downloadTarget', task);
    await merging.promise;
    backend.invoke('pauseDownload', 'a');
    assert.equal((await running).paused, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['sample_audio_a.m4s', 'sample_download_a.json', 'sample_video_a.m4s']);
    assert.equal(downloads.length, 4);
    assert.equal((await backend.invoke('downloadTarget', task)).success, true);
    assert.equal(downloads.length, 4);
    assert.equal(fs.readFileSync(path.join(dir, 'sample.mp4'), 'utf8'),
        'https://cdn.example/audio-v2https://cdn.example/video-v2');
});

function frontendHarness(invoke, storage = new Map()) {
    const elements = new Map();
    class Element {
        constructor() { this.style = {}; this.listeners = {}; this.children = []; this.textContent = ''; }
        addEventListener(ch, fn) { this.listeners[ch] = fn; }
        appendChild(el) { this.children.push(el); }
        append(...nodes) { this.children.push(...nodes); }
        remove() { this.removed = true; }
    }
    const listeners = {};
    const ipcListeners = {};
    const alerts = [];
    const context = vm.createContext({
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, new Element());
                return elements.get(id);
            },
            createElement: () => new Element(), body: new Element(),
            addEventListener: (ch, fn) => { listeners[ch] = fn; },
        },
        window: {
            electronAPI: { on: (ch, fn) => { ipcListeners[ch] = fn; }, invoke },
            addEventListener() {}, innerWidth: 1000, innerHeight: 800,
        },
        console: quietConsole, alert: message => alerts.push(message),
        model: { showErrorMessage: message => alerts.push(message) },
        $tasksContainer: new Element(),
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
        },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'web', 'download_task.js'), 'utf8'), context);
    return { run: code => vm.runInContext(code, context), elements, listeners, ipcListeners, alerts, storage };
}

test('右键暂停当前任务后自动下载后续任务，恢复排到队尾，暂停进度不被覆盖', async () => {
    const runs = [];
    const pending = new Map();
    const frontend = frontendHarness(async (ch, task) => {
        if (ch === 'completeDownload') return { success: true };
        if (ch === 'pauseDownload') {
            pending.get(task).resolve({ paused: true, success: false });
            return { success: true };
        }
        assert.equal(ch, 'downloadTarget');
        runs.push(task.uid);
        const wait = deferred();
        pending.set(task.uid, wait);
        return wait.promise;
    });
    frontend.run("taskQuene = [{ uid: 'a', cid: 1 }, { uid: 'b', cid: 2 }]; taskManager()");
    await frontend.listeners.contextmenu({
        target: { closest: () => ({ id: 'task-a' }) }, preventDefault() {}, clientX: 0, clientY: 0,
    });
    assert.equal(frontend.run('$pauseMenuItem.textContent'), '暂停下载');
    frontend.run("$pauseMenuItem.listeners.click()");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runs, ['a', 'b']);
    assert.equal(frontend.run("pausedTasks.has('a')"), true);
    assert.equal(frontend.elements.get('status-a').textContent, '已暂停');
    frontend.ipcListeners['download-progress']({ currentUid: 'a', avId: 'audio', progress: 10, speed: '1.00' });
    assert.equal(frontend.elements.get('status-a').textContent, '已暂停');
    assert.equal(frontend.elements.get('taskCount').innerText, 2);
    await frontend.listeners.contextmenu({
        target: { closest: () => ({ id: 'task-a' }) }, preventDefault() {}, clientX: 0, clientY: 0,
    });
    assert.equal(frontend.run('$pauseMenuItem.textContent'), '恢复下载');
    frontend.run('$pauseMenuItem.listeners.click()');
    assert.equal(frontend.run('taskQuene[1].uid'), 'a');
    pending.get('b').resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runs, ['a', 'b', 'a']);
    assert.equal(frontend.run('taskQuene[0].resume'), true);
    pending.get('a').resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frontend.run('globalTaskLock'), false);
    assert.deepEqual(frontend.alerts, []);
});

test('排队任务可暂停/取消，获取 CID 期间暂停不会开始下载', async () => {
    const info = deferred();
    const calls = [];
    const frontend = frontendHarness(async (ch, payload) => {
        calls.push(ch);
        if (ch === 'getVideoInfo') return info.promise;
        if (ch === 'cleanupFailedDownload') return { success: true };
        throw new Error(`Unexpected ${ch}: ${payload}`);
    });
    frontend.run("taskQuene = [{ uid: 'a' }, { uid: 'b', cid: 2 }]; taskManager()");
    await frontend.run("pauseTask('b'); pauseTask('a')");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frontend.run('pausedTasks.size'), 2);
    assert.equal(frontend.run('globalTaskLock'), false);
    info.resolve({ success: true, data: { cid: 1 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frontend.run('pausedTasks.size'), 2);
    frontend.run("cancelTask('a'); cancelTask('b')");
    assert.equal(frontend.run('pausedTasks.size'), 0);
    assert.deepEqual(calls, ['getVideoInfo', 'cleanupFailedDownload', 'cleanupFailedDownload']);
});

test('恢复后仍在排队的任务被取消时清理断点', async () => {
    const removed = [];
    const frontend = frontendHarness(async (ch, task) => {
        assert.equal(ch, 'cleanupFailedDownload');
        removed.push(task.uid);
        return { success: true };
    });
    frontend.run("globalTaskLock = true; taskQuene = [{ uid: 'a', cid: 1 }, { uid: 'b', cid: 2, resume: true }]");
    await frontend.run("pauseTask('b')");
    frontend.run("resumeTask('b'); cancelTask('b')");
    assert.deepEqual(removed, ['b']);
    assert.equal(frontend.run('taskQuene.length'), 1);
    assert.equal(frontend.run('pausedTasks.size'), 0);
    assert.equal(frontend.run('globalTaskLock'), true);
});

for (const engine of ['node', 'node-multi']) {
    test(`${engine}: 下载中签名过期后自动刷新并 Range 续传，内容保持完整`, { timeout: 15000 }, async t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-url-refresh-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const audio = Buffer.alloc((engine === 'node-multi' ? 8 : 1) * 1024 * 1024);
        for (let offset = 0; offset < audio.length; offset += 4) audio.writeUInt32LE(offset, offset);
        const video = Buffer.from('video');
        let token = 0;
        let expired = false;
        const resumedOffsets = [];
        let expectedResumeOffsets = [];
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const signedToken = Number(url.searchParams.get('token'));
            if (signedToken === 1 && expired) {
                res.writeHead(403).end();
                return;
            }
            const data = url.pathname === '/audio' ? audio : video;
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Number(range[2]) : data.length - 1;
            if (signedToken === 2 && url.pathname === '/audio') resumedOffsets.push(start);
            res.writeHead(range ? 206 : 200, {
                'Content-Length': end - start + 1,
                'Accept-Ranges': 'bytes',
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
            });
            if (signedToken === 1 && url.pathname === '/audio' && end > 0) {
                const partialSize = engine === 'node-multi' ? 1280 * 1024 : 256 * 1024;
                res.write(data.subarray(start, Math.min(end + 1, start + partialSize)));
                setTimeout(() => {
                    expired = true;
                    res.destroy();
                }, 30);
            } else {
                res.end(data.subarray(start, end + 1));
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const backend = backendHarness(dir, engine, async () => {
            token += 1;
            return { ok: true, json: async () => ({ code: 0, data: { dash: {
                audio: [{ id: 30280, baseUrl: `${baseUrl}/audio?token=${token}` }],
                video: [{ id: 80, baseUrl: `${baseUrl}/video?token=${token}` }],
            } } }) };
        }, (ch, data) => {
            if (engine === 'node-multi' && ch === 'download-progress' && data.avId === 'refreshing') {
                const state = JSON.parse(fs.readFileSync(path.join(dir, 'sample_audio_refresh.m4s.dstate.json')));
                expectedResumeOffsets = state.chunks.filter(chunk => chunk.downloaded > 0 && !chunk.completed)
                    .map(chunk => chunk.start + chunk.downloaded);
                assert.ok(expectedResumeOffsets.length > 0);
            }
        });
        const task = { uid: 'refresh', title: 'sample', bvid: 'BVtest', cid: 1, videoIndex: 0 };
        const result = await backend.invoke('downloadTarget', task);
        assert.equal(result.success, true, result.message);
        assert.equal(token, 2);
        assert.ok(resumedOffsets.some(offset => offset > 0));
        if (engine === 'node-multi') {
            assert.ok(expectedResumeOffsets.some(offset => resumedOffsets.includes(offset)));
        }
        assert.deepEqual(fs.readFileSync(result.filePath), Buffer.concat([audio, video]));
    });
}

test('持续 403 限制刷新次数，404 不刷新，错误不会伪装成下载成功', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-refresh-limit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const status of [403, 404]) {
        let fetched = 0;
        const backend = backendHarness(dir, 'node', async () => {
            fetched += 1;
            return { ok: true, json: async () => ({ code: 0, data: { dash: {
                audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio' }],
                video: [{ id: 80, baseUrl: 'https://cdn.example/video' }],
            } } }) };
        }, () => {}, {}, async () => {
            throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
        });
        const task = { uid: `error-${status}`, title: 'sample', videoIndex: 0 };
        const result = await backend.invoke('downloadTarget', task);
        assert.equal(result.success, false);
        assert.match(result.message, new RegExp(String(status)));
        assert.equal(fetched, status === 403 ? 3 : 1);
        assert.equal(backend.hasActive(), false);
        await backend.invoke('cleanupFailedDownload', task);
    }
});

test('同名任务的 UID 后缀隔离断点与清理，成品保留原标题并避免覆盖', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-task-isolation-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const downloading = deferred();
    let pauseFirst = true;
    const backend = backendHarness(dir, 'node', async () => ({
        ok: true, json: async () => ({ code: 0, data: { dash: {
            audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio' }],
            video: [{ id: 80, baseUrl: 'https://cdn.example/video' }],
        } } }),
    }), () => {}, {}, async (url, dest, headers, progress, retries, concurrency, signal) => {
        const uid = dest.endsWith('_a.m4s') ? 'a' : 'b';
        fs.writeFileSync(dest, `${uid}-${url.endsWith('audio') ? 'audio' : 'video'}`);
        if (uid === 'a' && url.endsWith('video') && pauseFirst) {
            pauseFirst = false;
            downloading.resolve();
            await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
    });
    const first = { uid: 'a', title: 'same-title', videoIndex: 0 };
    const second = { uid: 'b', title: 'same-title', videoIndex: 0 };
    const running = backend.invoke('downloadTarget', first);
    await downloading.promise;
    await backend.invoke('pauseDownload', 'a');
    assert.equal((await running).paused, true);
    assert.equal((await backend.invoke('downloadTarget', second)).success, true);
    await backend.invoke('completeDownload', second);
    assert.equal(fs.readFileSync(path.join(dir, 'same-title_audio_a.m4s'), 'utf8'), 'a-audio');
    assert.equal(fs.readFileSync(path.join(dir, 'same-title.mp4'), 'utf8'), 'b-audiob-video');
    first.resume = true;
    const result = await backend.invoke('downloadTarget', first);
    assert.equal(path.basename(result.filePath), 'same-title (2).mp4');
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'a-audioa-video');
    await backend.invoke('completeDownload', first);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['same-title (2).mp4', 'same-title.mp4']);
});

test('CID/下载 IPC 异常及附属文件失败都释放队列，失败任务可重试', async () => {
    for (const failingChannel of ['getVideoInfo', 'downloadTarget', 'downloadDanmu', 'downloadCover']) {
        const downloads = [];
        let failing = true;
        const frontend = frontendHarness(async (ch, task) => {
            if (failing && ch === failingChannel && (ch === 'getVideoInfo' || task.uid === 'a' || task.title === 'first')) {
                throw new Error(`broken ${ch}`);
            }
            if (ch === 'downloadTarget') downloads.push(task.uid);
            if (ch === 'getVideoInfo') return { success: true, data: { cid: 1 } };
            return { success: true };
        });
        await frontend.run(`taskQuene = [
            { uid: 'a', title: 'first', bvid: 'BV1', cid: ${failingChannel === 'getVideoInfo' ? 'null' : '1'}, danmu: true, cover: true, coverUrl: 'https://example.com/cover' },
            { uid: 'b', title: 'second', bvid: 'BV2', cid: 2 }
        ]; taskManager()`);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(frontend.run('globalTaskLock'), false);
        assert.ok(downloads.includes('b'));
        assert.equal(frontend.run('taskQuene.length'), 0);
        assert.equal(frontend.run("failedTasks.has('a')"),
            failingChannel === 'getVideoInfo' || failingChannel === 'downloadTarget');
        assert.ok(frontend.alerts.some(message => message.includes(`broken ${failingChannel}`)));
        failing = false;
        if (frontend.run("failedTasks.has('a')")) {
            frontend.run("retryFailedTask('a')");
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(downloads.at(-1), 'a');
            assert.equal(frontend.run('failedTasks.size'), 0);
            assert.equal(frontend.run('globalTaskLock'), false);
        }
    }
});

test('重启恢复排队/暂停/失败任务及选项，等待手动继续且不会自动发起下载', async () => {
    const storage = new Map();
    const original = frontendHarness(async () => new Promise(() => {}), storage);
    original.run(`taskQuene = [
        { uid: 'a', title: 'first', bvid: 'BV1', cid: 1, videoQualityId: 80, videoCodec: 'avc1',
          audioQualityId: 30280, folderNames: ['folder'], subtitleLanguage: 'zh-CN', danmu: true },
        { uid: 'b', title: 'second', bvid: 'BV2', cid: 2 }
    ]; taskManager(); pauseTask('b');
    markTaskFailed({ uid: 'c', title: 'third', bvid: 'BV3', cid: 3 }); saveDownloadTasks();`);
    const calls = [];
    const restored = frontendHarness(async (ch, task) => {
        calls.push({ ch, task });
        return { success: true };
    }, storage);
    assert.equal(restored.run('pausedTasks.size'), 3);
    assert.equal(restored.run('globalTaskLock'), false);
    assert.equal(restored.run('taskQuene.length'), 0);
    assert.deepEqual(calls, []);
    assert.equal(restored.elements.get('status-a').textContent, '已恢复，等待继续');
    restored.run("resumeTask('a')");
    await new Promise(resolve => setImmediate(resolve));
    const task = calls.find(call => call.ch === 'downloadTarget').task;
    assert.equal(task.resume, true);
    assert.equal(task.videoQualityId, 80);
    assert.equal(task.audioQualityId, 30280);
    assert.equal(task.subtitleLanguage, 'zh-CN');
    assert.deepEqual(Array.from(task.folderNames), ['folder']);
    const saved = JSON.parse([...storage.values()][0]);
    assert.deepEqual(saved.tasks.map(item => item.uid).sort(), ['b', 'c']);
    assert.ok(saved.tasks.every(item => !('downloading' in item)));
});

test('真实 AAC/AVC 样本可通过 UID 临时文件合并和纯音频转封装', { timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-uid-media-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const backend = backendHarness(dir, 'node', async () => ({
        ok: true, json: async () => ({ code: 0, data: { dash: {
            audio: [{ id: 30280, codecs: 'mp4a.40.2', baseUrl: 'https://cdn.example/audio' }],
            video: [{ id: 80, codecs: 'avc1.640028', baseUrl: 'https://cdn.example/video' }],
        } } }),
    }), () => {}, null, async (url, dest) => {
        fs.copyFileSync(path.join(__dirname, 'test-media', url.endsWith('audio') ? 'audio-aac.m4s' : 'video-avc.m4s'), dest);
    });
    for (const videoIndex of [0, -1]) {
        const task = { uid: `real-${videoIndex}`, title: 'original-title', videoIndex };
        const result = await backend.invoke('downloadTarget', task);
        assert.equal(result.success, true, result.message);
        assert.equal(path.basename(result.filePath), videoIndex === -1 ? 'original-title.m4a' : 'original-title.mp4');
        const parser = require('mp4box').createFile();
        let info;
        parser.onReady = value => { info = value; };
        const header = Buffer.alloc(Math.min(fs.statSync(result.filePath).size, 1024 * 1024));
        const fd = fs.openSync(result.filePath, 'r');
        try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
        const data = header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength);
        data.fileStart = 0;
        parser.appendBuffer(data);
        assert.equal(info.audioTracks.length, 1);
        assert.equal(info.videoTracks.length, videoIndex === -1 ? 0 : 1);
        await backend.invoke('completeDownload', task);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['original-title.m4a', 'original-title.mp4']);
});
