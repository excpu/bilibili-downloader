const ipcRenderer =  window.electronAPI;

// 浏览目录按钮逻辑
async function selectDir(type) {
    const path = await ipcRenderer.invoke('open-dir-dialog');
    if (path) {
        document.getElementById(type + 'Path').value = path;
    }
}

// 开始合并按钮逻辑
document.getElementById('startBtn').onclick = async () => {
    const btn = document.getElementById('startBtn');
    const logEl = document.getElementById('log');

    // 获取单选框的值
    let namingMode = 'title'; // 默认值
    const radios = document.getElementsByName('namingMode');
    for (let r of radios) {
        if (r.checked) namingMode = r.value;
    }

    const config = {
        inputDir: document.getElementById('inputPath').value,
        outputDir: document.getElementById('outputPath').value,
        namingMode: namingMode,
        addPrefix: document.getElementById('addPrefix').checked,
        copyDanmaku: document.getElementById('copyDanmaku').checked,
        copyCover: document.getElementById('copyCover').checked
    };

    if (!config.inputDir || !config.outputDir) {
        alert("请输入或选择目录！");
        return;
    }

    // 禁用按钮防重复点击
    btn.disabled = true;
    btn.innerText = "合并中...";
    document.getElementById('progressFill').classList.add('is-active');
    updateProgress(0, 0);

    // 发送任务到 Node 主进程
    ipcRenderer.send('start-merge', config);
};

// 更新进度条显示
function updateProgress(current, total) {
    const barEl = document.querySelector('.progress-bar');
    const fillEl = document.getElementById('progressFill');
    const textEl = document.getElementById('progressText');
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    fillEl.style.width = percent + '%';
    // 扫光按轨道固定像素宽度移动，避免进度变宽后动画看起来变快
    fillEl.style.setProperty('--track-width', `${barEl.clientWidth}px`);
    const activeItem = total > 0 ? Math.min(Math.floor(current) + 1, total) : 0;
    textEl.innerText = `${activeItem} / ${total} (${percent}%)`;
}

// 接收主进程的进度推送
ipcRenderer.on('merge-progress', (data) => {
    updateProgress(data.current, data.total);
});

// 接收主进程的日志推送
ipcRenderer.on('log', (msg) => {
    const logEl = document.getElementById('log');
    logEl.value += (logEl.value ? '\n' : '') + msg;
    // 自动滚动到底部
    logEl.scrollTop = logEl.scrollHeight;
});

// 任务完成恢复按钮状态
ipcRenderer.on('merge-done', () => {
    const btn = document.getElementById('startBtn');
    btn.disabled = false;
    btn.innerText = "开始合并";
    document.getElementById('progressFill').classList.remove('is-active');
});