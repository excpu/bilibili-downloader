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

module.exports = { fetchCdnList };
