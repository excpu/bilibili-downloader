const $taskCount = document.getElementById('taskCount');

// 平滑下载速度
class SpeedSmoother {
    constructor(alpha = 0.2, digits = 2) {
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
        document.getElementById(`status-${data.currentUid}`).innerText = "下载音频中";
    } else if (data.avId === "video") {
        document.getElementById(`status-${data.currentUid}`).innerText = "下载视频中";
    }

    document.getElementById(`speed-${data.currentUid}`).innerText = speedSm.update(data.speed);
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
    const uid = `${Date.now()}${Math.round(Math.random() * 1000)}`;
    const videoEle = {
        uid,
        bvid: currentVideoIdentity.bvid,
        cid: currentVideoIdentity.cid,
        title: currentVideoIdentity.title,
        videoIndex,
        audioIndex
    }
    taskQuene.push(videoEle);
    displayTasks(videoEle);
    taskManager();
}

function displayTasks(newTask) {
    const $taskItem = document.createElement('div');
    $taskItem.className = 'task';
    $taskItem.id = "task-" + newTask.uid;
    $taskItem.innerHTML = `
        <div>
            <div class="title title-vc p-10 pl-0">
                <span>${newTask.title}</span>
            </div>
            <div class="progress">
                <i id='progress-${newTask.uid}' style="width:0%"></i>
            </div>
            <div class="meta mt-5">状态：<span id='status-${newTask.uid}'>排队中</span> · 速度：<span id='speed-${newTask.uid}'>0.00</span> MB/s</div>
        </div>
        <!-- <div style="display:grid; gap:8px; align-content:center">
            <button class="btn" data-action="remove" data-id="demo1">取消</button>
        </div> -->
    `;
    $tasksContainer.appendChild($taskItem);
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
    await window.electronAPI.invoke('downloadTarget', taskQuene[0]);

    taskQuene.shift();
    globalTaskLock = false;
    taskManager();
}