// 此文件用于小文件下载，不会返回进度
// 请勿在此文件传入不安全的下载路径
const fs = require('fs');
const axios = require("axios");

const Auth = require('../modules/auth');
const auth = new Auth();

async function downloadFile(url, outputPath, credential = true) {
    const credentialCookie = auth.getConstructedCookie();
    let response;

    try {
        if (credential) {
            response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Cookie': credentialCookie
                }
            });
        } else {
            response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: {
                    'Referer': 'https://www.bilibili.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                }
            });
        }
    } catch (error) {
        console.error('❌ 网络请求弹幕失败：', error);
        throw error;
    }

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', (err) => {
            writer.close(); // 写入出错时安全关闭流
            reject(err);
        });
    });
}

module.exports = downloadFile;