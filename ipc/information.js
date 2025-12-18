// 这里用于处理所有用户获取账号信息的API
const { app, ipcMain } = require('electron');
const Auth = require('../modules/auth');

const { encWbi, getWbiKeys } = require('../modules/wbi');

const auth = new Auth();

module.exports = function registerInformationIpc(mainWindow) {
    // 获取登录状态
    ipcMain.handle('loginStatus', () => {
        return auth.loadLoginStatus();
    });

    // 获取用户信息
    ipcMain.handle('getUserInfo', async () => {
        if (auth.loadLoginStatus()) {
            const data = auth.load();
            auth.updateTicket(); // 尝试更新票据
            const url = `https://api.bilibili.com/x/web-interface/nav`;
            const credentialCookie = `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct};`;
            const result = await fetch(url, {
                method: 'GET',
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Accept': 'application/json',
                    'Cookie': credentialCookie // 登录验证
                },
            });
            const json = await result.json();
            if (json.code === 0 && json.data.isLogin === true) {
                return {
                    status: true,
                    data: json.data,
                };
            } else {
                auth.updateLoginStatus(false); // 更新登录状态为未登录
                return {
                    status: false,
                    message: '登录信息验证失败或登录已经过期',
                }
            }
        } else {
            return {
                status: false,
                message: '用户未登录',
            }
        }
    });

    // 请求登录二维码
    ipcMain.handle('requestLoginQr', async () => {
        const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/generate`;
        const response = await fetch(url, {
            headers: {
                'Referer': 'https://www.bilibili.com/', // 伪造 B站 Referer
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', // 防止被屏蔽
                'Accept': 'application/json' // 明确表明要 JSON
            }
        });

        if (!response.ok) {
            return { success: false, message: '网络请求失败' };
        }

        const json = await response.json();

        return {
            success: true,
            data: json.data
        }
    });

    // 轮询二维码登录状态
    ipcMain.handle('pollQrLoginStatus', async (event, oauthKey) => {
        if (!oauthKey) {
            return { success: false, message: '缺少 oauthKey 参数' };
        }
        const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${oauthKey}`;
        const response = await fetch(url, {
            headers: {
                'Referer': 'https://www.bilibili.com/', // 伪造 B站 Referer
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', // 防止被屏蔽
                'Accept': 'application/json' // 明确表明要 JSON
            }
        });
        if (!response.ok) {
            return { success: false, message: '网络请求失败' };
        }
        const json = await response.json();
        if (json.data.code === 0) {
            // 登录成功，保存登录信息
            // 使用 getSetCookie() 获取所有 Set-Cookie 头（Node.js 20+）
            const setCookieHeaders = response.headers.getSetCookie() || [];
            // 解析 cookies
            let cookieData = {};
            setCookieHeaders.forEach(cookie => {
                let match = cookie.match(/([^=]+)=([^;]+)/);
                if (match) {
                    cookieData[match[1]] = match[2];
                }
            });
            // 提取 SESSDATA 和 bili_jct
            const sessdata = cookieData['SESSDATA'] || '';
            const biliJct = cookieData['bili_jct'] || '';
            auth.updateLoginInfo(sessdata, biliJct);
            auth.updateTicket(); // 更新票据
            return { success: true };
        } else if (json.data.code === 86038) {
            return { success: false, message: '二维码过期' };
        } else {
            return { success: false, message: '登录未完成' };
        }
    });

    // 获取视频信息
    ipcMain.handle('getVideoInfo', async (event, bvid) => {
        try {
            const wbiKeys = await getWbiKeys();
            const params = {
                bvid: bvid
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            const url = `https://api.bilibili.com/x/web-interface/wbi/view?${wbiQuery}`;
            const data = auth.load();
            const credentialCookie = `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct};` || '';
            const response = await fetch(url, {
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Accept': 'application/json',
                    'Cookie': credentialCookie // 登录验证
                }
            });
            if (!response.ok) {
                return { success: false, message: '网络请求失败' };
            }
            const json = await response.json();
            if (json.code === 0) {
                return { success: true, data: json.data };
            } else {
                return { success: false, message: json.message || '获取视频信息失败' };
            }
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });

    // 获取视频流以及分辨率编码信息
    ipcMain.handle('getVideoStreams', async (event, payload) => {
        try {
            const { bvid, cid } = payload;
            const wbiKeys = await getWbiKeys(); // 获取最新的 wbiKeys
            const params = {
                bvid: bvid,
                cid: cid,
                fnval: 4048,
                fourk: 1,
                gaia_source: 'view-card'
            };
            console.log(bvid, cid);
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            console.log(wbiQuery);
            const url = `https://api.bilibili.com/x/player/wbi/playurl?${wbiQuery}`;
            const data = auth.load();
            const credentialCookie = `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct}; bili_ticket=${data.ticket}` || '';
            const response = await fetch(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.1',
                    'Accept': 'application/json',
                    "Connection": "keep-alive",
                    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
                    'Cache-Control': 'no-cache',
                    'Origin': 'https://www.bilibili.com',
                    'Cookie': credentialCookie // 登录验证
                }
            });
            if (!response.ok) {
                return { success: false, message: '网络请求失败' };
            }
            const json = await response.json();
            if (json.code === 0) {
                return { success: true, data: json.data };
            } else {
                return { success: false, message: json.message || '获取视频流信息失败' };
            }
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });
}