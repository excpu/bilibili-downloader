// 此文件用于小文件下载，不会返回进度
// 请勿在此文件传入不安全的下载路径
const fs = require('fs');
const got = require('got');
const { pipeline } = require('stream/promises');

const Auth = require('../modules/auth');
const auth = new Auth();

async function downloadFile(url, outputPath, credential = true) {
    const headers = {
        'Referer': 'https://www.bilibili.com/',
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0.1 Safari/605.1.15',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5',
        'DNT': '1',
        'Host': getHttpHostHeader(url),
        'Priority': 'u=5, i',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Storage-Access': 'none',
        'TE': 'trailers'
    };

    // 动态添加 Cookie
    if (credential) {
        headers['Cookie'] = auth.getConstructedCookie();
    }

    try {
        // 创建 got 流实例
        const downloadStream = got.stream(url, {
            headers,
            http2: true, // 启用 HTTP/2
            retry: 2,    // 重试2次
            throwHttpErrors: true // 如果状态码不是 2xx，抛出错误
        });

        // 处理请求错误（例如 DNS 解析失败、404 等）
        downloadStream.on('error', (error) => {
            console.error('❌ 网络请求失败：', error.message);
        });

        const fileWriter = fs.createWriteStream(outputPath);

        // 使用 stream/promises 的 pipeline
        await pipeline(
            downloadStream,
            fileWriter
        );

    } catch (error) {
        // 捕获 pipeline 或请求阶段抛出的所有异常
        console.error('❌ 写入文件或网络请求弹幕失败：', error);
        throw error;
    }
}

function getHttpHostHeader(urlString) {
    try {
        const url = new URL(urlString);
        // .host 返回 "域名:端口" 
        // 注意：如果是协议默认端口（如 https 的 443），它会自动省略端口部分
        return url.host;
    } catch (error) {
        return null;
    }
}

module.exports = downloadFile;