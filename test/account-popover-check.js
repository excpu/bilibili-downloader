const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(invoke, now = () => Date.now()) {
    const ids = [
        'avatarArea', 'avatar', 'accountPopover', 'accountName', 'accountVip',
        'accountCoins', 'accountBcoins', 'accountLevel', 'accountNextLevel',
        'accountLevelProgress', 'accountExperience', 'accountFollowing',
        'accountFollowers', 'accountDynamics', 'accountStatus', 'accountPortraitFace',
        'accountPortraitFrame', 'accountPortraitPlaceholder'
    ];
    const elements = Object.fromEntries(ids.map((id) => {
        const listeners = {};
        return [id, {
            textContent: '', hidden: false, style: {}, attributes: {}, listeners,
            classList: { toggle() {} },
            setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name] ?? null; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(name, callback) { listeners[name] = callback; },
            matches() { return false; },
            contains() { return false; }
        }];
    }));
    const document = { getElementById: (id) => elements[id], activeElement: null };
    const context = { document, window: { electronAPI: { invoke } }, console, Date: { now } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'nav_bar.js'), 'utf8'), context);
    return { elements, popover: context.createNavBar() };
}

const user = {
    mid: 123, isLogin: true, uname: '测试用户', money: 12.5,
    face: 'https://example.test/face.png',
    pendant: { pid: 123, image: 'https://example.test/frame.png' },
    wallet: { bcoin_balance: 0 }, vipStatus: 1, vip_label: { text: '年度大会员' },
    level_info: { current_level: 5, current_min: 10800, current_exp: 20600, next_exp: 28800 }
};

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('preloads statistics and reuses them on hover', async () => {
    const calls = [];
    const { elements, popover } = setup((channel, mid) => {
        calls.push([channel, mid]);
        return Promise.resolve(channel === 'getUserInfo'
            ? { status: true, data: user }
            : { success: true, relation: { following: 171, follower: 33 }, navnum: { opus: 9 }, errors: [] });
    });
    elements.avatarArea.listeners.mouseenter();
    assert.equal(calls.length, 0);
    popover.setUser(user);
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountPopover.hidden, false);
    assert.equal(elements.accountName.textContent, '测试用户');
    assert.equal(elements.accountPortraitFace.getAttribute('src'), user.face);
    assert.equal(elements.accountPortraitFrame.getAttribute('src'), user.pendant.image);
    assert.equal(elements.accountPortraitFrame.hidden, false);
    assert.equal(elements.accountVip.textContent, '年度大会员');
    assert.equal(elements.accountBcoins.textContent, '0');
    assert.equal(elements.accountExperience.textContent, '当前成长20600，距离升级Lv.6还需要8200');
    assert.equal(elements.accountLevelProgress.style.width, `${9800 / 18000 * 100}%`);
    assert.equal(elements.accountFollowing.textContent, '171');
    assert.equal(elements.accountFollowers.textContent, '33');
    assert.equal(elements.accountDynamics.textContent, '9');
    assert.equal(elements.accountStatus.textContent, '');
    assert.deepEqual(calls, [['getUserNavStats', 123]]);
    elements.avatarArea.listeners.mouseleave();
    assert.equal(elements.accountPopover.hidden, true);
});

test('updates portrait and frame after refresh, including removal and image failures', async () => {
    let time = 0;
    const updatedUser = { ...user, face: 'https://example.test/new-face.png', pendant: { pid: 0, image: '' } };
    const { elements, popover } = setup((channel) => Promise.resolve(channel === 'getUserInfo'
        ? { status: true, data: updatedUser }
        : { success: true, relation: { following: 1, follower: 2 }, navnum: { opus: 3 }, errors: [] }), () => time);
    popover.setUser(user);
    await flush();
    elements.accountPortraitFace.listeners.load();
    assert.equal(elements.accountPortraitPlaceholder.hidden, true);
    elements.accountPortraitFrame.listeners.error();
    assert.equal(elements.accountPortraitFrame.hidden, true);
    assert.equal(elements.accountPortraitFace.hidden, false);
    time += 300001;
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountPortraitFace.getAttribute('src'), updatedUser.face);
    assert.equal(elements.accountPortraitPlaceholder.hidden, false);
    assert.equal(elements.accountPortraitFrame.hidden, true);
    assert.equal(elements.accountPortraitFrame.getAttribute('src'), null);
    elements.accountPortraitFace.listeners.error();
    assert.equal(elements.accountPortraitFace.hidden, true);
    assert.equal(elements.accountPortraitPlaceholder.hidden, false);
    popover.clear();
    assert.equal(elements.accountPortraitFace.getAttribute('src'), null);
});

