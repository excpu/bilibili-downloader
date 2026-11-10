const got = require('got');

const BVID = /^BV[0-9A-Za-z]{10}$/;
const LINK_HOSTS = new Set(['b23.tv', 'www.bilibili.com', 'm.bilibili.com', 'bilibili.com']);

async function resolveBvid(input) {
    if (typeof input !== 'string') throw new Error('请输入 BV 号或视频链接');
    const value = input.trim();
    if (BVID.test(value)) return value;
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('请输入有效的 BV 号或 B站视频链接');
    }
    for (let redirects = 0; redirects < 5; redirects++) {
        if (!['http:', 'https:'].includes(url.protocol) || !LINK_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
            throw new Error('仅支持 B站视频链接和 b23.tv 短链接');
        }
        const match = url.pathname.match(/(?:^|\/)(BV[0-9A-Za-z]{10})(?:\/|$)/);
        if (match) return match[1];
        if (url.hostname.toLowerCase() !== 'b23.tv') break;
        const response = await got(url.toString(), {
            followRedirect: false,
            throwHttpErrors: false,
            timeout: 10000,
            retry: 0,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (response.statusCode < 300 || response.statusCode >= 400 || !response.headers.location) {
            throw new Error('无法解析 B站短链接');
        }
        url = new URL(response.headers.location, url);
    }
    throw new Error('链接中没有有效的 BV 号');
}

function buildTimeline(data) {
    if (!data || !Array.isArray(data.pages) || !data.pages.length) {
        throw new Error('未获取到分P信息');
    }
    let duration = 0;
    const parts = data.pages.map((page, index) => {
        const length = Number(page.duration);
        const cid = Number(page.cid);
        if (!Number.isFinite(length) || length <= 0 || !Number.isSafeInteger(cid) || cid <= 0) {
            throw new Error(`第 ${index + 1} P 的时长或 CID 无效`);
        }
        const part = { cid, duration: length, start: duration, title: page.part || `P${index + 1}` };
        duration += length;
        return part;
    });
    return { bvid: data.bvid, title: data.title, duration, parts };
}

module.exports = { resolveBvid, buildTimeline };
