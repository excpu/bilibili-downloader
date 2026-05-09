const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ================== 工具函数 ==================

function sanitizeFilename(name) {
    if (!name) return 'untitled';
    // 去掉非法字符
    let safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    // 去掉控制字符
    safeName = safeName.replace(/[\x00-\x1f]/g, '');
    safeName = safeName.replace(/^[ .]+|[ .]+$/g, ''); // strip 两端的点和空格
    return safeName || 'untitled';
}

function buildOutputName(entry, mode) {
    const title = entry.title || 'untitled';
    const pageData = entry.page_data || {};
    const part = pageData.part;
    const partStr = (part !== null && part !== undefined && part !== '') ? String(part) : '';

    let baseName = title;
    if (mode === 'title_part') {
        baseName = partStr ? `${title}-${partStr}` : title;
    } else if (mode === 'part_title') {
        baseName = partStr ? `${partStr}-${title}` : title;
    }
    return sanitizeFilename(baseName);
}

// 递归查找媒体文件
function findMediaFiles(entryDir) {
    let videoPath = null;
    let audioPath = null;
    let danmakuPath = null;

    function searchDir(currentPath) {
        const items = fs.readdirSync(currentPath, { withFileTypes: true });
        const fileNames = items.filter(i => i.isFile()).map(i => i.name);

        if (fileNames.includes('video.m4s') && fileNames.includes('audio.m4s')) {
            videoPath = path.join(currentPath, 'video.m4s');
            audioPath = path.join(currentPath, 'audio.m4s');

            // 弹幕在上一级目录
            const parentDir = path.dirname(currentPath);
            const maybeDanmaku = path.join(parentDir, 'danmaku.xml');
            if (fs.existsSync(maybeDanmaku)) {
                danmakuPath = maybeDanmaku;
            }
            return true; // 找到了就停止当前分支深入
        }

        for (const item of items) {
            if (item.isDirectory()) {
                if (searchDir(path.join(currentPath, item.name))) return true;
            }
        }
        return false;
    }

    searchDir(entryDir);
    return { videoPath, audioPath, danmakuPath };
}

// ================== 智能提取逻辑 ==================

function extractNumberFromString(text) {
    if (!text) return null;
    text = String(text);

    const headPatterns = [
        /^\s*[Pp]?\s*(\d{1,3})\b/,                     // P1, p01
        /^\s*第\s*(\d{1,4})\s*[话話集部季章节]/,         // 第1集
        /^\s*(?:EP|Ep|ep)\s*(\d{1,4})\b/,              // EP01
        /^[\[\(【（]\s*(\d{1,4})\s*[\]\)】）]/,         // [01]
        /^\s*(\d{1,4})\s*[-：:、\. ]/                  // 01-标题
    ];
    for (const pat of headPatterns) {
        const m = text.match(pat);
        if (m) return parseInt(m[1], 10);
    }

    const innerPatterns = [
        /#\s*(\d{1,4})\b/,                             // #104
        /第\s*(\d{1,4})\s*[话話集部季章节]/,
        /(?:EP|Ep|ep)\s*(\d{1,4})\b/
    ];
    for (const pat of innerPatterns) {
        const m = text.match(pat);
        if (m) return parseInt(m[1], 10);
    }

    return null;
}

function extractCandidates(entry) {
    const pageData = entry.page_data || {};
    let pageNo = null;

    if (typeof pageData.page === 'number' && pageData.page > 0) {
        pageNo = pageData.page;
    } else if (typeof pageData.page === 'string') {
        if (/^\d+$/.test(pageData.page)) pageNo = parseInt(pageData.page, 10);
        else pageNo = extractNumberFromString(pageData.page);
    }

    return {
        page: pageNo,
        part: extractNumberFromString(pageData.part),
        title: extractNumberFromString(entry.title)
    };
}

function getTimestamp(entry) {
    const t1 = entry.time_create_stamp;
    const t2 = entry.time_update_stamp;
    const val = t1 || t2;
    if (val) return parseInt(val, 10);
    return 0;
}

function chooseBestSource(items) {
    const sources = ["page", "part", "title"];
    let best = "page";
    let bestScore = -Infinity;

    for (const src of sources) {
        const nums = items.map(it => it.cand[src]).filter(n => n !== null);
        const coverage = nums.length;
        const uniq = new Set(nums).size;
        const dup = coverage - uniq;

        let inversions = 0;
        let prev = null;
        for (const it of items) {
            const n = it.cand[src];
            if (n === null) continue;
            if (prev !== null && n < prev) inversions++;
            prev = n;
        }

        const score = coverage * 1000 + uniq * 10 - dup * 200 - inversions * 20;
        if (score > bestScore) {
            bestScore = score;
            best = src;
        }
    }
    return best;
}

// 遍历收集
function collectEntries(inputRoot, sendLog) {
    const items = [];
    let idx = 0;

    function walk(dir) {
        let files;
        try {
            files = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }

        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                walk(fullPath);
            } else if (file.name === 'entry.json') {
                try {
                    const data = fs.readFileSync(fullPath, 'utf-8');
                    const entry = JSON.parse(data);
                    items.push({
                        path: fullPath,
                        entry: entry,
                        cand: extractCandidates(entry),
                        timestamp: getTimestamp(entry),
                        discover_index: idx++
                    });
                } catch (e) {
                    sendLog(`[WARN] 无法解析 JSON: ${fullPath}  错误: ${e.message}`);
                }
            }
        }
    }

    walk(inputRoot);
    return items;
}

