// 这里处理观看历史和收藏夹相关的 API（供"从历史/收藏选择"模态框使用）
const { ipcMain } = require('electron');
const got = require('got');
const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');

const auth = new Auth();

const API_HEADERS = {
    'Referer': 'https://www.bilibili.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.1',
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
    'Cache-Control': 'no-cache',
    'Origin': 'https://www.bilibili.com',
};

async function libraryGet(url) {
    await auth.ensureBuvidCredentials();
    const response = await got(url, {
        method: 'GET',
        headers: {
            ...API_HEADERS,
            'Cookie': await auth.getConstructedCookie() // 登录验证（SESSDATA 等）
        },
        responseType: 'json',
        http2: true
    });
    return response.body;
}

// 拉取视频合集（season）内的稿件：合集不能用 fav/resource/list，要走 seasons_archives_list（WBI 签名）
async function fetchSeasonArchives(seasonId, mid, pageNum = 1, pageSize = 20) {
    const wbiKeys = await getWbiKeys();
    const params = {
        mid: String(mid),
        season_id: String(seasonId),
        page_num: String(pageNum),
        page_size: String(pageSize)
    };
    const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);
    const json = await libraryGet(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?${wbiQuery}`);
    if (json.code !== 0) {
        return { success: false, code: json.code, message: json.message || '获取合集内容失败' };
    }
    const total = Number.parseInt(json.data?.page?.total, 10) || 0;
    return { success: true, archives: json.data?.archives || [], total };
}

module.exports = function registerLibraryIpc() {
    // 获取观看历史（仅视频稿件）
    ipcMain.handle('getWatchHistory', async (event, cursor = null) => {
        try {
                if (!await auth.loadLoginStatus()) {
                return { success: false, code: -101, message: '请先登录 B 站账号' };
            }
            const query = new URLSearchParams({
                type: 'archive', // 只要视频历史记录
                ps: '20',
                view_at: String(cursor?.view_at ?? 0),
                max: String(cursor?.max ?? 0),
                business: String(cursor?.business ?? ''),
            });
            const json = await libraryGet(`https://api.bilibili.com/x/web-interface/history/cursor?${query.toString()}`);
            if (json.code === 0) {
                const rawList = json.data?.list || [];
                const list = rawList.filter(item => item?.history?.business === 'archive' && item?.history?.bvid);
                return { success: true, list, rawCount: rawList.length, cursor: json.data?.cursor || null };
            }
            return { success: false, code: json.code, message: json.message || '获取历史记录失败' };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });

    // 获取收藏夹列表（自己创建的 + 收藏的）
    ipcMain.handle('getFavFolders', async () => {
        try {
                const data = await auth.load();
            const mid = Number(data?.DedeUserID || 0);
                            if (!await auth.loadLoginStatus() || !mid) {
                return { success: false, code: -101, message: '请先登录 B 站账号' };
            }
            const [createdJson, collectedJson] = await Promise.all([
                libraryGet(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}&type=2`),
                libraryGet(`https://api.bilibili.com/x/v3/fav/folder/collected/list?up_mid=${mid}&pn=1&ps=70&platform=web`),
            ]);
            if (createdJson.code !== 0) {
                return { success: false, code: createdJson.code, message: createdJson.message || '获取收藏夹列表失败' };
            }
            const folders = (createdJson.data?.list || []).map(item => ({
                id: item.id,
                title: item.title,
                media_count: item.media_count,
                kind: 'folder', // 自己创建的收藏夹
                own: true,
            }));
            if (collectedJson.code === 0) {
                const seen = new Set(folders.map(item => item.id));
                for (const item of collectedJson.data?.list || []) {
                    if (item.state === 1 || seen.has(item.id)) continue; // 跳过失效和重复的收藏夹
                    folders.push({
                        id: item.id,
                        title: item.title,
                        media_count: item.media_count,
                        // type=21 是"追的合集"：不能用 fav/resource/list，要走 seasons_archives_list
                        kind: item.type === 21 ? 'season' : 'folder',
                        ownerMid: item.mid,
                        upper: item.upper?.name || '',
                        own: false,
                    });
                }
            }
            return { success: true, folders };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });

    // 获取收藏夹内容明细（视频稿件 + 视频合集）；追的合集（kind=season）走合集稿件接口
    ipcMain.handle('getFavResources', async (event, payload = {}) => {
        try {
                if (!await auth.loadLoginStatus()) {
                return { success: false, code: -101, message: '请先登录 B 站账号' };
            }
            const { mediaId, pn = 1 } = payload;
            if (payload.kind === 'season') {
                const { seasonId, mid } = payload;
                if (!seasonId || !mid) {
                    return { success: false, message: '缺少合集参数 season_id 或 mid' };
                }
                const result = await fetchSeasonArchives(seasonId, mid, pn, 20);
                if (!result.success) {
                    return result;
                }
                const medias = result.archives
                    .filter(item => item?.bvid)
                    .map(item => ({
                        kind: 'video',
                        bvid: item.bvid,
                        title: item.title,
                        cover: item.pic,
                        duration: item.duration,
                        upper: payload.upper || '',
                        pub_time: item.pubdate || item.ctime,
                        invalid: false,
                    }));
                return { success: true, medias, hasMore: pn * 20 < result.total };
            }
            if (!mediaId) {
                return { success: false, message: '缺少 media_id 参数' };
            }
            const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${pn}&ps=20&order=mtime&type=0&rid=0`;
            const json = await libraryGet(url);
            if (json.code === 0) {
                const medias = (json.data?.medias || [])
                    .filter(item => (item?.type === 2 && item?.bvid) || item?.type === 21)
                    .map(item => {
                        if (item.type === 21) {
                            // 视频合集：id 即 ugc_season 的 season_id，bvid 可能为空
                            // attr 的失效语义只适用于稿件，合集不做失效判断，避免误标
                            return {
                                kind: 'collection',
                                seasonId: item.id,
                                mid: item.upper?.mid || item.mid,
                                bvid: item.bvid || '',
                                title: item.title,
                                cover: item.cover,
                                duration: 0,
                                upper: item.upper?.name || '',
                                fav_time: item.fav_time,
                                invalid: false,
                            };
                        }
                        return {
                            kind: 'video',
                            bvid: item.bvid,
                            title: item.title,
                            cover: item.cover,
                            duration: item.duration,
                            upper: item.upper?.name || '',
                            fav_time: item.fav_time,
                            invalid: item.attr !== 0,
                        };
                    });
                return { success: true, medias, hasMore: !!json.data?.has_more };
            }
            return { success: false, code: json.code, message: json.message || '获取收藏夹内容失败' };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });

    // 获取视频合集的第一条稿件（用于把收藏夹里的合集接入链接下载流程）
    ipcMain.handle('getCollectionFirstVideo', async (event, payload = {}) => {
        try {
            const { seasonId, mid } = payload;
            if (!seasonId || !mid) {
                return { success: false, message: '缺少合集参数 season_id 或 mid' };
            }
            const result = await fetchSeasonArchives(seasonId, mid, 1, 1);
            if (!result.success) {
                return result;
            }
            const first = result.archives[0];
            if (!first?.bvid) {
                return { success: false, message: '该合集暂无可下载视频' };
            }
            return { success: true, bvid: first.bvid, total: result.total };
        } catch (error) {
            return { success: false, message: '发生错误: ' + error.message };
        }
    });
};
