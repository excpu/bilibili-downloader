const $taskCount = document.getElementById('taskCount');
const $downloadDanmuCheckbox = document.getElementById("downloadDanmuCheckbox");
const $downloadCoverCheckbox = document.getElementById("downloadCoverCheckbox");

// 平滑下载速度， alpa 越小越平滑
class SpeedSmoother {
    constructor(alpha = 0.4, digits = 2) {
        this.alpha = alpha;
        this.digits = digits;
        this.smoothedValue = null;
    }

    /**
     * 输入: 速度字符串（如 "1.25", "800", "0.00"）
     * 输出: 平滑后的速度字符串（保留 this.digits 位小数）
     */
    update(speedStr) {
        const current = parseFloat(speedStr);

        // 如果解析失败，直接返回原字符串
        if (isNaN(current)) return speedStr;

        if (this.smoothedValue === null) {
            this.smoothedValue = current;
        } else {
            // 指数平滑
            this.smoothedValue =
                this.alpha * current +
                (1 - this.alpha) * this.smoothedValue;
        }

        // 返回字符串，保留指定小数
        return this.smoothedValue.toFixed(this.digits);
    }

    /**
     * 重置平滑状态
     */
    reset() {
        this.smoothedValue = null;
    }
}
const speedSmoothers = new Map();
const lastAvIdMap = new Map();


const lastTextUpdateTimeMap = new Map();
const TEXT_UPDATE_INTERVAL_MS = 1000; // 文字类信息（大小、速度、百分比、预计时间）节流为每 1 秒更新一次，避免频繁跳动

function getSpeedSmoother(uid) {
    if (!speedSmoothers.has(uid)) {
        speedSmoothers.set(uid, new SpeedSmoother(0.1));
    }
    return speedSmoothers.get(uid);
}

// 格式化字节大小函数
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// 格式化预计剩余时间（ETA）函数
function formatETA(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds === Infinity) {
        return '--:--';
    }
    const s = Math.round(seconds);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const unsubscribe = window.electronAPI.on('download-progress', (data) => {
    //console.log('进度来了：', data);
    // { percent: 30, speed: 123456, name: 'xxx' }
    // 添加容错：检查对应的DOM元素是否存在
    const progressEl = document.getElementById(`progress-${data.currentUid}`);
    const percentEl = document.getElementById(`percent-${data.currentUid}`);
    const statusEl = document.getElementById(`status-${data.currentUid}`);
    const speedEl = document.getElementById(`speed-${data.currentUid}`);
    const sizeEl = document.getElementById(`size-${data.currentUid}`);
    const etaEl = document.getElementById(`eta-${data.currentUid}`);
    
    if (!progressEl || !statusEl || !speedEl) {
        console.warn(`找不到对应的UI元素，uid: ${data.currentUid}`);
        return;
    }
    
    // 进度条保持高频实时更新（保留小数精度，平滑动画）
    progressEl.style.width = `${data.progress}%`;

    const avIdChanged = lastAvIdMap.get(data.currentUid) !== data.avId;
    if (avIdChanged) {
        lastAvIdMap.set(data.currentUid, data.avId);
        getSpeedSmoother(data.currentUid).reset();
    }

    if (data.avId === "audio") {
        statusEl.textContent = "下载音频中";
        statusEl.style.color = "var(--brand)";
    } else if (data.avId === "video") {
        statusEl.textContent = "下载视频中";
        statusEl.style.color = "var(--brand)";
    } else if (data.avId === "converting") {
        statusEl.textContent = "正在转码中...";
        statusEl.style.color = "var(--warn)";
    } else if (data.avId === "merging") {
        statusEl.textContent = "正在合并中...";
        statusEl.style.color = "var(--warn)";
    }

    // 每次高频数据到达时，持续平滑速度采样
    const smoother = getSpeedSmoother(data.currentUid);
    const smoothedSpeedStr = smoother.update(data.speed);

    // 文字类信息（大小、速度、整数百分比、预计时间）节流更新，避免过快刷新造成视觉疲劳与跳动
    const now = Date.now();
    const lastUpdate = lastTextUpdateTimeMap.get(data.currentUid) || 0;
    const isSpecialState = data.avId === "converting" || data.avId === "merging" || data.progress >= 100;
    const shouldUpdateText = avIdChanged || isSpecialState || (now - lastUpdate >= TEXT_UPDATE_INTERVAL_MS);

    if (shouldUpdateText) {
        lastTextUpdateTimeMap.set(data.currentUid, now);

        if (percentEl) {
            const intPercent = data.progress >= 100 ? 100 : Math.floor(Number(data.progress) || 0);
            percentEl.textContent = `${intPercent}%`;
        }

        speedEl.textContent = smoothedSpeedStr;

        const downloaded = Number(data.downloadedBytes) || 0;
        const total = Number(data.totalBytes) || 0;

        if (sizeEl) {
            if (total > 0) {
                sizeEl.textContent = `${formatBytes(downloaded)} / ${formatBytes(total)}`;
            } else if (downloaded > 0) {
                sizeEl.textContent = `${formatBytes(downloaded)} / --`;
            } else {
                sizeEl.textContent = '-- / --';
            }
        }

        if (etaEl) {
            if (data.avId === "converting" || data.avId === "merging" || data.progress >= 100) {
                etaEl.textContent = "00:00";
            } else if (total > 0 && downloaded > 0) {
                const remainingBytes = Math.max(0, total - downloaded);
                const speedMB = parseFloat(smoothedSpeedStr);
                const speedBytesPerSec = speedMB * 1024 * 1024;
                if (remainingBytes <= 0) {
                    etaEl.textContent = "00:00";
                } else if (speedBytesPerSec > 1024) {
                    const remainingSeconds = remainingBytes / speedBytesPerSec;
                    etaEl.textContent = formatETA(remainingSeconds);
                } else {
                    etaEl.textContent = "--:--";
                }
            } else {
                etaEl.textContent = "--:--";
            }
        }
    }
});

