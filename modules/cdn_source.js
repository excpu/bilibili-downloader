const fs = require('fs');
const path = require('path');

const CDN_LIST_URL = 'https://kanda-akihito-kun.github.io/ccb/api/cdn.json';
const FALLBACK_PATH = path.join(__dirname, '..', 'web', 'example', 'cdn.json');
const FETCH_TIMEOUT_MS = 5000;

let cachedList = null;

function loadFallbackList() {
    const data = fs.readFileSync(FALLBACK_PATH, 'utf-8');
    return JSON.parse(data);
}

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
        console.warn('获取远程 CDN 列表失败，使用本地示例文件:', error.message);
        try {
            cachedList = loadFallbackList();
        } catch (fallbackError) {
            console.error('加载本地 CDN 示例文件失败:', fallbackError);
            cachedList = {};
        }
    }

    return cachedList;
}

module.exports = { fetchCdnList };