test('displays an avatar without a frame when no pendant is provided', () => {
    const { elements, popover } = setup(() => new Promise(() => {}));
    popover.setUser({ ...user, pendant: null });
    assert.equal(elements.accountPortraitFace.hidden, false);
    assert.equal(elements.accountPortraitFrame.hidden, true);
    assert.equal(elements.accountPortraitFrame.getAttribute('src'), null);
});

test('max level and failed statistics are displayed without invented values', async () => {
    const maxUser = { ...user, vipStatus: 0, level_info: { current_level: 6, current_exp: 30000, next_exp: '--' } };
    const { elements, popover } = setup((channel) => Promise.resolve(channel === 'getUserInfo'
        ? { status: true, data: maxUser }
        : { success: true, relation: null, navnum: { opus: 0 }, errors: ['关系接口失败'] }));
    popover.setUser(maxUser);
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountVip.hidden, true);
    assert.equal(elements.accountLevelProgress.style.width, '100%');
    assert.equal(elements.accountExperience.textContent, '当前成长30000，已达到最高等级');
    assert.equal(elements.accountFollowing.textContent, '--');
    assert.equal(elements.accountDynamics.textContent, '0');
    assert.equal(elements.accountStatus.textContent, '统计数据更新失败');
});

test('logout invalidates pending preload requests', async () => {
    const pending = [];
    const { elements, popover } = setup(() => new Promise((resolve) => pending.push(resolve)));
    popover.setUser(user);
    elements.avatarArea.listeners.mouseenter();
    popover.clear();
    pending[0]({ success: true, relation: { following: 10 }, navnum: { opus: 5 }, errors: [] });
    await flush();
    assert.equal(elements.accountPopover.hidden, true);
    assert.equal(elements.accountFollowing.textContent, '--');
    assert.equal(elements.accountStatus.textContent, '');
    elements.avatarArea.listeners.mouseenter();
    assert.equal(pending.length, 1);
});

test('missing dynamic count is reported as unavailable', async () => {
    const { elements, popover } = setup((channel) => Promise.resolve(channel === 'getUserInfo'
        ? { status: true, data: user }
        : { success: true, relation: { following: 1, follower: 2 }, navnum: {}, errors: [] }));
    popover.setUser(user);
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountDynamics.textContent, '--');
    assert.equal(elements.accountStatus.textContent, '统计数据更新失败');
});

test('refreshes only after five minutes while retaining cached values', async () => {
    let time = 1000;
    const calls = [];
    const pending = [];
    const { elements, popover } = setup((channel, mid) => {
        calls.push([channel, mid]);
        if (calls.length === 1) {
            return Promise.resolve({ success: true, relation: { following: 171, follower: 33 }, navnum: { opus: 9 }, errors: [] });
        }
        return new Promise((resolve) => pending.push(resolve));
    }, () => time);
    popover.setUser(user);
    assert.equal(elements.accountStatus.textContent, '');
    await flush();
    time += 300000;
    elements.avatarArea.listeners.mouseenter();
    assert.equal(calls.length, 1);
    elements.avatarArea.listeners.mouseleave();
    time++;
    elements.avatarArea.listeners.mouseenter();
    assert.equal(calls.length, 3);
    assert.equal(elements.accountFollowing.textContent, '171');
    assert.equal(elements.accountDynamics.textContent, '9');
    assert.equal(elements.accountStatus.textContent, '');
    elements.avatarArea.listeners.mouseleave();
    elements.avatarArea.listeners.mouseenter();
    assert.equal(calls.length, 3);
    elements.avatarArea.listeners.mouseleave();
    pending[0]({ status: true, data: { ...user, uname: '新昵称' } });
    pending[1]({ success: true, relation: { following: 172, follower: 34 }, navnum: { opus: 10 }, errors: [] });
    await flush();
    assert.equal(elements.accountName.textContent, '新昵称');
    assert.equal(elements.accountDynamics.textContent, '10');
    elements.avatarArea.listeners.mouseenter();
    assert.equal(calls.length, 3);
});

