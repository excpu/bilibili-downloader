// 这里用于处理所有用户获取账号信息的API
const { ipcMain } = require('electron');
const Auth = require('../modules/auth');

const { encWbi, getWbiKeys } = require('../modules/wbi');

const got = require('got');

const auth = new Auth();

module.exports = function registerInformationIpc(mainWindow) {
    // 获取登录状态
    ipcMain.handle('loginStatus', () => {
        return auth.loadLoginStatus();
    });

    ipcMain.handle('logout', () => {
        auth.logout();
        return { success: true };
    });

    // 获取用户信息
    ipcMain.handle('getUserInfo', async () => {
        if (auth.loadLoginStatus()) {
            await auth.ensureBuvidCredentials();
            await auth.updateTicket(); // 尝试更新票据
            const url = `https://api.bilibili.com/x/web-interface/nav`;
            //const credentialCookie = `SESSDATA=${data.SESSDATA}; bili_jct=${data.bili_jct};` || "";
            // 更换为统一构造函数
            const credentialCookie = auth.getConstructedCookie();
            try {
                const result = await got(url, {
                    method: 'GET',
                    headers: {
                        'Referer': 'https://www.bilibili.com/',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                        'Accept': 'application/json',
                        'Cookie': credentialCookie // 登录验证
                    },
                    responseType: 'json',
                    http2: true
                });
                const json = result.body;
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
                    };
                }
            } catch (error) {
                return {
                    status: false,
                    message: '网络请求失败: ' + error.message,
                };
            }
        } else {
            auth.updateTicket(); // 尝试更新票据
            return {
                status: false,
                message: '用户未登录',
            }
        }
    });

    // 请求登录二维码
    ipcMain.handle('requestLoginQr', async () => {
        try {
            const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/generate`;
            const response = await got(url, {
                headers: {
                    'Referer': 'https://www.bilibili.com/', // 伪造 B站 Referer
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', // 防止被屏蔽
                    'Accept': 'application/json' // 明确表明要 JSON
                },
                responseType: 'json',
                http2: true
            });
            const json = response.body;
            return {
                success: true,
                data: json.data
            };
        } catch (error) {
            return { success: false, message: '网络请求失败' };
        }
    });

    // 轮询二维码登录状态
    ipcMain.handle('pollQrLoginStatus', async (event, oauthKey) => {
        if (!oauthKey) {
            return { success: false, message: '缺少 oauthKey 参数' };
        }
        try {
            const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${oauthKey}`;
            const response = await got(url, {
                headers: {
                    'Referer': 'https://www.bilibili.com/', // 伪造 B站 Referer
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0', // 防止被屏蔽
                    'Accept': 'application/json' // 明确表明要 JSON
                },
                responseType: 'json',
                http2: true
            });
            const json = response.body;
            if (json.data.code === 0) {
                // 登录成功，保存登录信息
                // got 的 response.headers['set-cookie'] 已经是数组
                const setCookieHeaders = response.headers['set-cookie'] || [];
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
                await auth.ensureBuvidCredentials(true);
                auth.updateTicket(); // 更新票据
                return { success: true };
            } else if (json.data.code === 86038) {
                return { success: false, message: '二维码过期' };
            } else {
                return { success: false, message: '登录未完成' };
            }
        } catch (error) {
            return { success: false, message: '网络请求失败' };
        }
    });

    // 获取视频信息
    ipcMain.handle('getVideoInfo', async (event, bvid) => {
        try {
            await auth.ensureBuvidCredentials();
            const wbiKeys = await getWbiKeys();
            const params = {
                bvid: bvid
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            const url = `https://api.bilibili.com/x/web-interface/wbi/view?${wbiQuery}`;
            const credentialCookie = auth.getConstructedCookie(); // 获取构造好的 Cookie，包含 buvid3 / buvid4 / b_nut 来减少风控的可能性
            const response = await got(url, {
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                    'Accept': 'application/json',
                    'Cookie': credentialCookie // 登录验证
                },
                responseType: 'json',
                http2: true
            });
            const json = response.body;
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
            await auth.ensureBuvidCredentials();
            const { bvid, cid } = payload;
            const wbiKeys = await getWbiKeys(); // 获取最新的 wbiKeys
            const params = {
                bvid: bvid,
                cid: cid,
                fnval: 4048,
                fourk: 1,
                gaia_source: 'view-card'
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
            const url = `https://api.bilibili.com/x/player/wbi/playurl?${wbiQuery}`;
            const credentialCookie = auth.getConstructedCookie(); // 获取构造好的 Cookie，包含 buvid3 / buvid4 / b_nut 来减少风控的可能性
            const response = await got(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.1',
                    'Accept': 'application/json',
                    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
                    'Cache-Control': 'no-cache',
                    'Origin': 'https://www.bilibili.com',
                    'Cookie': credentialCookie // 登录验证
                },
                responseType: 'json',
                http2: true
            });
            const json = response.body;
            if (json.code === 0) {
                console.log('视频流信息获取成功');
                return { success: true, data: json.data };
            } else {
                return { success: false, message: json.message || '获取视频流信息失败' };
            }
        } catch (error) {
            if (error.response) {
                console.error(`HTTP Error Code: ${error.response.statusCode}, Cause: ${error.response.statusMessage}`);
            }
            return { success: false, message: '发生错误: ' + error.message };
        }
    });
    // 获取合集信息
    ipcMain.handle('searchCollection', async (event, ugc_season_id, mid, ep_count) => {
        try {
            await auth.ensureBuvidCredentials();
            if (ugc_season_id === undefined || ugc_season_id === null || mid === undefined || mid === null) {
                return { success: false, message: '合集参数缺失：ugc_season_id 或 mid 为空' };
            }

            const wbiKeys = await getWbiKeys();
            const credentialCookie = auth.getConstructedCookie(); // 获取构造好的 Cookie，包含 buvid3 / buvid4 / b_nut 来减少风控的可能性

            const pageSize = 30;
            const normalizedEpCount = Number.parseInt(ep_count, 10);

            const fetchSeasonPage = async (pageNum) => {
                const params = {
                    mid: String(mid),
                    season_id: String(ugc_season_id),
                    page_num: String(pageNum),
                    page_size: String(pageSize)
                };
                const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
                const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?${wbiQuery}`;

                const response = await got(url, {
                    headers: {
                        'Referer': `https://www.bilibili.com/`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
                        'Accept': 'application/json',
                        'Cookie': credentialCookie // 登录验证
                    },
                    responseType: 'json',
                    http2: true
                });

                const json = response.body;
                if (json.code !== 0) {
                    const biliCode = typeof json.code === 'number' ? json.code : 'unknown';
                    const biliMessage = json.message || json.msg || '未知业务错误';
                    return {
                        success: false,
                        message: `第${pageNum}页获取失败: B站返回 code=${biliCode}, message=${biliMessage}`
                    };
                }

                return { success: true, data: json.data };
            };

            const firstPageResult = await fetchSeasonPage(1);
            if (!firstPageResult.success) {
                return firstPageResult;
            }

            const firstData = firstPageResult.data || {};
            const mergedArchives = Array.isArray(firstData.archives) ? [...firstData.archives] : [];
            const mergedAids = Array.isArray(firstData.aids) ? [...firstData.aids] : [];

            const totalFromResponse = Number.parseInt(firstData?.page?.total, 10);
            const totalCount = Number.isFinite(totalFromResponse) && totalFromResponse > 0
                ? totalFromResponse
                : (Number.isFinite(normalizedEpCount) && normalizedEpCount > 0 ? normalizedEpCount : mergedArchives.length);

            const pagesByTotal = Math.max(1, Math.ceil(totalCount / pageSize));
            const pagesByEpCount = Number.isFinite(normalizedEpCount) && normalizedEpCount > 0
                ? Math.ceil(normalizedEpCount / pageSize)
                : 1;
            const totalPages = Math.max(pagesByTotal, pagesByEpCount);

            for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
                const pageResult = await fetchSeasonPage(pageNum);
                if (!pageResult.success) {
                    return pageResult;
                }

                const pageData = pageResult.data || {};
                if (Array.isArray(pageData.archives)) {
                    mergedArchives.push(...pageData.archives);
                }
                if (Array.isArray(pageData.aids)) {
                    mergedAids.push(...pageData.aids);
                }
            }

            // 去重，避免分页边界重复数据
            const uniqueArchives = [];
            const archiveKeySet = new Set();
            for (const item of mergedArchives) {
                const key = item?.bvid || item?.aid;
                if (!key || archiveKeySet.has(key)) {
                    continue;
                }
                archiveKeySet.add(key);
                uniqueArchives.push(item);
            }

            const uniqueAids = [...new Set(mergedAids)];

            return {
                success: true,
                data: {
                    ...firstData,
                    archives: uniqueArchives,
                    aids: uniqueAids,
                    page: {
                        ...(firstData.page || {}),
                        page_num: 1,
                        page_size: pageSize,
                        total: totalCount
                    }
                }
            };
        } catch (error) {
            const statusCode = error?.response?.statusCode;
            const statusMessage = error?.response?.statusMessage;
            const body = error?.response?.body;

            let remoteCode = null;
            let remoteMessage = null;

            if (body && typeof body === 'object') {
                remoteCode = body.code;
                remoteMessage = body.message || body.msg;
            }

            const detailParts = [];
            if (statusCode) {
                detailParts.push(`HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ''}`);
            }
            if (error?.code) {
                detailParts.push(`错误码 ${error.code}`);
            }
            if (remoteCode !== null && remoteCode !== undefined) {
                detailParts.push(`B站code=${remoteCode}`);
            }
            if (remoteMessage) {
                detailParts.push(`B站message=${remoteMessage}`);
            }
            if (error?.message) {
                detailParts.push(`异常=${error.message}`);
            }

            return {
                success: false,
                message: detailParts.length > 0
                    ? `获取合集请求失败: ${detailParts.join(' | ')}`
                    : '获取合集请求失败: 未知错误'
            };
        }
    });
}