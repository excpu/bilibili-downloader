// 用于获取BiliBili中的 buvid3 / buvid4 / b_nut 减少风控的可能性
// 相关实现参考 https://github.com/BACNext/bilibili-API-collect-backup/blob/master/docs/misc/buvid3_4.md  Fork版本
const Auth = require('./auth');
const axios = require("axios");


async function getBvid34() {
    //const cookie = auth.getConstructedCookie(); // 获取构造好的 Cookie，包含 buvid3 / buvid4 / b_nut 来减少风控的可能性
    try {
        const response = await axios.get('https://api.bilibili.com/x/frontend/finger/spi', {
            headers: {
                'Referer': 'https://www.bilibili.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            }
        });
        return response.data;
    } catch (error) {
        console.error('获取 buvid3_4_nut 时出错:', error);
        throw error;
    }
}

async function getNut() {
    //const cookie = auth.getConstructedCookie();
    try {
        const response = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
            headers: {
                'Referer': 'https://www.bilibili.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                //'Cookie': cookie
            }
        });
        return response.data.data.nut;
    } catch (error) {
        console.error('获取 b_nut 时出错:', error);
        throw error;
    }
}

module.exports = {
    getBvid34,
    getNut
};