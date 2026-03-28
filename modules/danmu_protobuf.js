const axios = require('axios');
const protobuf = require('protobufjs');
const path = require('path');
// 身份验证相关
const Auth = require('./auth');
const auth = new Auth();

// WBI 相关
const { encWbi, getWbiKeys } = require('./wbi');

/**
 * 延迟函数
 * @param {number} ms 毫秒
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 转义 XML 特殊字符
 */
function escapeXml(unsafe) {
    return unsafe.replace(/[<>&"']/g, (m) => {
        switch (m) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return m;
        }
    });
}

/**
 * 获取视频弹幕（支持自动抓取全部分段）
 */
async function fetchAllVideoDanmaku(cid, duration) {
    // 1. 加载 Proto 文件
    const protoPath = path.join(__dirname, '..', 'assets', 'proto', 'dm.proto');

    let DmSegMobileReply;
    try {
        const root = await protobuf.load(protoPath);
        // 必须使用完整路径 
        DmSegMobileReply = root.lookupType("bilibili.community.service.dm.v1.DmSegMobileReply");
    } catch (err) {
        throw new Error(`Proto 加载失败: ${err.message}`);
    }

    let allDanmakus = [];
    const totalSegments = Math.ceil(duration / 360);
    console.log(`视频时长 ${duration}s，共需下载 ${totalSegments} 个分段`);

    // 假设这些工具函数在你的上下文可用
    const credentialCookie = auth.getConstructedCookie();
    const wbiKeys = getWbiKeys();

    for (let i = 1; i <= totalSegments; i++) {
        try {
            console.log(` -正在请求分段 ${i}, OID: ${cid}`);

            // 2. 构造参数并进行 WBI 签名
            const params = {
                type: 1,      // 1:视频 [cite: 146]
                oid: cid,     // 视频 cid [cite: 145]
                segment_index: i
            };
            const wbiQuery = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key);

            // 3. 发送请求
            const response = await axios.get(`https://api.bilibili.com/x/v2/dm/wbi/web/seg.so?${wbiQuery}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.bilibili.com',
                    'Cookie': credentialCookie,
                    'Origin': 'https://www.bilibili.com'
                },
                responseType: 'arraybuffer'
            });

            // 4. 解析二进制数据
            const buffer = Buffer.from(response.data);

            console.log(`4. 收到数据长度: ${buffer.length} bytes`);


            if (buffer.length === 0) {
                hasMore = false;
                break;
            }

            const message = DmSegMobileReply.decode(buffer);

            // 确保 message 合法再转换 
            if (message && typeof message === 'object') {
                const result = DmSegMobileReply.toObject(message, {
                    longs: String,
                    enums: String
                });

                if (result.elems && result.elems.length > 0) {
                    allDanmakus = allDanmakus.concat(result.elems);

                    // 5. 随机延迟防止风控
                    const delay = Math.floor(Math.random() * 500) + 500;
                    await sleep(delay);
                } else {
                    // 没有更多弹幕
                    break;
                }
            } else {
                break;
            }

        } catch (e) {
            console.error(`读取分段 ${i} 失败:`, e.message);
            // 如果遇到特定错误码（如 403），可以在这里停止循环
            break;
        }
    }

    console.log(`获取完成，共计 ${allDanmakus.length} 条弹幕`);
    return allDanmakus;
}

/**
 * 构造完整的 XML 弹幕文件
 */
async function constructXMLDanmaku(cid, duration) {
    try {
        const danmakuList = await fetchAllVideoDanmaku(cid, duration);
        const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>${cid}</chatid><mission>0</mission><maxlimit>8000</maxlimit><state>0</state><real_name>0</real_name><source>k-v</source>`;
        const xmlFooter = `</i>`;

        const xmlBody = danmakuList.map(d => {
            // 1. 出现时间 (秒)
            const time = (d.progress / 1000).toFixed(5);
            // 2. 模式 (1-3滚动, 4底端, 5顶端, 6逆向, 7特殊, 8代码)
            const mode = d.mode || 1;
            // 3. 字号
            const fontSize = d.fontsize || 25;
            // 4. 颜色 (十进制)
            const color = d.color || 16777215;
            // 5. 发送时间戳 (Unix timestamp)
            const timestamp = d.ctime || Math.floor(Date.now() / 1000);
            // 6. 弹幕池 (0普通, 1字幕, 2特殊)
            const pool = d.pool || 0;
            // 7. 用户ID Hash
            const userHash = d.midHash || '0';
            // 8. 弹幕ID (使用 idStr 避免精度丢失)
            const dmid = d.idStr || d.id || '0';

            const pAttribute = [time, mode, fontSize, color, timestamp, pool, userHash, dmid].join(',');
            const content = escapeXml(d.content || '');

            return `<d p="${pAttribute}">${content}</d>`;
        }).join('\n');

        return xmlHeader + '\n' + xmlBody + '\n' + xmlFooter;
    } catch (error) {
        console.error('获取弹幕失败：', error);
        throw error;
    }
}

module.exports = {
    constructXMLDanmaku
};