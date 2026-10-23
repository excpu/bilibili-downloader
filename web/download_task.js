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
//{uid,bvid,cid,title,folderNames,videoIndex,audioIndex,videoQualityId,videoCodec,audioQualityId,audioCodec}

function manageDownloadStart() {
    if (!currentVideoIdentity) {
        alert('请先获取视频信息');
        return;
    }
    // 文件夹层级依赖设置项，异步读取后再创建任务
    return addTasksToQueue();
}

async function addTasksToQueue() {
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
    const subtitleLanguage = document.getElementById('qualitySelectSubtitle')?.value || '';
    // 文件夹设置只需读取一次，多个任务复用
    const folderFlags = await folderStructure.getFolderFlags();
    const layerNames = folderFlags.inFolder
        ? (partInfo) => folderStructure.buildLayerNames(currentVideoIdentity, partInfo)
        : () => [];
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
            const folderNames = layerNames(partInfo);

            const videoEle = {
                uid,
                bvid: taskBvid,
                cid: taskCid,
                title: taskTitle,
                folderNames,
                duration: Number(partInfo.duration) || Number(currentVideoIdentity.duration) || 0,
                videoIndex,
                audioIndex,
                videoQualityId,
                videoCodec,
                audioQualityId,
                audioCodec,
                subtitleLanguage,
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
        const folderNames = layerNames(null);
        const videoEle = {
            uid,
            bvid: currentVideoIdentity.bvid,
            cid: currentVideoIdentity.cid,
            title: currentVideoIdentity.title,
            folderNames,
            duration: currentVideoIdentity.duration,
            videoIndex,
            audioIndex,
            videoQualityId,
            videoCodec,
            audioQualityId,
            audioCodec,
            subtitleLanguage,
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
async function downloadDanmu(cid, title, duration, danmu, uid, folderNames) {
    if (danmu) {
        await window.electronAPI.invoke('downloadDanmu', { cid, title, duration, folderNames });
        //document.getElementById(`status-${uid}`).innerText = "下载弹幕完成";
        console.log('弹幕下载完成');
    } else {
        // 如果不下载弹幕，直接返回'
        return;
    }
}
// Call 封面下载
async function downloadCover(cover, coverUrl, title, uid, folderNames) {
    if (cover && coverUrl) {
        await window.electronAPI.invoke('downloadCover', { url: coverUrl, title, folderNames });
        console.log('封面下载完成');
    } else {
        // 如果没有封面，直接返回
        return;
    }
}

// 取消后的收尾：移除 UI、出队并继续下一个任务
function finishCancelledTask(task) {
    removeTaskUi(task.uid);
    taskQuene = taskQuene.filter(item => item.uid !== task.uid);
    globalTaskLock = false;
    taskManager();
}

function removeTaskUi(uid) {
    speedSmoothers.delete(uid);
    lastAvIdMap.delete(uid);
    lastTextUpdateTimeMap.delete(uid);
    document.getElementById(`task-${uid}`)?.remove();
}

function cancelTask(uid) {
    const task = taskQuene.find(item => item.uid === uid);
    if (!task) return;
    const isCurrent = globalTaskLock && taskQuene[0] === task;
    if (!isCurrent) {
        taskQuene = taskQuene.filter(item => item.uid !== uid);
        removeTaskUi(uid);
        $taskCount.innerText = taskQuene.length;
        return;
    }
    task.cancelled = true;
    const statusEl = document.getElementById(`status-${uid}`);
    if (statusEl) {
        statusEl.textContent = '正在取消...';
        statusEl.style.color = 'var(--warn)';
    }
    window.electronAPI.invoke('cancelDownload', uid);
}

// 任务右键菜单
const $taskContextMenu = document.createElement('div');
$taskContextMenu.className = 'task-context-menu';
$taskContextMenu.style.cssText = 'position:fixed;display:none;z-index:9999;min-width:110px;padding:4px;'
    + 'background:var(--panel, #fff);color:var(--text, #222);border:1px solid var(--border, #ccc);'
    + 'border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25);font-size:13px;';
const $cancelMenuItem = document.createElement('div');
$cancelMenuItem.style.cssText = 'padding:6px 12px;cursor:pointer;border-radius:4px;color:var(--err, #d33);';
$cancelMenuItem.addEventListener('mouseenter', () => { $cancelMenuItem.style.background = 'rgba(128,128,128,.2)'; });
$cancelMenuItem.addEventListener('mouseleave', () => { $cancelMenuItem.style.background = ''; });
const $retryMenuItem = document.createElement('div');
$retryMenuItem.textContent = '重试';
$retryMenuItem.style.cssText = 'padding:6px 12px;cursor:pointer;border-radius:4px;display:none;';
$retryMenuItem.addEventListener('mouseenter', () => { $retryMenuItem.style.background = 'rgba(128,128,128,.2)'; });
$retryMenuItem.addEventListener('mouseleave', () => { $retryMenuItem.style.background = ''; });
$taskContextMenu.appendChild($retryMenuItem);
$taskContextMenu.appendChild($cancelMenuItem);
document.body.appendChild($taskContextMenu);

// 失败的任务：uid -> task，保留 UI，供右键重试或删除
const failedTasks = new Map();

function markTaskFailed(task) {
    failedTasks.set(task.uid, task);
}

function retryFailedTask(uid) {
    const task = failedTasks.get(uid);
    if (!task) return;
    failedTasks.delete(uid);
    task.resume = true;
    task.cancelled = false;
    task.needFetchCid = !task.cid;
    const progressEl = document.getElementById(`progress-${uid}`);
    const percentEl = document.getElementById(`percent-${uid}`);
    const statusEl = document.getElementById(`status-${uid}`);
    if (progressEl) progressEl.style.background = '';
    if (percentEl) {
        percentEl.style.color = '';
        percentEl.textContent = '0%';
    }
    if (statusEl) {
        statusEl.textContent = '等待重试';
        statusEl.style.color = '';
    }
    taskQuene.push(task);
    taskManager();
}

async function deleteFailedTask(uid) {
    const task = failedTasks.get(uid);
    if (!task) return;
    failedTasks.delete(uid);
    removeTaskUi(uid);
    await window.electronAPI.invoke('cleanupFailedDownload', {
        title: task.title,
        folderNames: task.folderNames || []
    });
}

let contextMenuUid = null;
const hideTaskContextMenu = () => {
    $taskContextMenu.style.display = 'none';
    contextMenuUid = null;
};

$retryMenuItem.addEventListener('click', () => {
    const uid = contextMenuUid;
    hideTaskContextMenu();
    if (uid) retryFailedTask(uid);
});

$cancelMenuItem.addEventListener('click', () => {
    const uid = contextMenuUid;
    hideTaskContextMenu();
    if (!uid) return;
    if (failedTasks.has(uid)) deleteFailedTask(uid);
    else cancelTask(uid);
});

document.addEventListener('contextmenu', async (event) => {
    const taskEl = event.target.closest?.('.task');
    if (!taskEl || !taskEl.id.startsWith('task-')) {
        hideTaskContextMenu();
        return;
    }
    const uid = taskEl.id.slice('task-'.length);
    const failedTask = failedTasks.get(uid);
    const task = failedTask || taskQuene.find(item => item.uid === uid);
    if (!task || task.cancelled) {
        hideTaskContextMenu();
        return;
    }
    event.preventDefault();
    const { clientX, clientY } = event;
    if (failedTask) {
        const engine = await window.electronAPI.invoke('getDownloadEngine');
        const resumeEnabled = await window.electronAPI.invoke('getNodeResumeEnabled');
        $retryMenuItem.style.display = engine === 'node-multi' && resumeEnabled ? 'block' : 'none';
        $cancelMenuItem.textContent = '删除';
    } else {
        $retryMenuItem.style.display = 'none';
        const isCurrent = globalTaskLock && taskQuene[0] === task;
        $cancelMenuItem.textContent = isCurrent ? '取消下载' : '取消任务';
    }
    contextMenuUid = uid;
    $taskContextMenu.style.display = 'block';
    const x = Math.min(clientX, window.innerWidth - $taskContextMenu.offsetWidth - 4);
    const y = Math.min(clientY, window.innerHeight - $taskContextMenu.offsetHeight - 4);
    $taskContextMenu.style.left = `${Math.max(0, x)}px`;
    $taskContextMenu.style.top = `${Math.max(0, y)}px`;
});
document.addEventListener('click', hideTaskContextMenu);
window.addEventListener('blur', hideTaskContextMenu);
window.addEventListener('resize', hideTaskContextMenu);

// 右键菜单逻辑结束

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
        if (currentTask.cancelled) {
            finishCancelledTask(currentTask);
            return;
        }
        if (!videoInfo.success || !videoInfo.data || !videoInfo.data.cid) {
            alert(`获取 ${currentTask.title} 的CID失败：${videoInfo.message || '未知错误'}`);
            if (statusEl) {
                statusEl.textContent = 'CID获取失败';
                statusEl.style.color = 'var(--err)';
            }
            markTaskFailed(currentTask);
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
    if (!result.success && (result.cancelled || currentTask.cancelled)) {
        finishCancelledTask(currentTask);
        return;
    }
    if (result.success) {
        if (currentTask.subtitleLanguage) {
            try {
                const playerConfig = await window.electronAPI.invoke('getPlayerConfig', currentTask.bvid, currentTask.cid);
                if (!playerConfig?.success) {
                    model.showErrorMessage(`获取 ${currentTask.title} 的字幕信息失败：${playerConfig?.message || '未知错误'}`);
                } else {
                    const subtitles = playerConfig.data?.data?.subtitle?.subtitles || [];
                    const subtitle = subtitles.find(item =>
                        String(item.lan || item.id || '') === currentTask.subtitleLanguage
                    );
                    if (subtitle?.subtitle_url) {
                        const subtitleResult = await window.electronAPI.invoke('downloadSubtitle', {
                            subtitleUrl: subtitle.subtitle_url,
                            language: subtitle.lan || currentTask.subtitleLanguage,
                            title: currentTask.title,
                            folderNames: currentTask.folderNames || []
                        });
                        if (subtitleResult?.success) {
                            model.showSuccessMessage(`字幕下载完成`);
                        } else {
                            model.showErrorMessage(`字幕下载失败：${currentTask.title}，${subtitleResult?.message || '未知错误'}`);
                        }
                    } else if (subtitle) {
                        model.showErrorMessage(`字幕下载失败：${currentTask.title}，字幕地址缺失`);
                    }
                }
            } catch (error) {
                model.showErrorMessage(`字幕下载失败：${currentTask.title}，${error.message || '未知错误'}`);
            }
        }
        // 下载成功
        await downloadDanmu(currentTask.cid, currentTask.title, currentTask.duration, currentTask.danmu, currentTask.uid, currentTask.folderNames);
        await downloadCover(currentTask.cover, currentTask.coverUrl, currentTask.title, currentTask.uid, currentTask.folderNames);
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
        
        markTaskFailed(currentTask);
        
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