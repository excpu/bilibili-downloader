// 用于不下载视频的情况下单独下载 弹幕和封面
function createIndependentDownload() {
    function downloadDanmu(videoEle = currentVideoIdentity) {
        if (!videoEle.cid) {
            model.showErrorMessage('无法下载弹幕：缺少视频信息');
            return;
        }
        const cid = videoEle.cid;
        const title = videoEle.title;
        window.electronAPI.invoke('downloadDanmu', { cid, title });
    }
    function downloadCover(videoEle = currentVideoIdentity) {
        if (!videoEle.coverUrl) {
            model.showErrorMessage('无法下载封面：缺少封面信息');
            return;
        }
        const coverUrl = videoEle.coverUrl;
        const title = videoEle.title;
        window.electronAPI.invoke('downloadCover', { url: coverUrl, title });
    }
    return {
        downloadDanmu,
        downloadCover
    };
}

const independentDownload = createIndependentDownload();

// 处理弹幕或封面下载错误和成功的提示
window.electronAPI.on('downloadDanmuProgress', (data) => {
    if (data.status === 'error') {
        model.showErrorMessage(`弹幕下载失败：${data.message}`);
    } else if (data.status === 'success') {
        model.showSuccessMessage('弹幕下载成功');
    }
});

window.electronAPI.on('downloadCoverProgress', (data) => {
    if (data.status === 'error') {
        model.showErrorMessage(`封面下载失败：${data.message}`);
    } else if (data.status === 'success') {
        model.showSuccessMessage('封面下载成功');
    }
});

