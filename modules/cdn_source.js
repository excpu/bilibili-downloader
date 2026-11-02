const fs = require('fs');
const path = require('path');

const CDN_LIST_URL = 'https://bapi.5share.site/api.php';
const FETCH_TIMEOUT_MS = 50000;

let cachedList = null;

// 获取 CDN 列表，优先请求远程接口，失败时回退到本地示例文件
async function fetchCdnList() {
    if (cachedList) return cachedList;

    try {
        const response = await fetch(CDN_LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!json || typeof json !== 'object') throw new Error('CDN 列表格式不正确');
        cachedList = json;
    } catch (error) {
        console.error('获取远程 CDN 列表失败:', error.message);
    }

    return cachedList;
}

// 规范化用户自定义的 CDN 主机：允许粘贴完整 URL，最终只保留主机名
function normalizeCdnHost(raw) {
    let value = String(raw ?? '').trim();
    if (!value) return '';

    // 去掉协议、userinfo、端口与路径，仅留下 hostname
    value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    value = value.split(/[/?#]/)[0];
    value = value.slice(value.lastIndexOf('@') + 1);
    value = value.split(':')[0].trim().toLowerCase();
    value = value.replace(/\.+$/, '');

    if (!value || value.length > 253) return '';

    // 逐段校验标签长度与字符集，拒绝空白、通配符等非法主机名
    const labels = value.split('.');
    const valid = labels.every((label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
    );

    return valid ? value : '';
}

module.exports = { fetchCdnList, normalizeCdnHost };