window.electronAPI.on('download-finished', (data) => {
    console.log('下载完成');
    speedSmoothers.delete(data);
    lastAvIdMap.delete(data);
    lastTextUpdateTimeMap.delete(data);
    let taskEle = document.getElementById(`task-${data}`);
    if (taskEle) {
        taskEle.remove();
    }
    // { percent: 30, speed: 123456, name: 'xxx' }
});

let taskQuene = [];

let globalTaskLock = false;

// taskQuene 子项格式
//{uid,bvid,cid,title,videoIndex,audioIndex,videoQualityId,videoCodec,audioQualityId,audioCodec}

function manageDownloadStart() {
    if (!currentVideoIdentity) {
        alert('请先获取视频信息');
        return;
    }
    const $qualitySelect = document.getElementById('qualitySelect');
    const videoIndex = parseInt($qualitySelect.value);
    const videoOption = $qualitySelect.options[$qualitySelect.selectedIndex];
    // 记录用户选择的“清晰度ID + 编码”，供主进程执行回退匹配。
    const videoQualityId = videoOption ? parseInt(videoOption.dataset.qualityId || '-1') : -1;
    const videoCodec = videoOption ? (videoOption.dataset.codec || '') : '';
    const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
    const audioIndex = parseInt($qualitySelectAudio.value);
    const audioOption = $qualitySelectAudio.options[$qualitySelectAudio.selectedIndex];
    // 音频同理：避免不同视频返回的可用流不一致时直接失败。
    const audioQualityId = audioOption ? parseInt(audioOption.dataset.qualityId || String(audioIndex)) : audioIndex;
    const audioCodec = audioOption ? (audioOption.dataset.codec || '') : '';
    currentVideoIdentity.danmu = $downloadDanmuCheckbox.checked;
    currentVideoIdentity.cover = $downloadCoverCheckbox.checked;
    // 如果是多P视频，生成多个下载任务
    if (currentVideoIdentity.isCollection && currentVideoIdentity.p.length === 0) {
        alert('请先展开合集视频或搜索全部详情');
        return;
    }
    if (currentVideoIdentity.p.length > 0 || currentVideoIdentity.isCollection) {
        const selectedParts = new Set(
            [...document.querySelectorAll('input[name="part[]"]:checked')]
                .map(item => item.value)
        );
        for (let i = 0; i < currentVideoIdentity.p.length; i++) {
            const partInfo = currentVideoIdentity.p[i];
            const uid = `${Date.now()}${Math.round(Math.random() * 1000)}_P${i}`;
            const selectionId = currentVideoIdentity.isCollection ? partInfo.selectionId : String(i);
            if (!selectedParts.has(selectionId)) {
                continue;
            }

            const taskBvid = partInfo.bvid || currentVideoIdentity.bvid;
            const taskCid = partInfo.cid || null;
            const taskTitle = currentVideoIdentity.isCollection
                ? `E${partInfo.episode}P${partInfo.page} - ${partInfo.episodeTitle} - ${partInfo.part}`
                : `P${partInfo.page} - ${currentVideoIdentity.title} - ${partInfo.part}`;

            const videoEle = {
                uid,
                bvid: taskBvid,
                cid: taskCid,
                title: taskTitle,
                duration: Number(partInfo.duration) || Number(currentVideoIdentity.duration) || 0,
                videoIndex,
                audioIndex,
                videoQualityId,
                videoCodec,
                audioQualityId,
                audioCodec,
                danmu: currentVideoIdentity.danmu,
                cover: currentVideoIdentity.cover,
                coverUrl: partInfo.coverUrl || currentVideoIdentity.coverUrl,
                needFetchCid: !taskCid
            }
            taskQuene.push(videoEle);
            displayTasks(videoEle);
        }
    } else {
        const uid = `${Date.now()}${Math.round(Math.random() * 1000)}`;
        const videoEle = {
            uid,
            bvid: currentVideoIdentity.bvid,
            cid: currentVideoIdentity.cid,
            title: currentVideoIdentity.title,
            duration: currentVideoIdentity.duration,
            videoIndex,
            audioIndex,
            videoQualityId,
            videoCodec,
            audioQualityId,
            audioCodec,
            danmu: currentVideoIdentity.danmu,
            cover: currentVideoIdentity.cover,
            coverUrl: currentVideoIdentity.coverUrl,
            needFetchCid: !currentVideoIdentity.cid
        }
        taskQuene.push(videoEle);
        displayTasks(videoEle);
    }
    taskManager();
}

