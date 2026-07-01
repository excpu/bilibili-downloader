// 用于获取 Bilibili 的 buvid3 / buvid4 / b_nut，减少风控概率
// 参考: https://github.com/BACNext/bilibili-API-collect-backup/blob/master/docs/misc/buvid3_4.md
const got = require('got');

const DEFAULT_HEADERS = {
    Referer: 'https://www.bilibili.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
};

function extractCookieValue(setCookieHeaders, key) {
    if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
        return '';
    }

    const prefix = `${key}=`;
    for (const cookieLine of setCookieHeaders) {
        if (typeof cookieLine !== 'string') {
            continue;
        }
        const parts = cookieLine.split(';');
        if (parts.length === 0) {
            continue;
        }
        const firstPair = parts[0].trim();
        if (!firstPair.startsWith(prefix)) {
            continue;
        }
        return firstPair.slice(prefix.length);
    }

    return '';
}

async function getBuvid3FromWebFrontend() {
    const response = await got('https://api.bilibili.com/x/web-frontend/getbuvid', {
        method: 'GET',
        headers: DEFAULT_HEADERS,
        responseType: 'json',
        http2: true
    });

    const body = response.body || {};
    const buvid3 = body?.data?.buvid || '';
    return {
        buvid3,
        raw: body
    };
}

async function getBuvid34FromSpi() {
    const response = await got('https://api.bilibili.com/x/frontend/finger/spi', {
        method: 'GET',
        headers: DEFAULT_HEADERS,
        responseType: 'json',
        http2: true
    });

    const body = response.body || {};
    return {
        buvid3: body?.data?.b_3 || '',
        buvid4: body?.data?.b_4 || '',
        raw: body
    };
}

async function getBuvid3AndNutFromHomepageHeaders() {
    let response;
    try {
        response = await got('https://www.bilibili.com/', {
            method: 'HEAD',
            headers: DEFAULT_HEADERS,
            throwHttpErrors: false,
            http2: true
        });
    } catch (error) {
        response = await got('https://www.bilibili.com/', {
            method: 'GET',
            headers: DEFAULT_HEADERS,
            throwHttpErrors: false,
            http2: true
        });
    }

    const setCookieHeaders = response.headers['set-cookie'];
    const cookieArray = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : (typeof setCookieHeaders === 'string' ? [setCookieHeaders] : []);

    return {
        buvid3: extractCookieValue(cookieArray, 'buvid3'),
        bNut: extractCookieValue(cookieArray, 'b_nut'),
        setCookieHeaders: cookieArray
    };
}

async function refreshBuvidCredentials() {
    const [spiResult, headerResult, buvidOnlyResult] = await Promise.allSettled([
        getBuvid34FromSpi(),
        getBuvid3AndNutFromHomepageHeaders(),
        getBuvid3FromWebFrontend()
    ]);

    const spi = spiResult.status === 'fulfilled' ? spiResult.value : { buvid3: '', buvid4: '' };
    const header = headerResult.status === 'fulfilled' ? headerResult.value : { buvid3: '', bNut: '' };
    const buvidOnly = buvidOnlyResult.status === 'fulfilled' ? buvidOnlyResult.value : { buvid3: '' };

    const buvid3 = spi.buvid3 || header.buvid3 || buvidOnly.buvid3 || '';
    const buvid4 = spi.buvid4 || '';
    const b_nut = header.bNut || '';

    return {
        buvid3,
        buvid4,
        b_nut,
        refreshedAt: Date.now()
    };
}

module.exports = {
    getBuvid3FromWebFrontend,
    getBuvid34FromSpi,
    getBuvid3AndNutFromHomepageHeaders,
    refreshBuvidCredentials
};