test('failed refresh keeps cached values and observes retry interval', async () => {
    let time = 1000;
    let count = 0;
    const { elements, popover } = setup((channel) => {
        count++;
        if (count === 1) return Promise.resolve({ success: true, relation: { following: 1, follower: 2 }, navnum: { opus: 3 }, errors: [] });
        if (channel === 'getUserInfo') return Promise.resolve({ status: true, data: user });
        return Promise.resolve({ success: true, relation: null, navnum: { opus: 4 }, errors: ['关系接口失败'] });
    }, () => time);
    popover.setUser(user);
    await flush();
    time += 300001;
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountFollowing.textContent, '1');
    assert.equal(elements.accountFollowers.textContent, '2');
    assert.equal(elements.accountDynamics.textContent, '4');
    assert.equal(elements.accountStatus.textContent, '统计数据更新失败');
    elements.avatarArea.listeners.mouseleave();
    elements.avatarArea.listeners.mouseenter();
    assert.equal(count, 3);
});

test('failed account refresh keeps previous NAV information', async () => {
    let time = 1000;
    const { elements, popover } = setup((channel) => {
        if (channel === 'getUserInfo') return Promise.reject(new Error('网络失败'));
        return Promise.resolve({ success: true, relation: { following: 1, follower: 2 }, navnum: { opus: 3 }, errors: [] });
    }, () => time);
    popover.setUser(user);
    await flush();
    time += 300001;
    elements.avatarArea.listeners.mouseenter();
    await flush();
    assert.equal(elements.accountName.textContent, '测试用户');
    assert.equal(elements.accountCoins.textContent, '12.5');
    assert.equal(elements.accountDynamics.textContent, '3');
    assert.equal(elements.accountStatus.textContent, '账户信息更新失败');
});

test('switching accounts discards cached values and ignores old responses', async () => {
    const pending = [];
    const { elements, popover } = setup(() => new Promise((resolve) => pending.push(resolve)));
    popover.setUser(user);
    popover.setUser({ ...user, mid: 456, uname: '另一个用户' });
    assert.equal(elements.accountFollowing.textContent, '--');
    pending[0]({ success: true, relation: { following: 1, follower: 2 }, navnum: { opus: 3 }, errors: [] });
    pending[1]({ success: true, relation: { following: 4, follower: 5 }, navnum: { opus: 6 }, errors: [] });
    await flush();
    assert.equal(elements.accountName.textContent, '另一个用户');
    assert.equal(elements.accountFollowing.textContent, '4');
    assert.equal(elements.accountDynamics.textContent, '6');
});

test('statistics IPC requests documented endpoints and reports partial failures', async () => {
    const handlers = {};
    const requests = [];
    class Auth {
        loadLoginStatus() { return true; }
        getConstructedCookie() { return 'test-cookie'; }
    }
    const requireStub = (name) => {
        if (name === 'electron') return { ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } } };
        if (name === '../modules/auth') return Auth;
        if (name === '../modules/wbi') return {};
        if (name === 'got') return async (url, options) => {
            requests.push({ url, options });
            if (url.includes('/x/relation/stat')) {
                return { body: { code: 0, data: { following: 12, follower: 34 } } };
            }
            return { body: { code: -400, message: '请求错误' } };
        };
        throw new Error(`unexpected module ${name}`);
    };
    const context = { require: requireStub, module: { exports: {} }, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ipc', 'information.js'), 'utf8'), context);
    context.module.exports({});
    const result = await handlers.getUserNavStats(null, 123);
    assert.equal(result.relation.following, 12);
    assert.equal(result.navnum, null);
    assert.match(result.errors[0], /动态: 请求错误/);
    assert.equal(requests[0].url, 'https://api.bilibili.com/x/relation/stat?vmid=123');
    assert.equal(requests[1].url, 'https://api.bilibili.com/x/space/navnum?mid=123');
    assert.equal(requests[0].options.headers.Cookie, 'test-cookie');
    const invalid = await handlers.getUserNavStats(null, '123');
    assert.equal(invalid.success, false);
    assert.equal(requests.length, 2);
});
