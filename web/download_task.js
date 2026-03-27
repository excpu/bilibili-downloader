const $taskCount = document.getElementById('taskCount');
const $downloadDanmuCheckbox = document.getElementById("downloadDanmuCheckbox");
const $downloadCoverCheckbox = document.getElementById("downloadCoverCheckbox");

// 平滑下载速度
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
const speedSm = new SpeedSmoother(0.25);

const unsubscribe = window.electronAPI.on('download-progress', (data) => {
    console.log('进度来了：', data);
    // { percent: 30, speed: 123456, name: 'xxx' }
    document.getElementById(`progress-${data.currentUid}`).style.width = `${data.progress}%`;

    if (data.avId === "audio") {
        document.getElementById(`status-${data.currentUid}`).textContent = "下载音频中";
    } else if (data.avId === "video") {
        document.getElementById(`status-${data.currentUid}`).textContent = "下载视频中";
    }

    document.getElementById(`speed-${data.currentUid}`).textContent = speedSm.update(data.speed);
});

window.electronAPI.on('download-finished', (data) => {
    console.log('下载完成');
    let taskEle = document.getElementById(`task-${data}`);
    taskEle.remove();
    // { percent: 30, speed: 123456, name: 'xxx' }
});

let taskQuene = [];

let globalTaskLock = false;

// taskQuene 子项格式
//{uid,bvid,cid,title,videoIndex,audioIndex}

function manageDownloadStart() {
    if (!currentVideoIdentity) {
        alert('请先获取视频信息');
        return;
    }
    const $qualitySelect = document.getElementById('qualitySelect');
    const videoIndex = parseInt($qualitySelect.value);
    const $qualitySelectAudio = document.getElementById('qualitySelectAudio');
    const audioIndex = parseInt($qualitySelectAudio.value);
    currentVideoIdentity.danmu = $downloadDanmuCheckbox.checked;
    currentVideoIdentity.cover = $downloadCoverCheckbox.checked;
    // 如果是多P视频，生成多个下载任务
    if (currentVideoIdentity.p.length > 0) {
        const uid = `${Date.now()}${Math.round(Math.random() * 1000)}`;
        for (let i = 0; i < currentVideoIdentity.p.length; i++) {
            // 查看是否被用户选中 （$multiPartSelector）
            const checked = document.querySelectorAll('input[name="part[]"]:checked');

            // 查看是否和某个选中的value相同
            let isChecked = false;
            checked.forEach((item) => {
                if (parseInt(item.value) === i) {
                    isChecked = true;
                }
            });

            if (!isChecked) {
                continue;
            }

            const videoEle = {
                uid,
                bvid: currentVideoIdentity.bvid,
                cid: currentVideoIdentity.p[i].cid,
                title: `P${currentVideoIdentity.p[i].page} - ${currentVideoIdentity.title} - ${currentVideoIdentity.p[i].part}`,
                videoIndex,
                audioIndex,
                danmu: currentVideoIdentity.danmu,
                cover: currentVideoIdentity.cover,
                coverUrl: currentVideoIdentity.coverUrl
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
            videoIndex,
            audioIndex,
            danmu: currentVideoIdentity.danmu,
            cover: currentVideoIdentity.cover,
            coverUrl: currentVideoIdentity.coverUrl
        }
        taskQuene.push(videoEle);
        displayTasks(videoEle);
    }
    taskManager();
}

function displayTasks(newTask) {
    const $taskItem = document.createElement("div");
    $taskItem.className = "task";
    $taskItem.id = "task-" + newTask.uid;

    const wrapper = document.createElement("div");

    const titleDiv = document.createElement("div");
    titleDiv.className = "title title-vc p-10 pl-0";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = newTask.title;
    titleDiv.appendChild(titleSpan);

    const progressDiv = document.createElement("div");
    progressDiv.className = "progress";

    const progressBar = document.createElement("i");
    progressBar.id = "progress-" + newTask.uid;
    progressBar.style.width = "0%";
    progressDiv.appendChild(progressBar);

    const metaDiv = document.createElement("div");
    metaDiv.className = "meta mt-5";

    metaDiv.append("状态：");

    const statusSpan = document.createElement("span");
    statusSpan.id = "status-" + newTask.uid;
    statusSpan.textContent = "排队中";
    metaDiv.appendChild(statusSpan);

    metaDiv.append(" · 速度：");

    const speedSpan = document.createElement("span");
    speedSpan.id = "speed-" + newTask.uid;
    speedSpan.textContent = "0.00";
    metaDiv.appendChild(speedSpan);

    metaDiv.append(" MB/s");

    wrapper.appendChild(titleDiv);
    wrapper.appendChild(progressDiv);
    wrapper.appendChild(metaDiv);

    $taskItem.appendChild(wrapper);
    $tasksContainer.appendChild($taskItem);
}


// Call弹幕下载
async function downloadDanmu(cid, title, danmu, uid) {
    if (danmu) {
        await window.electronAPI.invoke('downloadDanmu', { cid, title });
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
    const result = await window.electronAPI.invoke('downloadTarget', taskQuene[0]);
    if (result.success) {
        // 下载成功
        await downloadDanmu(taskQuene[0].cid, taskQuene[0].title, taskQuene[0].danmu, taskQuene[0].uid);
        await downloadCover(taskQuene[0].cover, taskQuene[0].coverUrl, taskQuene[0].title, taskQuene[0].uid);
    } else {
        alert(`下载 ${taskQuene[0].title} 失败：${result.message}`);
        // 在UI上标记下载失败
        document.getElementById(`status-${taskQuene[0].uid}`).textContent = "下载失败";
        document.getElementById(`status-${taskQuene[0].uid}`).style.color = "red";
        document.getElementById(`speed-${taskQuene[0].uid}`).textContent = "0.00";
        // 将progress 的i元素设置为红色
        document.getElementById(`progress-${taskQuene[0].uid}`).style.background = "red";
    }

    // 无论成功与否，都继续下一个任务
    taskQuene.shift();
    globalTaskLock = false;
    taskManager();
}