// DOM 插入HTML元素，显示下载任务
function displayTasks(newTask) {
    const $taskItem = document.createElement("div");
    $taskItem.className = "task";
    $taskItem.id = "task-" + newTask.uid;

    const headerDiv = document.createElement("div");
    headerDiv.className = "task-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.title = newTask.title;
    titleSpan.textContent = newTask.title;
    headerDiv.appendChild(titleSpan);

    const percentSpan = document.createElement("span");
    percentSpan.className = "task-percent";
    percentSpan.id = "percent-" + newTask.uid;
    percentSpan.textContent = "0%";
    headerDiv.appendChild(percentSpan);

    const progressDiv = document.createElement("div");
    progressDiv.className = "progress";

    const progressBar = document.createElement("i");
    progressBar.id = "progress-" + newTask.uid;
    progressBar.style.width = "0%";
    progressDiv.appendChild(progressBar);

    const metaDiv = document.createElement("div");
    metaDiv.className = "task-meta";

    // 状态项
    const statusItem = document.createElement("div");
    statusItem.className = "task-meta-item";
    const statusLabel = document.createElement("span");
    statusLabel.className = "task-meta-label";
    statusLabel.textContent = "状态：";
    const statusSpan = document.createElement("span");
    statusSpan.className = "task-meta-val";
    statusSpan.id = "status-" + newTask.uid;
    statusSpan.textContent = "排队中";
    statusItem.appendChild(statusLabel);
    statusItem.appendChild(statusSpan);

    // 大小项
    const sizeItem = document.createElement("div");
    sizeItem.className = "task-meta-item";
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "task-meta-label";
    sizeLabel.textContent = "大小：";
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "task-meta-val";
    sizeSpan.id = "size-" + newTask.uid;
    sizeSpan.textContent = "-- / --";
    sizeItem.appendChild(sizeLabel);
    sizeItem.appendChild(sizeSpan);

    // 速度项
    const speedItem = document.createElement("div");
    speedItem.className = "task-meta-item";
    const speedLabel = document.createElement("span");
    speedLabel.className = "task-meta-label";
    speedLabel.textContent = "速度：";
    const speedVal = document.createElement("span");
    speedVal.className = "task-meta-val";
    const speedSpan = document.createElement("span");
    speedSpan.id = "speed-" + newTask.uid;
    speedSpan.textContent = "0.00";
    speedVal.appendChild(speedSpan);
    speedVal.append(" MB/s");
    speedItem.appendChild(speedLabel);
    speedItem.appendChild(speedVal);

    // 预计时间项
    const etaItem = document.createElement("div");
    etaItem.className = "task-meta-item";
    const etaLabel = document.createElement("span");
    etaLabel.className = "task-meta-label";
    etaLabel.textContent = "预计时间：";
    const etaSpan = document.createElement("span");
    etaSpan.className = "task-meta-val";
    etaSpan.id = "eta-" + newTask.uid;
    etaSpan.textContent = "--:--";
    etaItem.appendChild(etaLabel);
    etaItem.appendChild(etaSpan);

    metaDiv.appendChild(statusItem);
    metaDiv.appendChild(sizeItem);
    metaDiv.appendChild(speedItem);
    metaDiv.appendChild(etaItem);

    $taskItem.appendChild(headerDiv);
    $taskItem.appendChild(progressDiv);
    $taskItem.appendChild(metaDiv);

    $tasksContainer.appendChild($taskItem);
}


