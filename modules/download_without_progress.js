// 此文件用于小文件下载，不会返回进度
// 请勿在此文件传入不安全的下载路径
const fs = require('fs');
const got = require('got');
const { pipeline } = require('stream/promises');

const zlib = require('zlib'); // 引入 zlib
const { PassThrough } = require('stream'); // 引入 PassThrough

const Auth = require('../modules/auth');
const auth = new Auth();

async function downloadFile(url, outputPath, credential = true, http2Enable = true) {
    const headers = {
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };

    if (credential) {
        headers['Cookie'] = auth.getConstructedCookie();
    }

    try {
        //设置 decompress: false，防止 got 内部自动解压抛错
        const downloadStream = got.stream(url, {
            headers,
            http2: http2Enable,
            retry: 0,
            decompress: false, // 禁用自动解压，手动接管
            throwHttpErrors: true
        });

        // 处理基础网络错误
        downloadStream.on('error', (error) => {
            console.error('❌ 网络请求失败：', error.message);
        });

        const fileWriter = fs.createWriteStream(outputPath);

        // 2. 核心逻辑：监听 response 事件，根据响应头动态选择解压器
        const responsePromise = new Promise((resolve, reject) => {
            downloadStream.on('response', async (res) => {
                try {
                    const encoding = res.headers['content-encoding'];
                    let decompressor;

                    // 根据不同的编码类型选择解压流
                    if (encoding === 'gzip') {
                        decompressor = zlib.createGunzip();
                    } else if (encoding === 'br') {
                        decompressor = zlib.createBrotliDecompress();
                    } else if (encoding === 'deflate') {
                        // B站弹幕报错是因为缺少标头，使用 createInflateRaw 处理
                        decompressor = zlib.createInflateRaw();
                    } else {
                        // 无压缩或未知压缩，直接透传
                        decompressor = new PassThrough();
                    }

                    // 执行 pipeline 传输
                    await pipeline(
                        downloadStream,
                        decompressor,
                        fileWriter
                    );
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            // 确保 downloadStream 本身的错误能被捕获
            downloadStream.on('error', reject);
        });

        await responsePromise;

    } catch (error) {
        if (error.response) {
            console.error(`❌ 下载失败：HTTP ${error.response.statusCode} ${error.response.statusMessage || ''}`);
        }
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