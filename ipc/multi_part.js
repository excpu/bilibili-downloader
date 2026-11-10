const { ipcMain } = require('electron');
const got = require('got');
const Auth = require('../modules/auth');
const { encWbi, getWbiKeys } = require('../modules/wbi');
const { resolveBvid, buildTimeline } = require('../modules/multi_part');

const auth = new Auth();

module.exports = function registerMultiPartIpc() {
    ipcMain.handle('resolveMultiPartVideo', async (event, input) => {
        try {
            const bvid = await resolveBvid(input);
            await auth.ensureBuvidCredentials();
            const keys = await getWbiKeys();
            const query = encWbi({ bvid, web_location: 1315873 }, keys.img_key, keys.sub_key);
            const response = await got(`https://api.bilibili.com/x/web-interface/wbi/view?${query}`, {
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
                    'Cookie': auth.getConstructedCookie(),
                },
                responseType: 'json',
                http2: true,
            });
            if (response.body.code !== 0 || !response.body.data) {
                throw new Error(response.body.message || '获取视频信息失败');
            }
            return { success: true, data: buildTimeline({ ...response.body.data, bvid }) };
        } catch (error) {
            console.error('解析分P视频失败:', error);
            return { success: false, message: error.message || '解析视频失败' };
        }
    });
};