// ================== 核心执行逻辑 ==================
// ffmpeg 用于合并Dash 音视频
let ffmpeg = require('ffmpeg-static');
// asar 修正
if (app.isPackaged && ffmpeg.includes('app.asar')) {
    ffmpeg = ffmpeg.replace('app.asar', 'app.asar.unpacked');
}

function runFFmpeg(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        // 如果环境变量或者根目录有特定 ffmpeg，你可以改这里，默认调系统环境变量
        const ffmpegCmd = ffmpeg;
        const args = ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath];

        // windowsHide: true 对应 Python 版的 CREATE_NO_WINDOW
        const child = spawn(ffmpegCmd, args, { windowsHide: true });

        let errLog = '';
        child.stderr.on('data', data => { errLog += data.toString(); });

        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code ${code}\n${errLog.slice(-1000)}`));
        });

        child.on('error', err => {
            reject(new Error(`启动失败(请检查系统是否安装FFmpeg): ${err.message}`));
        });
    });
}

module.exports = function registerMergeIpc() {
    // 选择目录
    ipcMain.handle('open-dir-dialog', async (event) => {
        // event.sender 就是发送指令的 mergeWindow 的 webContents
        const senderWindow = BrowserWindow.fromWebContents(event.sender);

        const result = await dialog.showOpenDialog(senderWindow, {
            properties: ['openDirectory'],
            title: '请选择目录'
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });
    ipcMain.on('start-merge', async (event, config) => {
        const sendLog = (msg) => event.sender.send('log', msg);

        const { inputDir, outputDir, namingMode, addPrefix, copyDanmaku } = config;
        sendLog("[INFO] 开始任务...");

        sendLog(`[INFO] 输入目录: ${inputDir}`);
        sendLog(`[INFO] 输出目录: ${outputDir}`);

        if (!fs.existsSync(inputDir)) {
            sendLog("[ERROR] 输入目录不存在");
            event.sender.send('merge-done');
            return;
        }

        const items = collectEntries(inputDir, sendLog);

        if (items.length === 0) {
            sendLog("[WARN] 未发现任何 entry.json");
            event.sender.send('merge-done');
            return;
        }

        let prefixWidth = 0;

        if (addPrefix) {
            const bestSrc = chooseBestSource(items);
            sendLog(`[INFO] 已启用猜测顺序：自动选择来源 = ${bestSrc}（page/part/title 中最靠谱的一项）`);

            for (const it of items) {
                const c = it.cand;
                let ep_no = c[bestSrc];
                if (ep_no === null || ep_no === undefined) {
                    ep_no = c.page ?? c.part ?? c.title;
                }
                it.ep_no = ep_no;
            }

            items.sort((a, b) => {
                const aHasEp = a.ep_no !== null && a.ep_no !== undefined;
                const bHasEp = b.ep_no !== null && b.ep_no !== undefined;

                if (aHasEp !== bHasEp) return aHasEp ? -1 : 1; // 有序号的排前面
                if (aHasEp && bHasEp && a.ep_no !== b.ep_no) return a.ep_no - b.ep_no;

                if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
                return a.discover_index - b.discover_index;
            });

            prefixWidth = Math.max(2, String(items.length).length);
            sendLog(`[INFO] 已启用顺序前缀：共 ${items.length} 个条目，前缀位数 = ${prefixWidth}`);
        } else {
            items.sort((a, b) => a.discover_index - b.discover_index);
            sendLog("[INFO] 未启用猜测顺序：按文件系统扫描顺序处理（不排序、不加前缀）");
        }

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // 异步逐个处理，避免阻塞主进程导致界面卡死
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            sendLog(`\n[INFO] 处理配置文件: ${item.path}`);

            const entryDir = path.dirname(item.path);
            const { videoPath, audioPath, danmakuPath } = findMediaFiles(entryDir);

            if (!videoPath || !fs.existsSync(videoPath)) {
                sendLog(`[WARN] 未找到 video.m4s，跳过: ${entryDir}`);
                continue;
            }
            if (!audioPath || !fs.existsSync(audioPath)) {
                sendLog(`[WARN] 未找到 audio.m4s，跳过: ${entryDir}`);
                continue;
            }

            let baseName = buildOutputName(item.entry, namingMode);
            let finalPrefix = "";
            if (addPrefix) {
                finalPrefix = String(i + 1).padStart(prefixWidth, '0') + "-";
                baseName = finalPrefix + baseName;
            }

            let outputPath = path.join(outputDir, `${baseName}.mp4`);
            let idx = 1;
            while (fs.existsSync(outputPath)) {
                outputPath = path.join(outputDir, `${baseName}(${idx}).mp4`);
                idx++;
            }

            sendLog(`[INFO] 找到视频: ${videoPath}`);
            sendLog(`[INFO] 找到音频: ${audioPath}`);
            sendLog(`[INFO] 输出目标: ${outputPath}`);

            if (copyDanmaku && danmakuPath && fs.existsSync(danmakuPath)) {
                const xmlOutputPath = outputPath.replace(/\.mp4$/, '.xml');
                try {
                    fs.copyFileSync(danmakuPath, xmlOutputPath);
                    sendLog(`[INFO] 已复制弹幕: -> ${xmlOutputPath}`);
                } catch (e) {
                    sendLog(`[WARN] 复制弹幕失败: ${e.message}`);
                }
            }

            try {
                await runFFmpeg(videoPath, audioPath, outputPath);
                sendLog(`[OK] 合成成功: ${outputPath}`);
            } catch (err) {
                sendLog(`[ERROR] ffmpeg 合成失败: ${err.message}`);
            }
        }

        sendLog(`\n[INFO] 处理完成，共发现 ${items.length} 个 entry.json`);
        sendLog(`[INFO] 所有任务完成。`);
        event.sender.send('merge-done');
    });
};