// Call弹幕下载
async function downloadDanmu(cid, title, duration, danmu, uid) {
    if (danmu) {
        await window.electronAPI.invoke('downloadDanmu', { cid, title, duration });
        //document.getElementById(`status-${uid}`).innerText = "下载弹幕完成";
        console.log('弹幕下载完成');
    } else {
        // 如果不下载弹幕，直接返回'
        return;
    }
}
// Call 封面下载
async function downloadCover(cover, coverUrl, title, uid) {
    if (cover && coverUrl) {
        await window.electronAPI.invoke('downloadCover', { url: coverUrl, title });
        console.log('封面下载完成');
    } else {
        // 如果没有封面，直接返回
        return;
    }
}

async function taskManager() {
    $taskCount.innerText = taskQuene.length;
    if (taskQuene.length < 1) {
        globalTaskLock = false;
        return;
    } else if (globalTaskLock === true) {
        return;
    }
    globalTaskLock = true;
    const currentTask = taskQuene[0];

    if (!currentTask.cid || currentTask.needFetchCid) {
        const statusEl = document.getElementById(`status-${currentTask.uid}`);
        if (statusEl) {
            statusEl.textContent = '获取CID中';
            statusEl.style.color = 'var(--brand)';
        }

        const videoInfo = await window.electronAPI.invoke('getVideoInfo', currentTask.bvid);
        if (!videoInfo.success || !videoInfo.data || !videoInfo.data.cid) {
            alert(`获取 ${currentTask.title} 的CID失败：${videoInfo.message || '未知错误'}`);
            if (statusEl) {
                statusEl.textContent = 'CID获取失败';
                statusEl.style.color = 'var(--err)';
            }
            taskQuene.shift();
            globalTaskLock = false;
            taskManager();
            return;
        }

        currentTask.cid = videoInfo.data.cid;
        if (!currentTask.duration && videoInfo.data.duration) {
            currentTask.duration = Number(videoInfo.data.duration) || 0;
        }
        currentTask.needFetchCid = false;
    }

    const result = await window.electronAPI.invoke('downloadTarget', currentTask);
    if (result.success) {
        // 下载成功
        await downloadDanmu(currentTask.cid, currentTask.title, currentTask.duration, currentTask.danmu, currentTask.uid);
        await downloadCover(currentTask.cover, currentTask.coverUrl, currentTask.title, currentTask.uid);
    } else {
        alert(`下载 ${currentTask.title} 失败：${result.message}`);
        // 在UI上标记下载失败，并移除该任务UI（防止进度显示混乱）
        const failedUid = currentTask.uid;
        const taskEl = document.getElementById(`task-${failedUid}`);
        const statusEl = document.getElementById(`status-${failedUid}`);
        const speedEl = document.getElementById(`speed-${failedUid}`);
        const progressEl = document.getElementById(`progress-${failedUid}`);
        const etaEl = document.getElementById(`eta-${failedUid}`);
        const percentEl = document.getElementById(`percent-${failedUid}`);
        
        if (statusEl) {
            statusEl.textContent = "下载失败";
            statusEl.style.color = "var(--err)";
        }
        if (speedEl) speedEl.textContent = "0.00";
        if (progressEl) progressEl.style.background = "var(--err)";
        if (etaEl) etaEl.textContent = "--:--";
        if (percentEl) {
            percentEl.textContent = "失败";
            percentEl.style.color = "var(--err)";
        }
        
        // 3秒后自动移除失败的任务UI，避免后续进度事件错误更新
        // setTimeout(() => {
        //     if (taskEl) taskEl.remove();
        // }, 3000);
    }

    // 无论成功与否，都继续下一个任务
    taskQuene.shift();
    globalTaskLock = false;
    taskManager();
}